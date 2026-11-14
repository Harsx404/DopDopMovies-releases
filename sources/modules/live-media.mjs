// Shared live-feed checks. A playlist alone does not prove that its media plays.
// GPCDN can serve a session playlist older than its entire live window even
// with no-cache headers. Only this observed CDN gets an extra query value;
// signed URLs on other providers must remain byte-for-byte unchanged.
import zlib from 'node:zlib';

export function freshLiveUrl(value, live, now = Date.now()) {
  if (!live) return value;
  const url = new URL(value);
  if ((url.hostname === 'gpcdn.net' || url.hostname.endsWith('.gpcdn.net')) && /\.m3u8$/i.test(url.pathname)) {
    url.searchParams.set('_ddLive', String(now));
    return url.href;
  }
  return value;
}
export function isPng(bytes) {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

// Tim Streams hosts each segment on an image CDN as a real PNG: its pixel bytes
// (inflated, row filters undone) are "KWP1", a big-endian length, then the
// MPEG-TS. Returns the TS, or null for any other image.
export function decodePngSegment(bytes) {
  if (!isPng(bytes)) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  let at = 8, ihdr = null;
  const idat = [];
  while (at + 12 <= buf.length) {
    const size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    if (type === 'IHDR') ihdr = buf.subarray(at + 8, at + 8 + size);
    else if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + size));
    at += 12 + size;
    if (type === 'IEND') break;
  }
  if (!ihdr || !idat.length || ihdr[8] !== 8 || ihdr[12] !== 0) return null;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr[9]];
  if (!channels) return null;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const stride = width * channels;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  if (raw.length < height * (stride + 1)) return null;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y ? out[prev + x] : 0;
      const c = y && x >= channels ? out[prev + x - channels] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[row + x] = v & 0xff;
    }
  }
  if (out.toString('latin1', 0, 4) !== 'KWP1') return null;
  const length = out.readUInt32BE(4);
  const ts = out.subarray(8, 8 + Math.min(length, out.length - 8));
  return transportStreamOffset(ts) >= 0 ? ts : null;
}

export function transportStreamOffset(bytes) {
  const end = Math.min(bytes.length - 376, 4096);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47 && bytes[i + 376] === 0x47) return i;
  }
  return -1;
}

export function normalizeLiveSegment(bytes) {
  const decoded = decodePngSegment(bytes);
  if (decoded) return { bytes: decoded, type: 'video/mp2t' };
  const offset = transportStreamOffset(bytes);
  return offset >= 0 ? { bytes: bytes.subarray(offset), type: 'video/mp2t' } : { bytes, type: null };
}

export async function verifyLiveHls(source, { fetch, fetchStream, userAgent }) {
  const headers = { 'User-Agent': userAgent, Referer: source.referer || '', Accept: '*/*' };
  async function inspect(url, depth = 0) {
    if (depth > 3) throw new Error('Too many nested live playlists');
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Live playlist HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid live playlist');
    const lines = text.split(/\r?\n/).map(s => s.trim());
    const uris = lines.filter(s => s && !s.startsWith('#'));
    if (!uris.length) throw new Error('Empty live playlist');
    if (text.includes('#EXT-X-STREAM-INF:')) {
      let error;
      for (const uri of uris.slice(0, 3)) {
        try { return await inspect(new URL(uri, url).href, depth + 1); }
        catch (e) { error = e; }
      }
      throw error;
    }
    const target = new URL(uris[Math.max(0, uris.length - 2)], url).href;
    const SAMPLE = 4096;
    const request = { headers: { ...headers, Range: `bytes=0-${SAMPLE - 1}` }, signal: AbortSignal.timeout(12000) };
    let sample, status;
    if (fetchStream) {
      const media = await fetchStream(target, request);
      status = media.statusCode;
      sample = Buffer.alloc(0);
      try {
        if (![200, 206].includes(status)) throw new Error(`Live media HTTP ${status}`);
        for await (const chunk of media.stream) {
          sample = Buffer.concat([sample, chunk]).subarray(0, SAMPLE);
          if (sample.length >= SAMPLE) break;
        }
      } finally { media.stream.destroy(); }
    } else {
      const media = await fetch(target, request);
      status = media.status;
      if (!media.ok) throw new Error(`Live media HTTP ${status}`);
      sample = Buffer.from(await media.arrayBuffer()).subarray(0, SAMPLE);
    }
    if (sample.length < 188) throw new Error('Empty live media');
    if (isPng(sample)) {
      // A PNG-wrapped segment only decodes whole.
      const whole = await fetch(target, { headers, signal: AbortSignal.timeout(20000) });
      if (!whole.ok) throw new Error(`Live media HTTP ${whole.status}`);
      if (!decodePngSegment(new Uint8Array(await whole.arrayBuffer()))) throw new Error('Live media is not playable video or audio');
      return { ...source, verified: true };
    }
    const encrypted = /#EXT-X-KEY:.*METHOD=(?!NONE)/.test(text);
    const mp4 = /ftyp|styp|moof/.test(sample.subarray(4, 8).toString());
    const adts = sample[0] === 0xff && (sample[1] & 0xf6) === 0xf0;
    if (!encrypted && transportStreamOffset(sample) < 0 && !mp4 && !adts)
      throw new Error('Live media is not playable video or audio');
    return { ...source, verified: true };
  }
  return inspect(source.url);
}

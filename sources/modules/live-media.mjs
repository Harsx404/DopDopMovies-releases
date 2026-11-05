// Shared live-feed checks. A playlist alone does not prove that its media plays.
// GPCDN can serve a session playlist older than its entire live window even
// with no-cache headers. Only this observed CDN gets an extra query value;
// signed URLs on other providers must remain byte-for-byte unchanged.
export function freshLiveUrl(value, live, now = Date.now()) {
  if (!live) return value;
  const url = new URL(value);
  if ((url.hostname === 'gpcdn.net' || url.hostname.endsWith('.gpcdn.net')) && /\.m3u8$/i.test(url.pathname)) {
    url.searchParams.set('_ddLive', String(now));
    return url.href;
  }
  return value;
}
export function transportStreamOffset(bytes) {
  const end = Math.min(bytes.length - 376, 4096);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47 && bytes[i + 376] === 0x47) return i;
  }
  return -1;
}

export function normalizeLiveSegment(bytes) {
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
    const request = { headers: { ...headers, Range: 'bytes=0-4095' }, signal: AbortSignal.timeout(12000) };
    let sample, status;
    if (fetchStream) {
      const media = await fetchStream(target, request);
      status = media.statusCode;
      sample = Buffer.alloc(0);
      try {
        if (![200, 206].includes(status)) throw new Error(`Live media HTTP ${status}`);
        for await (const chunk of media.stream) {
          sample = Buffer.concat([sample, chunk]).subarray(0, 4096);
          if (sample.length >= 4096) break;
        }
      } finally { media.stream.destroy(); }
    } else {
      const media = await fetch(target, request);
      status = media.status;
      if (!media.ok) throw new Error(`Live media HTTP ${status}`);
      sample = Buffer.from(await media.arrayBuffer()).subarray(0, 4096);
    }
    if (sample.length < 188) throw new Error('Empty live media');
    const encrypted = /#EXT-X-KEY:.*METHOD=(?!NONE)/.test(text);
    const mp4 = /ftyp|styp|moof/.test(sample.subarray(4, 8).toString());
    const adts = sample[0] === 0xff && (sample[1] & 0xf6) === 0xf0;
    if (!encrypted && transportStreamOffset(sample) < 0 && !mp4 && !adts)
      throw new Error('Live media is not playable video or audio');
    return { ...source, verified: true };
  }
  return inspect(source.url);
}

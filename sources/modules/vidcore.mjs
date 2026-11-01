// VidCore / vidrack (Movy, Cineplay, Nova) — direct m3u8 per upstream source name.
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs: setup() runs once
// with the app runtime and this module's config from index.json; resolve()
// runs per play. Hosts and endpoints live in index.json, not here.

let UA, dnsFetch, dnsFetchStream, getHeadersForHost, resolveUrl, VIDCORE_API, VIDCORE_REFERER;

export function setup(rt, config) {
  ({ UA, dnsFetch, dnsFetchStream, getHeadersForHost, resolveUrl } = rt);
  VIDCORE_API = config.api;
  VIDCORE_REFERER = config.referer;
}

// Do not buffer whole video segments while resolving. Check a real media
// playlist (descending through masters) and a small range of its first segment.
async function playable(url, depth = 0) {
  if (depth > 3) throw new Error('playlist nesting limit');
  const headers = getHeadersForHost(new URL(url).hostname);
  const response = await dnsFetch(url, { headers });
  const body = await response.text();
  if (!response.ok || !body.trimStart().startsWith('#EXTM3U')) throw new Error('invalid playlist');
  const lines = body.split(/\r?\n/).map(s => s.trim());
  const first = lines.find(s => s && !s.startsWith('#'));
  if (!first) throw new Error('empty playlist');
  if (body.includes('#EXT-X-STREAM-INF')) return playable(resolveUrl(url, first), depth + 1);
  const targets = [body.match(/#EXT-X-MAP:.*?URI="([^"]+)"/)?.[1], first].filter(Boolean);
  for (const target of targets) {
    const absolute = resolveUrl(url, target);
    const options = { headers: { ...getHeadersForHost(new URL(absolute).hostname), Range: 'bytes=0-1023' } };
    if (dnsFetchStream) {
      const r = await dnsFetchStream(absolute, options);
      try {
        if (r.statusCode < 200 || r.statusCode >= 300) throw new Error('media unavailable');
        let bytes = 0;
        for await (const chunk of r.stream) { bytes += chunk.length; if (bytes) break; }
        if (!bytes) throw new Error('empty media');
      } finally { r.stream.destroy(); }
    } else {
      const r = await dnsFetch(absolute, options);
      if (!r.ok || !(await r.arrayBuffer()).byteLength) throw new Error('media unavailable');
    }
  }
  return true;
}

async function resolveVidCore(source, tmdbId, type, season, episode) {
  // VidCore movy — direct m3u8, no encryption
  let url = `${VIDCORE_API}/api/sources/${source}?id=${tmdbId}`;
  if (type === "tv") url += `&type=tv&season=${season}&episode=${episode}`;
  const r = await dnsFetch(url, { headers: { "User-Agent": UA, Referer: VIDCORE_REFERER } });
  if (!r.ok) throw new Error(`VidCore ${source}: HTTP ${r.status}`);
  const data = JSON.parse(await r.text());
  if (!data.sources || data.sources.length === 0) throw new Error(`VidCore ${source}: no sources`);

  // Deduplicate by quality — prefer moon.* hosts (peakstorm/zenoak, known stable)
  const seen = new Set();
  const unique = [];
  // Sort: prefer moon.* CDN first, keep original order otherwise
  const sorted = [...data.sources].sort((a, b) => {
    const aMoon = /moon\.(peakstorm|zenoak)\.top/.test(a.url) ? 0 : 1;
    const bMoon = /moon\.(peakstorm|zenoak)\.top/.test(b.url) ? 0 : 1;
    if (aMoon !== bMoon) return aMoon - bMoon;
    return 0;
  });
  for (const s of sorted) {
    const q = s.quality || "auto";
    if (!seen.has(q)) {
      seen.add(q);
      unique.push(s);
    }
  }

  // Verify first stream with correct headers — manifest AND first segment.
  // VidCore rotates CDN domains that sometimes serve the playlist but 403
  // every segment (e.g. Cloudflare-challenged stillhaven.top); checking a
  // segment lets dead streams fail over to the next provider.
  // Same-quality entries can point at different servers. Probe them BEFORE
  // deduplicating; a broken first 4K server must not hide a working mirror.
  const checked = await Promise.all(sorted.slice(0, 8).map(async candidate => {
    let timer;
    try {
      await Promise.race([playable(candidate.url), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('playback check timed out')), 10000); })]);
      return candidate;
    } catch { return null; } finally { clearTimeout(timer); }
  }));
  const live = checked.filter(Boolean);
  if (!live.length) throw new Error(`VidCore ${source}: no playable streams for this title`);
  unique.length = 0;
  seen.clear();
  for (const candidate of live) if (!seen.has(candidate.quality || 'auto')) { seen.add(candidate.quality || 'auto'); unique.push(candidate); }
  const firstUrl = unique[0].url;
  const host = new URL(firstUrl).hostname;
  const sr = await dnsFetch(firstUrl, { headers: getHeadersForHost(host) });
  const st = await sr.text();
  const valid = sr.ok && st.includes("#EXTM3U");
  if (!valid) throw new Error(`VidCore ${source}: stream failed playback check (CDN ${host})`);

  let qualities = [];
  if (st.includes("#EXT-X-STREAM-INF")) {
    const lines = st.split(/\r?\n/);
    const seenQ = new Set();
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
        const res = lines[i].match(/RESOLUTION=\d+x(\d+)/);
        const bw = lines[i].match(/BANDWIDTH=(\d+)/)?.[1] ? parseInt(lines[i].match(/BANDWIDTH=(\d+)/)[1], 10) : 0;
        let j = i + 1;
        while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith("#"))) j++;
        if (j < lines.length && res) {
          const h = parseInt(res[1], 10);
          const qName = h >= 2000 ? "2160p" : h >= 1000 ? "1080p" : h >= 650 ? "720p" : h >= 450 ? "480p" : h >= 300 ? "360p" : `${h}p`;
          const vUrl = resolveUrl(firstUrl, lines[j].trim());
          variants.push({ h, bw, quality: qName, url: vUrl });
        }
      }
    }
    variants.sort((a, b) => b.h - a.h || b.bw - a.bw);
    for (const v of variants) {
      if (!seenQ.has(v.quality)) {
        seenQ.add(v.quality);
        qualities.push({ quality: v.quality, url: v.url, cdn: host });
      }
    }
    qualities.push({ quality: "auto", url: firstUrl, cdn: host });
  }
  if (!qualities.length) {
    qualities = unique.map(s => ({
      quality: s.quality || "auto",
      url: s.url,
      cdn: new URL(s.url).hostname,
    }));
  }

  return {
    cdn: host,
    qualities,
    verified: true,
    subtitles: unique.flatMap(s => s.subtitles || []).filter((s, i, all) => s.url && all.findIndex(x => x.url === s.url) === i),
    referer: getHeadersForHost(host).Referer || null,
  };
}

// params.upstream: vidrack's own source name. Upstream names go dead without
// notice ("movy", "cineplay" → empty); remap them here in index.json.
export async function resolve(req, { params }) {
  return resolveVidCore(params.upstream, req.id, req.type, req.season, req.episode);
}

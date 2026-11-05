// VidCore / vidrack (Movy, Cineplay, Nova) — direct m3u8 per upstream source name.
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs: setup() runs once
// with the app runtime and this module's config from index.json; resolve()
// runs per play. Hosts and endpoints live in index.json, not here.

let UA, dnsFetch, dnsFetchStream, getHeadersForHost, resolveUrl, movyBrowserProof, VIDCORE_API, VIDCORE_REFERER;

export function setup(rt, config) {
  ({ UA, dnsFetch, dnsFetchStream, getHeadersForHost, resolveUrl, movyBrowserProof } = rt);
  VIDCORE_API = config.api;
  VIDCORE_REFERER = config.referer;
}

// How much of the first segment a check reads: enough to time how fast the server delivers.
const SPEED_SAMPLE = 256 * 1024;

const isMovish = s => /^movy-fallback-movish-/.test(s.provider || '') && new URL(s.url).origin === 'https://api.dlproxy.com';
function sourceHeaders(s) {
  const supplied = Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const referer = supplied.referer || (isMovish(s) ? 'https://movish.to/' : getHeadersForHost(new URL(s.url).hostname).Referer);
  return { Referer: referer, Origin: supplied.origin || (referer ? new URL(referer).origin : undefined) };
}
const headersFor = (url, s) => ({ ...getHeadersForHost(new URL(url).hostname), ...sourceHeaders(s) });
function playlistError(body, status) {
  let code;
  try { code = JSON.parse(body).code; } catch {}
  return Object.assign(new Error(code === 'PROOF_REQUIRED' ? 'Movy requires browser verification' : `invalid playlist (HTTP ${status})`), { code });
}
function proxyUrl(url, candidate, pick) {
  const params = new URLSearchParams({ url });
  const referer = sourceHeaders(candidate).Referer;
  if (referer) params.set('referer', referer);
  if (pick) params.set('pick', String(pick));
  return `/api/hls?${params}`;
}

// Do not buffer whole video segments while resolving. Check a real media
// playlist (descending through masters) and the start of its first segment,
// timing it. Answers the top playlist's text and the time the sample took.
async function playable(url, candidate, depth = 0, top = null) {
  if (depth > 3) throw new Error('playlist nesting limit');
  const headers = headersFor(url, candidate);
  const response = await dnsFetch(url, { headers });
  const body = await response.text();
  if (!response.ok || !body.trimStart().startsWith('#EXTM3U')) throw playlistError(body, response.status);
  const lines = body.split(/\r?\n/).map(s => s.trim());
  const first = lines.find(s => s && !s.startsWith('#'));
  if (!first) throw new Error('empty playlist');
  const playlist = top ?? body;
  if (body.includes('#EXT-X-STREAM-INF')) return playable(resolveUrl(url, first), candidate, depth + 1, playlist);
  const targets = [body.match(/#EXT-X-MAP:.*?URI="([^"]+)"/)?.[1], first].filter(Boolean);
  let ms = 0;
  for (const target of targets) {
    const absolute = resolveUrl(url, target);
    const sample = target === first ? SPEED_SAMPLE : 1024;
    const options = { headers: { ...headersFor(absolute, candidate), Range: `bytes=0-${sample - 1}` } };
    const began = Date.now();
    if (dnsFetchStream) {
      const r = await dnsFetchStream(absolute, options);
      try {
        if (r.statusCode < 200 || r.statusCode >= 300) {
          // Proof can also expire between the playlist and the first segment.
          let errorBody = '';
          for await (const chunk of r.stream) { errorBody += chunk.toString(); if (errorBody.length >= 4096) break; }
          throw playlistError(errorBody, r.statusCode);
        }
        let bytes = 0;
        for await (const chunk of r.stream) { bytes += chunk.length; if (bytes >= sample) break; }
        if (!bytes) throw new Error('empty media');
      } finally { r.stream.destroy(); }
    } else {
      const r = await dnsFetch(absolute, options);
      if (!r.ok) throw playlistError(await r.text(), r.status);
      if (!(await r.arrayBuffer()).byteLength) throw new Error('media unavailable');
    }
    if (target === first) ms = Date.now() - began;
  }
  return { playlist, ms };
}

// Best picture first; "Auto" streams are ranked by the tallest picture they turn out to have.
const RANK = { "4K": 2160, "2160p": 2160, "UHD": 2160, "1440p": 1440, "1080p": 1080, "FHD": 1080, "720p": 720, "HD": 720, "480p": 480, "360p": 360 };
// Dubbed servers ("Orion · Hindi") are offered as their own choice, never picked to start with.
const dubOf = (s) => /\b(hindi|tamil|telugu|spanish|french|german)\b/i.exec(s.label || "")?.[1];
const rankOf = (quality, playlist) => RANK[quality] ?? RANK[String(quality).toUpperCase()] ?? Math.max(0, ...[...(playlist || "").matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1])));

// The list of servers for a title barely changes: a second play of it skips asking again.
const listCache = new Map();
const LIST_TTL_MS = 10 * 60_000;

async function resolveVidCore(source, tmdbId, type, season, episode) {
  // VidCore movy — direct m3u8, no encryption
  let url = `${VIDCORE_API}/api/sources/${source}?id=${tmdbId}`;
  if (type === "tv") url += `&type=tv&season=${season}&episode=${episode}`;
  const started = Date.now();
  let data = listCache.get(url)?.at > Date.now() - LIST_TTL_MS ? listCache.get(url).data : null;
  if (!data) {
    const r = await dnsFetch(url, { headers: { "User-Agent": UA, Referer: VIDCORE_REFERER } });
    console.log(`  vidcore ${source}: sources answered in ${Date.now() - started}ms`);
    if (!r.ok) throw new Error(`VidCore ${source}: HTTP ${r.status}`);
    data = JSON.parse(await r.text());
    if (!data.sources || data.sources.length === 0) throw new Error(`VidCore ${source}: no sources`);
    listCache.set(url, { at: Date.now(), data });
    if (listCache.size > 200) listCache.delete(listCache.keys().next().value);
  }

  // Keep all mirrors until they have been checked; one failed rendition says
  // nothing about another URL on the same proxy hostname.
  const sorted = [...data.sources].map((s) => (dubOf(s) ? { ...s, quality: dubOf(s)[0].toUpperCase() + dubOf(s).slice(1).toLowerCase() } : s)).sort((a, b) => {
    if (!!dubOf(a) !== !!dubOf(b)) return dubOf(a) ? 1 : -1;
    const aMoon = /moon\.(peakstorm|zenoak)\.top/.test(a.url) ? 0 : 1;
    const bMoon = /moon\.(peakstorm|zenoak)\.top/.test(b.url) ? 0 : 1;
    if (aMoon !== bMoon) return aMoon - bMoon;
    return 0;
  });
  const check = async candidate => {
    let timer;
    try {
      const result = await Promise.race([playable(candidate.url, candidate), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('playback check timed out')), 10000); })]);
      return { candidate, ...result, rank: rankOf(candidate.quality, result.playlist) };
    } finally { clearTimeout(timer); }
  };
  const checked = await Promise.allSettled(sorted.slice(0, 8).map(check));
  for (const [i, r] of checked.entries()) if (r.status === 'rejected' && r.reason?.code !== 'PROOF_REQUIRED') console.log(`  vidcore ${source}: ${sorted[i].label || sorted[i].quality}: ${r.reason?.message || 'check failed'}`);
  const results = checked.filter(r => r.status === 'fulfilled').map(r => r.value);
  const gated = checked.flatMap((r, i) => r.status === 'rejected' && r.reason?.code === 'PROOF_REQUIRED' && isMovish(sorted[i]) ? [sorted[i]] : []);
  let proofError;
  if (gated.length) {
    try {
      const session = await movyBrowserProof?.({ type, id: tmdbId, season, episode });
      if (!session?.proof || session.expiresAt <= Date.now() + 60000) throw new Error('Movy: browser verification needs the desktop app');
      const retried = await Promise.allSettled(gated.map(candidate => {
        const url = new URL(candidate.url);
        url.searchParams.set('bp', session.proof);
        return check({ ...candidate, url: url.href });
      }));
      for (const [i, r] of retried.entries()) if (r.status === 'rejected') console.log(`  vidcore ${source}: ${gated[i].label || gated[i].quality}: ${r.reason?.code || r.reason?.message || 'verification failed'}`);
      results.push(...retried.filter(r => r.status === 'fulfilled').map(r => r.value));
    } catch (e) { proofError = e; }
  }
  // Sharpest picture first; between servers with the same picture, the one that delivered fastest.
  const working = results.sort((a, b) => (!!dubOf(a.candidate) - !!dubOf(b.candidate)) || b.rank - a.rank || a.ms - b.ms);
  console.log(`  vidcore ${source}: ${working.length} of ${checked.length} servers working after ${Date.now() - started}ms`);
  if (!working.length) throw Object.assign(proofError || new Error(gated.length ? 'Movy: browser verification required' : `VidCore ${source}: no playable streams for this title`), gated.length ? { code: 'PROOF_REQUIRED' } : {});
  const firstUrl = working[0].candidate.url;
  const host = new URL(firstUrl).hostname;
  // Its playlist was read during the check.
  const qualities = [];
  const seenQ = new Set();
  const add = (quality, url, candidate, pick) => {
    if (seenQ.has(quality)) return;
    seenQ.add(quality);
    qualities.push({ quality, url: proxyUrl(url, candidate, pick), cdn: new URL(url).hostname });
  };
  for (const { candidate, playlist: st } of working) {
    // A dubbed master remains selectable even when the best original server
    // is also a master. Keep its audio groups by proxying the complete master.
    if (dubOf(candidate)) { add(candidate.quality, candidate.url, candidate); continue; }
    if (!st.includes('#EXT-X-STREAM-INF')) { add(candidate.quality || 'auto', candidate.url, candidate); continue; }
    const lines = st.split(/\r?\n/);
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
          variants.push({ h, bw, quality: qName });
        }
      }
    }
    variants.sort((a, b) => b.h - a.h || b.bw - a.bw);
    for (const v of variants) {
      add(v.quality, candidate.url, candidate, v.h);
    }
    add('auto', candidate.url, candidate);
  }

  return {
    cdn: host,
    qualities,
    verified: true,
    subtitles: working.flatMap(w => (w.candidate.subtitles || []).filter(s => s.url).map(s => ({ ...s, url: proxyUrl(s.url, w.candidate) }))).filter((s, i, all) => all.findIndex(x => x.url === s.url) === i),
  };
}

// params.upstream: vidrack's own source name. Upstream names go dead without
// notice ("movy", "cineplay" → empty); remap them here in index.json.
export async function resolve(req, { params }) {
  return resolveVidCore(params.upstream, req.id, req.type, req.season, req.episode);
}

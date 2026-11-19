// KatDrama (k-drama.in): series by TMDB id, so titles never need matching. Its own player
// page (vid2.php) is gone; the site's working server by id is the VidSync embed, whose
// JSON API is read here. No site scripts are executed.
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs. Hosts live in index.json.

let UA, dnsFetch, BASE, NODES, episodeRuntime;

// VidSync spreads its API over many worker hosts; any of them answers any title.
const DEFAULT_NODES = [
  "https://vidsync-shard.vs-deals.workers.dev",
  "https://vidsync-shard.vs-deals2.workers.dev",
  "https://vidsync-shard.vs-deals3.workers.dev",
  "https://vidsync-shard.vs-deals4.workers.dev",
  "https://vidsync-shard.vs-deals5.workers.dev",
  "https://vidsync-shard.vs-admin.workers.dev",
  "https://vidsync-shard.vs-mikami3000.workers.dev",
  "https://vidsync-shard.vs-xdoroka.workers.dev",
];

export function setup(rt, config) {
  ({ UA, dnsFetch } = rt);
  episodeRuntime = rt.tmdbEpisodeRuntime;
  BASE = (config.base || "https://vidsync.pro").replace(/\/+$/, "");
  NODES = Array.isArray(config.nodes) && config.nodes.length ? config.nodes : DEFAULT_NODES;
}

/** FNV-1a, as the embed uses, so the same title keeps landing on the same node. */
function fnv(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

const proxied = (url, referer) => `/api/hls?url=${encodeURIComponent(url)}${referer ? `&referer=${encodeURIComponent(referer)}` : ""}`;

/**
 * Some streams refuse anyone but their own player, so only the ones that answer are offered.
 * VidSync's providers can also return a different show of the same name: when the episode's
 * length is known, a playlist far longer or shorter than it is dropped.
 */
async function answers(url, referer, minutes) {
  try {
    const get = async (u) => { const r = await dnsFetch(u, { headers: { "User-Agent": UA, ...(referer ? { Referer: referer } : {}) }, signal: AbortSignal.timeout(8000) }); return r.ok ? r.text() : ""; };
    let text = await get(url);
    if (!text.trimStart().startsWith("#EXTM3U")) return false;
    if (!minutes) return true;
    // A master playlist: measure its first variant.
    const variant = text.match(/^(?!#)(\S+)$/m)?.[1];
    if (!/#EXTINF/.test(text) && variant) text = await get(new URL(variant, url).href);
    const secs = [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    if (!secs) return true;
    const got = secs / 60;
    return Math.abs(got - minutes) <= Math.max(15, minutes * 0.35);
  } catch { return false; }
}

/** API answer → the app's shape. One entry per distinct playlist. */
export function parseStreams(data) {
  const seen = new Set();
  const qualities = [];
  for (const s of data?.sources || []) {
    const url = s?.directUrl || s?.url;
    if (!/^https:\/\//.test(url || "") || (s.type && s.type !== "hls") || seen.has(url)) continue;
    seen.add(url);
    const referer = s.streamHeaders?.Referer || s.headers?.Referer || "";
    const q = s.quality && s.quality !== "Auto" ? s.quality : "Auto";
    qualities.push({ quality: `${q}${s.provider?.name ? ` · ${s.provider.name}` : ""}`, url: proxied(url, referer), raw: url, referer, type: "hls" });
  }
  const subtitles = (data?.subtitles || [])
    .filter((t) => /^https:\/\//.test(t?.url || ""))
    .map((t) => ({ url: proxied(t.url), lang: t.language || "en", label: t.languageName || t.label || t.language || "Subtitles" }));
  return { qualities, subtitles };
}

async function call(node, path, id) {
  const headers = { "User-Agent": UA, Origin: BASE, Referer: `${BASE}/`, Accept: "application/json" };
  const tok = await dnsFetch(`${node}/api/token`, {
    method: "POST",
    headers: { ...headers, "X-Content-Id": String(id), "Content-Type": "application/json" },
    body: JSON.stringify({ ipv4: null }),
    signal: AbortSignal.timeout(8000),
  });
  if (!tok.ok) throw new Error(`token HTTP ${tok.status}`);
  const { token } = await tok.json();
  const res = await dnsFetch(`${node}${path}`, { headers: { ...headers, "X-API-Token": token }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function resolve(req) {
  if (req.type !== "tv") throw new Error("KatDrama: series only");
  const id = Number(req.id), season = Number(req.season) || 1, episode = Number(req.episode) || 1;
  if (!Number.isInteger(id) || id <= 0) throw new Error("KatDrama: TMDB id required");
  const q = `type=tv&id=${id}&season=${season}&episode=${episode}`;
  const start = fnv(`tv-${id}-${season}-${episode}`) % NODES.length;
  let lastErr;
  for (let k = 0; k < Math.min(3, NODES.length); k++) {
    const node = NODES[(start + k) % NODES.length];
    try {
      const data = await call(node, `/api/core/streams?${q}`, id);
      const { qualities } = parseStreams(data);
      const minutes = await Promise.resolve(episodeRuntime?.(id, season, episode)).catch(() => null);
      const checks = await Promise.all(qualities.map((x) => answers(x.raw, x.referer, minutes)));
      const working = qualities.filter((_, i) => checks[i]).map(({ raw, referer, ...x }) => x);
      if (!working.length) { lastErr = new Error(qualities.length ? "only a different show came back for this episode" : "no working stream for this episode"); continue; }
      let subtitles = parseStreams(data).subtitles;
      if (!subtitles.length) {
        try { subtitles = parseStreams(await call(node, `/api/subtitles?id=${id}&${q}`, id)).subtitles; } catch {}
      }
      return { cdn: new URL(node).host, verified: true, qualities: working, subtitles };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`KatDrama: ${lastErr?.message || "no working stream for this episode"}`);
}

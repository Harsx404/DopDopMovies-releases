// VidSrc — embed player URL from vsembed's lookup API.
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs: setup() runs once
// with the app runtime and this module's config from index.json; resolve()
// runs per play. Hosts and endpoints live in index.json, not here.

let UA, dnsFetch, VIDSRC_API, VIDSRC_API_REFERER, VIDSRC_PLAYER_REFERER;

export function setup(rt, config) {
  ({ UA, dnsFetch } = rt);
  VIDSRC_API = config.api;
  VIDSRC_API_REFERER = config.apiReferer;
  VIDSRC_PLAYER_REFERER = config.playerReferer;
}

async function resolveVidSrc(tmdbId, type, season, episode) {
  // VidSrc — returns embed URL
  let url = `${VIDSRC_API}/vs_src.php?type=${type}&id=${tmdbId}`;
  if (type === "tv") url += `&s=${season}&e=${episode}`;
  // vsembed.ru stalls on roughly one call in three; a second try answers fast.
  const get = () => Promise.race([
    dnsFetch(url, { headers: { "User-Agent": UA, Referer: VIDSRC_API_REFERER } }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("VidSrc: timed out")), 8000)),
  ]);
  const r = await get().catch(get);
  if (!r.ok) throw new Error(`VidSrc: HTTP ${r.status}`);
  const data = JSON.parse(await r.text());
  if (!data.src) throw new Error("VidSrc: no src in response");
  // The embed URL is an iframe player — return it for iframe display
  return {
    cdn: new URL(data.src).hostname,
    qualities: [{ quality: "embed", url: data.src }],
    verified: true,
    isEmbed: true,
    // The player host rotates; it only serves pages referred by vsembed.ru.
    referer: VIDSRC_PLAYER_REFERER,
  };
}

export async function resolve(req) {
  return resolveVidSrc(req.id, req.type, req.season, req.episode);
}

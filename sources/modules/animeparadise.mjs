// AnimeParadise — title-keyed anime, multi-quality HLS.
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs: setup() runs once
// with the app runtime and this module's config from index.json; resolve()
// runs per play. Hosts and endpoints live in index.json, not here.

let UA, dnsFetch, AP_API, AP_STREAM, AP_REFERER, tmdbAbsoluteEpisode, tmdbSeasonName;

export function setup(rt, config) {
  ({ UA, dnsFetch, tmdbAbsoluteEpisode, tmdbSeasonName } = rt);
  AP_API = config.api;
  AP_STREAM = config.stream;
  AP_REFERER = config.referer;
}

// AnimeParadise — public API at api.animeparadise.moe + stream.animeparadise.moe
// Flow: search → anime detail → episodes → episode details (streamLink) → m3u8
async function resolveAnimeParadise(query, epNum) {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
  const API = AP_API;
  const STREAM = AP_STREAM;

  // Step 1: Search — AP's index handles season queries itself: "X Season 2"
  // returns the dedicated entry (romanized title included) or nothing at all,
  // so results[0] can be trusted without a word-overlap floor (which would
  // also reject correctly-matched romanized titles like "Kimetsu no Yaiba").
  const searchUrl = `${API}/search?q=${encodeURIComponent(query)}`;
  const searchResp = await dnsFetch(searchUrl, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const searchData = JSON.parse(await searchResp.text());
  const results = searchData.data || [];
  if (results.length === 0) throw new Error(`AnimeParadise: no results for "${query}"`);
  const anime = results[0];
  const link = anime.link || anime._id;

  // Step 2: Get anime detail (to get _id)
  const detailUrl = `${API}/anime/${encodeURIComponent(link)}`;
  const detailResp = await dnsFetch(detailUrl, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const detailData = JSON.parse(await detailResp.text());
  const animeId = detailData.data?._id || link;

  // Step 3: Get episodes
  const epsUrl = `${API}/anime/${encodeURIComponent(animeId)}/episode`;
  const epsResp = await dnsFetch(epsUrl, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const epsData = JSON.parse(await epsResp.text());
  const episodes = epsData.data || [];
  if (episodes.length === 0) throw new Error(`AnimeParadise: no episodes for ${anime.title || query}`);

  // Find the requested episode
  const ep = episodes.find((e) => parseInt(e.number) === epNum) || episodes[0];
  const uid = ep.uid;
  const origin = ep.origin || animeId;
  if (!uid) throw new Error(`AnimeParadise: no uid for EP ${epNum}`);

  // Step 4: Get episode details (streamLink)
  const epDetailUrl = `${API}/ep/${encodeURIComponent(uid)}?origin=${encodeURIComponent(origin)}`;
  const epDetailResp = await dnsFetch(epDetailUrl, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const epDetailData = JSON.parse(await epDetailResp.text());
  const streamLink = epDetailData.data?.episode?.streamLink;
  if (!streamLink) throw new Error(`AnimeParadise: no streamLink for EP ${epNum}`);

  // Step 5: Get m3u8
  const m3u8Url = `${STREAM}/m3u8?url=${encodeURIComponent(streamLink)}`;
  const m3u8Resp = await dnsFetch(m3u8Url, { headers: { "User-Agent": UA, Referer: AP_REFERER } });
  const m3u8Text = await m3u8Resp.text();
  if (!m3u8Text.includes("#EXTM3U")) throw new Error(`AnimeParadise: invalid m3u8 for EP ${epNum}`);

  // Parse master playlist for qualities
  const qualities = [];
  const lines = m3u8Text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
      const resMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const variantPath = lines[i + 1]?.trim();
      if (variantPath) {
        const variantUrl = variantPath.startsWith("http") ? variantPath : `${STREAM}${variantPath}`;
        qualities.push({
          quality: resMatch ? `${resMatch[2]}p` : "HLS",
          url: variantUrl,
          type: "hls",
          cdn: "stream.animeparadise.moe",
          headers: { Referer: AP_REFERER },
        });
      }
    }
  }
  // If no variants (single quality), use the master URL itself
  if (qualities.length === 0) {
    qualities.push({
      quality: "1080p",
      url: m3u8Url,
      type: "hls",
      cdn: "stream.animeparadise.moe",
      headers: { Referer: AP_REFERER },
    });
  }

  // Get subtitles — only return ones with full URLs (filter out Google Drive IDs)
  const subData = epDetailData.data?.episode?.subData || [];
  const subtitles = subData
    .filter((s) => s.src && s.src.startsWith("http"))
    .map((s) => ({ url: s.src, lang: s.label, type: s.type || "vtt" }));

  return {
    qualities,
    cdn: "stream.animeparadise.moe",
    verified: true,
    subtitles,
  };
}

export async function resolve(req) {
  const { id, type, season, episode, animeEp } = req;
  const title = req.cartoonTitle || req.q;
  if (!title) throw new Error("AnimeParadise: title required");
  const n = Number(season) || 1;
  const ep = Number(episode) || 1;
  if (parseInt(animeEp)) return resolveAnimeParadise(title, parseInt(animeEp));
  if (type !== "tv" || n <= 1) return resolveAnimeParadise(title, ep);
  // Dedicated season entry first ("Black Clover 2nd Season"), then the main
  // show's continuous numbering via TMDB absolute mapping.
  const ord = { 2: "2nd", 3: "3rd" }[n] || `${n}th`;
  const arc = await tmdbSeasonName(id, n).catch(() => null);
  const probes = [`${title} Season ${n}`, `${title} ${ord} Season`, `${title} ${n}`];
  if (arc) probes.unshift(`${title} ${arc}`, arc);
  for (const q of probes) {
    try { return await resolveAnimeParadise(q, ep); } catch {}
  }
  return resolveAnimeParadise(title, (await tmdbAbsoluteEpisode(id, season, episode).catch(() => null)) || ep);
}

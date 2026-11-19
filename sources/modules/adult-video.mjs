// After Dark video rooms: HDSex, XNXX, RedGIFs, XBooru, SuperPorn, HentaiHaven,
// LeakGallery, ViralXXX, X-Video and Coomer. Search and stream lookups for each site.
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime, so fixes for
// these sites ship in a source-pack update instead of a new app version.
let UA, curlFetch, curlFetchDoH, curlPost, dnsFetch, dnsFetchStream;

export function setup(rt) {
  ({ UA, curlFetch, curlFetchDoH, curlPost, dnsFetch, dnsFetchStream } = rt);
}

// --- SuperPorn (superporn.com) — adult tube provider with direct MP4 ---
const SUPERPORN_BASE = "https://www.superporn.com";

export async function superpornSearch(q) {
  const html = await curlFetch(`${SUPERPORN_BASE}/search?q=${encodeURIComponent(q)}`, {
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9",
  });
  // Extract video cards: <a href="https://www.superporn.com/video/..." class="thumb-duracion"> ... <img alt="..." data-src="...">
  const cards = [...html.matchAll(/<a href="(https:\/\/www\.superporn\.com\/video\/[^"]*)" class="thumb-duracion"[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[^>]*data-src="([^"]*)"/g)];
  const results = cards.map(c => ({
    url: c[1],
    slug: c[1].replace(/^https:\/\/www\.superporn\.com\/video\//, ""),
    title: c[2].replace(/&#039;/g, "'").replace(/&amp;/g, "&"),
    thumb: c[3],
  }));
  return { videos: results };
}

export async function superpornGetStream(slug) {
  const html = await curlFetch(`${SUPERPORN_BASE}/video/${slug}`, {
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9",
  });
  // Extract MP4 URL from <source> tag
  const sourceMatch = html.match(/<source[^>]*src="([^"]*)"[^>]*type="video\/mp4"/);
  if (!sourceMatch) throw new Error("No MP4 source found");
  const mp4Url = sourceMatch[1].replace(/&amp;/g, "&");
  // Extract poster
  const posterMatch = html.match(/poster="([^"]*)"/);
  const poster = posterMatch ? posterMatch[1] : "";
  // Extract title
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(/ - SuperPorn.*$/i, "") : "";
  return { mp4Url, poster, title };
}

// --- HDSex (hdsex.org) — adult tube provider with native HLS player ---
const HDSEX_BASE = "https://hdsex.org";

export async function hdsexSearch(q) {
  const html = await curlFetch(`${HDSEX_BASE}/search/${encodeURIComponent(q)}`, {
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9",
  });
  // Extract video cards: href="/video/{id}" title="..." ... data-poster="..." data-preview="..." data-id="..."
  const cards = [...html.matchAll(/href="\/video\/(\d+)"[^>]*\s+title\s*=\s*"([^"]*)"[^>]*\s+class="video__preview"[^>]*\s+data-poster="([^"]*)"[^>]*\s+data-preview="([^"]*)"[^>]*\s+data-id="(\d+)"/g)];
  const results = cards.map(c => ({
    id: c[1],
    title: c[2].trim(),
    poster: c[3],
    preview: c[4],
  }));
  return { videos: results };
}

export async function hdsexGetStream(videoId) {
  const html = await curlFetch(`${HDSEX_BASE}/video/${videoId}`, {
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9",
  });
  // Extract HLS URL from <source> tag
  const sourceMatch = html.match(/<source[^>]*src="([^"]*)"[^>]*type="application\/x-mpegURL"/);
  if (!sourceMatch) throw new Error("No HLS source found");
  const hlsUrl = sourceMatch[1].replace(/\x26amp;/g, "\x26");
  // Extract poster
  const posterMatch = html.match(/poster="([^"]*)"/);
  const poster = posterMatch ? posterMatch[1] : "";
  // Extract title
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(/ - HDSex\.org.*$/i, "") : "";
  return { hlsUrl, poster, title };
}

// --- HentaiHaven (hentaihaven.com) — hentai anime provider ---
// URL structure: /video/{series-slug}/ for series, /video/{series-slug}/{episode-slug}
// for episodes (e.g. /video/new-glass-the-movie/the-movie-1 — no longer /episode-N).
// Search via HTML scraping of ?s=... (WP REST API returns old 404 URLs for newer videos)
// Episode pages have an iframe player with encrypted data param. The player.php page
// has an x-secure-token meta tag (ROT13+base64 x3 → JSON with "en" and "iv" fields).
// Those are POSTed to api.php which returns the HLS stream URL. All server-side, no browser.
const HH_BASE = "https://hentaihaven.com";

function rot13(s) {
  return s.split("").map((c) => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode(((code - 65 + 13) % 26) + 65);
    if (code >= 97 && code <= 122) return String.fromCharCode(((code - 97 + 13) % 26) + 97);
    return c;
  }).join("");
}

function hhDecodeToken(token) {
  let e = token.replace("sha512-", "");
  for (let i = 0; i < 3; i++) {
    e = rot13(e);
    e = Buffer.from(e, "base64").toString("utf-8");
  }
  return JSON.parse(e);
}

export async function hhSearch(query) {
  const url = `${HH_BASE}/?s=${encodeURIComponent(query)}`;
  const html = await curlFetch(url, {
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9",
  });
  // Extract /video/{series-slug}/ links with covers and titles
  const blocks = html.match(/<a[^>]*href="(https:\/\/hentaihaven\.com\/video\/[^"]*\/)"[^>]*>[\s\S]*?<\/a>/g) || [];
  const seen = new Set();
  const results = [];
  for (const block of blocks) {
    const link = block.match(/href="([^"]*)"/)?.[1];
    if (!link) continue;
    const slug = link.replace(/.*\/video\//, "").replace(/\/$/, "");
    if (seen.has(slug)) continue;
    seen.add(slug);
    const cover = block.match(/<img[^>]*src="([^"]*)"/)?.[1] || null;
    const altText = block.match(/alt="([^"]*)"/)?.[1] || "";
    const title = altText.replace(/\s*cover\s*$/i, "").trim() || slug;
    results.push({ slug, title, cover, description: "", link });
  }
  return results;
}

export async function hhGetEpisodes(seriesSlug) {
  const url = `${HH_BASE}/video/${seriesSlug}/`;
  const html = await curlFetch(url, {
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9",
  });
  // Extract title
  const title = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]?.replace(/<[^>]*>/g, "").trim() || seriesSlug;
  // Extract cover
  const cover = html.match(/<img[^>]*src="([^"]*)"[^>]*alt="[^"]*cover[^"]*"/)?.[1] || null;
  // Extract genres
  const genres = (html.match(/<a[^>]*href="[^"]*genre\/[^"]*"[^>]*>([^<]*)<\/a>/g) || [])
    .map(g => g.replace(/<[^>]*>/g, "").trim());
  // Extract description
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1] || "";
  // Extract episodes — links are /video/{series-slug}/{episode-slug}[/]
  const epRe = new RegExp(`href="https://hentaihaven\\.com/video/${seriesSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^"/?#]+)/?"`, "g");
  const seen = new Set();
  const episodes = [];
  let em;
  while ((em = epRe.exec(html)) !== null) {
    const epSlug = em[1];
    if (seen.has(epSlug)) continue;
    seen.add(epSlug);
    const trailingNum = epSlug.match(/(\d+)$/);
    episodes.push({
      number: trailingNum ? Number(trailingNum[1]) : episodes.length + 1,
      slug: epSlug,
      link: `${HH_BASE}/video/${seriesSlug}/${epSlug}/`,
    });
  }
  return { slug: seriesSlug, title, cover, genres, description: desc, episodes };
}

export async function hhGetStream(seriesSlug, episodeSlug) {
  // 1. Fetch the episode page — accepts the episode slug ("the-movie-1").
  // A bare number is resolved through the series episode list.
  let epPath = String(episodeSlug);
  if (/^\d+$/.test(epPath)) {
    const series = await hhGetEpisodes(seriesSlug);
    const ep = series.episodes.find((e) => e.number === Number(epPath)) || series.episodes[0];
    if (!ep) throw new Error("No episodes found");
    epPath = ep.slug;
  }
  const episodeUrl = `${HH_BASE}/video/${seriesSlug}/${epPath}/`;
  const videoHtml = await curlFetch(episodeUrl, {
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9",
  });
  // 2. Extract the iframe data param
  const iframeMatch = videoHtml.match(/player\.php\?data=([^"&]+)/);
  if (!iframeMatch) throw new Error("Player iframe not found");
  const dataParam = iframeMatch[1];
  // 3. Fetch the player.php page
  const playerUrl = `${HH_BASE}/wp-content/plugins/player-logic/player.php?data=${dataParam}&lang=en`;
  const playerHtml = await curlFetch(playerUrl, {
    Accept: "text/html",
    Referer: episodeUrl,
  });
  // 4. Extract and decode the x-secure-token
  const tokenMatch = playerHtml.match(/x-secure-token" content="([^"]*)"/);
  if (!tokenMatch) throw new Error("x-secure-token not found");
  const config = hhDecodeToken(tokenMatch[1]);
  // 5. POST to api.php to get the HLS URL
  const apiBody = await curlPost(
    `${HH_BASE}/wp-content/plugins/player-logic/api.php`,
    `action=zarat_get_data_player_ajax&a=${encodeURIComponent(config.en)}&b=${encodeURIComponent(config.iv)}`,
    {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${HH_BASE}/`,
    }
  );
  const data = JSON.parse(apiBody);
  if (!data.status || !data.data?.sources?.length) throw new Error("No stream sources returned");
  return {
    sources: data.data.sources.map((s) => ({ src: s.src, type: s.type, label: s.label })),
    poster: config.image || null,
  };
}

// --- LeakGallery (leakgallery.com) — OnlyFans leaks, REST API, CORS-direct CDN ---
// API at api.leakgallery.com returns JSON. CDN at cdn.leakgallery.com serves
// MP4/images with Access-Control-Allow-Origin: * — browser plays directly, zero VPS bandwidth.
const LG_API = "https://api.leakgallery.com";
const LG_CDN = "https://cdn.leakgallery.com";

export async function lgSearch(q) {
  // If query looks like a creator name, search profiles; otherwise fetch popular media
  const headers = { Accept: "application/json", "User-Agent": UA };
  if (q && q !== "popular" && q !== "trending" && q !== "new") {
    const searchUrl = `${LG_API}/search?q=${encodeURIComponent(q)}`;
    const body = await curlFetch(searchUrl, headers);
    const profiles = JSON.parse(body);
    // Also search media by query — popular endpoint doesn't support text search,
    // so we fetch the creator's media if we get profile hits
    const results = profiles.slice(0, 20).map(p => ({
      id: p.username,
      slug: p.username,
      title: p.username,
      thumb: p.profile_pic || "",
      profile: true,
    }));
    return { videos: results };
  }
  // Default: fetch trending/popular media
  const period = q === "trending" ? "Last-Hour" : "Day";
  const body = await curlFetch(`${LG_API}/popular/media/${period}`, headers);
  const medias = JSON.parse(body);
  const results = medias.slice(0, 40).map(m => ({
    id: String(m.id),
    slug: String(m.id),
    title: m.caption_title || `${m.profile?.username || "Unknown"} video`,
    thumb: m.thumbnail_path ? `${LG_CDN}/${m.thumbnail_path}` : (m.profile?.profile_pic || ""),
    poster: m.thumbnail_path ? `${LG_CDN}/${m.thumbnail_path}` : "",
    is_video: m.is_video,
  }));
  return { videos: results };
}

export async function lgProfileMedia(username) {
  const body = await curlFetch(`${LG_API}/profile/${encodeURIComponent(username)}/media`, {
    Accept: "application/json", "User-Agent": UA,
  });
  const data = JSON.parse(body);
  const medias = data.medias || [];
  return medias.slice(0, 60).map(m => ({
    id: String(m.id),
    title: m.caption_title || `${username} video`,
    thumb: m.thumbnail_path ? `${LG_CDN}/${m.thumbnail_path}` : "",
    poster: m.thumbnail_path ? `${LG_CDN}/${m.thumbnail_path}` : "",
    is_video: m.is_video,
  }));
}

export async function lgGetStream(mediaId) {
  const body = await curlFetch(`${LG_API}/media/${encodeURIComponent(mediaId)}`, {
    Accept: "application/json", "User-Agent": UA,
  });
  const m = JSON.parse(body);
  if (!m.file_path) throw new Error("No file_path in media response");
  const mp4Url = `${LG_CDN}/${m.file_path}`;
  const poster = m.thumbnail_path ? `${LG_CDN}/${m.thumbnail_path}` : "";
  const title = m.caption_title || `${m.profile?.username || "Unknown"} video`;
  return { mp4Url, poster, title };
}

// --- ViralXXXPorn (viralxxxporn.com) — OnlyFans leaks, HTML scrape, CORS-direct CDN ---
// CDN at nude.viralxxxporn.com reflects Access-Control-Allow-Origin — browser plays directly.
const VXP_BASE = "https://viralxxxporn.com";

export async function vxpSearch(q) {
  if (!q || q === "new" || q === "popular" || q === "trending") {
    // Fetch latest videos from homepage
    const html = await curlFetch(`${VXP_BASE}/videos/`, { Accept: "text/html", "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
    return { videos: vxpExtractCards(html) };
  }
  const html = await curlFetch(`${VXP_BASE}/search/${encodeURIComponent(q)}/`, { Accept: "text/html", "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
  return { videos: vxpExtractCards(html) };
}

const vxpSlugs = new Map();

function vxpExtractCards(html) {
  // kernel-team platform: video cards have href="/video/{id}/{slug}/" with thumb images
  const cards = [...html.matchAll(/<a[^>]*href="(https:\/\/(?:www\.)?viralxxxporn\.com\/video\/\d+\/[^"]*\/)"[^>]*>[\s\S]*?<img[^>]*(?:data-src|src)="([^"]*)"[^>]*alt="([^"]*)"/g)];
  const seen = new Set();
  const results = [];
  for (const c of cards) {
    const url = c[1];
    const idMatch = url.match(/\/video\/(\d+)\//);
    const id = idMatch ? idMatch[1] : url;
    if (seen.has(id)) continue;
    seen.add(id);
    if (vxpSlugs.size > 5000) vxpSlugs.clear();
    vxpSlugs.set(id, url);
    results.push({
      id,
      slug: url.replace(/^https:\/\/(?:www\.)?viralxxxporn\.com\/video\//, "").replace(/\/$/, ""),
      title: c[3].replace(/&#039;/g, "'").replace(/&amp;/g, "&").trim(),
      thumb: c[2],
      poster: c[2],
    });
  }
  return results;
}

export async function vxpGetStream(id) {
  // Need the full video page URL — search for it if we only have an ID
  let videoUrl;
  if (/^\d+$/.test(id)) {
    // The bare id 404s; use the page URL remembered from search/browse cards.
    videoUrl = vxpSlugs.get(id);
    if (!videoUrl) { vxpExtractCards(await curlFetch(`${VXP_BASE}/videos/`, { Accept: "text/html", "User-Agent": UA })); videoUrl = vxpSlugs.get(id); }
    if (!videoUrl) throw new Error("Video page not found for id " + id);
  } else {
    videoUrl = `${VXP_BASE}/video/${id}/`;
  }
  const html = await curlFetch(videoUrl, { Accept: "text/html", "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
  // kernel-team: video_url and video_alt_url in a JS config object
  const urlMatch = html.match(/video_url:\s*['"]([^'"]+)['"]/);
  const altMatch = html.match(/video_alt_url:\s*['"]([^'"]+)['"]/);
  if (!urlMatch) throw new Error("No video_url found on page");
  const mp4Url = urlMatch[1].replace(/&amp;/g, "&");
  const altUrl = altMatch ? altMatch[1].replace(/&amp;/g, "&") : "";
  const posterMatch = html.match(/post_image:\s*['"]([^'"]+)['"]/);
  const poster = posterMatch ? posterMatch[1] : "";
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(/\s*-\s*Viral\s*XXX.*$/i, "").trim() : "";
  return { mp4Url, altUrl, poster, title };
}

// --- x-video.tube — OnlyFans leaks, kernel-team platform, CORS-direct CDN ---
// Same platform as ViralXXXPorn. CDN at storage5.x-video.tube has full CORS headers.
const XVT_BASE = "https://x-video.tube";

export async function xvtSearch(q) {
  if (!q || q === "new" || q === "popular" || q === "trending") {
    const html = await curlFetch(`${XVT_BASE}/videos/`, { Accept: "text/html", "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
    return { videos: xvtExtractCards(html) };
  }
  const html = await curlFetch(`${XVT_BASE}/search/${encodeURIComponent(q)}/`, { Accept: "text/html", "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
  return { videos: xvtExtractCards(html) };
}

// Video pages live at /video/<id>/<slug>/ — the bare id 404s. Remember each
// card's slug so a search result (not on the front page) can still be opened.
const xvtSlugs = new Map();

function xvtExtractCards(html) {
  const cards = [...html.matchAll(/<a[^>]*href="(https:\/\/x-video\.tube\/video\/\d+\/[^"]*\/)"[^>]*>[\s\S]*?<img[^>]*(?:data-src|src)="([^"]*)"[^>]*alt="([^"]*)"/g)];
  const seen = new Set();
  const results = [];
  for (const c of cards) {
    const url = c[1];
    const idMatch = url.match(/\/video\/(\d+)\//);
    const id = idMatch ? idMatch[1] : url;
    if (seen.has(id)) continue;
    seen.add(id);
    if (xvtSlugs.size > 5000) xvtSlugs.clear();
    xvtSlugs.set(id, url);
    results.push({
      id,
      slug: url.replace(/^https:\/\/x-video\.tube\/video\//, "").replace(/\/$/, ""),
      title: c[3].replace(/&#039;/g, "'").replace(/&amp;/g, "&").trim(),
      thumb: c[2],
      poster: c[2],
    });
  }
  return results;
}

export async function xvtGetStream(id) {
  let videoUrl;
  if (/^\d+$/.test(id)) {
    videoUrl = xvtSlugs.get(id);
    if (!videoUrl) { xvtExtractCards(await curlFetch(`${XVT_BASE}/videos/`, { Accept: "text/html", "User-Agent": UA })); videoUrl = xvtSlugs.get(id); }
    if (!videoUrl) throw new Error("Video page not found for id " + id);
  } else {
    videoUrl = `${XVT_BASE}/video/${id}/`;
  }
  const html = await curlFetch(videoUrl, { Accept: "text/html", "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
  const urlMatch = html.match(/video_url:\s*['"]([^'"]+)['"]/);
  if (!urlMatch) throw new Error("No video_url found on page");
  const mp4Url = urlMatch[1].replace(/&amp;/g, "&");
  const posterMatch = html.match(/post_image:\s*['"]([^'"]+)['"]/);
  const poster = posterMatch ? posterMatch[1] : "";
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(/\s*-\s*X-?Video.*$/i, "").trim() : "";
  return { mp4Url, poster, title };
}

// --- XNXX (xnxx.com) — large tube, native multi-quality MP4 ---
// Search results are server-rendered thumb-blocks; the video page calls
// setVideoUrl/UrlHigh/... with CDN URLs. The CDN 403s unless the request
// carries the video page's cookies + referer, so bytes stream through
// /xnxx-media with a server-side cookie jar (per video id, ~1h TTL).
const XNXX_BASE = "https://www.xnxx.com";
const XNXX_MEDIA_HOST = /(^|\.)(xnxx\.com|xnxx-cdn\.com|xnxx-cdn\.xyz)$/i;
export const xnxxJars = new Map(); // video id → { cookie, referer, at }

function xnxxThumb(u) { return u ? `/proxy?url=${encodeURIComponent(u)}` : ""; }

export async function xnxxSearch(q) {
  // The homepage is JS-rendered (no server-side cards), so both default
  // terms fall back to /hits — the server-rendered most-viewed listing.
  const path = !q || q === "new" || q === "popular" ? "/hits" : `/search/${encodeURIComponent(q)}`;
  // dnsFetch (DoH) — xnxx.com is DNS-poisoned on some ISPs, curl's plain DNS fails.
  const r = await dnsFetch(`${XNXX_BASE}${path}`, {
    headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!r.ok) throw new Error(`XNXX HTTP ${r.status}`);
  const html = await r.text();
  const videos = [];
  // Two server-rendered card formats:
  //  - search: <div id="video_{eid}" ... class="thumb-block ..."> with <p class="metadata">
  //  - listing (home/hits): <div id="video-thumb-{eid}" data-video='{json}'> with
  //    <a class="title" title="..."> and a .metadata block; data-video carries a
  //    preview.mp4 used for hover previews.
  for (const chunk of html.split('<div id="video_').slice(1)) {
    const href = chunk.match(/href="(\/video-[0-9a-z]+\/[^"]*)"/)?.[1];
    if (!href) continue;
    const id = href.replace(/^\/video-/, "").replace(/\/$/, "");
    const thumb = chunk.match(/data-src="(https:\/\/[^"]+)"/)?.[1] || "";
    const title = chunk.match(/<a[^>]*href="\/video-[^"]*"[^>]*>([^<]{4,160})<\/a>/)?.[1]?.trim();
    const meta = chunk.match(/<p class="metadata">([\s\S]*?)<\/p>/)?.[1]?.replace(/<[^>]+>/g, " ");
    const duration = meta?.match(/\b(\d{1,3}:\d{2}(?::\d{2})?)\b/)?.[1] || (meta?.match(/\b(\d+)\s*min\b/) ? `${meta.match(/\b(\d+)\s*min\b/)[1]} min` : "");
    const quality = meta?.match(/\b(\d{3,4}p)\b/)?.[1] || "";
    videos.push({ id, title: xnxxDecode(title || id), thumb: xnxxThumb(thumb), poster: xnxxThumb(thumb), duration, quality });
    if (videos.length >= 40) break;
  }
  if (!videos.length) {
    for (const chunk of html.split(/id="video-thumb-/).slice(1)) {
      const id = chunk.match(/^([0-9a-z]+)"/)?.[1];
      const href = chunk.match(/<a class="thumb-link" href="(\/video-[0-9a-z]+\/[^"]*)"/)?.[1];
      if (!id || !href) continue;
      let data = {};
      try { data = JSON.parse(chunk.match(/data-video='([^']+)'/)?.[1] || "{}"); } catch { /* partial card */ }
      const title = chunk.match(/<a class="title"[^>]*title="([^"]*)"/)?.[1] || id;
      const meta = chunk.match(/<div class="metadata">([\s\S]*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, " ") || "";
      const duration = meta.match(/\b(\d{1,3}:\d{2}(?::\d{2})?|\d+\s*min)\b/)?.[1]?.replace(/\s+min$/, " min") || "";
      const quality = meta.match(/\b(\d{3,4}p)\b/)?.[1] || "";
      videos.push({
        id: href.replace(/^\/video-/, "").replace(/\/$/, ""),
        title: xnxxDecode(title),
        thumb: xnxxThumb(data.mozaiqueListing || data.sfwThumbUrl || ""),
        poster: xnxxThumb(data.sfwThumbUrl || data.mozaiqueListing || ""),
        preview: data.previewVideo ? xnxxThumb(data.previewVideo) : "",
        duration,
        quality,
      });
      if (videos.length >= 40) break;
    }
  }
  return { videos };
}

function xnxxDecode(s) {
  return String(s).replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

async function xnxxFetchPage(id) {
  const pageUrl = `${XNXX_BASE}/video-${id}`;
  const r = await dnsFetch(pageUrl, {
    headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!r.ok) throw new Error(`Video page HTTP ${r.status}`);
  const html = await r.text();
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  if (xnxxJars.size > 2000) xnxxJars.clear();
  xnxxJars.set(id, { cookie, referer: pageUrl, at: Date.now() });
  return html;
}

export async function xnxxGetStream(id) {
  const html = await xnxxFetchPage(id);
  // Player calls: setVideoUrl(360p), setVideoUrlHigh, setVideoHqv, setVideoUrlLow, setVideoHls
  const formats = {};
  for (const m of html.matchAll(/setVideo(UrlLow|UrlHigh|Hqv|Url|Hls)\(['"]([^'"]+)['"]\)/g)) formats[m[1]] = m[2];
  const ld = html.match(/"contentUrl"\s*:\s*"([^"]+)"/)?.[1] || "";
  const mp4 = formats.UrlHigh || formats.Hqv || formats.Url || (ld.includes(".mp4") ? ld : "") || formats.UrlLow;
  if (!mp4) throw new Error("No MP4 source found on page");
  const poster = html.match(/setThumbUrl169?\(['"]([^'"]+)['"]\)/)?.[1] || html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || "";
  const title = html.match(/setVideoTitle\(['"]([^'"]+)['"]\)/)?.[1] || html.match(/<title>([^<]*?)\s*[-–]\s*XNXX/i)?.[1] || id;
  return {
    mp4Url: `/xnxx-media?id=${encodeURIComponent(id)}&url=${encodeURIComponent(mp4)}`,
    qualities: [formats.UrlHigh, formats.Hqv, formats.Url, ld, formats.UrlLow].filter(Boolean),
    poster: xnxxThumb(poster),
    title,
  };
}

export async function xnxxRefreshJar(id) {
  const hit = xnxxJars.get(id);
  if (hit && Date.now() - hit.at < 3600e3) return hit;
  try { await xnxxFetchPage(id); } catch { /* fall through with stale jar */ }
  return xnxxJars.get(id) || null;
}

// --- XBooru (xbooru.com) — gelbooru-style board with an open JSON API ---
// dapi returns posts directly (file_url is a playable mp4/webm, no CORS),
// so both search and playback go through /xbooru-media with Range support.
const XBOORU_API = "https://xbooru.com/index.php";

function xbooruWrap(u) { return u ? `/xbooru-media?url=${encodeURIComponent(u)}` : ""; }

function xbooruTitle(p) {
  const tags = String(p.tags || "").split(/\s+/).filter(Boolean);
  return tags.slice(0, 6).join(" ") || `post ${p.id}`;
}

export async function xbooruSearch(q) {
  const tags = !q || q === "new" ? "video sort:updated:desc" : q === "popular" ? "video sort:score:desc" : `video ${q}`;
  const r = await dnsFetch(`${XBOORU_API}?page=dapi&s=post&q=index&json=1&limit=40&tags=${encodeURIComponent(tags)}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`XBooru API HTTP ${r.status}`);
  const text = (await r.text()).trim();
  // dapi answers a tag that doesn't exist with 200 + empty body — that's an
  // empty result set, not an error.
  if (!text) return { videos: [] };
  const posts = JSON.parse(text);
  if (!Array.isArray(posts)) return { videos: [] };
  return {
    videos: posts.map((p) => ({
      id: String(p.id),
      title: xbooruTitle(p),
      thumb: xbooruWrap(p.preview_url || p.sample_url || p.file_url),
      poster: xbooruWrap(p.sample_url || p.preview_url || p.file_url),
    })),
  };
}

export async function xbooruGetStream(id) {
  const r = await dnsFetch(`${XBOORU_API}?page=dapi&s=post&q=index&json=1&id=${encodeURIComponent(id)}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`XBooru API HTTP ${r.status}`);
  const text = (await r.text()).trim();
  const posts = text ? JSON.parse(text) : null;
  const p = Array.isArray(posts) ? posts[0] : null;
  if (!p?.file_url) throw new Error("Post not found");
  // Single-post responses sometimes omit preview/sample URLs — a video file
  // makes a broken <img> poster, so only accept image-looking URLs.
  const poster = [p.sample_url, p.preview_url].find((u) => /\.(jpe?g|png|gif|webp)$/i.test(u || "")) || "";
  return {
    mp4Url: xbooruWrap(p.file_url),
    poster: xbooruWrap(poster),
    title: xbooruTitle(p),
  };
}

// --- Coomer.st — OnlyFans/Fansly archive, REST API, VPS-proxied CDN ---
// API works locally with Accept: text/css header. CDN (n1-n4.coomer.st) is unreachable
// locally but works from VPS. Media is proxied through /coomer-media?url=...
const COOMER_BASE = "https://coomer.st";
const COOMER_API = "https://coomer.st/api/v1";

export async function coomerSearch(q) {
  if (!q || q === "popular" || q === "trending" || q === "new") {
    // Fetch global posts feed
    const body = await curlFetch(`${COOMER_API}/posts?o=0`, {
      Accept: "text/css",
      "User-Agent": UA,
    });
    const data = JSON.parse(body);
    const posts = data.posts || data;
    const results = (Array.isArray(posts) ? posts : []).slice(0, 40).map(p => ({
      id: `${p.service}/${p.user}/${p.id}`,
      slug: String(p.id),
      title: p.title || p.substring?.substring(0, 60) || `${p.user} post`,
      thumb: p.attachments?.[0]?.path ? coomerMediaUrl(p.attachments[0].path) : (p.file?.path ? coomerMediaUrl(p.file.path) : ""),
      poster: p.attachments?.[0]?.path ? coomerMediaUrl(p.attachments[0].path) : "",
      user: p.user,
      service: p.service,
      is_video: !!(p.file?.path && p.file.path.endsWith(".mp4")) || p.attachments?.some(a => a.path?.endsWith(".mp4")),
    }));
    return { videos: results };
  }
  // Search creators
  const body = await curlFetch(`${COOMER_API}/creators?o=0`, {
    Accept: "text/css",
    "User-Agent": UA,
  });
  const creators = JSON.parse(body);
  const creatorList = Array.isArray(creators) ? creators : (creators.creators || []);
  const filtered = creatorList.filter(c => c.name?.toLowerCase().includes(q.toLowerCase())).slice(0, 20);
  const results = filtered.map(c => ({
    id: c.user_id || c.id,
    slug: c.user_id || c.id,
    title: c.name,
    thumb: "",
    profile: true,
    service: c.service,
  }));
  return { videos: results };
}

function coomerMediaUrl(path) {
  if (!path) return "";
  // Coomer file paths are like /data/xx/yy/hash.ext or /thumbnails/data/...
  // The CDN (n1-n4.coomer.st, Moldova) blocks datacenter IPs, so we proxy
  // through a Cloudflare Worker which has a better chance of reaching it.
  const COOMER_PROXY = "https://coomer-proxy.harshkandoo.workers.dev/media?url=";
  if (path.startsWith("http")) return `${COOMER_PROXY}${encodeURIComponent(path)}`;
  return `${COOMER_PROXY}${encodeURIComponent(`${COOMER_BASE}${path}`)}`;
}

export async function coomerProfilePosts(service, userId) {
  const body = await curlFetch(`${COOMER_API}/${service}/user/${userId}/posts?o=0`, {
    Accept: "text/css",
    "User-Agent": UA,
  });
  const data = JSON.parse(body);
  const posts = data.posts || data;
  return (Array.isArray(posts) ? posts : []).slice(0, 60).map(p => ({
    id: `${service}/${userId}/${p.id}`,
    title: p.title || p.substring?.substring(0, 60) || `${p.user || userId} post`,
    thumb: p.attachments?.[0]?.path ? coomerMediaUrl(p.attachments[0].path) : "",
    poster: p.attachments?.[0]?.path ? coomerMediaUrl(p.attachments[0].path) : "",
    is_video: !!(p.file?.path && p.file.path.endsWith(".mp4")) || p.attachments?.some(a => a.path?.endsWith(".mp4")),
    user: p.user,
    service: p.service,
  }));
}

export async function coomerGetStream(service, userId, postId) {
  const body = await curlFetch(`${COOMER_API}/${service}/user/${userId}/post/${postId}`, {
    Accept: "text/css",
    "User-Agent": UA,
  });
  const post = JSON.parse(body);
  // Find the first MP4 attachment
  const mp4Attachment = post.attachments?.find(a => a.path?.endsWith(".mp4")) || (post.file?.path?.endsWith(".mp4") ? post.file : null);
  if (!mp4Attachment) throw new Error("No video found in post");
  const mp4Url = coomerMediaUrl(mp4Attachment.path);
  const poster = post.attachments?.find(a => !a.path?.endsWith(".mp4"))?.path ? coomerMediaUrl(post.attachments.find(a => !a.path?.endsWith(".mp4")).path) : "";
  const title = post.title || `${post.user || "Unknown"} post`;
  return { mp4Url, poster, title };
}

// --- RedGIFs (redgifs.com) — creator-style clips, REST API, CORS-direct CDN ---
// API uses a temporary JWT token. CDN at media.redgifs.com reflects Origin header.
const RG_API = "https://api.redgifs.com";

let rgTokenCache = { token: null, expires: 0 };

async function rgGetToken() {
  if (rgTokenCache.token && Date.now() < rgTokenCache.expires) return rgTokenCache.token;
  const body = await curlFetchDoH(`${RG_API}/v2/auth/temporary`, {
    Accept: "application/json",
    "User-Agent": UA,
  });
  const data = JSON.parse(body);
  rgTokenCache = { token: data.token, expires: Date.now() + 3600 * 1000 }; // 1h cache
  return data.token;
}

export async function rgSearch(q) {
  const token = await rgGetToken();
  if (!q || q === "popular" || q === "trending" || q === "new") {
    const body = await curlFetchDoH(`${RG_API}/v2/gifs/search?search_text=amateur&count=30`, {
      Accept: "application/json",
      "User-Agent": UA,
      Authorization: `Bearer ${token}`,
    });
    return { videos: rgParseResults(JSON.parse(body)) };
  }
  const body = await curlFetchDoH(`${RG_API}/v2/gifs/search?search_text=${encodeURIComponent(q)}&count=30`, {
    Accept: "application/json",
    "User-Agent": UA,
    Authorization: `Bearer ${token}`,
  });
  return { videos: rgParseResults(JSON.parse(body)) };
}

// media.redgifs.com is DNS-blocked by some ISPs — route media through the
// local /rg-media proxy (dnsFetchStream resolves via DoH). Everything else
// (api.redgifs.com) stays server-side already.
function rgMediaUrl(u) {
  if (!u) return "";
  try {
    if (/(^|\.)redgifs\.com$/i.test(new URL(u).hostname)) {
      return `/rg-media?url=${encodeURIComponent(u)}`;
    }
  } catch {}
  return u;
}

function rgParseResults(data) {
  const gifs = data.gifs || [];
  return gifs.map(g => ({
    id: g.id,
    slug: g.id,
    title: g.title || g.userName || g.id,
    thumb: rgMediaUrl(g.urls?.thumbnail || g.urls?.sd || ""),
    poster: rgMediaUrl(g.urls?.thumbnail || g.urls?.sd || ""),
    preview: rgMediaUrl(g.urls?.sd || g.urls?.hd || ""),
    mp4Url: rgMediaUrl(g.urls?.hd || g.urls?.sd || ""),
  }));
}

export async function rgGetStream(id) {
  const token = await rgGetToken();
  const body = await curlFetchDoH(`${RG_API}/v2/gifs/${encodeURIComponent(id)}`, {
    Accept: "application/json",
    "User-Agent": UA,
    Authorization: `Bearer ${token}`,
  });
  const g = JSON.parse(body).gif;
  if (!g) throw new Error("GIF not found");
  const mp4Url = g.urls?.hd || g.urls?.sd || "";
  if (!mp4Url) throw new Error("No MP4 URL found");
  const poster = g.urls?.thumbnail || g.urls?.sd || "";
  const title = g.title || g.userName || id;
  return { mp4Url: rgMediaUrl(mp4Url), poster: rgMediaUrl(poster), title };
}


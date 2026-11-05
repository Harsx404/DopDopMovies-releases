// HiAnime + ZokoAnime — DopDop Anime Source Pack Module.
// Title-keyed & MAL-keyed anime streaming with multi-quality HLS and subtitles.
//
// Follows the source-pack contract: setup(runtime, config), resolve(req, ctx).
// Endpoints:
//   Search:   https://hianime.at/search?keyword=...
//   Episodes: https://hianime.at/api/theme/episode/list/{numericId}
//   Servers:  https://hianime.at/api/theme/episode/servers?episodeId={epId}
//   Embed:    https://zokoanime.video/stream/mal/{malId}/{ep}/{mode}
//   Stream:   master.m3u8 (1080p, 720p, 360p) + .vtt subtitles

import { subtitleLabel, subtitleLanguage } from "./zokoanime.mjs";

let UA, dnsFetch, tmdbAbsoluteEpisode, tmdbSeasonName, BASE_URL, EMBED_URL;

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const XOR_KEY = Buffer.from("otaku-embed-v1");
// The player reaches streams through the backend, which adds the Referer they need.
const proxied = (url, referer) => `/api/hls?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`;

export function setup(rt, config = {}) {
  UA = rt.UA || DEFAULT_UA;
  dnsFetch = rt.dnsFetch || rt.smartFetch || rt.fetch || fetch;
  tmdbAbsoluteEpisode = rt.tmdbAbsoluteEpisode || (async () => null);
  tmdbSeasonName = rt.tmdbSeasonName || (async () => null);

  BASE_URL = (config.base || "https://hianime.at").replace(/\/+$/, "");
  EMBED_URL = (config.embed || "https://zokoanime.video").replace(/\/+$/, "");
}

/** Word-overlap scoring for anime title matching */
function titleNorm(s) {
  return String(s || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleScore(query, candidate) {
  const qw = new Set(titleNorm(query).split(" ").filter(Boolean));
  const cw = new Set(titleNorm(candidate).split(" ").filter(Boolean));
  if (!qw.size || !cw.size) return 0;
  let hit = 0;
  for (const w of qw) if (cw.has(w)) hit++;
  return hit / qw.size + (hit / cw.size) * 0.01;
}

/** Deobfuscate window.__P base64 XOR blob from ZokoAnime embed */
function deobfuscateBlob(b64) {
  try {
    const buf = Buffer.from(b64, "base64");
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
      out[i] = buf[i] ^ XOR_KEY[i % XOR_KEY.length];
    }
    return JSON.parse(out.toString("utf8"));
  } catch {
    return null;
  }
}

/** Search anime by title on hianime.at */
async function searchAnime(query) {
  const q = encodeURIComponent(String(query || "").trim());
  const url = `${BASE_URL}/search?keyword=${q}`;
  const res = await dnsFetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: `${BASE_URL}/`,
    },
  });
  if (!res.ok) throw new Error(`HiAnime search failed: HTTP ${res.status}`);
  const html = await res.text();

  // Parse results from main film list (excluding sidebar)
  const mainHtml = html.split('id="main-sidebar"')[0] || html;
  const filmRe = /<h3 class="film-name">\s*<a href="[^"]*\/([^"/]*)"\s*title="([^"]*)"/g;
  const results = [];
  let m;
  while ((m = filmRe.exec(mainHtml)) !== null) {
    const slug = m[1];
    const title = m[2]
      .replace(/&#039;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .trim();

    // Extract numeric ID from end of slug (e.g. "we-never-learn-bokuben-516" -> "516")
    const idMatch = slug.match(/-(\d+)$/);
    const numericId = idMatch ? idMatch[1] : null;

    if (numericId) {
      results.push({ slug, numericId, title });
    }
  }

  return results;
}

/** Search best matching entry with season variants */
async function findBestShow(title, season, seasonName) {
  const n = Number(season) || 1;
  const probes = [];

  if (n > 1) {
    const ord = { 2: "2nd", 3: "3rd", 4: "4th" }[n] || `${n}th`;
    if (seasonName) probes.push(`${title} ${seasonName}`, seasonName);
    probes.push(`${title} Season ${n}`, `${title} ${ord} Season`, `${title} ${n}`);
  }
  probes.push(title);

  for (const q of probes) {
    const hits = await searchAnime(q).catch(() => []);
    if (!hits.length) continue;

    let best = null;
    for (const h of hits) {
      const score = titleScore(q, h.title);
      if (!best || score > best.score) best = { ...h, score };
    }

    if (best && best.score >= 0.7) {
      return { ...best, wholeShow: n > 1 && q === title };
    }
  }

  // Nothing close enough: a different show must never play in its place.
  return null;
}

/** Get episode list for a show numeric ID */
async function getEpisodes(numericId, watchSlug) {
  const url = `${BASE_URL}/api/theme/episode/list/${numericId}`;
  const res = await dnsFetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BASE_URL}/watch/${watchSlug || numericId}`,
    },
  });
  if (!res.ok) throw new Error(`HiAnime episodes failed: HTTP ${res.status}`);
  const data = JSON.parse(await res.text());
  const html = data.html || "";

  const epRe = /data-number="([^"]*)"[^>]*data-id="([0-9]+)"/g;
  const episodes = [];
  let m;
  while ((m = epRe.exec(html)) !== null) {
    const num = parseFloat(m[1]);
    const id = m[2];
    episodes.push({ num: isNaN(num) ? m[1] : num, id });
  }

  return episodes;
}

/** Get stream embed URLs from servers endpoint */
async function getServers(episodeId, watchSlug) {
  const url = `${BASE_URL}/api/theme/episode/servers?episodeId=${episodeId}`;
  const res = await dnsFetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BASE_URL}/watch/${watchSlug || episodeId}`,
    },
  });
  if (!res.ok) throw new Error(`HiAnime servers failed: HTTP ${res.status}`);
  const data = JSON.parse(await res.text());
  const html = data.html || "";

  // Parse server items with data-type, data-server-name, and base64 data-hash
  const itemRe = /<div class="item server-item"[^>]*data-type="([^"]*)"[^>]*data-server-name="([^"]*)"[^>]*data-hash="([^"]*)"/g;
  const servers = [];
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const type = m[1].toLowerCase(); // "sub" or "dub"
    const name = m[2];
    const hash = m[3];
    let embedUrl = "";
    try {
      embedUrl = Buffer.from(hash, "base64").toString("utf8");
    } catch {}

    if (embedUrl.startsWith("http")) {
      servers.push({ type, name, embedUrl });
    }
  }

  return servers;
}

/** Extract master playlist and subtitles from ZokoAnime embed */
async function extractFromEmbed(embedUrl) {
  const res = await dnsFetch(embedUrl, {
    headers: {
      "User-Agent": UA,
      Referer: `${BASE_URL}/`,
    },
  });
  if (!res.ok) throw new Error(`ZokoAnime embed failed: HTTP ${res.status}`);
  const html = await res.text();

  const pMatch = html.match(/window\.__P="([^"]*)"/);
  if (!pMatch) throw new Error("ZokoAnime embed: window.__P not found");

  const config = deobfuscateBlob(pMatch[1]);
  if (!config || !config.src) throw new Error("ZokoAnime embed: failed to decode stream configuration");

  const masterM3u8 = config.src;
  const subtitles = (config.subtitles || []).map((s) => ({
    label: subtitleLabel(s),
    lang: subtitleLanguage(s),
    url: s.src,
  }));

  return { masterM3u8, subtitles };
}

/** Enumerate quality renditions from master m3u8 playlist */
async function parseRenditions(masterM3u8, embedUrl, serverName, mode) {
  const qualities = [];
  const suffix = mode === "dub" ? " · Dub" : "";

  // Base auto rendition
  qualities.push({
    quality: `auto${suffix}`,
    url: proxied(masterM3u8, embedUrl),
    type: "hls",
    lang: mode,
  });

  try {
    const res = await dnsFetch(masterM3u8, {
      headers: {
        "User-Agent": UA,
        Referer: embedUrl,
      },
    });
    if (res.ok) {
      const text = await res.text();
      const lines = text.split("\n");
      const baseDir = masterM3u8.substring(0, masterM3u8.lastIndexOf("/") + 1);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("#EXT-X-STREAM-INF")) {
          const resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
          const next = lines[i + 1]?.trim();
          if (resMatch && next && !next.startsWith("#")) {
            const variantUrl = next.startsWith("http") ? next : `${baseDir}${next}`;
            qualities.push({
              quality: `${resMatch[1]}p${suffix}`,
              url: proxied(variantUrl, embedUrl),
              type: "hls",
              lang: mode,
            });
          }
        }
      }
    }
  } catch {}

  return qualities;
}

/** Main DopDop Source Pack resolve implementation */
export async function resolve(req, ctx = {}) {
  const title = req.cartoonTitle || req.title || req.q;
  if (!title && !req.malId) {
    throw new Error("HiAnime: title or malId required");
  }

  const type = req.type || "tv";
  const season = Number(req.season) || 1;
  const reqEp = parseInt(req.animeEp) || Number(req.episode) || 1;
  const mode = /dub/i.test(req.animeLang || "") ? "dub" : "sub";

  let masterM3u8 = null;
  let subtitles = [];
  let serverName = "ZokoAnime";
  let activeEmbedUrl = "";
  let playing = mode;

  // 1. Direct MAL ID fast-path if provided
  if (req.malId) {
    activeEmbedUrl = `${EMBED_URL}/stream/mal/${req.malId}/${reqEp}/${mode}`;
    try {
      const extracted = await extractFromEmbed(activeEmbedUrl);
      masterM3u8 = extracted.masterM3u8;
      subtitles = extracted.subtitles;
    } catch {}
  }

  // 2. Title search and episode resolution
  if (!masterM3u8) {
    const seasonName =
      type === "tv" && season > 1
        ? await tmdbSeasonName(req.id || req.tmdbId, season).catch(() => null)
        : null;

    const show = await findBestShow(title, season, seasonName);
    if (!show) {
      throw new Error(`HiAnime: no anime found matching "${title}"`);
    }

    const episodes = await getEpisodes(show.numericId, show.slug);
    if (!episodes.length) {
      throw new Error(`HiAnime: no episodes found for ${show.title}`);
    }

    // A show listed as one long run numbers later seasons on from the first.
    let targetEp = show.wholeShow ? null : episodes.find((e) => e.num === reqEp);
    if (!targetEp && season > 1 && type === "tv") {
      const abs = await tmdbAbsoluteEpisode(req.id || req.tmdbId, season, reqEp).catch(() => null);
      if (abs) targetEp = episodes.find((e) => e.num === abs);
    }
    if (!targetEp) {
      throw new Error(`HiAnime: no S${season} E${reqEp} of ${show.title}`);
    }

    const servers = await getServers(targetEp.id, show.slug);
    if (!servers.length) {
      throw new Error(`HiAnime: no servers available for episode ${reqEp}`);
    }

    // The mode asked for, else whatever exists, labelled as what it really is.
    const candidate =
      servers.find((s) => s.type === mode && /zoko/i.test(s.name)) ||
      servers.find((s) => s.type === mode) ||
      servers[0];

    serverName = candidate.name || "ZokoAnime";
    playing = candidate.type === "dub" ? "dub" : "sub";
    activeEmbedUrl = candidate.embedUrl;

    const extracted = await extractFromEmbed(activeEmbedUrl);
    masterM3u8 = extracted.masterM3u8;
    subtitles = extracted.subtitles;
  }

  if (!masterM3u8) {
    throw new Error(`HiAnime: no playable stream extracted for ${title} EP ${reqEp}`);
  }

  const qualities = await parseRenditions(masterM3u8, activeEmbedUrl, serverName, playing);

  return {
    cdn: "hls.dramahot.top",
    verified: true,
    qualities,
    subtitles: subtitles.map((s) => ({ ...s, url: proxied(s.url, activeEmbedUrl) })),
  };
}


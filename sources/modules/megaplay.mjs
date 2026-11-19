// MegaPlay — DopDop Anime Source Pack Module.
//
// ID-keyed anime: TMDB title + year → AniList entry → MegaPlay stream page.
// Matching on AniList IDs (not site search) is what lets it find older and
// less popular shows that title-search sources miss.
//
// Flow:
//   AniList GraphQL  → anime id (+ MAL id), walking SEQUEL links for season N
//   {base}/stream/ani/{id}/{ep}/{sub|dub}  (falls back to /stream/mal/…)
//     → data-id file id
//   {base}/stream/getSources?id={fileId}  → { enc, tracks }
//   {decrypt} POST { text: enc }          → { result: { file: master.m3u8 } }
//   master.m3u8 needs Referer = {base}/ — served through /api/hls.
//
// Hosts live in index.json config: base, anilist, decrypt.

import { subtitleLabel, subtitleLanguage } from "./zokoanime.mjs";

let UA, dnsFetch, tmdbAbsoluteEpisode, BASE, ANILIST, DECRYPT;

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const proxied = (url, referer) => `/api/hls?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`;

export function setup(rt, config = {}) {
  UA = rt.UA || DEFAULT_UA;
  dnsFetch = rt.dnsFetch || rt.smartFetch || rt.fetch || fetch;
  tmdbAbsoluteEpisode = rt.tmdbAbsoluteEpisode || (async () => null);
  BASE = (config.base || "https://megaplay.buzz").replace(/\/+$/, "");
  ANILIST = config.anilist || "https://graphql.anilist.co";
  DECRYPT = config.decrypt || "https://enc-dec.app/api/dec-megaplay";
}

const timeout = (ms) => AbortSignal.timeout(ms);

// ---------------------------------------------------------------- AniList

const MEDIA_FIELDS = "id idMal format episodes seasonYear startDate { year } title { romaji english native } synonyms";

async function anilist(query, variables) {
  const r = await dnsFetch(ANILIST, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({ query, variables }),
    signal: timeout(15000),
  });
  if (!r.ok) throw new Error(`MegaPlay: AniList HTTP ${r.status}`);
  const j = JSON.parse(await r.text());
  if (j.errors?.length) throw new Error(`MegaPlay: AniList ${j.errors[0].message}`);
  return j.data;
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function nameScore(query, media) {
  const q = new Set(norm(query).split(" ").filter(Boolean));
  if (!q.size) return 0;
  const names = [media.title?.english, media.title?.romaji, ...(media.synonyms || [])].filter(Boolean);
  let best = 0;
  for (const n of names) {
    const w = new Set(norm(n).split(" ").filter(Boolean));
    if (!w.size) continue;
    let hit = 0;
    for (const x of q) if (w.has(x)) hit++;
    best = Math.max(best, hit / q.size + (hit / w.size) * 0.25);
  }
  return best;
}

const SERIES = new Set(["TV", "TV_SHORT", "ONA"]);

/** Pick the AniList entry for this TMDB title: name match, right format, closest year. */
async function findMedia(title, { type, year }) {
  const data = await anilist(
    `query($s:String){Page(perPage:15){media(search:$s,type:ANIME,sort:SEARCH_MATCH){${MEDIA_FIELDS}}}}`,
    { s: title },
  );
  const list = data?.Page?.media || [];
  let best = null;
  for (const m of list) {
    let score = nameScore(title, m);
    const isSeries = SERIES.has(m.format);
    if (type === "movie") score += m.format === "MOVIE" ? 0.4 : -0.4;
    else score += isSeries ? 0.4 : m.format === "MOVIE" ? -0.6 : -0.2;
    const y = m.seasonYear || m.startDate?.year;
    if (year && y) score += y === year ? 0.5 : Math.abs(y - year) <= 1 ? 0.2 : -0.3;
    if (!best || score > best.score) best = { m, score };
  }
  // A different show must never play in its place.
  return best && best.score >= 1 ? best.m : null;
}

/** Season N = follow the main-line SEQUEL chain from the first season. */
async function sequelOf(media, steps) {
  let cur = media;
  for (let i = 0; i < steps && cur; i++) {
    const data = await anilist(
      `query($id:Int){Media(id:$id){relations{edges{relationType node{${MEDIA_FIELDS} type}}}}}`,
      { id: cur.id },
    );
    const edges = data?.Media?.relations?.edges || [];
    cur = edges
      .filter((e) => e.relationType === "SEQUEL" && e.node.type === "ANIME" && SERIES.has(e.node.format))
      .map((e) => e.node)
      .sort((a, b) => (a.seasonYear || 9999) - (b.seasonYear || 9999))[0] || null;
  }
  return cur;
}

// ---------------------------------------------------------------- MegaPlay

function fileIdFrom(html) {
  return (
    html.match(/<title\b[^>]*>\s*File\s+(\d+)\s*-\s*MegaPlay/i)?.[1] ||
    html.match(/<div\b(?=[^>]*\sid=["']megaplay-player["'])(?=[^>]*\sdata-id=["'](\d+)["'])/i)?.[1] ||
    html.match(/\sdata-id=["'](\d+)["']/i)?.[1] ||
    null
  );
}

/** Stream page for one episode; AniList path first, MAL path as backup. */
async function findFile(media, ep, mode) {
  const pages = [`${BASE}/stream/ani/${media.id}/${ep}/${mode}`];
  if (media.idMal) pages.push(`${BASE}/stream/mal/${media.idMal}/${ep}/${mode}`);
  for (const page of pages) {
    const r = await dnsFetch(page, { headers: { "User-Agent": UA, Referer: `${BASE}/` }, signal: timeout(15000) }).catch(() => null);
    if (!r?.ok) continue;
    const id = fileIdFrom(await r.text());
    if (id) return { id, page };
  }
  return null;
}

async function sourcesFor(file) {
  const r = await dnsFetch(`${BASE}/stream/getSources?id=${file.id}&platform=OTHER`, {
    headers: { "User-Agent": UA, Referer: file.page, "X-Requested-With": "XMLHttpRequest" },
    signal: timeout(15000),
  });
  if (!r.ok) throw new Error(`MegaPlay: sources HTTP ${r.status}`);
  const data = JSON.parse(await r.text());
  if (!data?.enc) throw new Error("MegaPlay: no stream in response");

  const d = await dnsFetch(DECRYPT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({ text: data.enc }),
    signal: timeout(15000),
  });
  if (!d.ok) throw new Error(`MegaPlay: decrypt HTTP ${d.status}`);
  const master = JSON.parse(await d.text())?.result?.file;
  if (!master) throw new Error("MegaPlay: could not decode stream");
  return { master, tracks: Array.isArray(data.tracks) ? data.tracks : [] };
}

async function renditions(master, referer, mode) {
  const suffix = mode === "dub" ? " · Dub" : "";
  const out = [{ quality: `auto${suffix}`, url: proxied(master, referer), type: "hls", lang: mode }];
  try {
    const r = await dnsFetch(master, { headers: { "User-Agent": UA, Referer: referer }, signal: timeout(15000) });
    if (!r.ok) throw new Error(`MegaPlay: stream HTTP ${r.status}`);
    const lines = (await r.text()).split("\n");
    const dir = master.slice(0, master.lastIndexOf("/") + 1);
    const query = master.includes("?") ? master.slice(master.indexOf("?")) : "";
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
      const h = lines[i].match(/RESOLUTION=\d+x(\d+)/)?.[1];
      const next = lines[i + 1]?.trim();
      if (!h || !next || next.startsWith("#")) continue;
      // Variants inherit the master's token when they carry none of their own.
      const abs = next.startsWith("http") ? next : `${dir}${next}${next.includes("?") ? "" : query}`;
      out.push({ quality: `${h}p${suffix}`, url: proxied(abs, referer), type: "hls", lang: mode });
    }
  } catch (e) {
    if (/HTTP 4/.test(e.message)) throw e;
  }
  return out;
}

// ---------------------------------------------------------------- resolve

export async function resolve(req) {
  const title = req.cartoonTitle || req.title || req.q;
  if (!title) throw new Error("MegaPlay: title required");
  const type = req.type === "movie" ? "movie" : "tv";
  const season = Number(req.season) || 1;
  const ep = parseInt(req.animeEp) || Number(req.episode) || 1;
  const year = Number(req.year) || null;
  const want = /dub/i.test(req.animeLang || "") ? "dub" : "sub";

  const first = await findMedia(title, { type, year });
  if (!first) throw new Error(`MegaPlay: no match for "${title}"`);

  // Try the season's own AniList entry, then the show's continuous numbering.
  const tries = [];
  if (type === "tv" && season > 1 && !parseInt(req.animeEp)) {
    const entry = await sequelOf(first, season - 1).catch(() => null);
    if (entry) tries.push([entry, ep]);
    const abs = await tmdbAbsoluteEpisode(req.id || req.tmdbId, season, ep).catch(() => null);
    if (abs) tries.push([first, abs]);
  } else {
    tries.push([first, type === "movie" ? 1 : ep]);
  }

  // Fetch Sub and Dub together so the player can switch between them without
  // a new lookup. The language asked for leads; each rendition is tagged with
  // what it really is, so a missing dub never plays as one.
  const modes = want === "dub" ? ["dub", "sub"] : ["sub", "dub"];
  const referer = `${BASE}/`;
  const one = async (media, n, mode) => {
    const file = await findFile(media, n, mode);
    if (!file) return null;
    const { master, tracks } = await sourcesFor(file);
    return { mode, master, tracks, qualities: await renditions(master, referer, mode) };
  };
  for (const [media, n] of tries) {
    const got = (await Promise.all(modes.map((m) => one(media, n, m).catch(() => null)))).filter(Boolean);
    if (!got.length) continue;
    // Subtitles belong to the sub release; the dub's are usually signs only.
    const subs = (got.find((g) => g.mode === "sub") || got[0]).tracks;
    return {
      cdn: new URL(got[0].master).host,
      verified: true,
      qualities: got.flatMap((g) => g.qualities),
      subtitles: subs
        .filter((t) => t?.file && (t.kind === "captions" || t.kind === "subtitles"))
        .map((t) => ({ label: subtitleLabel(t), lang: subtitleLanguage(t), url: proxied(t.file, referer), default: !!t.default })),
    };
  }
  throw new Error(`MegaPlay: episode ${ep} not available`);
}

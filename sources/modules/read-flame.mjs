// Flame Comics — DopDop read addon.
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime
// and this module's config from index.json, where its hosts live, so a site
// that moves is fixed by a pack update.
let UA, smartFetch;

export function setup(rt, config) {
  ({ UA, smartFetch } = rt);
  if (config.FLAME_BASE) FLAME_BASE = config.FLAME_BASE;
}

// --- Flame Comics (flamecomics.xyz) — premier manhwa provider ---
// Built on Next.js: _next/data/{buildId}/browse.json, series/{id}.json, series/{id}/{token}.json
// Direct high-res WebP images on https://cdn.flamecomics.xyz/uploads/images/series/
let FLAME_BASE = "https://flamecomics.xyz";
let flameBuildId = null;
let flameBuildIdFetchedAt = 0;
let flameBrowseCache = null;

async function getFlameBuildId() {
  if (flameBuildId && Date.now() - flameBuildIdFetchedAt < 30 * 60 * 1000) {
    return flameBuildId;
  }
  const r = await smartFetch(FLAME_BASE, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Flame Comics home: HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (!m) throw new Error("Flame Comics: could not find __NEXT_DATA__ buildId");
  const data = JSON.parse(m[1]);
  flameBuildId = data.buildId;
  flameBuildIdFetchedAt = Date.now();
  return flameBuildId;
}

async function getFlameBrowseSeries() {
  if (flameBrowseCache && Date.now() - flameBrowseCache.at < 10 * 60 * 1000) {
    return flameBrowseCache.series;
  }
  let buildId = await getFlameBuildId();
  let url = `${FLAME_BASE}/_next/data/${buildId}/browse.json`;
  let r = await smartFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (r.status === 404) {
    flameBuildId = null;
    buildId = await getFlameBuildId();
    url = `${FLAME_BASE}/_next/data/${buildId}/browse.json`;
    r = await smartFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  }
  if (!r.ok) throw new Error(`Flame Comics browse: HTTP ${r.status}`);
  const data = await r.json();
  const series = data.pageProps?.series || [];
  flameBrowseCache = { at: Date.now(), series };
  return series;
}

export async function flameSearch(query, limit = 30) {
  const all = await getFlameBrowseSeries();
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, "");
  const filtered = all.filter((s) => {
    const t = (s.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return t.includes(q);
  });
  return filtered.slice(0, limit).map((s) => {
    const id = String(s.series_id);
    const cover = s.cover ? `https://cdn.flamecomics.xyz/uploads/images/series/${id}/${s.cover}?${s.last_edit || Date.now()}` : null;
    return {
      id,
      slug: id,
      title: s.title,
      cover,
      type: s.type || "manhwa",
      status: s.status,
      rating: s.rating,
      chapterCount: s.chapter_count,
    };
  });
}

export async function flameInfo(seriesId) {
  let buildId = await getFlameBuildId();
  let url = `${FLAME_BASE}/_next/data/${buildId}/series/${seriesId}.json?id=${seriesId}`;
  let r = await smartFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (r.status === 404) {
    flameBuildId = null;
    buildId = await getFlameBuildId();
    url = `${FLAME_BASE}/_next/data/${buildId}/series/${seriesId}.json?id=${seriesId}`;
    r = await smartFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  }
  if (!r.ok) throw new Error(`Flame Comics info: HTTP ${r.status}`);
  const data = await r.json();
  const s = data.pageProps?.series;
  if (!s) throw new Error("Flame Comics: series not found");
  const sid = String(s.series_id || seriesId);
  const cover = s.cover ? `https://cdn.flamecomics.xyz/uploads/images/series/${sid}/${s.cover}?${s.last_edit || Date.now()}` : null;
  const chapters = (data.pageProps?.chapters || []).map((c) => ({
    id: String(c.token),
    number: c.chapter,
    slug: `${sid}/${c.token}`,
    title: c.title ? `Chapter ${c.chapter} - ${c.title}` : `Chapter ${c.chapter}`,
    date: c.release_date ? new Date(c.release_date * 1000).toISOString() : null,
  }));
  return {
    id: sid,
    slug: sid,
    title: s.title,
    cover,
    banner: null,
    description: s.description ? s.description.replace(/<[^>]*>/g, "").trim() : "",
    status: s.status,
    type: s.type || "manhwa",
    author: Array.isArray(s.author) ? s.author.join(", ") : (s.author || ""),
    artist: Array.isArray(s.artist) ? s.artist.join(", ") : (s.artist || ""),
    year: s.release_year,
    rating: s.rating,
    chapterCount: chapters.length,
    genres: [s.type, ...(s.tags || [])].filter(Boolean),
    chapters,
  };
}

export async function flameChapterPages(seriesId, token) {
  let buildId = await getFlameBuildId();
  let url = `${FLAME_BASE}/_next/data/${buildId}/series/${seriesId}/${token}.json?id=${seriesId}&token=${token}`;
  let r = await smartFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (r.status === 404) {
    flameBuildId = null;
    buildId = await getFlameBuildId();
    url = `${FLAME_BASE}/_next/data/${buildId}/series/${seriesId}/${token}.json?id=${seriesId}&token=${token}`;
    r = await smartFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  }
  if (!r.ok) throw new Error(`Flame Comics chapter: HTTP ${r.status}`);
  const data = await r.json();
  const ch = data.pageProps?.chapter;
  if (!ch) throw new Error("Flame Comics: chapter not found");
  const rawImages = ch.images || {};
  const imageList = Object.values(rawImages);
  const releaseDate = ch.release_date || Date.now();
  const pages = imageList.map((img) => 
    `https://cdn.flamecomics.xyz/uploads/images/series/${seriesId}/${token}/${img.name}?${releaseDate}`
  );
  return {
    pages: pages.map((u) => `/manga-image?url=${encodeURIComponent(u)}`),
    rawPages: pages,
    title: ch.title || null,
  };
}

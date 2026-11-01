// Asura Scans — DopDop read addon.
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime
// and this module's config from index.json, where its hosts live, so a site
// that moves is fixed by a pack update.
let UA, smartFetch;

export function setup(rt, config) {
  ({ UA, smartFetch } = rt);
  if (config.ASURA_API) ASURA_API = config.ASURA_API;
}

// --- AsuraScans (asuracomic.net / api.asurascans.com) — manhwa/webtoon provider ---
// Full API: search, series info, chapter list, chapter pages.
// Images on cdn.asurascans.com — no Referer needed, direct access works.
let ASURA_API = "https://api.asurascans.com";

export async function asuraSearch(query, limit = 20) {
  const url = `${ASURA_API}/api/search?q=${encodeURIComponent(query)}`;
  const r = await smartFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`AsuraScans search: HTTP ${r.status}`);
  const data = await r.json();
  return (data.data || []).slice(0, limit).map((m) => ({
    id: String(m.id),
    slug: m.slug,
    title: m.title,
    cover: m.cover || m.cover_url || null,
    type: m.type || "manhwa",
    status: m.status,
    year: m.release_year,
    rating: m.rating,
    chapterCount: m.chapter_count,
  }));
}

export async function asuraInfo(slug) {
  const r = await smartFetch(`${ASURA_API}/api/series/${slug}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`AsuraScans info: HTTP ${r.status}`);
  const data = await r.json();
  const s = data.series;
  if (!s) throw new Error("AsuraScans: series not found");
  return {
    id: String(s.id),
    slug: s.slug,
    title: s.title,
    cover: s.cover || null,
    banner: s.banner || null,
    description: s.description || "",
    status: s.status,
    type: s.type || "manhwa",
    author: s.author || "",
    artist: s.artist || "",
    year: s.release_year,
    rating: s.rating,
    chapterCount: s.chapter_count,
    genres: (s.genres || []).map(g => g.name || g),
  };
}

export async function asuraChapters(slug) {
  const r = await smartFetch(`${ASURA_API}/api/series/${slug}/chapters`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`AsuraScans chapters: HTTP ${r.status}`);
  const data = await r.json();
  return (data.data || []).map((c) => ({
    id: String(c.id),
    number: c.number,
    slug: c.slug,
    pageCount: c.page_count,
    date: c.published_at,
    seriesSlug: c.series_slug,
    premium: !!c.is_premium,
  }));
}

export async function asuraChapterPages(seriesSlug, chapterSlug) {
  const r = await smartFetch(`${ASURA_API}/api/series/${seriesSlug}/chapters/${chapterSlug}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`AsuraScans chapter pages: HTTP ${r.status}`);
  const data = await r.json();
  const ch = data.data?.chapter;
  if (!ch) throw new Error("AsuraScans: chapter not found");
  const pages = (ch.pages || []).map((p) => p.url);
  if (!pages.length) {
    // Early-access/premium chapters return no pages until early_access_until passes.
    const until = ch.early_access_until ? ` — free ${new Date(ch.early_access_until).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";
    throw new Error(ch.is_premium || data.data?.access_gate ? `AsuraScans: early-access chapter${until}` : "AsuraScans: chapter has no pages");
  }
  return {
    pages: pages.map((u) => `/manga-image?url=${encodeURIComponent(u)}`),
    rawPages: pages,
    prevChapter: data.data?.prev_chapter || null,
    nextChapter: data.data?.next_chapter || null,
  };
}

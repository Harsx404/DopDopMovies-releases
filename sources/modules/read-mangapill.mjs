// Mangapill — DopDop read addon.
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime
// and this module's config from index.json, where its hosts live, so a site
// that moves is fixed by a pack update.
let UA, smartFetch, decodeEntities;

export function setup(rt, config) {
  ({ UA, smartFetch, decodeEntities } = rt);
  if (config.MANGAPILL_BASE) MANGAPILL_BASE = config.MANGAPILL_BASE;
  if (config.MANGAPILL_CDN) MANGAPILL_CDN = config.MANGAPILL_CDN;
}

// --- Mangapill (mangapill.com) — full manga library with direct CDN images ---
// Has ALL chapters for popular manga (e.g. One Piece: 1209 chapters).
// Images require Referer: https://mangapill.com/ header (handled by /manga-image proxy).
let MANGAPILL_BASE = "https://mangapill.com";
let MANGAPILL_CDN = "https://cdn.readdetectiveconan.com";

async function mangapillFetch(path) {
  const url = path.startsWith("http") ? path : `${MANGAPILL_BASE}${path}`;
  const r = await smartFetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: MANGAPILL_BASE + "/",
    },
  });
  if (!r.ok) throw new Error(`Mangapill: HTTP ${r.status}`);
  return r.text();
}

export async function mangapillSearch(query) {
  const html = await mangapillFetch(`/search?q=${encodeURIComponent(query)}`);
  // Each result: <a href="/manga/{id}/{slug}" ...> with <img data-src="{coverUrl}" ...> and title text
  const results = [];
  const re = /<a href="\/manga\/(\d+)\/([^"]+)"[^>]*>[\s\S]*?<img data-src="([^"]*)"[^>]*alt="([^"]*)"[\s\S]*?<div class="mt-3 font-black leading-tight line-clamp-2">([^<]*)<\/div>[\s\S]*?<div class="line-clamp-2 text-xs text-secondary mt-1">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    results.push({
      id: m[1],
      slug: m[2],
      title: decodeEntities(m[5].trim()),
      cover: m[3] ? `/manga-image?url=${encodeURIComponent(m[3])}` : null,
      description: decodeEntities(m[6].trim()),
    });
  }
  return results;
}

export async function mangapillInfo(mangaId, slug) {
  const html = await mangapillFetch(`/manga/${mangaId}/${slug || ""}`);
  // Title
  const titleMatch = html.match(/<h1[^>]*>([^<]*)<\/h1>/);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : slug;
  // Description: first <p> with substantial text after the title
  let description = "";
  const descMatch = html.match(/<div class="text-sm text-secondary mt-1">([\s\S]*?)<\/div>/);
  if (descMatch) description = decodeEntities(descMatch[1].replace(/<[^>]+>/g, "").trim());
  // Cover image
  const coverMatch = html.match(/<img[^>]*data-src="(https:\/\/cdn\.readdetectiveconan\.com\/file\/mangapill\/i\/[^"]*)"/);
  const cover = coverMatch ? `/manga-image?url=${encodeURIComponent(coverMatch[1])}` : null;
  // Type (manga/manhwa/manhua/novel)
  const typeMatch = html.match(/<div class="text-xs leading-5 bg-purple-500[^"]*"[^>]*>([^<]*)<\/div>/);
  const type = typeMatch ? typeMatch[1].trim().toLowerCase() : "manga";
  // Status
  const statusMatch = html.match(/<div class="text-xs leading-5 bg-green-500[^"]*"[^>]*>([^<]*)<\/div>/);
  const status = statusMatch ? statusMatch[1].trim() : null;
  // Genres
  const genres = [];
  const genreRe = /<div class="text-xs leading-5 bg-card rounded px-1\.5">([^<]*)<\/div>/g;
  let gm;
  while ((gm = genreRe.exec(html)) !== null) genres.push(gm[1].trim());
  // Chapters: href="/chapters/{mangaId}-{chapterId}/{slug}"
  const chapters = [];
  const chapRe = /href="\/chapters\/(\d+)-(\d+)\/([^"]+)"/g;
  let cm;
  while ((cm = chapRe.exec(html)) !== null) {
    const chapterSlug = cm[3];
    // Extract chapter number from slug like "one-piece-chapter-1193"
    const numMatch = chapterSlug.match(/chapter-(\d+(?:\.\d+)?)/);
    chapters.push({
      id: cm[2],
      chapter: numMatch ? numMatch[1] : null,
      title: chapterSlug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      slug: chapterSlug,
      url: `/chapters/${cm[1]}-${cm[2]}/${chapterSlug}`,
    });
  }
  // Chapters are in descending order on the page — reverse to ascending
  chapters.reverse();
  return { id: mangaId, title, description, cover, type, status, genres, chapters };
}

export async function mangapillChapter(chapterUrl) {
  // chapterUrl is like /chapters/{mangaId}-{chapterId}/{slug}
  const html = await mangapillFetch(chapterUrl);
  // Page images: data-src="https://cdn.readdetectiveconan.com/file/mangap/..."
  const pages = [];
  const re = /data-src="(https:\/\/cdn\.readdetectiveconan\.com\/file\/mangap\/[^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    pages.push(m[1]);
  }
  // Title
  const titleMatch = html.match(/<h1[^>]*>([^<]*)<\/h1>/);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : chapterUrl;
  // Prev/next chapter links
  const prevMatch = html.match(/href="\/chapters\/(\d+-\d+\/[^"]+)"[^>]*>\s*<svg[^>]*>[\s\S]*?M15 18[\s\S]*?<\/svg>/);
  const nextMatch = html.match(/href="\/chapters\/(\d+-\d+\/[^"]+)"[^>]*>\s*<svg[^>]*>[\s\S]*?M9 18[\s\S]*?<\/svg>/);
  // Fallback: look for prev/next by chapter navigation
  const allChapLinks = [...html.matchAll(/href="\/chapters\/(\d+-\d+\/[^"]+)"/g)].map(x => x[1]);
  return {
    title,
    pages,
    // Rewrite page URLs to go through our image proxy (needs Referer header)
    proxiedPages: pages.map(p => `/manga-image?url=${encodeURIComponent(p)}`),
    prev: prevMatch ? prevMatch[1] : null,
    next: nextMatch ? nextMatch[1] : null,
  };
}

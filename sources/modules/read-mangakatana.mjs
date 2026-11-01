// MangaKatana — DopDop read addon.
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime
// and this module's config from index.json, where its hosts live, so a site
// that moves is fixed by a pack update.
let curlFetch, curlPost, decodeEntities;

export function setup(rt, config) {
  ({ curlFetch, curlPost, decodeEntities } = rt);
  if (config.MK_BASE) MK_BASE = config.MK_BASE;
}

// --- MangaKatana (mangakatana.com) — manhua provider ---
// Search via POST AJAX to home URL. Manga detail via HTML scraping.
// Chapter pages via POST with atcq= param, decoded: base64 → reverse → base64 → JSON array.
// Images on i1.mangakatana.com — no hotlink protection, no Referer needed.
let MK_BASE = "https://mangakatana.com";

async function mkFetch(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${MK_BASE}${path}`;
  return curlFetch(url, {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    ...opts,
  });
}

export async function mkSearch(query) {
  // Search via POST AJAX (same as the site's search form)
  const html = await curlPost(MK_BASE + "/", `s=${encodeURIComponent(query)}&search_by=m_name`, {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "text/html,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  });
  const results = [];
  // Each result is <div class="item" data-id="..."> with <a href="...manga/..." class="title">Title</a>
  const itemRe = /<div class="item"[^>]*>[\s\S]*?<a href="https:\/\/mangakatana\.com\/manga\/([^"]+)" class="title">([^<]*)<\/a>[\s\S]*?<img src="([^"]*)"/g;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    results.push({
      slug: m[1],
      title: decodeEntities(m[2].trim()),
      cover: m[3] || null,
    });
  }
  return results;
}

export async function mkInfo(slug) {
  const html = await mkFetch(`/manga/${slug}`);
  // Title from <h1 class="heading">
  const titleMatch = html.match(/<h1 class="heading">([^<]*)<\/h1>/);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : slug;
  // Cover from imgs/cover path
  const coverMatch = html.match(/src="(https:\/\/mangakatana\.com\/imgs\/cover\/[^"]*)"/);
  const cover = coverMatch ? coverMatch[1] : null;
  // Description from meta description
  const descMatch = html.match(/<meta name="description" content="([^"]*)"/);
  let description = descMatch ? decodeEntities(descMatch[1]) : "";
  // Clean up "Summary: " prefix
  if (description.startsWith("Summary: ")) description = description.slice(9);
  // Genres from data-genre attribute or genre links
  const genres = [];
  const genreRe = /href="https:\/\/mangakatana\.com\/genre\/[^"]*"[^>]*>([^<]*)<\/a>/g;
  let gm;
  while ((gm = genreRe.exec(html)) !== null) {
    const g = gm[1].trim();
    if (g && !genres.includes(g)) genres.push(g);
  }
  // Chapters: href="https://mangakatana.com/manga/{slug}/c{num}"
  const chapters = [];
  const chapRe = new RegExp(`href="https://mangakatana\\.com/manga/${slug}/c(\\d+(?:\\.\\d+)?)"`, "g");
  let cm;
  const seen = new Set();
  while ((cm = chapRe.exec(html)) !== null) {
    const num = cm[1];
    if (!seen.has(num)) {
      seen.add(num);
      chapters.push({
        number: num,
        slug: `c${num}`,
      });
    }
  }
  // Chapters are in descending order — reverse to ascending
  chapters.reverse();
  return { slug, title, description, cover, genres, type: "manhua", chapters };
}

export async function mkChapter(slug, chapterSlug) {
  // POST to chapter URL with atcq= to get encrypted image data
  const enc = await curlPost(`${MK_BASE}/manga/${slug}/${chapterSlug}`, "atcq=", {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "text/html,*/*;q=0.8",
  });
  // Decode: base64 → reverse string → base64 → JSON array
  const step1 = Buffer.from(enc.trim(), "base64").toString("utf-8");
  const step2 = step1.split("").reverse().join("");
  const step3 = Buffer.from(step2, "base64").toString("utf-8");
  const arr = JSON.parse(step3);
  // Array[0] and [1] are "about:blank", actual images start at index 2
  const pages = arr.filter((u) => u && u.startsWith("http"));
  return {
    pages: pages.map((u) => `/manga-image?url=${encodeURIComponent(u)}`),
    rawPages: pages,
  };
}

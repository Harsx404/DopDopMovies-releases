// MangaRead — DopDop read addon.
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime
// and this module's config from index.json, where its hosts live, so a site
// that moves is fixed by a pack update.
let curlFetch, decodeEntities;

export function setup(rt, config) {
  ({ curlFetch, decodeEntities } = rt);
  if (config.MANGAREAD_BASE) MANGAREAD_BASE = config.MANGAREAD_BASE;
}

// --- MangaRead (mangaread.org) — manhua provider (Madara WordPress theme) ---
// Search via /?s=...&post_type=wp-manga. Detail/chapters via manga page HTML.
// Chapter images use class="wp-manga-chapter-img" with whitespace in src — no hotlink protection.
let MANGAREAD_BASE = "https://www.mangaread.org";

async function mangareadFetch(path) {
  const url = path.startsWith("http") ? path : `${MANGAREAD_BASE}${path}`;
  return curlFetch(url, {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  });
}

export async function mangareadSearch(query) {
  const html = await mangareadFetch(`/?s=${encodeURIComponent(query)}&post_type=wp-manga`);
  const results = [];
  const re = /<h3 class="h4"><a href="https:\/\/www\.mangaread\.org\/manga\/([^"]+)">([^<]*)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    results.push({ slug: m[1].replace(/\/$/, ""), title: decodeEntities(m[2].trim()) });
  }
  // Covers from search results
  const coverRe = /<div class="tab-thumb c-image-hover"[^>]*>[\s\S]*?src="([^"]*)"/g;
  let cm;
  let i = 0;
  while ((cm = coverRe.exec(html)) !== null && i < results.length) {
    results[i].cover = cm[1] && !cm[1].includes("dflazy") ? cm[1] : null;
    i++;
  }
  return results;
}

export async function mangareadInfo(slug) {
  const html = await mangareadFetch(`/manga/${slug}/`);
  // Title from <title> tag — format: "Read X - manga Online in English"
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/^Read\s+/i, "").replace(/\s*-\s*manga.*$/i, "").replace(/\s*-\s*Read\s.*$/i, "").trim()) : slug;
  // Description from meta description
  const descMatch = html.match(/<meta name="description" content="([^"]*)"/);
  let description = descMatch ? decodeEntities(descMatch[1]) : "";
  // Clean up "A brief description of the manhua X: " prefix
  description = description.replace(/^A brief description of the (?:manhua|manga|manhwa)[^:]*:\s*/i, "");
  // Cover from og:image
  const coverMatch = html.match(/<meta property="og:image" content="([^"]*)"/);
  const cover = coverMatch ? coverMatch[1] : null;
  // Genres from genres-content section
  const genres = [];
  const genreSectionMatch = html.match(/<div class="genres-content">([\s\S]*?)<\/div>/);
  if (genreSectionMatch) {
    const genreRe = /href="https:\/\/www\.mangaread\.org\/genres\/[^"]*"[^>]*>([^<]*)<\/a>/g;
    let gm;
    while ((gm = genreRe.exec(genreSectionMatch[1])) !== null) {
      const g = gm[1].trim();
      if (g) genres.push(g);
    }
  }
  // Status: find "Status" heading then next summary-content
  const statusMatch = html.match(/Status\s*<\/h5>[\s\S]*?<div class="summary-content">\s*([^<]*)/);
  const status = statusMatch ? statusMatch[1].trim() : null;
  // Chapters: href="https://www.mangaread.org/manga/{slug}/chapter-{num}/"
  const chapters = [];
  const chapRe = new RegExp(`href="https://www\\.mangaread\\.org/manga/${slug}/chapter-([\\d.]+)/"`, "g");
  let cm;
  const seen = new Set();
  while ((cm = chapRe.exec(html)) !== null) {
    const num = cm[1];
    if (!seen.has(num)) {
      seen.add(num);
      chapters.push({
        number: num,
        slug: `chapter-${num}`,
      });
    }
  }
  // Chapters are in descending order — reverse to ascending
  chapters.reverse();
  return { slug, title, description, cover, genres, status, type: "manhua", chapters };
}

export async function mangareadChapter(slug, chapterSlug) {
  const html = await mangareadFetch(`/manga/${slug}/${chapterSlug}/`);
  // Images use class="wp-manga-chapter-img" with tabs/newlines in src attribute
  const pages = [];
  const imgRe = /<img[^>]*class="wp-manga-chapter-img"[^>]*>/g;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const srcMatch = tag.match(/src="\s*([^"]+?)"/);
    if (srcMatch) {
      const url = srcMatch[1].trim();
      if (url && !pages.includes(url)) pages.push(url);
    }
  }
  return {
    pages: pages.map((u) => `/manga-image?url=${encodeURIComponent(u)}`),
    rawPages: pages,
  };
}

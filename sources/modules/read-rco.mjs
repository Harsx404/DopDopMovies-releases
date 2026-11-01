// ReadComicsOnline — DopDop read addon.
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime
// and this module's config from index.json, where its hosts live, so a site
// that moves is fixed by a pack update.
let curlFetch, decodeEntities;

export function setup(rt, config) {
  ({ curlFetch, decodeEntities } = rt);
  if (config.RCO_BASE) RCO_BASE = config.RCO_BASE;
  if (config.RCO_CDN) RCO_CDN = config.RCO_CDN;
}

// --- ReadComicsOnline (readcomicsonline.lol) — western comics provider ---
// Next.js SSR site. All HTML pages and CDN images accessible from server-side.
// Data extracted from JSON-LD script tags (ComicSeries + ComicIssue).
// Image URL pattern: cdn.readcomicsonline.lol/pages/{slug}/{issue}/p{page:03d}.webp
let RCO_BASE = "https://readcomicsonline.lol";
let RCO_CDN = "https://cdn.readcomicsonline.lol";

async function rcoFetch(path) {
  const url = path.startsWith("http") ? path : `${RCO_BASE}${path}`;
  return curlFetch(url, {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  });
}

function rcoExtractJsonLd(html, type) {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      if (data["@type"] === type) return data;
    } catch (e) {}
  }
  return null;
}

export async function rcoSearch(query) {
  const html = await rcoFetch(`/search?q=${encodeURIComponent(query)}`);
  const results = [];
  // Extract comic links with titles and covers
  const re = /href="\/comic\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const inner = m[2];
    const titleMatch = inner.match(/>([^<]+)<\/h[1-6]/);
    const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : slug;
    const coverMatch = inner.match(/src="([^"]*cdn\.readcomicsonline\.lol\/covers-sm[^"]*)"/);
    const cover = coverMatch ? coverMatch[1] : null;
    results.push({ slug, title, cover });
  }
  return results;
}

export async function rcoInfo(slug) {
  const html = await rcoFetch(`/comic/${slug}`);
  const series = rcoExtractJsonLd(html, "ComicSeries");
  // Chapters from href="/comic/{slug}/{issue}"
  const chapters = [];
  const re = new RegExp(`href="/comic/${slug}/([^"]+)"`, "g");
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const issue = m[1];
    if (!seen.has(issue)) {
      seen.add(issue);
      chapters.push({ slug: issue, number: issue });
    }
  }
  // Chapters are in descending order — reverse to ascending
  chapters.reverse();
  return {
    slug,
    title: series?.name || slug,
    description: series?.description || "",
    cover: series?.image || `${RCO_CDN}/covers/${slug}/1.webp`,
    genres: series?.genre || [],
    status: null,
    publisher: series?.publisher?.name || null,
    author: series?.author?.name || null,
    type: "western",
    chapters,
  };
}

// Series catalogue — /comics (all), /publisher/{p}, /genre/{g}. Each card is an
// <a href="/comic/{slug}"> with the cover <img>, an <h3> title and an
// "N issues" / "N views" meta line. Cached in memory for 30 minutes.
const RCO_CATALOG_TTL = 30 * 60 * 1000;
const rcoCatalogCache = new Map();

export async function rcoCatalog({ publisher, genre } = {}) {
  const path = publisher ? `/publisher/${publisher}` : genre ? `/genre/${genre}` : "/comics";
  const hit = rcoCatalogCache.get(path);
  if (hit && Date.now() - hit.at < RCO_CATALOG_TTL) return hit.items;
  const html = await rcoFetch(path);
  const items = [];
  const seen = new Set();
  const re = /href="\/comic\/([^"\/]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1];
    const inner = m[2];
    const cover = inner.match(/src="([^"]*cdn\.readcomicsonline\.lol\/covers[^"]*)"/)?.[1];
    if (seen.has(slug) || !cover) continue; // text-only links (nav, "This week") have no cover
    seen.add(slug);
    const title = inner.match(/<h3[^>]*>([^<]+)<\/h3>/)?.[1] ?? inner.match(/alt="([^"]+?) comic cover"/)?.[1] ?? slug;
    items.push({
      slug,
      title: decodeEntities(title.trim()),
      cover,
      issues: Number(inner.match(/(\d+)\s*issues?/)?.[1]) || null,
      views: Number(inner.match(/(\d+)(?:<!-- -->)?\s*views/)?.[1]) || null,
      status: inner.match(/>(Completed|Ongoing)</)?.[1] ?? null,
    });
  }
  rcoCatalogCache.set(path, { at: Date.now(), items });
  return items;
}

export async function rcoChapter(slug, issue) {
  const html = await rcoFetch(`/comic/${slug}/${issue}`);
  const comicIssue = rcoExtractJsonLd(html, "ComicIssue");
  const pageCount = comicIssue?.numberOfPages || 0;
  // Generate image URLs using the pattern: p001.webp through p{pageCount:03d}.webp
  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    const pageStr = String(i).padStart(3, "0");
    pages.push(`${RCO_CDN}/pages/${slug}/${issue}/p${pageStr}.webp`);
  }
  return {
    pages: pages.map((u) => `/manga-image?url=${encodeURIComponent(u)}`),
    rawPages: pages,
  };
}

// NovelFull — DopDop read addon.
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime
// and this module's config from index.json, where its hosts live, so a site
// that moves is fixed by a pack update.
let curlFetch, decodeEntities;

export function setup(rt, config) {
  ({ curlFetch, decodeEntities } = rt);
  if (config.NOVELFULL_BASE) NOVELFULL_BASE = config.NOVELFULL_BASE;
}

// --- NovelFull (novelfull.com) — light novel reader via HTML scraping ---
// NovelFull sits behind Cloudflare TLS-fingerprint checking: Node's fetch and
// dnsFetch both get 403 ("Just a moment..."), but curl (different JA3/JA4
// fingerprint) gets 200. So we shell out to curl for NovelFull requests.
let NOVELFULL_BASE = "https://novelfull.com";

async function novelfullFetch(path, headers = {}) {
  const url = path.startsWith("http") ? path : `${NOVELFULL_BASE}${path}`;
  const html = await curlFetch(url, {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: NOVELFULL_BASE + "/",
    ...headers,
  });
  if (!html || html.length < 50) throw new Error("NovelFull: empty response");
  // Detect Cloudflare challenge page
  if (html.includes("Just a moment...") || html.includes("cf-challenge")) {
    throw new Error("NovelFull: Cloudflare challenge — try again later");
  }
  return html;
}

export async function searchNovels(q, page = 1) {
  const html = await novelfullFetch(`/search?keyword=${encodeURIComponent(q)}&page=${page}`);
  const results = [];
  // Real hits are .row cards whose title is <h3 class="truyen-title">…<a href
  // title="T">. The sidebar's popular list uses plain <h3><a> — requiring
  // truyen-title keeps a no-hit search from returning that fixed list.
  for (const row of html.split('<div class="row">').slice(1)) {
    const a = row.match(/<h3 class="truyen-title">[\s\S]*?<a\s+href="\/([^"]+)\.html"[^>]*title="([^"]*)"/);
    if (!a) continue;
    const img = row.match(/<img[^>]*src="([^"]*)"[^>]*class="cover"/) || row.match(/<img[^>]*class="cover"[^>]*src="([^"]*)"/);
    let cover = img ? img[1] : null;
    if (cover && cover.startsWith("/")) cover = NOVELFULL_BASE + cover;
    results.push({ slug: a[1], title: decodeEntities(a[2].trim()), cover });
  }
  // Total pages: highest page= number inside the pagination list.
  const pag = html.match(/<ul class="pagination[^"]*">([\s\S]*?)<\/ul>/);
  let totalPages = 1;
  if (pag) for (const m of pag[1].matchAll(/page=(\d+)/g)) totalPages = Math.max(totalPages, parseInt(m[1]));
  return { novels: results, page, totalPages };
}

export async function getNovelInfo(slug) {
  const html = await novelfullFetch(`/${slug}.html`);
  const titleMatch = html.match(/<h3 class="title">([^<]*)<\/h3>/);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : slug;
  const coverMatch = html.match(/<img[^>]*class="thumbnail"[^>]*src="([^"]*)"/) || html.match(/<meta name="image" content="([^"]*)"/);
  const cover = coverMatch ? coverMatch[1] : null;
  const descMatch = html.match(/<div class="desc-text"[^>]*>([\s\S]*?)<\/div>/);
  let description = "";
  if (descMatch) {
    description = descMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 1000);
  }
  // Genres
  const genres = [];
  const genreRe = /<a href="\/genre\/[^"]*">([^<]*)<\/a>/g;
  let gm;
  while ((gm = genreRe.exec(html))) genres.push(gm[1].trim());
  // Author / status from info-list
  const authorMatch = html.match(/<a[^>]*href="\/author\/[^"]*"[^>]*>([^<]*)<\/a>/);
  const author = authorMatch ? decodeEntities(authorMatch[1].trim()) : null;
  const statusMatch = html.match(/<li>\s*<span[^>]*>Status:<\/span>\s*([^<]*)</);
  const status = statusMatch ? statusMatch[1].trim() : null;
  // Chapters
  const chapters = [];
  const chapRe = /<a href="([^"]+)" title="([^"]*)"[^>]*><span class="chapter-text">([^<]*)<\/span><\/a>/g;
  let cm;
  while ((cm = chapRe.exec(html))) {
    chapters.push({
      slug: cm[1].replace(/^\//, "").replace(/\.html$/, ""),
      title: decodeEntities(cm[2].trim()),
      url: cm[1],
    });
  }
  // Chapters may be paginated; detect total pages
  const totalPagesMatch = html.match(/Page \d+\/(\d+)/);
  const totalPages = totalPagesMatch ? parseInt(totalPagesMatch[1]) : 1;
  return { slug, title, cover, description, genres: [...new Set(genres)], author, status, chapters, totalPages, chapterCount: chapters.length };
}

export async function getNovelChaptersPage(slug, page = 1) {
  const html = await novelfullFetch(`/${slug}.html?page=${page}`);
  const chapters = [];
  const chapRe = /<a href="([^"]+)" title="([^"]*)"[^>]*><span class="chapter-text">([^<]*)<\/span><\/a>/g;
  let cm;
  while ((cm = chapRe.exec(html))) {
    chapters.push({
      slug: cm[1].replace(/^\//, "").replace(/\.html$/, ""),
      title: decodeEntities(cm[2].trim()),
      url: cm[1],
    });
  }
  return { chapters, page };
}

export async function readNovelChapter(chapterSlug) {
  // chapterSlug is the full path like "novel-slug/chapter-1-..."
  const html = await novelfullFetch(`/${chapterSlug}.html`);
  const titleMatch = html.match(/<a class="chapter-title"[^>]*>([\s\S]*?)<\/a>/) || html.match(/<span class="chapter-text">([^<]*)<\/span>/);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "").trim()) : chapterSlug;

  // Content: extract between the chapter-content div opening and the last
  // <hr class="chapter-end"> that closes the reading area. The content div
  // contains nested ad <div>s, so strip those first, then convert <p>/<br>.
  let content = "";
  const startIdx = html.indexOf('id="chapter-content"');
  if (startIdx >= 0) {
    const afterOpen = html.indexOf(">", startIdx) + 1;
    const endIdx = html.lastIndexOf("chapter-end", html.length);
    const raw = endIdx > afterOpen ? html.slice(afterOpen, endIdx) : html.slice(afterOpen);
    // Remove nested ad divs (iframes, scripts, ad containers)
    let cleaned = raw
      .replace(/<div[^>]*>[\s\S]*?<\/div>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "");
    // Convert <p> and <br> to newlines, strip remaining tags
    cleaned = cleaned
      .replace(/<\/p>/gi, "\n")
      .replace(/<p[^>]*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "");
    cleaned = decodeEntities(cleaned)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    content = cleaned;
  }

  // Prev/next chapter links: <a ... href="..." id="prev_chap"> / id="next_chap"
  // Disabled chapters have class="... disabled" and no href.
  const prevMatch = html.match(/<a[^>]*\sid="prev_chap"[^>]*>/);
  const nextMatch = html.match(/<a[^>]*\sid="next_chap"[^>]*>/);
  const extractHref = (tag) => {
    if (!tag) return null;
    if (/disabled/.test(tag)) return null;
    const href = tag.match(/href="([^"]*)"/);
    return href ? href[1].replace(/^\//, "").replace(/\.html$/, "") : null;
  };
  const prev = extractHref(prevMatch?.[0]);
  const next = extractHref(nextMatch?.[0]);

  return { title, content, prev, next };
}

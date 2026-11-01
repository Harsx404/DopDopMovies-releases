// Hive Scans — DopDop read addon.
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime
// and this module's config from index.json, where its hosts live, so a site
// that moves is fixed by a pack update.
let UA, smartFetch;

export function setup(rt, config) {
  ({ UA, smartFetch } = rt);
  if (config.HIVE_API) HIVE_API = config.HIVE_API;
}

// --- Hive Scans (hivetoons.org / api.hivetoons.org) — action & fantasy manhwa provider ---
// REST API on api.hivetoons.org, images on storage.hivetoon.com
let HIVE_API = "https://api.hivetoons.org";

export async function hiveSearch(query, limit = 25) {
  const url = `${HIVE_API}/api/query?perPage=${limit}&searchTerm=${encodeURIComponent(query)}`;
  const r = await smartFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Hive Scans search: HTTP ${r.status}`);
  const data = await r.json();
  return (data.posts || []).map((p) => ({
    id: String(p.id),
    slug: p.slug || String(p.id),
    title: p.postTitle,
    cover: p.featuredImage || null,
    type: p.seriesType ? p.seriesType.toLowerCase() : "manhwa",
    status: p.seriesStatus,
    rating: p.averageRating,
    chapterCount: p.chapters ? p.chapters.length : undefined,
  }));
}

export async function hiveInfo(slug) {
  let meta = null;
  try {
    const url = `${HIVE_API}/api/post?postSlug=${encodeURIComponent(slug)}`;
    const r = await smartFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (r.ok) {
      const data = await r.json();
      meta = data.post;
    }
  } catch (e) {
    // API metadata fetch optional
  }

  // Fetch series HTML to extract complete chapter list (and fallback metadata)
  let html = "";
  try {
    const pageRes = await smartFetch(`https://hivetoons.org/series/${slug}`, { headers: { "User-Agent": UA } });
    if (pageRes.ok) html = await pageRes.text();
  } catch (e) {
    // HTML fetch fallback
  }

  const chapters = [];
  const seenIds = new Set();

  // 1. Try extracting chapters from TanStack Router / Vastro data stream
  if (html) {
    const chapRe = /\{id:(\d+),slug:"(chapter-[^"]+)",number:([0-9\.]+),title:"([^"]*)",chapterStatus:"([^"]*)",[^}]*?createdAt:"([^"]*)"/g;
    let cm;
    while ((cm = chapRe.exec(html)) !== null) {
      const id = cm[1];
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const num = parseFloat(cm[3]);
      const isLockedSnippet = html.slice(cm.index, cm.index + 300);
      const isLocked = isLockedSnippet.includes("isLocked:!0") || isLockedSnippet.includes("isLocked:true") || isLockedSnippet.includes("isPermanentlyLocked:!0");
      chapters.push({
        id,
        number: num,
        slug: id,
        title: cm[4] ? `Chapter ${num}: ${cm[4]}` : `Chapter ${num}`,
        date: cm[6],
        premium: isLocked,
      });
    }

    // 2. Fallback to anchor tags if stream didn't match
    if (chapters.length === 0) {
      const aRe = new RegExp(`<a\\s+[^>]*href="/series/${slug}/(chapter-[^"]+)"[^>]*>([\\s\\S]*?)</a>`, "gi");
      let am;
      while ((am = aRe.exec(html)) !== null) {
        const chSlug = am[1];
        if (seenIds.has(chSlug)) continue;
        seenIds.add(chSlug);
        const numMatch = chSlug.match(/chapter-(\d+(?:\.\d+)?)/i);
        const num = numMatch ? parseFloat(numMatch[1]) : undefined;
        const timeMatch = am[2].match(/dateTime="([^"]*)"/i);
        chapters.push({
          id: chSlug,
          number: num,
          slug: chSlug,
          title: num ? `Chapter ${num}` : chSlug,
          date: timeMatch ? timeMatch[1] : null,
          premium: false,
        });
      }
    }
  }

  // 3. Fallback to API post.chapters if any were provided
  if (chapters.length === 0 && meta?.chapters?.length) {
    for (const c of meta.chapters) {
      chapters.push({
        id: String(c.id),
        number: c.number,
        slug: String(c.id),
        title: c.title ? `Chapter ${c.number}: ${c.title}` : `Chapter ${c.number}`,
        date: c.createdAt,
        premium: !!c.isLocked,
      });
    }
  }

  const title = meta?.postTitle || (html.match(/<meta property="og:title" content="([^"]*)"/i) || [])[1] || slug;
  const cover = meta?.featuredImage || (html.match(/<meta property="og:image" content="([^"]*)"/i) || [])[1] || null;
  const description = meta?.postContent
    ? meta.postContent.replace(/<[^>]*>/g, "").trim()
    : ((html.match(/<meta property="og:description" content="([^"]*)"/i) || [])[1] || "");
  const genres = meta?.genres ? meta.genres.map((g) => g.name || g) : [];

  return {
    id: String(meta?.id || slug),
    slug: meta?.slug || slug,
    title,
    cover,
    banner: meta?.banner || null,
    description,
    status: meta?.seriesStatus || null,
    type: meta?.seriesType ? meta.seriesType.toLowerCase() : "manhwa",
    author: meta?.author || "",
    artist: meta?.artist || "",
    year: meta?.releaseDate ? new Date(meta.releaseDate).getFullYear() : (meta?.releaseYear || undefined),
    rating: meta?.averageRating,
    chapterCount: chapters.length,
    genres,
    chapters,
  };
}

export async function hiveChapterPages(seriesSlug, chapterIdOrSlug) {
  // If numeric chapter id, try official REST API first
  if (chapterIdOrSlug && /^\d+$/.test(chapterIdOrSlug)) {
    try {
      const url = `${HIVE_API}/api/chapter?chapterId=${encodeURIComponent(chapterIdOrSlug)}`;
      const r = await smartFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.ok) {
        const data = await r.json();
        const ch = data.chapter;
        if (ch && Array.isArray(ch.images) && ch.images.length > 0) {
          if (ch.isLocked || ch.isLockedByCoins || ch.isPermanentlyLocked) {
            throw new Error("Hive Scans: chapter is locked");
          }
          const rawImages = ch.images.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          const pages = rawImages.map((img) => img.url.replace(/ /g, "%20"));
          return {
            pages: pages.map((u) => `/manga-image?url=${encodeURIComponent(u)}`),
            rawPages: pages,
            title: ch.title || null,
          };
        }
      }
    } catch (e) {
      if (e.message && e.message.includes("locked")) throw e;
      // otherwise fall through to web reader scraper
    }
  }

  // Fallback: scrape web reader page HTML
  if (seriesSlug) {
    const chSlug = chapterIdOrSlug.startsWith("chapter-") ? chapterIdOrSlug : `chapter-${chapterIdOrSlug}`;
    const pageUrl = `https://hivetoons.org/series/${seriesSlug}/${chSlug}`;
    const res = await smartFetch(pageUrl, { headers: { "User-Agent": UA } });
    if (res.ok) {
      const html = await res.text();
      const imgRe = /https:\/\/storage\.hivetoon\.com\/public\/upload\/series\/[^\s"'<>]+\.(?:webp|jpg|jpeg|png)/gi;
      const matches = html.match(imgRe) || [];
      const seen = new Set();
      const pages = [];
      for (const u of matches) {
        if (u.includes("cover_") || u.includes("thumb")) continue;
        if (!seen.has(u)) {
          seen.add(u);
          pages.push(u.replace(/ /g, "%20"));
        }
      }
      if (pages.length > 0) {
        return {
          pages: pages.map((u) => `/manga-image?url=${encodeURIComponent(u)}`),
          rawPages: pages,
          title: null,
        };
      }
    }
  }

  throw new Error("Hive Scans: could not resolve chapter pages");
}

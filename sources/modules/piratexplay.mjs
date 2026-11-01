// PirateXPlay — Hindi, Tamil and Telugu cartoons and animated films.
//
// DopDop source addon. Its URLs end in the TMDB id, so a title is matched
// exactly rather than by name. The signed stream only comes out of the host's
// player, so the app's capture bridge plays it for a moment and reports the
// playlist (desktop app only). The address lives in index.json.

let UA, dnsFetch, cachedFetch, captureStream, BASE, PAGES;

export function setup(rt, config) {
  ({ UA, dnsFetch, cachedFetch, captureStream } = rt);
  BASE = config.base;
  PAGES = config.catalogPages || 2;
}

async function page(path) {
  const r = await dnsFetch(new URL(path, BASE).href, { headers: { "User-Agent": UA, Referer: `${BASE}/` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`PirateXPlay: HTTP ${r.status}`);
  return r.text();
}

/** Listing articles → { title, type, id, year, href }. */
function articles(html) {
  return html.split(/<article /).slice(1).map((a) => {
    const href = a.match(/<a[^>]+href="([^"]+)"/)?.[1] || "";
    const m = href.match(/\/(series|movies)\/(.+)-(\d+)\/?$/);
    if (!m) return null;
    const raw = (a.match(/entry-title">([^<]*)/)?.[1] || "").replace(/&#0?39;/g, "'").replace(/&amp;/g, "&").trim();
    const year = raw.match(/\((\d{4})\)\s*$/)?.[1];
    return { title: raw.replace(/\s*\(\d{4}\)\s*$/, ""), type: m[1] === "series" ? "tv" : "movie", id: Number(m[3]), year: year ? Number(year) : undefined, href, slug: m[2] };
  }).filter(Boolean);
}

/** What the site lists as cartoons, for the Cartoons room. */
export function catalog() {
  return cachedFetch("piratexplay:catalog", 6 * 3600_000, async () => {
    const pages = await Promise.all(Array.from({ length: PAGES }, (_, i) => page(`/category/cartoon/${i ? `page/${i + 1}/` : ""}`).catch(() => null)));
    const seen = new Set();
    return pages.flatMap((html) => (html ? articles(html) : [])).filter((t) => {
      const k = `${t.type}:${t.id}`;
      if (!t.title || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map(({ title, type, year }) => ({ title, type, year }));
  });
}

/** Player pages on a title or episode page, the site's own player first. */
function players(html) {
  const urls = [...html.matchAll(/<iframe[^>]+(?:src|data-src)\s*=\s*['"]([^'"]+)/gi)].map((m) => new URL(m[1], BASE).href);
  return [...new Set(urls)].sort((a, b) => Number(!a.includes("/public/player/")) - Number(!b.includes("/public/player/")));
}

export async function resolve(req) {
  const title = req.cartoonTitle || req.title;
  if (!title) throw new Error("PirateXPlay: no title");
  const results = await page(`/?s=${encodeURIComponent(title)}`);
  const hit = results && articles(results).find((a) => a.id === Number(req.id) && a.type === req.type);
  if (!hit) throw new Error("PirateXPlay: title not found");

  let html;
  if (req.type === "tv") {
    const show = hit.slug.replace(/-season-\d+$/, "");
    const season = req.season || 1;
    html = await page(`/episode/${show}-season-${season}-${hit.id}-${season}x${req.episode || 1}/`);
    if (!html) throw new Error("PirateXPlay: episode not found");
  } else {
    html = await page(hit.href);
    if (!html) throw new Error("PirateXPlay: title not found");
  }

  const urls = players(html);
  if (!urls.length) throw new Error("PirateXPlay: no players found");
  let last;
  for (const url of urls.slice(0, 2)) {
    try {
      const stream = await captureStream(url, `${BASE}/`);
      return {
        verified: true,
        qualities: [{ quality: "auto", type: "hls", url: `/api/hls?url=${encodeURIComponent(stream.url)}&referer=${encodeURIComponent(stream.referer)}` }],
        subtitles: [],
      };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

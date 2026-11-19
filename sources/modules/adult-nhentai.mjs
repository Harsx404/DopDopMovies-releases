// nhentai — Laya After Dark read source (hentai manga / doujinshi).
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime
// and this module's config from index.json. Uses nhentai's public v2 JSON API;
// images live on i*/t*.nhentai.net and go through the backend's /manga-image
// proxy (Referer attached there), so nothing hotlinks from the page.
//
// Galleries tagged lolicon or shotacon are excluded from every listing and
// refused on open — the app never shows sexual content involving minors.
let UA, smartFetch;
let API = "https://nhentai.net/api/v2";
let IMAGE = "https://i1.nhentai.net";
let THUMB = "https://t1.nhentai.net";
let BLOCKED = ["lolicon", "shotacon"];

export function setup(rt, config = {}) {
  ({ UA, smartFetch } = rt);
  if (config.api) API = config.api;
  if (config.image) IMAGE = config.image;
  if (config.thumb) THUMB = config.thumb;
  if (Array.isArray(config.blockedTags)) BLOCKED = config.blockedTags;
}

// nhentai's v2 API can take 40-75 s (images stay fast), past the runtime's 15 s default:
// give it 110 s (the web proxy allows 120), share one request between callers asking the same thing, and keep answers 10 min.
const API_TIMEOUT_MS = 110_000;
const CACHE_MS = 10 * 60_000;
const cache = new Map();
async function api(path) {
  const hit = cache.get(path);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = (async () => {
    const r = await smartFetch(`${API}${path}`, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://nhentai.net/" },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    }).catch((e) => { throw new Error(e?.name === "TimeoutError" || e?.name === "AbortError" ? "nhentai is very slow right now; try again in a minute" : `nhentai: ${e.message}`); });
    if (!r.ok) throw new Error(`nhentai: HTTP ${r.status}`);
    return r.json();
  })();
  cache.set(path, { value, until: Date.now() + CACHE_MS });
  value.catch(() => cache.delete(path));
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

const proxied = (base, path) => (path ? `/manga-image?url=${encodeURIComponent(`${base}/${path}`)}` : null);
const exclusions = () => BLOCKED.map((t) => `-tag:"${t}"`).join(" ");

function summary(g) {
  return {
    id: String(g.id),
    title: g.english_title || g.japanese_title || `Gallery ${g.id}`,
    cover: proxied(THUMB, g.thumbnail),
    pages: g.num_pages || 0,
    favorites: g.num_favorites || 0,
  };
}

/** Search (or browse when q is empty). sort: "date" | "popular" | "popular-week" | "popular-today". */
export async function nhSearch(q = "", page = 1, sort = "") {
  const query = `${String(q).trim()} ${exclusions()}`.trim();
  const params = new URLSearchParams({ query, page: String(page) });
  if (sort && sort !== "date") params.set("sort", sort);
  const d = await api(`/search?${params}`);
  return { items: (d.result || []).filter((g) => !g.blacklisted).map(summary), pages: d.num_pages || 1 };
}

function assertAllowed(g) {
  const hit = (g.tags || []).find((t) => t.type === "tag" && BLOCKED.includes(String(t.name).toLowerCase()));
  if (hit) throw new Error("This gallery isn't available.");
}

export async function nhInfo(id) {
  if (!/^\d+$/.test(String(id))) throw new Error("Bad gallery id");
  const g = await api(`/galleries/${id}`);
  assertAllowed(g);
  const of = (type) => (g.tags || []).filter((t) => t.type === type).map((t) => t.name);
  return {
    id: String(g.id),
    title: g.title?.pretty || g.title?.english || g.title?.japanese || `Gallery ${g.id}`,
    fullTitle: g.title?.english || g.title?.japanese || "",
    cover: proxied(THUMB, g.cover?.path || g.thumbnail?.path),
    pages: g.num_pages || (g.pages || []).length,
    favorites: g.num_favorites || 0,
    uploaded: g.upload_date ? g.upload_date * 1000 : null,
    tags: of("tag"),
    artists: of("artist"),
    groups: of("group"),
    parodies: of("parody"),
    characters: of("character"),
    languages: of("language").filter((l) => l !== "translated"),
    category: of("category")[0] || "doujinshi",
    thumbs: (g.pages || []).slice(0, 12).map((p) => proxied(THUMB, p.thumbnail)),
  };
}

/** Every page image of a gallery — a gallery reads as a single chapter. */
export async function nhPages(id) {
  if (!/^\d+$/.test(String(id))) throw new Error("Bad gallery id");
  const g = await api(`/galleries/${id}`);
  assertAllowed(g);
  return {
    title: g.title?.pretty || g.title?.english || `Gallery ${g.id}`,
    pages: (g.pages || []).sort((a, b) => a.number - b.number).map((p) => `${IMAGE}/${p.path}`),
  };
}

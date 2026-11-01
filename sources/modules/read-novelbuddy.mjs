// NovelBuddy — DopDop read addon.
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime
// and this module's config from index.json, where its hosts live, so a site
// that moves is fixed by a pack update.
let UA, smartFetch, decodeEntities;

export function setup(rt, config) {
  ({ UA, smartFetch, decodeEntities } = rt);
  if (config.NB_BASE) NB_BASE = config.NB_BASE;
  if (config.NB_API) NB_API = config.NB_API;
}

// --- NovelBuddy (novelbuddy.me / api.novelbuddy.me) — light & web novels ---
// Next.js SSR: pageProps.__NEXT_DATA__ carries search results, novel info and
// chapter content; the JSON API serves the complete chapter list (the page
// embeds only the newest 50). No Cloudflare gating — plain fetch works.
let NB_BASE = "https://novelbuddy.me";
let NB_API = "https://api.novelbuddy.me";

async function nbFetch(path) {
  const url = path.startsWith("http") ? path : `${NB_BASE}${path}`;
  const r = await smartFetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!r.ok) throw new Error(`NovelBuddy: HTTP ${r.status}`);
  return r.text();
}

async function nbApi(path) {
  const r = await smartFetch(`${NB_API}${path}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`NovelBuddy API: HTTP ${r.status}`);
  const d = await r.json();
  if (d.success === false) throw new Error(`NovelBuddy: ${d.message || "API error"}`);
  return d.data ?? d;
}

function nbNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("NovelBuddy: unexpected page (no __NEXT_DATA__)");
  return JSON.parse(m[1]).props?.pageProps || {};
}

const nbChapter = (c) => ({
  number: c.number != null ? String(c.number) : (String(c.name || "").match(/chapter\s*([\d.]+)/i)?.[1] ?? null),
  slug: c.slug || String(c.url || "").split("/").pop(),
  title: c.name || c.slug,
  date: c.updated_at || c.date,
});

export async function nbSearch(query) {
  const pp = nbNextData(await nbFetch(`/search?q=${encodeURIComponent(query)}`));
  return (pp.ssrItems || []).filter((i) => i.slug).map((i) => ({
    slug: i.slug,
    title: i.name,
    cover: i.cover || null,
    status: i.status || null,
    chapterCount: i.stats?.chaptersCount ?? null,
    type: "novel",
  }));
}

export async function nbInfo(slug) {
  const pp = nbNextData(await nbFetch(`/${slug}`));
  const m = pp.initialManga;
  if (!m?.id) throw new Error("NovelBuddy: novel not found");
  // Chapter keys carry the full "{novel}/{chapter}" page path, like NovelFull.
  const full = (list) => (list || []).map((c) => { const n = nbChapter(c); return { ...n, slug: `${slug}/${n.slug}` }; });
  let chapters = [];
  try {
    const d = await nbApi(`/titles/${m.id}/chapters`);
    chapters = full(d.chapters || d);
  } catch {
    chapters = full(m.chapters);
  }
  chapters.reverse(); // API returns newest-first
  return {
    slug,
    title: m.name,
    cover: m.cover || null,
    description: decodeEntities(String(m.summary || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
    genres: [...new Set([...(m.genres || []), ...(m.tags || []), ...(m.themes || [])].map((g) => g.name || g).filter(Boolean))],
    author: (m.authors || []).map((a) => a.name || a).filter(Boolean).join(", ") || null,
    status: m.status || null,
    chapters,
    totalPages: 1,
    chapterCount: m.stats?.chaptersCount ?? chapters.length,
    type: "novel",
  };
}

export async function nbRead(chapterPath) {
  // chapterPath is "{novelSlug}/{chapterSlug}" — the public page URL.
  const pp = nbNextData(await nbFetch(`/${chapterPath}`));
  const ch = pp.initialChapter;
  if (!ch) throw new Error("NovelBuddy: chapter not found");
  const content = decodeEntities(
    String(ch.content || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<p[^>]*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  ).replace(/\n{3,}/g, "\n\n").trim();
  const rel = (c) => (c?.url ? String(c.url).replace(/^\/+/, "") : c?.slug ? `${chapterPath.split("/")[0]}/${c.slug}` : null);
  return { title: ch.name || chapterPath, content, prev: rel(pp.previousChapter), next: rel(pp.nextChapter) };
}

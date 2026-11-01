// Classic cartoons (SuperCartoons, ToonJet, Archive.org) — title-keyed, matched by episode title.
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs: setup() runs once
// with the app runtime and this module's config from index.json; resolve()
// runs per play. Hosts and endpoints live in index.json, not here.

let UA, cachedFetch, dnsFetch, SUPERCARTOONS_BASE, TOONJET_BASE, ARCHIVE_BASE;

export function setup(rt, config) {
  ({ UA, cachedFetch, dnsFetch } = rt);
  SUPERCARTOONS_BASE = config.supercartoons;
  TOONJET_BASE = config.toonjet;
  ARCHIVE_BASE = config.archive;
}

// --- Cartoon providers (classic cartoons; keyed by title, not TMDB id) ---
// Word-overlap score between a query ("Tom and Jerry") and a candidate
// ("the-tom-and-jerry-cartoon-kit" slug or archive title). Returns 0..1.
function cartoonNorm(s) {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cartoonScore(query, candidate) {
  const qw = new Set(cartoonNorm(query).split(" ").filter(Boolean));
  const cw = new Set(cartoonNorm(candidate).split(" ").filter(Boolean));
  if (!qw.size || !cw.size) return 0;
  let hit = 0;
  for (const w of qw) if (cw.has(w)) hit++;
  // Recall drives the threshold; a small precision bonus breaks ties toward the
  // tightest title ("Doraemon" > "Doraemon Birthday Specials" — both have recall
  // 1 for a one-word query, so API order used to pick wrong).
  return hit / qw.size + (hit / cw.size) * 0.01;
}

// Try the episode title first (classic cartoon shorts map to episode names),
// then the series title; return the first playable result.
async function resolveCartoonByTitle(title, epTitle, find) {
  for (const q of [epTitle, title].filter(Boolean)) {
    try {
      const hit = await find(q);
      if (hit) return hit;
    } catch {}
  }
  throw new Error("no cartoon match");
}

// SuperCartoons (supercartoons.net) — WordPress site, ?s= search →
// /cartoon/{slug}/ page → JWPlayer config has a direct mp4 on ww.supercartoons.net.
async function resolveSuperCartoons(title, epTitle) {
  const BASE = SUPERCARTOONS_BASE;
  return resolveCartoonByTitle(title, epTitle, async (q) => {
    const r = await dnsFetch(`${BASE}/?s=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": UA, Referer: BASE + "/" },
    });
    if (!r.ok) return null;
    const links = [...new Set((await r.text()).match(/\/cartoon\/[a-z0-9-]+\//gi) || [])];
    if (!links.length) return null;
    const best = links
      .map((l) => ({ l, s: cartoonScore(q, l.slice(9, -1)) }))
      .sort((a, b) => b.s - a.s)[0];
    if (!best || best.s < 0.34) return null;
    const page = await dnsFetch(BASE + best.l, { headers: { "User-Agent": UA, Referer: BASE + "/" } });
    if (!page.ok) return null;
    const file = (await page.text()).match(/file\s*:\s*"(https?:\/\/[^"]+\.mp4)"/i);
    if (!file) return null;
    return {
      cdn: "ww.supercartoons.net",
      qualities: [{ quality: "auto", url: file[1], type: "mp4", cdn: "ww.supercartoons.net" }],
      verified: true,
    };
  });
}

// ToonJet (toonjet.com) — /cartoons/ lists series pages (/cartoons/{Series}/)
// which list episodes (/cartoon/{id}/{Series}/{Title}/). Episode pages now embed
// YouTube via a JS player config (initialVideoId); older ones embed archive.org.
async function resolveToonJet(title, epTitle) {
  const BASE = TOONJET_BASE;
  const idx = await cachedFetch("toonjet:index", 60 * 60_000, async () => {
    const r = await dnsFetch(`${BASE}/cartoons/`, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`ToonJet: HTTP ${r.status}`);
    return r.text();
  });
  // Featured episode links on the index are kept as candidates too.
  const candidates = [...new Set(idx.match(/\/cartoon\/\d+\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\//g) || [])]
    .map((l) => {
      const [, , series, ep] = l.split("/");
      return { l, label: `${series} ${ep}`, ep };
    });
  const seriesLinks = [...new Set(idx.match(/\/cartoons\/[A-Za-z0-9-]+\//g) || [])]
    .filter((l) => l !== "/cartoons/" && l !== "/cartoons/Classic/");
  const series = seriesLinks
    .map((l) => ({ l, s: cartoonScore(title, l.slice(9, -1)) }))
    .filter((x) => x.s >= 0.3)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  for (const s of series) {
    const page = await cachedFetch(`toonjet:series:${s.l}`, 6 * 3600_000, async () => {
      const r = await dnsFetch(BASE + s.l, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(`ToonJet series: HTTP ${r.status}`);
      return r.text();
    }).catch(() => "");
    for (const l of new Set(page.match(/\/cartoon\/\d+\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\//g) || [])) {
      const [, , ser, ep] = l.split("/");
      candidates.push({ l, label: `${ser} ${ep}`, ep });
    }
  }
  if (!candidates.length) throw new Error("ToonJet: empty index");
  return resolveCartoonByTitle(title, epTitle, async (q) => {
    const best = candidates
      .map((c) => ({ c, s: Math.max(cartoonScore(q, c.ep), cartoonScore(q, c.label)) }))
      .sort((a, b) => b.s - a.s)[0];
    if (!best || best.s < 0.34) return null;
    const page = await dnsFetch(BASE + best.c.l, { headers: { "User-Agent": UA } });
    if (!page.ok) return null;
    const html = await page.text();
    const yt = html.match(/initialVideoId:\s*'([A-Za-z0-9_-]{6,})'/);
    if (yt) {
      return {
        isEmbed: true,
        embedDirect: true,
        cdn: "youtube-nocookie.com",
        qualities: [{ quality: "auto", url: `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1&rel=0`, type: "embed", cdn: "youtube-nocookie.com" }],
        verified: true,
      };
    }
    const emb = html.match(/archive\.org\/embed\/([^/"?]+)\/([^"?]+)/);
    if (!emb) return null;
    const mp4 = `${ARCHIVE_BASE}/download/${emb[1]}/${encodeURIComponent(emb[2])}`;
    return {
      cdn: "archive.org",
      qualities: [{ quality: "auto", url: mp4, type: "mp4", cdn: "archive.org" }],
      verified: true,
    };
  });
}

// Archive.org — public-domain cartoons (Popeye, Looney Tunes, Superman, ...).
// advancedsearch API → metadata → /download/{id}/{file}.mp4.
async function resolveArchiveCartoon(title, epTitle) {
  return resolveCartoonByTitle(title, epTitle, async (q) => {
    const aq = `title:(${q}) AND mediatype:movies AND subject:(cartoon OR cartoons OR animation OR animated)`;
    const api = `${ARCHIVE_BASE}/advancedsearch.php?q=${encodeURIComponent(aq)}&fl[]=identifier&fl[]=title&fl[]=downloads&rows=10&sort[]=downloads desc&output=json`;
    const r = await dnsFetch(api, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const docs = JSON.parse(await r.text()).response?.docs || [];
    const best = docs
      .map((d) => ({ d, s: cartoonScore(q, d.title || "") }))
      .sort((a, b) => b.s - a.s || (b.d.downloads || 0) - (a.d.downloads || 0))[0];
    if (!best || best.s < 0.34) return null;
    const meta = await dnsFetch(`${ARCHIVE_BASE}/metadata/${best.d.identifier}`, { headers: { "User-Agent": UA } });
    if (!meta.ok) return null;
    const files = (JSON.parse(await meta.text()).files || []).filter((f) => /\.mp4$/i.test(f.name));
    if (!files.length) return null;
    const qualities = files
      .sort((a, b) => (+b.size || 0) - (+a.size || 0))
      .slice(0, 4)
      .map((f) => ({
        quality: f.height ? `${f.height}p` : `${Math.max(1, Math.round((+f.size || 0) / 1048576))}MB`,
        url: `${ARCHIVE_BASE}/download/${best.d.identifier}/${encodeURIComponent(f.name).replace(/%2F/g, "/")}`,
        type: "mp4",
        cdn: "archive.org",
      }));
    return { cdn: "archive.org", qualities, verified: true };
  });
}

const SITES = { supercartoons: resolveSuperCartoons, toonjet: resolveToonJet, archive: resolveArchiveCartoon };

export async function resolve(req, { params }) {
  return SITES[params.site](req.cartoonTitle, req.eptitle);
}

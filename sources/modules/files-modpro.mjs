// File downloads from UHDMovies, MoviesMod and MoviesLeech: whole files (MKV/MP4) for the
// Download manager, not streams.
//
// Each site is WordPress: search → post → one entry per release (quality, size). An entry's
// button goes through a "please wait / generate link" redirect site (a LandingPress link
// locker) to a DriveSeed file page; DriveSeed's Instant Download then redirects to a direct
// Google file. All of it is plain HTTP: see docs/extractor-uhdmovies-moviesmod.md.

let rt;
let SITES = {
  uhdmovies: { label: "UHDMovies", base: "https://uhdmovies.ceo", layout: "uhd" },
  moviesmod: { label: "MoviesMod", base: "https://moviesmod.fi", layout: "mod" },
  moviesleech: { label: "MoviesLeech", base: "https://moviesleech.help", layout: "mod" },
};

export function setup(runtime, config = {}) {
  rt = runtime;
  if (config.sites) for (const [id, s] of Object.entries(config.sites)) SITES[id] = { ...SITES[id], ...s };
}

const UA = () => rt.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
async function get(url, extra = {}) {
  const r = await rt.dnsFetch(url, { headers: { "User-Agent": UA(), ...extra }, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
const text = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&#8211;|&ndash;/g, "-").replace(/&amp;/g, "&").replace(/&#0?39;|&#8217;/g, "'").replace(/\s+/g, " ").trim();
const norm = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
const QUALITY = (s) => (/2160p|4k/i.test(s) ? "2160p" : /1080p/i.test(s) ? "1080p" : /720p/i.test(s) ? "720p" : /480p/i.test(s) ? "480p" : "");
const SIZE = (s) => s.match(/\b(\d+(?:\.\d+)?)\s*(GB|MB)\b/i)?.slice(1).join(" ").toUpperCase().replace(/\s+/, " ") || "";

/** Post links on a search page whose title matches the film (and year when known). */
async function searchSite(id, title, year, season) {
  const s = SITES[id];
  const html = await get(`${s.base}/?s=${encodeURIComponent(title)}`);
  const want = norm(title).split(" ").filter((w) => w.length > 1);
  const seen = new Set();
  const posts = [];
  for (const m of html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*?(?:title="([^"]+)")?[^>]*>/gi)) {
    const [, href, ttl] = m;
    let u;
    try { u = new URL(href); } catch { continue; }
    if (u.origin !== new URL(s.base).origin || !/^\/[a-z0-9-]{12,}\/?$/i.test(u.pathname) || seen.has(u.pathname)) continue;
    const label = text(ttl || u.pathname.replace(/[-/]/g, " "));
    const n = norm(label);
    // The title, then what posts put after it (year, season, audio…): "Money Heist" isn't "Money Heist Korea".
    const base = n.replace(/^download /, "");
    const t = norm(title);
    if (!want.every((w) => n.includes(w)) || !base.startsWith(t) || !/^(?:$| (?:\d{4}|season|s\d|series|complete|dual|hindi|english|multi|part|\d{3,4}p|imax|extended|uncut|movie)\b)/.test(base.slice(t.length))) continue;
    if (season) {
      // Series: a season post (or a multi-season pack) — never a film of the same name.
      const looksSeries = /(?:^| )(?:season|series|complete|s\d{1,2})(?: |$)/.test(n);
      if (!looksSeries) continue;
    } else if (year && !n.includes(String(year))) continue;
    seen.add(u.pathname);
    posts.push({ url: u.href, label });
  }
  return posts.slice(0, 4);
}

/**
 * UHDMovies paragraphs: the post body split at each <p>. Release names sit in their own
 * paragraph (in <strong>, or plain and unclosed on newer posts), buttons in the next ones.
 */
function uhdParas(html) {
  const parts = html.split(/(?=<p[\s>])/i);
  let at = 0;
  return parts.map((raw) => { const p = { raw, at, text: text(raw) }; at += raw.length; return p; });
}
const SID = /href="(https?:\/\/[^"]+\?sid=[^"]+)"/i;
const SIZE_TAG = /\[\s*[\d.]+\s*[GM]B\s*\]/i;
const isRelease = (p) => !SID.test(p.raw) && /\d{3,4}p|4k/i.test(p.text) && (SIZE_TAG.test(p.text) || /\b(?:x26[45]|hevc|bluray|web-?dl|webrip)\b/i.test(p.text)) && p.text.length < 700;

/** UHDMovies: a paragraph with the release name and [size], then a Google Drive button. */
function uhdEntries(html) {
  const out = [];
  const ps = uhdParas(html);
  ps.forEach((p, i) => {
    if (!isRelease(p)) return;
    const btn = ps.slice(i + 1, i + 3).find((q) => SID.test(q.raw));
    if (!btn) return;
    const name = p.text;
    out.push({ name: name.replace(SIZE_TAG, "").trim(), size: SIZE(name), quality: QUALITY(name), link: btn.raw.match(SID)[1] });
  });
  return out;
}

/** MoviesMod / MoviesLeech: an <h3>/<h4> "1080p [2GB]" heading, then a links-page button. */
function modEntries(html) {
  const out = [];
  const re = /<h[34][^>]*>([\s\S]{3,300}?)<\/h[34]>\s*<p[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"/gi;
  for (const m of html.matchAll(re)) {
    const name = text(m[1]);
    if (!/\d{3,4}p/i.test(name) || /episode|zip|pack/i.test(name) && !/movie/i.test(name)) continue;
    out.push({ name, size: SIZE(name), quality: QUALITY(name), link: m[2] });
  }
  return out;
}

const EP = (s, e) => new RegExp(`\\bS0?${s}[\\s.]*E0?${e}(?!\\d)`, "i");

/** MoviesMod series: "Season N 720p [size/episode]" headings, each opening an episodes page. */
function modSeasonEntries(html, season) {
  const out = [];
  const re = /<h[34][^>]*>([\s\S]{3,300}?)<\/h[34]>\s*<p[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"/gi;
  for (const m of html.matchAll(re)) {
    const name = text(m[1]);
    const sn = Number(name.match(/season\s*(\d{1,2})/i)?.[1]);
    if (!/\d{3,4}p/i.test(name) || (sn && sn !== season) || /zip|pack/i.test(name)) continue;
    out.push({ name, size: SIZE(name), quality: QUALITY(name), link: m[2] });
  }
  return out;
}

/**
 * UHDMovies series: one block per quality (named after its first episode, with that
 * episode's size), followed by "Episode 1", "Episode 2"… buttons, each its own link.
 */
function uhdEpisodeEntries(html, season, episode) {
  const out = [];
  const ps = uhdParas(html);
  const blocks = ps.filter(isRelease);
  blocks.forEach((m, i) => {
    const name = m.text;
    const sm = name.match(/\bS(\d{1,2})E\d{1,3}/i);
    if (sm && Number(sm[1]) !== season) return;
    const body = html.slice(m.at + m.raw.length, blocks[i + 1]?.at ?? m.at + m.raw.length + 20000);
    const btn = [...body.matchAll(/href="(https?:\/\/[^"]+\?sid=[^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*Episode\s*0?(\d{1,3})\b/gi)].find((b) => Number(b[2]) === episode);
    if (btn) out.push({ name: name.replace(SIZE_TAG, "").replace(/\bS(\d{1,2})E\d{1,3}.*?(?=(?:2160|1080|720|480)p)/i, (x, sn) => `S${sn}E${String(episode).padStart(2, "0")}.`).trim(), size: SIZE(name) ? `~${SIZE(name)}` : "", quality: QUALITY(name), link: btn[1] });
    // Older posts name each episode's own block (S02E05 …) with a single button.
    else if (EP(season, episode).test(name)) { const one = body.match(SID); if (one) out.push({ name: name.replace(SIZE_TAG, "").trim(), size: SIZE(name), quality: QUALITY(name), link: one[1] }); }
  });
  return out;
}

/** Files for a film, or for one episode of a series: one row per release on each site. */
export async function fileSearch({ title, year, season, episode } = {}) {
  if (!title) throw new Error("title required");
  const tv = !!(season && episode);
  const results = await Promise.allSettled(Object.keys(SITES).map(async (id) => {
    const posts = await searchSite(id, title, year, tv ? season : undefined);
    const files = [];
    for (const p of posts.slice(0, tv ? 3 : 2)) {
      const html = await get(p.url);
      let entries;
      if (!tv) entries = SITES[id].layout === "uhd" ? uhdEntries(html) : modEntries(html);
      // UHDMovies lists every episode as its own release; keep this one.
      else if (SITES[id].layout === "uhd") entries = uhdEpisodeEntries(html, season, episode);
      // MoviesMod links an episodes page per quality: the episode is picked when it's resolved.
      else entries = modSeasonEntries(html, season).map((e) => ({ ...e, name: `${e.name.replace(/\s*\[[^\]]*\]\s*$/, "")} · Episode ${episode}`, link: `${e.link}#ep=${episode}` }));
      for (const e of entries) files.push({ site: id, siteLabel: SITES[id].label, post: p.label, ...e });
    }
    return files;
  }));
  const files = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const errors = results.map((r, i) => (r.status === "rejected" ? `${SITES[Object.keys(SITES)[i]].label}: ${r.reason?.message}` : null)).filter(Boolean);
  return { files, errors };
}

const REDIRECTOR = /\?sid=|\/r\.php\?id=/i;
const CHROME = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Ch-Ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms + Math.random() * 300));

/**
 * The redirect site in five requests, one cookie jar: GET ?sid → POST lp-land → POST the
 * "I'm not a robot" form → set the page's lp cookie → GET ?lp_go → read the target from
 * its location.replace(). Short pauses between steps: the site dislikes bursts.
 */
export async function resolveSid(sid) {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const go = async (url, opts = {}) => {
    const r = await rt.dnsFetch(url, { ...opts, headers: { "User-Agent": UA(), ...CHROME, Cookie: cookie(), ...(opts.headers || {}) }, signal: AbortSignal.timeout(25_000) });
    for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(";")[0]; const i = kv.indexOf("="); if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return r.text();
  };
  const origin = new URL(sid).origin;
  const land = (await go(sid)).match(/name="_lp_http"\s+value="([^"]+)"/)?.[1];
  if (!land) throw new Error("The link page changed");
  await pause(700);
  const form = (await go(`${origin}/`, { method: "POST", body: `_lp_http=${encodeURIComponent(land)}`, headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: sid, Origin: origin } }))
    .match(/<form[^>]*id="lp-s1-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) throw new Error("The link page changed");
  const fields = new URLSearchParams([...form[2].matchAll(/name="([^"]+)"\s+value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  await pause(800);
  const stage2 = await go(form[1], { method: "POST", body: fields.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${origin}/`, Origin: origin } });
  const token = stage2.match(/\?lp_go=([a-zA-Z0-9_-]+)/)?.[1];
  const ck = stage2.match(/sc\("([a-zA-Z0-9_-]+)","([^"]+)"/);
  if (!token || !ck) throw new Error("The link page changed");
  jar.set(ck[1], ck[2]);
  await pause(600);
  const out = await go(`${origin}/?lp_go=${token}`, { headers: { Referer: form[1] } });
  const target = out.match(/location\.replace\(["']([^"']+)["']/)?.[1]?.replaceAll("\\/", "/");
  if (!target) throw new Error(/session expired/i.test(out) ? "The link expired; try again" : "No link behind this button");
  return target;
}

/** A file row's link → direct file URL. */
export async function fileResolve(link) {
  let sids = [link];
  // MoviesMod/Leech buttons open a links page first: its redirect links, in order.
  // A series episodes page (#ep=N): the links after the "Episode N" heading.
  if (!REDIRECTOR.test(link)) {
    const ep = Number(link.match(/#ep=(\d+)$/)?.[1]);
    let html = await get(link.replace(/#ep=\d+$/, ""));
    if (ep) {
      // Each episode's link wraps its "Episode N" heading.
      const own = [...html.matchAll(/href=["']?(https?:\/\/[^"'\s>]+\?sid=[^"'\s>]+)[^>]*>((?:(?!<\/a>)[\s\S]){0,300})<\/a>/gi)]
        .find((m) => new RegExp(`^Episode\\s*0?${ep}(?!\\d)`, "i").test(text(m[2])));
      if (!own) throw new Error(`Episode ${ep} isn't on this page`);
      html = `href="${own[1]}"`;
    }
    sids = [...new Set([...html.matchAll(/href=["]?(https?:\/\/[^"\s>]+\?sid=[^"\s>]+)/gi)].map((m) => m[1]))];
    if (!sids.length) throw new Error("No download link on that page");
  }
  let last = "No file host behind this release";
  for (const sid of sids.slice(0, 6)) {
    try {
      const target = await resolveSid(sid);
      // Promo links go to the site's own pages; only DriveSeed carries files.
      if (/driveseed|driveleech/i.test(target)) return await driveseedDirect(target);
    } catch (e) { last = e.message; }
  }
  throw new Error(last);
}

/** DriveSeed file page → Instant Download → the Google file behind it. */
export async function driveseedDirect(pageUrl) {
  if (/googleusercontent\.com|\.r2\.dev|workers\.dev/i.test(pageUrl)) return { url: pageUrl };
  let html = await get(pageUrl);
  // /r?key=… and /l?id=… pages hop to /file/<id> by script.
  const hop = html.match(/location\.replace\(["'](\/file\/[^"']+)["']/)?.[1];
  if (hop) { pageUrl = new URL(hop, pageUrl).href; html = await get(pageUrl); }
  const name = text(html.match(/<title>([^<]+)/i)?.[1]);
  const size = html.match(/og:title"\s+content="[^"]*-\s*([\d.]+\s*[GM]B)"/i)?.[1] || "";
  const instant = html.match(/href="(https?:\/\/cdn\.[^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*Instant Download/i)?.[1]
    || html.match(/href="(https?:\/\/[^"]*video-(?:gen|seed)[^"]+)"/i)?.[1];
  if (!instant) throw new Error("No instant download on this file page");
  // Plain fetch: the redirect itself is the answer (dnsFetch follows redirects).
  const r = await fetch(instant, { redirect: "manual", headers: { "User-Agent": UA(), Referer: pageUrl }, signal: AbortSignal.timeout(25_000) });
  const loc = r.headers.get("location") || "";
  const direct = (() => { try { return new URL(loc).searchParams.get("url") || loc; } catch { return loc; } })();
  if (!/^https:\/\//.test(direct)) throw new Error("The file host didn't give a link");
  return { url: direct, name, size };
}

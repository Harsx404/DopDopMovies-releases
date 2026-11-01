// SportsIndX — aggregator listing several embed providers per match.
//
// DopDop live addon. Prefers StreamFree mirrors, which resolve to a real
// playlist, then other embeds resolved on the server, then a proxied iframe.
// The site address lives in index.json.

import { verifyLiveHls } from './live-media.mjs';

let cachedFetch, geoProxyFetch, resolveUrl, embedProxyUrl, packModule, captureStream, SPORTSINDX_BASE, streamfree, mediaRuntime;
const resolvedFeeds = new Map();
const resolvingFeeds = new Map();

export function setup(rt, config) {
  ({ cachedFetch, geoProxyFetch, resolveUrl, embedProxyUrl, packModule, captureStream } = rt);
  SPORTSINDX_BASE = config.base;
  mediaRuntime = { fetch: rt.smartFetch || rt.dnsFetch || rt.fetch, fetchStream: rt.dnsFetchStream, userAgent: rt.UA };
  resolvedFeeds.clear();
  resolvingFeeds.clear();
}

const verified = source => verifyLiveHls(source, mediaRuntime);

const sf = () => streamfree;
async function ready() {
  streamfree ??= await packModule("live-streamfree");
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#34;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Scrape the homepage schedule for all live/upcoming events across every category.
export async function events() {
  await ready();
  return cachedFetch("sportsindx:events", 120_000, fetchSportsIndxEvents);
}
async function fetchSportsIndxEvents() {
  const r = await sf().fetcher()(`${SPORTSINDX_BASE}/`, { headers: { Referer: SPORTSINDX_BASE + "/" } });
  const html = await r.text();

  const events = [];
  const seenSlugs = new Set();
  // Split into category-card blocks so we can tag each match with its category
  const categoryBlocks = html.split(/<details class="category-card"/).slice(1);
  for (const block of categoryBlocks) {
    const catMatch = block.match(/data-category="([^"]+)"/);
    const category = catMatch ? catMatch[1] : "other";
    const nameMatch = block.match(/<span class="category-name">([^<]+)<\/span>/);
    const categoryName = nameMatch ? nameMatch[1] : category;

    const rowRe = /<a class="match-row" href="\/match\/([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = rowRe.exec(block))) {
      const slug = m[1];
      if (seenSlugs.has(slug)) continue; // same match appears in multiple categories (e.g. Popular + Football)
      seenSlugs.add(slug);
      const attrs = m[2];
      const inner = m[3];
      const title = attrs.match(/data-title="([^"]*)"/)?.[1] || inner.match(/<span class="match-title">([^<]+)</)?.[1] || slug;
      const home = attrs.match(/data-home="([^"]*)"/)?.[1] || null;
      const away = attrs.match(/data-away="([^"]*)"/)?.[1] || null;
      const timestamp = inner.match(/data-timestamp="(\d+)"/)?.[1];
      events.push({
        slug,
        title: decodeHtmlEntities(title),
        home: home ? decodeHtmlEntities(home) : null,
        away: away ? decodeHtmlEntities(away) : null,
        category,
        categoryName,
        timestamp: timestamp ? Number(timestamp) / 1000 : null,
      });
    }
  }
  return events;
}

// Fetch a match page and parse its data-links attribute (JSON array of embed
// sources from multiple providers — StreamFree mirrors, TopEmbed, admin PPV, etc.)
async function getLinks(slug) {
  return cachedFetch(`sportsindx:links:${slug}`, 60_000, () => fetchLinks(slug));
}
async function fetchLinks(slug) {
  const matchUrl = `${SPORTSINDX_BASE}/match/${slug}`;
  const parseLinks = (html) => {
    const match = html.match(/\bdata-links\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!match) return null;
    try { return JSON.parse(decodeHtmlEntities(match[1] || match[2] || "")); } catch { return null; }
  };

  const response = await sf().fetcher()(matchUrl, { headers: { Referer: SPORTSINDX_BASE + "/" } });
  let links = parseLinks(await response.text());
  if (!links) {
    const workerResponse = await geoProxyFetch(matchUrl, SPORTSINDX_BASE + "/");
    if (workerResponse.ok) links = parseLinks(await workerResponse.text());
  }
  if (!links?.length) throw new Error("No stream sources found for this match");
  return links;
}

function decodePackedSportsPlayer(html) {
  const packed = html.match(/var (_\w+)=\[([\d,]+)\],(_\w+)=(\d+),(_\w+)=(\d+),(_\w+)=""/);
  if (!packed) return "";
  const values = packed[2].split(",").map(Number);
  const xorKey = Number(packed[4]);
  const subtract = Number(packed[6]);
  if (!values.length || !Number.isFinite(xorKey) || !Number.isFinite(subtract)) return "";
  return values.map((value) => String.fromCharCode((((value ^ xorKey) - subtract + 256) & 255))).join("");
}

async function resolveEmbeddedSportsHls(embedUrl, referer, depth = 0) {
  if (depth > 3) return null;
  const response = await geoProxyFetch(embedUrl, referer);
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("mpegurl") || embedUrl.includes(".m3u8")) return { url: embedUrl, referer };

  const html = await response.text();
  const combined = `${html}\n${decodePackedSportsPlayer(html)}`;
  const hls = combined.match(/https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/i)?.[0];
  if (hls) return { url: decodeHtmlEntities(hls), referer: embedUrl };

  const iframeMatches = [...combined.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)];
  for (const match of iframeMatches.slice(0, 3)) {
    const child = resolveUrl(embedUrl, decodeHtmlEntities(match[1]));
    if (!/^https?:\/\//i.test(child) || child === embedUrl) continue;
    try {
      const resolved = await resolveEmbeddedSportsHls(child, embedUrl, depth + 1);
      if (resolved) return resolved;
    } catch {}
  }
  return null;
}

// Resolve a SportsIndX match to a playable stream. Returns all embed links
// so the frontend can show them as source buttons. Tries StreamFree HLS first,
// then falls back to direct iframe embeds (including embedindia.st).
async function resolveMatch(slug) {
  const links = (await getLinks(slug)).filter(l => !/vip|premium|paid/i.test(l.status || ''))
    .sort((a, b) => Number(b.status === 'Verified') - Number(a.status === 'Verified'));
  if (!links.length) throw new Error("No stream sources available for this match");

  const streamfreeLinks = links.filter(
    (l) => /streamfree\.top|strmfree\.st/i.test(l.embedUrl) && l.embedUrl.includes("/embed/")
  );
  for (const streamfreeLink of streamfreeLinks) {
    try {
      const resolved = await sf().resolveEmbed(streamfreeLink.embedUrl, `${SPORTSINDX_BASE}/match/${slug}`);
      return await verified({ ...resolved, type: "hls", allLinks: links });
    } catch {}
  }

  // Resolve wrapper/obfuscated embeds to HLS on the server. This avoids black
  // frames caused by provider DNS, TLS, referrer, and iframe restrictions.
  for (const link of links.slice(0, 6)) {
    try {
      const resolved = await resolveEmbeddedSportsHls(link.embedUrl, `${SPORTSINDX_BASE}/match/${slug}`);
      if (resolved) {
        return await verified({ ...resolved, type: "hls", quality: link.quality || "HD", provider: link.name || link.provider, allLinks: links });
      }
    } catch {}
  }

  // Players that only reveal their stream when run: the desktop app plays them for a moment.
  // Outside it, or if none answers, fall to the iframe below only when there's no bridge at all.
  let noBridge = false;
  for (const link of links.slice(0, 2)) {
    try {
      const stream = await captureStream(link.embedUrl, `${SPORTSINDX_BASE}/match/${slug}`);
      return await verified({ ...stream, type: "hls", quality: link.quality || "HD", allLinks: links });
    } catch (e) {
      if (/needs app/i.test(e.message)) { noBridge = true; break; }
    }
  }
  if (!noBridge) throw new Error("No stream is playing for this match right now");

  // No direct HLS was available. Keep an iframe fallback, but make it
  // same-origin so browser DNS/frame restrictions do not immediately blank it.
  const BLOCKED_DOMAINS = ["embedindia.st", "embed.st", "streameo.online"];
  const best = links.find((l) => l.status === "Verified") || links[0];
  let embedUrl = best.embedUrl;
  let provider = best.name || best.provider;

  // If the best link is on a blocked domain, try to find one that isn't
  let chosen = best;
  try {
    const bestHost = new URL(best.embedUrl).hostname;
    if (BLOCKED_DOMAINS.includes(bestHost)) {
      const unblocked = links.find((l) => {
        try {
          const h = new URL(l.embedUrl).hostname;
          return !BLOCKED_DOMAINS.includes(h);
        } catch { return false; }
      });
      if (unblocked) chosen = unblocked;
    }
  } catch {}

  embedUrl = chosen.embedUrl;
  provider = chosen.name || chosen.provider;

  embedUrl = embedProxyUrl(embedUrl, `${SPORTSINDX_BASE}/match/${slug}`);
  provider = (chosen.name || chosen.provider) + " (proxied)";

  return { url: embedUrl, type: "iframe", provider, allLinks: links };
}


/** Stream choices for a match, for its page. */
export async function links(slug) {
  await ready();
  return getLinks(slug);
}

/** One chosen link, or the best available when `link` is absent. */
export function resolve({ slug, link, fresh = false }) {
  const key = `${slug}:${link ?? 'best'}`;
  const cached = resolvedFeeds.get(key);
  if (!fresh && cached?.expires > Date.now()) return Promise.resolve(cached.value);
  if (resolvingFeeds.has(key)) return resolvingFeeds.get(key);
  const work = resolveFeed({ slug, link }).then(value => {
    if (value.verified) resolvedFeeds.set(key, { value, expires: Date.now() + 60_000 });
    return value;
  }).finally(() => resolvingFeeds.delete(key));
  resolvingFeeds.set(key, work);
  return work;
}

async function resolveFeed({ slug, link }) {
  await ready();
  if (link === undefined || link === null) return resolveMatch(slug);
  const all = await getLinks(slug);
  const chosen = all[Number(link)];
  if (!chosen) throw new Error("That stream is no longer listed");
  if (/vip|premium|paid/i.test(chosen.status || '')) throw new Error('This feed requires a provider subscription');
  const referer = `${SPORTSINDX_BASE}/match/${slug}`;
  if (/streamfree\.top|strmfree\.st/i.test(chosen.embedUrl) && chosen.embedUrl.includes("/embed/")) {
    try {
      return await verified({ ...(await sf().resolveEmbed(chosen.embedUrl, referer)), type: "hls" });
    } catch { /* fall through to the generic path */ }
  }
  const hls = await resolveEmbeddedSportsHls(chosen.embedUrl, referer).catch(() => null);
  if (hls) {
    try { return await verified({ ...hls, type: "hls", quality: chosen.quality || "HD" }); }
    catch { /* A stale playlist is not a playable feed; try the live player. */ }
  }
  try {
    return await verified({ ...(await captureStream(chosen.embedUrl, referer)), type: "hls", quality: chosen.quality || "HD" });
  } catch (e) {
    if (!/needs app/i.test(e.message)) throw new Error("This stream isn't playing right now");
  }
  return { url: embedProxyUrl(chosen.embedUrl, referer), type: "iframe", provider: chosen.name || chosen.provider };
}

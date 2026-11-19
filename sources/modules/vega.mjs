// Vega family (VegaMovies, MoviesDrive, RogMovies) — Hindi / dual-audio direct files via gateway chains.
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs: setup() runs once
// with the app runtime and this module's config from index.json; resolve()
// runs per play. Hosts and endpoints live in index.json, not here.

let UA, dnsFetch, dnsFetchStream, ffmpegBin, PIXELDRAIN_API;

export function setup(rt, config) {
  ({ UA, dnsFetch, dnsFetchStream, ffmpegBin } = rt);
  PIXELDRAIN_API = config.pixeldrain;
}

// Lowercased words only, camelCase split — the base of title matching.
function cartoonNorm(s) {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ============================================================================
// VegaMovies — Bollywood/regional movies & series,
// title-keyed. Ported from Zenda-Cross/vega-providers (vega + hubcloud).
// Chain: search.php (Typesense JSON) → post page → quality blocks with
// nexdrive links → vcloud page (real URL hidden as atob(atob('...')) → ?token=)
// → unlocked host buttons: presigned R2, pixeldrain, CF workers, gpdl/hubcloud
// redirects ending at googleusercontent. Output = progressive mp4/mkv files.
// ============================================================================
//
// MoviesDrive — Vega's sister site: same
// Typesense search.php API, same host-button chain. Posts link to
// mdrive.lol archives (per-quality packs or "Single Episode" indexes) which
// list hubcloud drive/ + video/ links → gamerxyt/sportverse hubcloud.php
// unlock page → pixel/gpdl ?id= buttons → googleusercontent / pixeldrain.
//
// RogMovies — third clone in the same family (search.php Typesense +
// nexdrive gateway links).

const VEGA_GATEWAY_RE = /nexdrive|vcloud|hubcloud|hubdrive|hubcdn|gdflix|gdtot|fastdl|fast-dl|fsl\.|filebee|gamerxyt|hdlink|mdrive|vgmlinks/i;

const VEGA_JUNK_RE = /vegamovies|unpkg|fonts\.|gstatic|google\.com\/search|bit\.ly|t\.me|telegram|signup|wp-content|wp-includes|feed|xmlrpc|#|javascript:|\/category\//i;

// Glue/format words carry no title signal — "Dhurandhar The Revenge" otherwise
// fuzzy-matches "Cats and Dogs: The Revenge of Kitty Galore" on "the revenge".
const VEGA_STOPWORDS = new Set(("the a an of and to in for on at or part movie film full season s e ep episode episodes " +
  "hindi english dual audio multi web dl webdl webrip hdrip bluray bdrip brrip hdts hdtc camrip dvdrip predvd hevc x264 x265 mkv mp4 esub esubs uncensored uncut repack ds4k sdr raw undekha dubbed")
  .split(" "));

function vegaScore(query, candidate) {
  const filt = (s) => new Set(cartoonNorm(s).split(" ").filter((w) => w && !VEGA_STOPWORDS.has(w)));
  let qw = filt(query), cw = filt(candidate);
  // Title made only of glue words ("The Revenge") — fall back to raw overlap.
  if (!qw.size) {
    qw = new Set(cartoonNorm(query).split(" ").filter(Boolean));
    cw = new Set(cartoonNorm(candidate).split(" ").filter(Boolean));
  }
  if (!qw.size || !cw.size) return 0;
  let hit = 0;
  for (const w of qw) if (cw.has(w)) hit++;
  const overlap = hit / Math.max(qw.size, cw.size);
  // The post's name begins with the whole title and then adds a subtitle ("Stree 2: Sarkate Ka
  // Aatank" for "Stree 2"): that's the title, however long the subtitle.
  const q = cartoonNorm(query).trim(), c = cartoonNorm(candidate).trim();
  return q && c.startsWith(q + " ") ? Math.max(overlap, 0.8) : overlap;
}

// MKV CodecID strings and mp4 sample-entry fourccs for audio Chromium decodes
// vs audio it can't. First ~512KB of a file always contains the track headers.
const BAD_AUDIO_RE = /A_(?:AC3|EAC3|TRUEHD|DTS|MLP|PCM)|ac-3|ec-3|ac-4|dts[cehlx]|mlpa|twos|sowt/i;

const GOOD_AUDIO_RE = /A_(?:AAC|MP3|OPUS|VORBIS|FLAC)|mp4a/i;

function within(work, ms, fallback = null) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

export async function probeVegaMedia(url) {
  const r = await dnsFetchStream(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-1023' } });
  try {
    if (![200, 206].includes(r.statusCode)) return null;
    let bytes = Buffer.alloc(0);
    for await (const chunk of r.stream) {
      bytes = Buffer.concat([bytes, chunk]).subarray(0, 1024);
      if (bytes.length >= 16) {
        const valid = bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) || bytes.subarray(4,8).toString() === 'ftyp' || (bytes[0] === 0x47 && bytes[188] === 0x47);
        return valid ? (r.url || url) : null;
      }
    }
    return null;
  } finally { r.stream.destroy(); }
}

async function probeAudioSupport(streamUrl) {
  try {
    // dnsFetchStream — dnsFetch buffers whole bodies, and hosts that ignore
    // Range would download a 1.5GB movie just to sniff its header.
    const { statusCode, stream } = await dnsFetchStream(streamUrl, {
      headers: { "User-Agent": UA, Range: "bytes=0-524287" },
    });
    if (statusCode >= 400) { stream.destroy(); return "unknown"; }
    const chunks = [];
    let n = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      n += chunk.length;
      if (n >= 524288) { stream.destroy(); break; }
    }
    const head = Buffer.concat(chunks).toString("latin1");
    if (BAD_AUDIO_RE.test(head)) return "bad";
    if (GOOD_AUDIO_RE.test(head)) return "good";
    return "unknown";
  } catch { return "unknown"; }
}

async function vegaText(url, base) {
  const r = await dnsFetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", Referer: `${base}/` },
  });
  if (!r.ok) throw new Error(`Vega ${r.status} for ${new URL(url).hostname}`);
  return r.text();
}

async function vegaSearch(query, base, retried = false) {
  const r = await dnsFetch(`${base}/search.php?q=${encodeURIComponent(query)}&page=1`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`search HTTP ${r.status}`);
  const finalUrl = r.headers.get('x-final-url') || base + '/search.php';
  const body = await r.text();
  if (!retried && body.trimStart().startsWith('<') && new URL(finalUrl).origin !== new URL(base).origin)
    return vegaSearch(query, new URL(finalUrl).origin, true);
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('Search endpoint returned a page instead of catalog data'); }
  return (data.hits || []).map(h => h.document).filter(h => h?.permalink && h.post_title)
    .map(h => ({ ...h, permalink: new URL(h.permalink, finalUrl).href }));
}

export function parseVegaHtmlSearch(html, base) {
  const hits = new Map();
  for (const m of html.matchAll(/<a\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(m[3].replace(/&amp;/g, '&'), base); } catch { continue; }
    if (url.origin !== new URL(base).origin || !/\/\d+-[^/]+\.html$/.test(url.pathname)) continue;
    const title = ((m[1]+m[4]).match(/\btitle=(["'])(.*?)\1/i)?.[2] || m[5].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (title && (!hits.has(url.href) || title.length > hits.get(url.href).post_title.length)) hits.set(url.href, { permalink: url.href, post_title: title });
  }
  return [...hits.values()];
}

// vegamoviess.mobi / vega-hot.com clones: no search.php API — they answer the
// classic "do=search&subaction=search&story=" form and return HTML post cards
// whose anchors carry the full title in `title=` / inner text.
async function vegaSearchHtml(query, base) {
  // The clone's search tokenizes badly on punctuation — "India's" misses
  // "Indias" posts entirely, so strip quotes/apostrophes from the story term.
  const story = query.replace(/[''\"`]/g, "");
  const r = await dnsFetch(`${base}/index.php?do=search&subaction=search&story=${encodeURIComponent(story)}`, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", Referer: `${base}/` },
  });
  if (!r.ok) throw new Error(`search HTTP ${r.status}`);
  const html = await r.text();
  return parseVegaHtmlSearch(html, r.headers.get('x-final-url') || base);
}

// "Download Title (2024) Hindi WEB-DL 480p 720p" → {title, year}
function vegaCleanTitle(raw) {
  let t = String(raw || "").replace(/^download\s+/i, "");
  const year = (t.match(/\b(19|20)\d{2}\b/) || [])[0];
  // Newer posts run on into sizes and formats ("Full Movie WeB-DL 480p [350MB] | 720p…"):
  // the name ends where those begin, or they drown it out when compared.
  t = t.replace(/\s(?:\||\[|\{).*$/, " ").replace(/\b(?:full\s*movie|\d{3,4}p)\b.*$/i, " ");
  t = t
    .replace(/\b(19|20)\d{2}\b/, " ")
    .replace(/\b(season\s*\d+|s\d{1,2}\b|all\s*seasons?|complete|hindi|english|dual\s*audio|multi\s*audio|web-?dl|webrip|hdrip|bluray|bdrip|brrip|hdts|hdtc|camrip|dvdrip|pre-?dvd|hevc|x26[45]|10-?bit|\d{3,4}p|4k|mkv|mp4|esubs?|with\s*subtitles?|amzn|prime\s*video|netflix|jio\s*hotstar|hotstar|zee5|sony\s*liv|mx\s*player|apple\s*tv\+?|full\s*movie|full\s*series|web\s*series|all\s*episodes?|added|uncut|unrated|extended|imax|ddp?\d[\d.]*|aac|atmos|esub)\b/gi, " ")
    .replace(/[[\]{}()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { title: t, year: year ? Number(year) : null };
}

// Anchors pointing at download gateways, tagged with the quality label of the
// nearest preceding block header and whether they sit in a "Single Episodes"
// (per-episode index) row rather than a batch/zip pack.
export function vegaPageLinks(html) {
  const links = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].replace(/&amp;/g, "&");
    if (!VEGA_GATEWAY_RE.test(href) || VEGA_JUNK_RE.test(href)) continue;
    const ctx = html.slice(Math.max(0, m.index - 2500), m.index);
    const ctxText = [...ctx.matchAll(/>([^<>]{2,200})</g)].map((x) => x[1].trim()).filter(Boolean);
    const label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const quality = label.match(/\b(?:480|720|1080|2160)p|4k\b/i)?.[0]
      || (ctxText.slice().reverse().find((t) => /\b(480|720|1080|2160|4k)p?\b/i.test(t) && /p\b|4k/i.test(t)) || "").match(/\b(?:480|720|1080|2160)p|4k\b/i)?.[0] || "";
    links.push({
      url: href,
      quality,
      label,
      episodeIndex: ctxText.slice(-15).some((t) => /single\s*episodes?/i.test(t)) || /single\s*episodes?/i.test(label),
      batch: /batch|zip/i.test(label),
    });
  }
  return links;
}

// nexdrive/hubdrive pages either link straight to a vcloud page or (series)
// carry a "-:Episodes: N:-" index with one gateway link per episode.
function vegaFindVcloud(html) {
  const m = html.match(/href="(https?:\/\/[^"]*(?:vcloud|hubcloud)[^"]*)"/i);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

function vegaEpisodeLinks(html) {
  // Marker styles: Vega "-:Episodes: N:-", MoviesDrive "EP01" text, and the
  // .mobi clones' "-: Episodes: Bonus EP-04 :-".
  const markers = [...html.matchAll(/-:\s*Episodes?:\s*([\d.]+)\s*:-|\bEP\.?-?\s*0*(\d+)\b/gi)];
  const out = [];
  for (let i = 0; i < markers.length; i++) {
    const seg = html.slice(markers[i].index, markers[i + 1]?.index);
    const hrefs = [...seg.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, "&")).filter((h) => VEGA_GATEWAY_RE.test(h));
    // Prefer fast-dl (G-Direct): its verify form POSTs straight through to the
    // file URL, while vgmlinks/vcloud hops really are captcha-gated.
    const url = hrefs.find((h) => /fast-dl/i.test(h))
      || hrefs.find((h) => /vcloud|hubcloud/i.test(h))
      || hrefs[0];
    const ep = parseFloat(markers[i][1] || markers[i][2]);
    const bonus = /bonus/i.test(html.slice(Math.max(0, markers[i].index - 60), markers[i].index + markers[i][0].length));
    if (url && ep) out.push({ ep, url, bonus });
  }
  return out;
}

// vcloud pages hide the real URL as atob(atob('...')); decoding yields the same
// URL with ?token=... which unlocks the host buttons. Classify each host.
async function vegaVcloudHosts(vcloudUrl, base) {
  const html = await vegaText(vcloudUrl, base);
  let page = html;
  // vcloud-style token unlock: real URL hidden as atob(atob('...'))
  const tok = html.match(/atob\(atob\(['"]([^'"]+)['"]\)\)/);
  if (tok) {
    try {
      const dec = Buffer.from(Buffer.from(tok[1], "base64").toString(), "base64").toString().trim();
      if (/^https?:/i.test(dec)) page = await vegaText(dec, base).catch(() => html);
    } catch {}
  } else {
    // hubcloud drive//video pages: the unlock button is a hubcloud.php link on
    // a helper host (gamerxyt, sportverse) which serves the host-buttons page.
    const unlock = html.match(/href="(https?:\/\/[^"]*hubcloud\.php\?[^"]*)"/i);
    if (unlock) page = await vegaText(unlock[1].replace(/&amp;/g, "&"), base).catch(() => html);
  }
  const hosts = [];
  const push = (server, url, needsRedirect) => {
    if (!hosts.some((h) => h.url === url)) hosts.push({ server, url, needsRedirect });
  };
  for (const m of page.matchAll(/href="(https?:\/\/[^"]+)"/gi)) {
    const href = m[1].replace(/&amp;/g, "&");
    if (VEGA_JUNK_RE.test(href)) continue;
    if (/pixeldrain\.[a-z]+\/u\/negn6f/i.test(href)) continue; // tutorial stub, not a file
    if (/pixeld/i.test(href)) push("Pixeldrain", href);
    else if (/cloudflarestorage/i.test(href)) push("CF Storage", href);
    else if (/hubcdn/i.test(href) && !/\?id=/.test(href)) push("HubCdn", href);
    else if (/gofile/i.test(href)) continue; // needs account-token dance — skip
    else if (/fastdl|fsl\./i.test(href)) push("FastDl", href);
    else if (/hubcloud|gamerxyt|\?id=|\bid=/i.test(href)) push("GDrive", href, true);
    else if (/\.r2\.dev|workers\.dev|\.mkv|\.mp4|\?token=/i.test(href)) push("CF Worker", href);
  }
  // Real pixeldrain link hides in a script var when the button is a stub —
  // when present it replaces the button-derived pixeldrain links entirely.
  const pxl = page.match(/var\s+pxl\s*=\s*['"](https?:\/\/[^'"]+)['"]/i);
  if (pxl) {
    for (let i = hosts.length - 1; i >= 0; i--) if (hosts[i].server === "Pixeldrain") hosts.splice(i, 1);
    push("Pixeldrain", pxl[1]);
  }
  return hosts;
}

// gpdl/hubcloud links 302 → workers.dev → gamerxyt dl.php?link=<googleusercontent>.
// dnsFetch follows redirects; x-final-url reports the landing URL.
async function vegaFollowRedirect(url) {
  try {
    // Following a redirect may land on a multi-GB file. Never buffer that file
    // merely to discover its URL; only request a bounded header sample.
    const r = await dnsFetchStream(url, { headers: { 'User-Agent': UA, Referer: url, Range: 'bytes=0-1023' } });
    try {
      if (r.statusCode >= 400) return null;
      const final = new URL(r.url || url);
      const link = final.searchParams.get('link');
      if (link && /^https?:\/\//i.test(link)) return link;
      if (r.statusCode === 206 || /^video\//i.test(r.headers['content-type'] || '') || /googleusercontent|\/api\/file\//i.test(final.href)) return final.href;
      return null;
    } finally { r.stream.destroy(); }
  } catch {
    return null;
  }
}

// fast-dl.one "G-Direct" pages: the Turnstile widget is cosmetic — a bare POST
// to the same URL returns the page with the real file link (googleusercontent).
async function vegaFastDl(url) {
  try {
    // Current fast-dl pages link "dl.php?code=…&secret=…", which 302s to the
    // file. Follow it with a 1-byte range so only the final URL is read.
    const page = await vegaText(url, new URL(url).origin).catch(() => "");
    const dl = page.match(/href="([^"]*dl\.php\?[^"]+)"/i)?.[1];
    if (dl) {
      const { statusCode, stream, url: final } = await dnsFetchStream(new URL(dl.replace(/&amp;/g, "&"), url).href, {
        headers: { "User-Agent": UA, Referer: url, Range: "bytes=0-0" },
      });
      stream.destroy();
      if (statusCode < 400 && !/fast-dl\./i.test(final)) return final;
    }
    // Older mirrors: POST the page and read the direct link out of the reply.
    const r = await dnsFetch(url, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Referer: url },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const direct = html.match(/href="(https?:\/\/[^"]*(?:googleusercontent|video-downloads)[^"]*)"/i);
    if (direct) return direct[1].replace(/&amp;/g, "&");
    return [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)]
      .map((x) => x[1].replace(/&amp;/g, "&"))
      .find((h) => !VEGA_JUNK_RE.test(h) && !/fast-dl\.one/i.test(h) && /\.mkv|\.mp4|drive\.google|workers\.dev|r2\.dev|pixel|download/i.test(h)) || null;
  } catch {
    return null;
  }
}

// Newer MoviesDrive posts link to hubcloud.ist/drive/search-recover.php, a JS app
// whose file list is fetched from ?api=search. Decode the base64 `q` param, call
// the API, and continue resolving the first matching file page.
async function hubcloudSearchRecoverFile(url) {
  try {
    const u = new URL(url);
    const q = u.searchParams.get("q");
    const fromAc = u.searchParams.get("from_ac");
    if (!q || !fromAc) return null;
    let decoded;
    try { decoded = Buffer.from(q, "base64").toString("utf8"); } catch { return null; }
    const api = `${u.origin}${u.pathname}?from_ac=${encodeURIComponent(fromAc)}&q=${encodeURIComponent(decoded)}&api=search&page=1`;
    const r = await dnsFetch(api, { headers: { "User-Agent": UA, Accept: "application/json", Referer: url } });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    const hit = data?.hits?.[0];
    if (!hit?.url) return null;
    return hit.url;
  } catch { return null; }
}

async function vegaResolveDownloadLink(link, epNum, base) {
  if (/fast-dl\.|vgmlinks/i.test(link)) {
    const direct = await vegaFastDl(link);
    return direct ? [{ server: "G-Direct", url: direct }] : [];
  }
  // HubCloud search-recover gateway: the HTML has no links; results come from an API.
  if (/hubcloud\.[a-z]+\/drive\/search-recover\.php/i.test(link)) {
    const fileUrl = await hubcloudSearchRecoverFile(link);
    return fileUrl ? vegaResolveDownloadLink(fileUrl, epNum, base) : [];
  }
  let vcloud = link;
  if (!/vcloud|hubcloud/i.test(link)) {
    const page = await vegaText(link, base);
    if (epNum != null) {
      const eps = vegaEpisodeLinks(page);
      const row = eps.find((e) => e.ep === epNum && !e.bonus) || eps.find((e) => e.ep === epNum)
        || eps.find((e) => Math.floor(e.ep) === epNum) || eps[0];
      vcloud = row?.url || vegaFindVcloud(page);
    } else {
      vcloud = vegaFindVcloud(page)
        || page.match(/href="(https?:\/\/[^"]*fast-dl\.[^"]+)"/i)?.[1]?.replace(/&amp;/g, "&");
    }
    if (!vcloud) return [];
    if (/fast-dl\.|vgmlinks/i.test(vcloud)) {
      const direct = await vegaFastDl(vcloud);
      return direct ? [{ server: "G-Direct", url: direct }] : [];
    }
    if (!/vcloud|hubcloud/i.test(vcloud)) return vegaResolveDownloadLink(vcloud, null, base); // one more hop
  }
  const hosts = await vegaVcloudHosts(vcloud, base);
  const out = await Promise.all(hosts.slice(0, 6).map(h => within((async () => {
    let url = h.url;
    if (/pixeldrain\.[a-z]+\/u\//i.test(url)) {
      url = `${PIXELDRAIN_API}/api/file/${url.split("/u/")[1].split(/[/?#]/)[0]}?download`;
    } else if (h.needsRedirect) {
      url = await vegaFollowRedirect(url);
      if (!url) return null;
    }
    const verified = await probeVegaMedia(url);
    return verified ? { server: h.server, url: verified } : null;
  })(), 10000)));
  return out.filter(Boolean);
}

const VEGA_RANK = (q) => (/1080/.test(q) ? 0 : /720/.test(q) ? 1 : /2160|4k/i.test(q) ? 2 : 3);

async function resolveVegaLike({ base, name, searchBases }, type, title, season, episode, tmdbId, year) {
  if (!title) throw new Error(`${name}: title required`);
  const isTv = type === "tv";
  const searchers = searchBases || [{ base, search: vegaSearch }];
  const variants = isTv && Number(season) > 1
    ? [`${title} season ${season}`, title]
    : year ? [`${title} ${year}`, title] : [title];
  let best = null, searchError;
  for (const { base: sb, search } of searchers) {
    for (const q of variants) {
      const hits = await search(q, sb).catch(e => { searchError = e; return []; });
      const top = hits
        .map((h) => {
          const clean = vegaCleanTitle(h.post_title);
          let s = vegaScore(q.replace(/\s*season\s*\d+/i, "").replace(/\b(19|20)\d{2}\b/, ""), clean.title);
          // A post stamped a different release year is a different title —
          // glue-word overlap otherwise matches unrelated sequels/spinoffs.
          if (!isTv && year && clean.year && Number(clean.year) !== Number(year)) return { h, s: 0 };
          if (isTv !== /season|series|episode/i.test(h.post_title)) return { h, s: 0 };
          if (s < 0.55) return { h, s: 0 };
          if (year && Number(clean.year) === Number(year)) s += 0.15;
          if (isTv === /season|series|episode/i.test(h.post_title)) s += 0.15;
          if (isTv && new RegExp(`season\\s*0*${season}\\b`, "i").test(h.post_title)) s += 0.2;
          return { h, s };
        })
        .sort((a, b) => b.s - a.s)[0];
      if (top && (!best || top.s > best.s)) best = { ...top, base: new URL(top.h.permalink, sb).origin };
      if (best && best.s >= 0.85) break;
    }
    if (best && best.s >= 0.85) break;
  }
  if (!best || best.s < 0.55) throw new Error(searchError ? `${name}: catalog unavailable (${searchError.message})` : `${name}: no match for "${title}"`);

  const postBase = best.base;
  const postUrl = new URL(best.h.permalink, postBase).toString();
  const html = await vegaText(postUrl, postBase);
  let links = vegaPageLinks(html);

  let epNum = null;
  if (isTv) {
    epNum = Number(episode) || 1;
    links = links.filter((l) => l.episodeIndex && !l.batch);
    links.sort((a, b) => (b.quality === "720p") - (a.quality === "720p"));
    if (!links.length) links = vegaPageLinks(html).filter((l) => !l.batch);
  } else {
    links = links.filter((l) => !l.batch);
    const rank = link => VEGA_RANK(link.quality) + (/hevc|h\.?265|10.?bit/i.test(link.label) ? 4 : 0);
    links.sort((a, b) => rank(a) - rank(b));
  }
  if (!links.length) throw new Error(`${name}: no download links`);

  const qualities = [];
  const seen = new Set();
  // Each link is a multi-hop chain (gateway → unlock page → host buttons →
  // redirect) — resolve the top links in parallel to stay under the frontend's
  // resolve timeout.
  const perLink = await Promise.all(links.slice(0, 3).map((l) => within(vegaResolveDownloadLink(l.url, epNum, postBase), 22000, [])));
  for (const [i, streams] of perLink.entries()) {
    for (const s of streams) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      qualities.push({ quality: [links[i].quality, s.server].filter(Boolean).join(" · ") || s.server, url: s.url, type: "mp4" });
    }
    if (qualities.length >= 4) break;
  }
  const checked = await Promise.all(qualities.map(q => within(probeVegaMedia(q.url), 8000).then(url => url ? { ...q, url } : null)));
  qualities.splice(0, qualities.length, ...checked.filter(Boolean));
  if (!qualities.length) throw new Error(`${name}: download servers returned no playable video`);

  // These packs are usually MKV with AC3/EAC3 audio Chromium can't decode —
  // silent video. Probe each stream's header; when the audio is unsupported
  // and ffmpeg is available, route the file through the local remux endpoint
  // (AAC audio over an fMP4 HLS playlist) instead of the raw URL.
  const canRemux = !!(await ffmpegBin());
  if (canRemux) {
    await Promise.all(qualities.map(async (q) => {
      const verdict = await Promise.race([
        probeAudioSupport(q.url),
        new Promise((r) => setTimeout(() => r("unknown"), 12000)),
      ]);
      if (verdict === "bad") {
        q.url = `/api/remux?url=${encodeURIComponent(q.url)}`;
        q.type = "hls";
      }
    }));
  }

  return { cdn: new URL(postBase).hostname.replace(/^www\.|^new\d+\./, ""), verified: true, qualities };
}

// params.search: the site's mirrors, tried in order. api "html" = the DLE
// clones' "do=search" form, "typesense" = /search.php JSON. Domains rotate
// often — update them in index.json.
const SEARCHERS = { html: vegaSearchHtml, typesense: vegaSearch };

// ============================================================================
// 4KHDHub — English BluRay/WEB releases (2160p REMUX/HDR down to 1080p).
// Chain: /?s= search cards → movie page (title "(YEAR)") → download items, each
// a release header ("The Odyssey (2160p BluRay HDR H265)") with gateway links
// (greenmotors ?id= → base64·base64·rot13·base64 JSON whose "o" is the
// base64 hubcloud URL, or plain hubcloud/hubdrive links) → hubcloud drive page
// → the same host-button chain as MoviesDrive. The page's own "Watch" iframe is
// the Videasy player (a different upload), so it's never used here.
// ============================================================================

const hdRot13 = (s) => s.replace(/[a-z]/gi, (c) => {
  const base = c <= "Z" ? 65 : 97;
  return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
});
const hdB64 = (s) => Buffer.from(s, "base64").toString();

// Theatre recordings and early telesync rips — never play these.
const HDHUB_BAD_RE = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine|predvd|pre-?dvd|scr|screener)\b/i;

export function parse4khdhubSearch(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\s+href="([^"]+)"\s+class="movie-card"[^>]*aria-label="([^"]+?)(?:\s+details)?"/gi)) {
    out.push({ url: new URL(m[1], base).href, title: m[2].replace(/&amp;/g, "&").replace(/&#0?39;/g, "'") });
  }
  return out;
}

// Each download item: header label, file name, and its gateway links.
export function parse4khdhubReleases(html) {
  const out = [];
  const parts = html.split(/<div class="download-item\b/i).slice(1);
  for (const part of parts) {
    const label = (part.match(/download-header[^>]*>\s*<div[^>]*>\s*([^<]+)/i)?.[1] || "").trim();
    const file = (part.match(/class="file-title">([^<]+)/i)?.[1] || "").trim();
    const links = [...part.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, "&"))
      .filter((h) => /\?id=|hubcloud|hubdrive|hubcdn/i.test(h) && !/4khdhub/i.test(h));
    if (label || file) out.push({ label, file, links });
  }
  return out;
}

export function rank4khdhubRelease(r) {
  const s = `${r.label} ${r.file}`;
  if (HDHUB_BAD_RE.test(s.replace(/[._]/g, " "))) return -1;
  // Season packs/episodes on a movie page aren't the film.
  if (/\bS\d{1,2}E\d{1,3}\b|\bS\d{1,2}\b.*complete/i.test(s)) return -1;
  let score = /2160p|\b4k\b|uhd/i.test(s) ? 300 : /1080p/i.test(s) ? 200 : /720p/i.test(s) ? 100 : 50;
  // Inside a tier: the encode streams better than an 80GB remux, and H264 plays
  // where HEVC isn't decoded.
  if (/remux/i.test(s)) score -= 20;
  if (/h\.?264|x264|avc/i.test(s) && !/h\.?265|x265|hevc/i.test(s)) score += 5;
  if (/bluray|blu-ray|web-?dl/i.test(s)) score += 2;
  return score;
}

// greenmotors-style gateway → hubcloud URL.
async function hdhubGateway(url, base) {
  if (/hubcloud|hubdrive|hubcdn/i.test(new URL(url).hostname)) return url;
  const html = await vegaText(url, base);
  const tok = html.match(/s\(\s*'o'\s*,\s*'([^']+)'/)?.[1];
  if (tok) {
    try {
      const data = JSON.parse(hdB64(hdRot13(hdB64(hdB64(tok)))));
      const target = data.o ? hdB64(data.o).trim() : "";
      if (/^https?:\/\//i.test(target)) return target;
    } catch {}
  }
  return html.match(/href="(https?:\/\/[^"]*(?:hubcloud|hubdrive)[^"]*)"/i)?.[1]?.replace(/&amp;/g, "&") || null;
}

async function resolve4khdhub(params, req) {
  const name = params.name || "4KHDHub";
  const title = req.title || req.cartoonTitle;
  if (!title) throw new Error(`${name}: title required`);
  if (req.type === "tv") throw new Error(`${name}: movies only`);
  const year = req.year ? Number(req.year) : null;

  let base, cards = [], searchError;
  for (const b of params.bases) {
    try {
      cards = parse4khdhubSearch(await vegaText(`${b}/?s=${encodeURIComponent(title)}`, b), b);
      base = b;
      break;
    } catch (e) { searchError = e; }
  }
  if (!base) throw new Error(`${name}: catalog unavailable (${searchError?.message})`);
  const candidates = cards
    .map((c) => ({ ...c, s: vegaScore(title, c.title) }))
    .filter((c) => c.s >= 0.55 && !/-series-|season/i.test(c.url))
    .sort((a, b) => b.s - a.s)
    .slice(0, 4);
  if (!candidates.length) throw new Error(`${name}: no match for "${title}"`);

  // Same-name films are common ("The Odyssey" 1997/2026): the page's <title>
  // carries the year, which must match.
  let page = null;
  for (const c of candidates) {
    const html = await vegaText(c.url, base).catch(() => "");
    const y = Number(html.match(/<title>[^<]*\((\d{4})\)/i)?.[1]) || null;
    if (year && y && Math.abs(y - year) > 1) continue;
    if (year && !y) continue;
    page = { url: c.url, html };
    break;
  }
  if (!page) throw new Error(`${name}: no ${year || ""} page for "${title}"`.replace("  ", " "));

  const releases = parse4khdhubReleases(page.html)
    .map((r) => ({ ...r, rank: rank4khdhubRelease(r) }))
    .filter((r) => r.rank >= 0 && r.links.length)
    .sort((a, b) => b.rank - a.rank);
  if (!releases.length) throw new Error(`${name}: no playable releases`);

  const tag = (r) => (r.label.match(/\(([^)]+)\)\s*$/)?.[1] || r.file || "file");
  const resolveRelease = async (r) => {
    for (const link of r.links) {
      const hub = await hdhubGateway(link, base).catch(() => null);
      if (!hub) continue;
      const streams = await vegaResolveDownloadLink(hub, null, base).catch(() => []);
      if (streams.length) return streams;
    }
    return [];
  };
  // Best tier first; the next one or two resolve alongside as fallbacks.
  const picked = releases.slice(0, 3);
  const perRelease = await Promise.all(picked.map((r) => within(resolveRelease(r), 30000, [])));
  const qualities = [];
  const seen = new Set();
  for (const [i, streams] of perRelease.entries()) {
    for (const s of streams.slice(0, 2)) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      qualities.push({ quality: `${tag(picked[i])} · ${s.server}`, url: s.url, type: "mp4" });
    }
  }
  if (!qualities.length) throw new Error(`${name}: download servers returned no playable video`);

  // BluRay audio is usually DTS/TrueHD/AC3 — remux to AAC when ffmpeg exists.
  if (await ffmpegBin()) {
    await Promise.all(qualities.map(async (q) => {
      const verdict = await within(probeAudioSupport(q.url), 12000, "unknown");
      if (verdict === "bad") { q.url = `/api/remux?url=${encodeURIComponent(q.url)}`; q.type = "hls"; }
    }));
  }
  return { cdn: new URL(base).hostname, verified: true, qualities, page: page.url };
}

export async function resolve(req, { params }) {
  if (params.site === "4khdhub") return resolve4khdhub(params, req);
  const searchBases = params.search.map((s) => ({ base: s.base, search: SEARCHERS[s.api] }));
  return resolveVegaLike({ base: searchBases[0].base, name: params.name, searchBases },
    req.type, req.cartoonTitle || req.title, req.season, req.episode, req.id, req.year);
}

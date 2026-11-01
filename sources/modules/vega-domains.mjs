// The VegaMovies.Domains catalog uses nested DLE post URLs and mhub gateways.
// Keep this resolver separate from MoviesDrive/RogMovies, whose flows differ.
export const VEGA_DOMAINS = 'https://vegamovies.domains';
const isCatalog = url => ['vegamovies.domains', 'www.vegamovies.domains'].includes(new URL(url).hostname);
const videoHeader = bytes => bytes.length >= 12 && (
  bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ||
  bytes.subarray(4, 8).toString() === 'ftyp' || (bytes[0] === 0x47 && bytes[188] === 0x47)
);

export function createVegaPageReader({ fetchStream, browserFetch, userAgent }) {
  const trace = (...args) => { if (process.env.DOPDOP_VEGA_DEBUG === '1') console.log('[vega]', ...args); };
  async function open(url, headers) {
    for (let hop = 0; hop < 6; hop++) {
      const r = await fetchStream(url, { headers: { 'User-Agent': userAgent, ...headers } });
      if (r.statusCode === 303 && r.headers.location) {
        r.stream.destroy();
        url = new URL(r.headers.location, url).href;
        continue;
      }
      return r;
    }
    throw new Error('VegaMovies: too many redirects');
  }
  async function readPage(url) {
    trace('page', new URL(url).hostname, new URL(url).pathname);
    const r = await open(url, { Accept: 'text/html,*/*' });
    trace('page HTTP', r.statusCode);
    if (isCatalog(url) && r.statusCode === 403) {
      r.stream.destroy();
      const page = await browserFetch(url);
      if (page.status !== 200) throw new Error(`VegaMovies: page HTTP ${page.status}`);
      return page;
    }
    if (r.statusCode >= 400) { r.stream.destroy(); throw new Error(`VegaMovies: HTTP ${r.statusCode}`); }
    const chunks = [];
    let size = 0;
    for await (const chunk of r.stream) {
      chunks.push(chunk);
      size += chunk.length;
      if (videoHeader(chunks[0])) { r.stream.destroy(); return { url: r.url || url, media: true }; }
      if (size > 2 * 1024 * 1024) { r.stream.destroy(); throw new Error('VegaMovies: page is too large'); }
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (isCatalog(url) && /<title>\s*Just a moment|cf-chl-/i.test(body)) return browserFetch(url);
    return { url: r.url || url, body, status: r.statusCode };
  }
  async function probeMedia(url) {
    trace('media', new URL(url).hostname);
    const r = await open(url, { Range: 'bytes=0-1023', Accept: '*/*' });
    try {
      if (![200, 206].includes(r.statusCode)) return null;
      let bytes = Buffer.alloc(0);
      for await (const chunk of r.stream) {
        bytes = Buffer.concat([bytes, chunk]).subarray(0, 1024);
        if (bytes.length >= 16) return videoHeader(bytes) ? { url: r.url || url } : null;
      }
      return null;
    } finally { r.stream.destroy(); }
  }
  return { readPage, probeMedia };
}
const entities = s => String(s).replace(/&amp;|&#0*38;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ');
const plain = s => entities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const httpUrl = (url, base) => {
  try {
    let u = new URL(entities(url), base);
    if (u.hostname === 'href.li' && u.search.startsWith('?http')) u = new URL(u.search.slice(1));
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
};
const gateway = url => /(?:mhub\.|lithub\.|nexdrive|vcloud|hubcloud|hubdrive|hubcdn|gdflix|fast-dl|vgmlinks)/i.test(new URL(url).hostname);
function anchors(html, base) {
  return [...html.matchAll(/<a\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map(m => ({ url: httpUrl(m[3], base), label: plain(m[5]), attrs: m[1] + m[4], index: m.index }))
    .filter(a => a.url);
}

export function parseVegaSearch(html, base = VEGA_DOMAINS) {
  const hits = new Map();
  for (const a of anchors(html, base)) {
    const u = new URL(a.url);
    if (u.origin !== new URL(base).origin || !/\/\d+-[^/]+\.html$/.test(u.pathname)) continue;
    const title = a.attrs.match(/\btitle\s*=\s*(["'])(.*?)\1/i)?.[2] || a.label;
    if (title && (!hits.has(a.url) || title.length > hits.get(a.url).post_title.length))
      hits.set(a.url, { post_title: entities(title), permalink: a.url });
  }
  return [...hits.values()];
}

export function parseVegaDownloads(html, base = VEGA_DOMAINS) {
  return anchors(html, base).filter(a => gateway(a.url)).map(a => {
    const before = html.slice(Math.max(0, a.index - 3000), a.index);
    const blocks = [...before.matchAll(/<(h[1-6]|p|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => plain(m[2]));
    const heading = blocks.reverse().find(t => /\b(?:480|720|1080|2160)p\b|\b4k\b/i.test(t)) || '';
    const quality = heading.match(/\b(?:480|720|1080|2160)p\b|\b4k\b/i)?.[0] || '';
    return { ...a, quality, heading, batch: /\b(?:batch|zip|pack)\b/i.test(a.label),
      season: Number(heading.match(/\b(?:season\s*|s)0*(\d+)\b/i)?.[1]) || null };
  });
}

export function parseVegaEpisodes(html, base) {
  const markers = [...html.matchAll(/-:\s*Episodes?:\s*([\d.]+)\s*:-|\b(?:EP\.?-?|Episode\s*:?)[ \t]*0*(\d+)\b/gi)];
  return markers.flatMap((m, i) => {
    const urls = anchors(html.slice(m.index, markers[i + 1]?.index), base).filter(a => gateway(a.url));
    return urls.map(a => ({ ...a, episode: Number(m[1] || m[2]) }));
  });
}

const rot13 = s => s.replace(/[a-z]/gi, c => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= 'm' ? 13 : -13)));
const normalizeTitle = s => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function cleanVegaTitle(raw) {
  const text = raw.replace(/^download\s+/i, '');
  const year = Number(text.match(/\((19\d{2}|20\d{2})\)/)?.[1]) || null;
  const title = text.split(/\((?:19|20)\d{2}\)|\bseason\s*\d|\bS\d{1,2}(?:E\d+)?\b|\b(?:dual|multi)\s*audio|\b(?:bluray|web-?dl|webrip|hdrip|480p|720p|1080p)\b/i)[0]
    .replace(/[[\]{}()]/g, ' ').trim();
  return { title, year };
}
function scoreVegaTitle(query, candidate) {
  const words = s => new Set(normalizeTitle(s).split(' ').filter(w => w && !['the', 'a', 'an', 'of', 'and'].includes(w)));
  const q = words(query), c = words(candidate);
  const overlap = [...q].filter(w => c.has(w)).length;
  return overlap / Math.max(q.size, c.size, 1);
}
function redirectMetadata(html, currentUrl) {
  // These strings are public link metadata embedded in the response, not the
  // user's browser cookies. Decode locally; never forward them as Cookie headers.
  const parts = [...html.matchAll(/ck\(['"]_wp_http_(\d+)['"],\s*['"]([A-Za-z0-9+/=]+)['"]/g)]
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (!parts.length) return null;
  try {
    const joined = parts.map(m => m[2]).join('');
    const twice = Buffer.from(Buffer.from(joined, 'base64').toString(), 'base64').toString();
    const data = JSON.parse(Buffer.from(rot13(twice), 'base64').toString());
    const blog = new URL(data.blog_url);
    if (blog.origin !== new URL(currentUrl).origin || typeof data.data !== 'string') return null;
    blog.searchParams.set('re', Buffer.from(data.data).toString('base64'));
    return { url: blog.href, waitMs: Math.min(45000, Math.max(31000, (Number(data.total_time) || 0) * 1000 + 2000)) };
  } catch { return null; }
}

export function decodeVegaRedirect(html, currentUrl) {
  return redirectMetadata(html, currentUrl)?.url || null;
}

export function createVegaDomainsProvider({ readPage, probeMedia, cleanTitle = cleanVegaTitle, scoreTitle = scoreVegaTitle,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, cacheTtlMs = 5 * 60_000 }) {
  const streams = new Map();
  const pending = new Map();
  const copy = result => ({ ...result, qualities: result.qualities.map(q => ({ ...q })) });
  async function chain(url, episode, visited = new Set(), depth = 0, control = {}) {
    if (control.stopped || depth > 8 || visited.has(url)) return null;
    visited.add(url);
    const page = await readPage(url);
    if (page.media) return probeMedia(page.url);
    const html = page.body;
    const finalUrl = page.url || url;
    const wrapped = new URL(finalUrl).searchParams.get('link');
    if (wrapped && httpUrl(wrapped, finalUrl)) return probeMedia(wrapped);
    const redirect = redirectMetadata(html, finalUrl);
    if (redirect) {
      // The gateway enforces this for new tickets. Probing the ticket early
      // can poison it with an error response; replay uses verified URLs below.
      await wait(redirect.waitMs);
      return chain(redirect.url, episode, visited, depth + 1, control);
    }
    const token = html.match(/atob\(atob\(['"]([^'"]+)['"]\)\)/)?.[1];
    if (token) {
      const decoded = Buffer.from(Buffer.from(token, 'base64').toString(), 'base64').toString().trim();
      if (httpUrl(decoded, finalUrl)) return chain(decoded, episode, visited, depth + 1, control);
    }
    const eps = parseVegaEpisodes(html, finalUrl);
    if (eps.length && episode != null) {
      const matches = eps.filter(e => e.episode === episode);
      for (const row of matches) {
        const result = await chain(row.url, null, new Set(visited), depth + 1, control).catch(() => null);
        if (result) return result;
      }
      return null; // Never silently play episode 1 for a missing episode.
    }
    const links = anchors(html, finalUrl).filter(a => !/signup|tutorial|telegram|bit\.ly|\/wp-|\/feed\//i.test(a.url));
    const pxl = html.match(/var\s+pxl\s*=\s*['"](https?:\/\/[^'"]+)['"]/i)?.[1];
    const hosts = [
      ...links.filter(a => /\.r2\.dev|cloudflarestorage/i.test(a.url)),
      ...(pxl ? [{ url: pxl }] : links.filter(a => /pixeldrain\.[^/]+\/u\//i.test(a.url) && !/\/u\/negn6f(?:[/?]|$)/i.test(a.url))),
      ...links.filter(a => {
        const target = new URL(a.url);
        return gateway(a.url) && a.url !== finalUrl && !/filepress|\/author\/|\/comments\//i.test(a.url)
          && (target.origin !== new URL(finalUrl).origin || target.search.length > 1);
      }),
    ];
    for (const host of hosts.slice(0, 6)) {
      if (control.stopped) return null;
      let target = host.url;
      const pixel = target.match(/pixeldrain\.[^/]+\/u\/([^/?#]+)/i);
      if (pixel) target = `https://pixeldrain.dev/api/file/${pixel[1]}?download`;
      try {
        if (/\.r2\.dev|cloudflarestorage|\/api\/file\/|\.m(?:p4|kv)(?:[?]|$)/i.test(target)) {
          const media = await probeMedia(target);
          if (media) return media;
        } else {
          const media = await chain(target, episode, new Set(visited), depth + 1, control);
          if (media) return media;
        }
      } catch { /* Try the next download server. */ }
    }
    return null;
  }

  async function resolveFresh(type, title, season, episode, year) {
    if (!title) throw new Error('VegaMovies: title required');
    const variants = [year ? `${title} ${year}` : title, title];
    let best;
    for (const query of new Set(variants)) {
      const url = `${VEGA_DOMAINS}/index.php?` + new URLSearchParams({ do: 'search', subaction: 'search', story: query.replace(/['’"`]/g, '') });
      const page = await readPage(url);
      const hits = parseVegaSearch(page.body);
      for (const hit of hits) {
        const clean = cleanTitle(hit.post_title);
        const isSeries = /season|series|episode|\bS\d{1,2}(?:E\d+)?\b/i.test(hit.post_title);
        if ((type === 'tv') !== isSeries || (year && clean.year && Math.abs(clean.year - year) > 1)) continue;
        const score = scoreTitle(title, clean.title);
        if (score < 0.7) continue;
        const ranked = score + (year && year === clean.year ? 0.1 : 0);
        if (!best || ranked > best.score) best = { hit, score: ranked };
      }
      if (best) break;
    }
    if (!best) throw new Error(`VegaMovies: no match for "${title}"`);
    const post = await readPage(best.hit.permalink);
    let links = parseVegaDownloads(post.body);
    if (type === 'tv') links = links.filter(l => !l.batch && (!l.season || l.season === Number(season || 1)));
    const rank = q => /1080/i.test(q) ? 0 : /720/i.test(q) ? 1 : /480/i.test(q) ? 2 : 3;
    links.sort((a, b) => rank(a.quality) - rank(b.quality));
    if (!links.length) throw new Error('VegaMovies: no download links for this season/title');
    for (let start = 0; start < Math.min(links.length, 4); start += 2) {
      const control = {};
      try {
        // Start playback as soon as a verified stream is ready. A slow or dead
        // alternate quality must not hold a working stream until timeout.
        const quality = await Promise.any(links.slice(start, start + 2).map(async link => {
          const media = await chain(link.url, type === 'tv' ? Number(episode || 1) : null, new Set(), 0, control);
          if (!media) throw new Error('No media on this download server');
          return { quality: link.quality || 'auto', url: media.url, type: 'mp4' };
        }));
        control.stopped = true;
        return { cdn: new URL(quality.url).hostname, verified: true, qualities: [quality] };
      } catch { /* Try the next available qualities. */ }
    }
    throw new Error('VegaMovies: download servers returned no playable video');
  }

  async function resolve(type, title, season, episode, year) {
    const key = JSON.stringify([type, normalizeTitle(title || ''), year || null,
      type === 'tv' ? Number(season || 1) : null, type === 'tv' ? Number(episode || 1) : null]);
    if (pending.has(key)) return copy(await pending.get(key));
    const operation = (async () => {
      const cached = streams.get(key);
      if (cached && cached.expires > now()) {
        const result = copy(cached.result);
        const media = await probeMedia(result.qualities[0].url).catch(() => null);
        if (media) {
          result.qualities[0].url = media.url;
          return result;
        }
      }
      streams.delete(key);
      const result = await resolveFresh(type, title, season, episode, year);
      if (streams.size >= 64) streams.delete(streams.keys().next().value);
      streams.set(key, { expires: now() + cacheTtlMs, result: copy(result) });
      return result;
    })();
    pending.set(key, operation);
    try { return copy(await operation); }
    finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  return { resolve };
}

// Source-pack entry points. The Vega source has its own module so sibling
// MoviesDrive/RogMovies behavior and their module versions stay unchanged.
let provider;
let runtime;
export function setup(rt) {
  runtime = rt;
  provider = createVegaDomainsProvider(createVegaPageReader({ fetchStream: rt.dnsFetchStream, userAgent: rt.UA,
    browserFetch: async url => {
      if (!globalThis.dopdopVegaFetch) throw new Error('VegaMovies: verification required — open the desktop app and select VegaMovies');
      return globalThis.dopdopVegaFetch(url);
    },
  }));
}
export async function resolve(req) {
  const result = await provider.resolve(req.type, req.cartoonTitle || req.title, req.season, req.episode, req.year);
  if (process.env.DOPDOP_VEGA_DEBUG === '1') console.log('[vega] stream resolved; probing audio');
  if (await runtime.ffmpegBin()) await Promise.all(result.qualities.map(async q => {
    const r = await runtime.dnsFetchStream(q.url, { headers: { 'User-Agent': runtime.UA, Range: 'bytes=0-524287' } }).catch(() => null);
    if (!r) return;
    try {
      if (r.statusCode >= 400) return;
      const chunks = [];
      let size = 0;
      for await (const chunk of r.stream) {
        chunks.push(chunk); size += chunk.length;
        if (size >= 524288) break;
      }
      const header = Buffer.concat(chunks).toString('latin1');
      if (/A_(?:AC3|EAC3|TRUEHD|DTS|MLP|PCM)|ac-3|ec-3|ac-4|dts[cehlx]|mlpa/i.test(header)) {
        q.url = `/api/remux?url=${encodeURIComponent(q.url)}`;
        q.type = 'hls';
      }
    } finally { r.stream.destroy(); }
  }));
  return result;
}

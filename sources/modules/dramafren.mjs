// DramaFren — native short-drama catalogs, independent of TMDB.
// Follows the source-pack contract: setup(runtime, config), resolve(req, ctx).
// Defaults can be overridden by source-pack config. Site JavaScript is parsed,
// never evaluated. Native catalog addon loaded through the source pack.
// Native IDs remain strings (NetShort IDs exceed Number.MAX_SAFE_INTEGER).
// Catalog language selects localized metadata/subtitles, not guaranteed audio.
// Example (same runtime passed to other sources):
//   setup(runtime);
//   await search('Married to the Wrong Twin', { platform: 'goodshort', lang: 'en' });
//   await resolve({ type: 'tv', platform: 'goodshort', dramaId: '31001855365', episode: 1 });
// Optional verified-browser access: runtime.browserFetch(url) -> {url,status,body}.

export const LANGUAGES = {
  dramafren: ['en'],
  dramabox: ['en', 'id', 'in', 'zhHans', 'es', 'de', 'fr', 'pt', 'ko', 'th', 'vi', 'zh', 'ar', 'ja', 'it'],
  dramawave: ['en-US', 'id-ID', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'es-MX', 'pt-PT', 'fr-FR', 'ru-RU', 'de-DE', 'vi-VN', 'it-IT', 'tr-TR', 'ms-MY', 'th-TH', 'tl-PH', 'hi-IN', 'ar-SA'],
  goodshort: ['en', 'id', 'es', 'ko', 'th', 'de', 'fr', 'pt', 'ar'],
  netshort: ['en', 'in', 'th', 'ms', 'pt', 'es', 'fr', 'de', 'it', 'tr', 'ar', 'ja', 'ko', 'zh_CN', 'zh_TW'],
  flickreels: ['en', 'id', 'th', 'ms', 'pt', 'es', 'fr', 'de', 'it', 'tr', 'ar', 'ja', 'ko', 'zh_CN', 'zh_TW'],
  stardusttv: ['en_US', 'zh_CN', 'ja_JP', 'ko_KR', 'es_ES', 'zh_TW', 'id_ID', 'th_TH', 'pt_BR', 'fr_FR', 'de_DE', 'ar_AE', 'vi_VN', 'tr_TR', 'ru_RU'],
};

export const DEFAULT_CONFIG = {
  defaultPlatform: 'dramabox', defaultLang: 'en',
  defaultServers: { goodshort: 2 },
  sites: {
    dramafren: { label: 'DramaFren', base: 'https://dramafren.org', note: 'Chinese short dramas; often full-series compilations with English subtitles' },
    dramabox: { label: 'DramaBox', base: 'https://dramabox.dramafren.org' },
    dramawave: { label: 'DramaWave', base: 'https://dramawave.dramafren.org' },
    goodshort: { label: 'GoodShort', base: 'https://goodshort.dramafren.org', note: 'Server 2 verified; server 1 proxy challenged when checked 2026-11-01' },
    netshort: { label: 'NetShort', base: 'https://netshort.dramafren.org' },
    flickreels: { label: 'FlickReels', base: 'https://flickreels.dramafren.org', note: 'Catalog and API working; sampled video CDN returned HTTP 403 on 2026-11-01' },
    stardusttv: { label: 'StarDustTV', base: 'https://stardusttv.dramafren.org' },
    radreel: { label: 'RadReel', base: 'https://radreel.dramafren.org', disabled: true, note: 'Linked by DramaFren; DNS unavailable when checked 2026-11-01' },
  },
  endpointHosts: [
    'cdn-dramabox.dramafren.org', 'cdn-dramaboxv2.dramafren.org', 'cdn-dramaboxv3.dramafren.org',
    'cdn-dramawave.dramafren.org', 'cdn-dramawavev2.dramafren.org',
    'cdn-netshort.dramafren.org', 'cdn-netshortv2.dramafren.org', 'cdn-netshortv3.dramafren.org',
    'cdn-flickreels.dramafren.org', 'cdn-flickreelsv2.dramafren.org',
  ],
};

export class DramaFrenError extends Error {
  constructor(message, code = 'UPSTREAM') { super(`DramaFren: ${message}`); this.name = 'DramaFrenError'; this.code = code; }
}
const fail = (message, code) => { throw new DramaFrenError(message, code); };
const challenge = body => /<title>\s*Just a moment|window\._cf_chl_opt|cf-chl-widget|Verify you are human/i.test(body);

function unescapeJs(value) {
  return value.replace(/\\(?:u([a-f\d]{4})|x([a-f\d]{2})|([\s\S]))/gi, (_, u, x, c) =>
    u || x ? String.fromCharCode(parseInt(u || x, 16)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] ?? c));
}
export function text(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp|ndash|mdash|rsquo|lsquo|rdquo|ldquo);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }[e.toLowerCase()] || m;
  }).replace(/\s+/g, ' ').trim();
}
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = text(m[2] ?? m[3] ?? m[4]);
  return out;
}
function httpUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const u = new URL(value, base); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
function meta(html, name) {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) { const a = attrs(m[0]); if (a.property === name || a.name === name) return a.content || ''; }
  return '';
}
const norm = s => text(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Read only literal assignments: JSON, quoted strings, numbers and simple
// arrays of strings. Function calls, expressions and executable code are ignored.
export function literals(html, name) {
  const values = [];
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const re = new RegExp(`\\b${name}\\s*=\\s*`, 'g');
    let match;
    while ((match = re.exec(script[1]))) {
      const source = script[1].slice(re.lastIndex);
      const first = source[0];
      let end = 0, quote = '', depth = 0, escaped = false;
      for (; end < source.length; end++) {
        const c = source[end];
        if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) { quote = ''; if (first === '"' || first === "'") { end++; break; } } }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') { if (--depth === 0) { end++; break; } }
        else if (!depth && /[;\r\n]/.test(c)) break;
      }
      const raw = source.slice(0, end).trim();
      try { values.push(JSON.parse(raw)); } catch {
        if (/^'(?:[^'\\]|\\.)*'$/.test(raw)) values.push(unescapeJs(raw.slice(1, -1)));
        else if (/^\[\s*(?:'(?:[^'\\]|\\.)*'\s*,?\s*)*\]$/.test(raw)) values.push([...raw.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => unescapeJs(m[1])));
      }
    }
  }
  return values;
}
const lastValue = (html, name) => literals(html, name).filter(v => typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : v != null).at(-1);

/** Optional desktop reader. Pass its result as runtime.browserFetch.
 * Uses the same isolated-window pattern as the app's Vega source, without
 * importing Electron or changing the app. Only configured source hosts open.
 */
export function createDramaFrenBrowserFetch({ BrowserWindow, config = DEFAULT_CONFIG, clickCheckbox, wait = ms => new Promise(r => setTimeout(r, ms)), attempts = 180 }) {
  let win, queue = Promise.resolve();
  const allowed = value => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && !u.port && !u.username && !u.password &&
        (Object.values(config.sites).some(s => new URL(s.base).origin === u.origin) || config.endpointHosts.includes(u.hostname));
    } catch { return false; }
  };
  async function read(target) {
    if (!allowed(target)) fail('catalog URLs only', 'BAD_REQUEST');
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({ show: false, width: 950, height: 720, title: 'DramaFren verification',
        webPreferences: { partition: 'persist:dramafren', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      win.webContents.setAudioMuted(true);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guard = (event, url) => { if (!allowed(url)) event.preventDefault(); };
      win.webContents.on('will-navigate', guard);
      win.webContents.on('will-redirect', guard);
    }
    const w = win;
    let solved = false;
    try {
      await w.loadURL(target).catch(e => { if (e.code !== 'ERR_ABORTED') throw e; });
      for (let i = 0; i < attempts; i++) {
        if (w.isDestroyed()) fail('verification window closed', 'NEEDS_CHECK');
        const page = await w.webContents.executeJavaScript(`({ title: document.title, type: document.contentType, text: document.body?.innerText || '', html: document.documentElement?.outerHTML || '' })`).catch(() => null);
        if (page && !/just a moment|security verification|verify you are human|verifying you are human/i.test(page.title + '\n' + page.text)) {
          const url = w.webContents.getURL();
          if (!allowed(url) || !page.html) fail('catalog navigation failed', 'UPSTREAM');
          solved = true;
          return { status: 200, url, body: /json|plain/.test(page.type) || /^\s*[\[{]/.test(page.text) ? page.text : page.html };
        }
        // Optional checkbox clicker supplied by the desktop runtime. A missing
        // widget or a puzzle leaves the window available for manual completion.
        if (clickCheckbox && (i === 2 || i === 10)) await clickCheckbox(w).catch(() => false);
        if (i === 2) { w.show(); w.focus(); }
        await wait(500);
      }
      fail('finish the Cloudflare checkbox in the browser window, then retry', 'NEEDS_CHECK');
    } finally { if (solved && !w.isDestroyed()) w.hide(); }
  }
  return target => { const result = queue.catch(() => {}).then(() => read(target)); queue = result; return result; };
}

export function languageFor(platform, requested = 'en') {
  const supported = LANGUAGES[platform] || [];
  if (supported.includes(requested)) return requested;
  let canonical = String(requested).replace(/_/g, '-').toLowerCase();
  canonical = ({ zh: 'zh-tw', 'zh-hant': 'zh-tw', 'zh-hans': 'zh-cn', zhhans: 'zh-cn', in: 'id' }[canonical] || canonical);
  const equivalent = s => ({ zhhans: 'zh-cn', zh: 'zh-tw', in: 'id' }[s] || s);
  const exact = supported.find(s => equivalent(s.replace(/_/g, '-').toLowerCase()) === canonical);
  const regional = !canonical.startsWith('zh') && supported.find(s => equivalent(s.replace(/_/g, '-').toLowerCase()).split('-')[0] === canonical.split('-')[0]);
  return exact || regional || fail(`language ${requested} is not available for ${platform}`, 'BAD_REQUEST');
}

export function parseCatalog(html, base, platform, lang) {
  const items = new Map();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = attrs(m[1]), href = httpUrl(a.href, base);
    if (!href) continue;
    const u = new URL(href);
    if (u.origin !== new URL(base).origin || (platform === 'dramafren' ? !/^\/(series|watch)\/[^/]+\/?$/.test(u.pathname) : u.searchParams.get('page') !== 'detail')) continue;
    const id = platform === 'dramafren' ? u.pathname : u.searchParams.get('id');
    const image = m[2].match(/<img\b[^>]*>/i)?.[0];
    const img = image ? attrs(image) : {};
    const title = text(m[2].match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i)?.[1] || a.title || img.alt || m[2]).replace(/\s*Watch Now(?:\s*\([A-Z_-]+\))?\s*$/i, '').trim();
    if (!id || !title) continue;
    u.searchParams.set('lang', lang);
    if (platform === 'dramafren') u.searchParams.delete('lang');
    const item = { id, platform, title, lang, url: u.href, poster: httpUrl(img['data-src'] || img.src, base) };
    const old = items.get(id);
    if (!old || (!old.poster && item.poster)) items.set(id, item);
  }
  let next = null;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = attrs(m[1]);
    if (/(?:^|\s)next(?:\s|$)/i.test(a.rel || a.class || '') || /^(?:Next|›|»)/i.test(text(m[2]))) {
      const target = httpUrl(a.href, base);
      if (target && new URL(target).origin === new URL(base).origin) { next = target; break; }
    }
  }
  return { items: [...items.values()], next };
}

export function parseDetail(html, url, platform, lang) {
  const title = text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || meta(html, 'og:title'));
  const episodes = new Map();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = attrs(m[1]), href = httpUrl(a.href, url);
    if (!href || new URL(href).origin !== new URL(url).origin) continue;
    const u = new URL(href), native = u.searchParams.get('ep');
    if (platform === 'dramafren' ? !/^\/watch\//.test(u.pathname) : u.searchParams.get('page') !== 'watch' || native === null) continue;
    // The API index is kept separate from the number shown in the app.
    const number = platform === 'dramafren' ? Number(text(m[2]).match(/\bEP\s*(\d+)/i)?.[1]) : Number(native) + (platform === 'goodshort' ? 1 : 0);
    if (!Number.isInteger(number) || number < 1) continue;
    if (platform !== 'dramafren') u.searchParams.set('lang', lang);
    const label = text(m[2]).replace(/\s+\w+ \d{1,2}, \d{4}$/, '');
    const key = platform === 'dramafren' ? u.pathname : native;
    const old = episodes.get(key);
    if (!old || /^Start Watching$/i.test(old.title)) episodes.set(key, { number, nativeEpisode: native, title: /^Start Watching$/i.test(label) ? `Episode ${number}` : label || `Episode ${number}`, url: u.href });
  }
  return { title, url, platform, lang, poster: httpUrl(meta(html, 'og:image'), url), description: meta(html, 'description') || meta(html, 'og:description'), episodes: [...episodes.values()].sort((a, b) => a.number - b.number) };
}

export function normalizeStream(payload, apiUrl, watchUrl, platform, lang) {
  if (payload?.ok === false || payload?.status === 'error' || (payload?.status_code != null && payload.status_code !== 1)) fail(payload.message || payload.error || 'no playable source', 'NO_STREAM');
  const d = payload?.data || payload;
  const primary = d?.videoUrl || d?.video_url || d?.url;
  if (!primary) fail(d?.message || payload?.message || 'no playable source', 'NO_STREAM');
  if (d.remaining_ttl != null && Number(d.remaining_ttl) <= 0) fail('expired stream; retry playback', 'EXPIRED');
  const type = u => d.isHls === false || /\.mp4(?:[?#]|$)|mime_type=video_mp4|[?&]seg=/.test(u) || d.nativeNoCors ? 'mp4' : 'hls';
  const qualities = [], seen = new Set();
  const candidates = [...(d.qualities || d.quality_options || []), { quality: 'auto', url: primary }];
  for (const q of candidates) {
    const url = httpUrl(q.url || q.file || q.src, apiUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const quality = String(q.quality || q.label || 'auto').match(/\d{3,4}p/i)?.[0].toLowerCase() || q.quality || q.label || 'auto';
    qualities.push({ quality, url, type: type(url), cdn: new URL(url).host, headers: { Referer: watchUrl } });
  }
  if (!qualities.length) fail('no playable source', 'NO_STREAM');
  const subtitles = [];
  for (const sub of d.subtitles || d.subtitle_options || []) {
    const raw = sub.url || sub.src || sub.file;
    // DramaWave's subtitle proxy is relative to the player, not its API CDN.
    const url = httpUrl(raw, raw?.startsWith('?proxy_sub=') ? watchUrl : apiUrl);
    if (!url || subtitles.some(s => s.url === url)) continue;
    subtitles.push({ url, lang: sub.lang_code || sub.subtitleLanguage || sub.srclang || sub.lang || sub.language || lang, label: sub.label || sub.language || sub.lang_code || sub.subtitleLanguage || 'Subtitles' });
  }
  return { provider: 'dramafren', platform, lang, referer: watchUrl, cdn: qualities[0].cdn, qualities, subtitles, verified: false };
}

export function createDramafrenSource(rt = {}, config = {}) {
  config = { ...DEFAULT_CONFIG, ...config, sites: { ...DEFAULT_CONFIG.sites, ...config.sites }, defaultServers: { ...DEFAULT_CONFIG.defaultServers, ...config.defaultServers } };
  const sites = config.sites || {};
  const cache = new Map(), inflight = new Map(), browserHosts = new Set();
  const now = rt.now || Date.now;
  function site(platform = config.defaultPlatform || 'dramabox') {
    const s = sites[platform];
    if (!s?.base) fail(`unknown platform ${platform}`, 'BAD_REQUEST');
    if (s.disabled) fail(`${s.label || platform} is not available: ${s.note || 'upstream offline'}`, 'UNAVAILABLE');
    return { ...s, platform, base: new URL(s.base).origin };
  }
  function allowed(value) {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
    return Object.values(sites).some(s => new URL(s.base).origin === u.origin) || (config.endpointHosts || []).includes(u.hostname);
  }
  async function browserPage(url) {
    const reader = rt.browserFetch;
    if (!reader) fail('Cloudflare verification required — open the desktop app and complete the checkbox', 'NEEDS_CHECK');
    const out = await reader(url);
    if (out.status >= 400) fail(`HTTP ${out.status}`, 'UPSTREAM');
    if (challenge(out.body || '')) fail('Cloudflare check pending; finish the checkbox, then retry', 'NEEDS_CHECK');
    return { url: out.url || url, body: out.body || '' };
  }
  async function readFresh(url) {
    if (!allowed(url)) fail('URL is outside the configured DramaFren sites', 'BAD_REQUEST');
    const host = new URL(url).host;
    if (browserHosts.has(host)) return browserPage(url);
    let out;
    if (rt.readPage) out = await rt.readPage(url);
    else {
      const headers = { 'User-Agent': rt.UA || 'Mozilla/5.0', Referer: new URL(url).origin + '/' };
      if (rt.curlFetch) {
        try { out = { url, body: await rt.curlFetch(url, headers), status: 200 }; } catch { /* app's DoH stack below */ }
      }
      if (!out) {
        const r = await (rt.smartFetch || rt.dnsFetch || fetch)(url, { headers, signal: AbortSignal.timeout(config.timeoutMs || 20000) });
        out = { url: r.url || url, status: r.status, body: await r.text() };
      }
    }
    if (!allowed(out.url || url)) fail('unexpected off-site redirect', 'UPSTREAM');
    if (challenge(out.body || '')) { browserHosts.add(host); return browserPage(url); }
    if (out.status >= 400 || /<title>\s*404 Not Found/i.test(out.body || '')) fail(`HTTP ${out.status >= 400 ? out.status : 404}`, 'UPSTREAM');
    return out;
  }
  async function read(url, ttl = 0) {
    const hit = cache.get(url);
    if (ttl && hit?.expires > now()) return structuredClone(hit.value);
    if (inflight.has(url)) return inflight.get(url);
    const pending = readFresh(url).then(value => {
      if (ttl) { if (cache.size >= 128) cache.delete(cache.keys().next().value); cache.set(url, { value, expires: now() + ttl }); }
      return value;
    }).finally(() => inflight.delete(url));
    inflight.set(url, pending);
    return pending;
  }
  function nativeUrl(s, value, lang) {
    let url;
    if (/^https?:/.test(value || '')) {
      url = new URL(value);
      if (url.origin !== s.base || (s.platform === 'dramafren' ? !/^\/(series|watch)\/[^/]+\/?$/.test(url.pathname) : url.pathname !== '/index.php' || !['detail', 'watch'].includes(url.searchParams.get('page')))) fail('invalid drama URL', 'BAD_REQUEST');
    } else if (s.platform === 'dramafren') {
      if (/^\/(series|watch)\/[\p{L}\p{N}_-]+\/?$/u.test(value || '')) url = new URL(value, s.base);
      else {
        if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(value || '')) fail('a native series slug is required', 'BAD_REQUEST');
        url = new URL(`/series/${value}/`, s.base);
      }
    } else {
      if (!/^[\w-]+$/.test(value || '')) fail('a native drama ID is required', 'BAD_REQUEST');
      url = new URL('/index.php', s.base); url.search = new URLSearchParams({ page: 'detail', id: value }).toString();
    }
    if (s.platform !== 'dramafren') url.searchParams.set('lang', lang);
    return url.href;
  }
  function options(input = {}) {
    const native = [input.url, input.dramaId, input.id].find(v => typeof v === 'string' && v.startsWith('https://'));
    const inferred = native && Object.entries(sites).find(([, s]) => new URL(s.base).origin === new URL(native).origin)?.[0];
    const s = site(input.platform || inferred), lang = languageFor(s.platform, input.lang || config.defaultLang || 'en');
    return { s, lang };
  }
  async function catalog(input = {}) {
    const { s, lang } = options(input);
    const page = Number(input.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 10000) fail('invalid catalog page', 'BAD_REQUEST');
    const u = new URL(s.platform === 'dramafren' ? (page > 1 ? `/page/${page}/` : '/') : '/index.php', s.base);
    if (s.platform !== 'dramafren') u.search = new URLSearchParams(s.platform === 'dramawave' || s.platform === 'stardusttv' ? { hp: String(page), lang } : { page: 'home', p_hist: String(page), lang }).toString();
    const data = await read(u.href, 300000);
    return { platform: s.platform, lang, page, ...parseCatalog(data.body, u.href, s.platform, lang) };
  }
  async function search(query, input = {}) {
    if (!String(query || '').trim()) fail('search query is required', 'BAD_REQUEST');
    const { s, lang } = options(input), u = new URL(s.platform === 'dramafren' ? '/' : '/index.php', s.base);
    u.search = new URLSearchParams(s.platform === 'dramafren' ? { s: query } : s.platform === 'dramawave' ? { q: query, lang } : { page: 'search_result', q: query, lang }).toString();
    const data = await read(u.href, 60000);
    return { platform: s.platform, lang, ...parseCatalog(data.body, u.href, s.platform, lang) };
  }
  async function detail(value, input = {}) {
    const { s, lang } = options({ ...input, url: value });
    let url = nativeUrl(s, String(value || ''), lang);
    let data = await read(url, 300000);
    if (s.platform === 'dramafren' && new URL(url).pathname.startsWith('/watch/')) {
      const parent = data.body.match(/itemprop=["']partOfSeries["'][^>]*>[\s\S]*?<a\b([^>]*)>/i)?.[1];
      const href = parent && httpUrl(attrs(parent).href, url);
      if (!href || new URL(href).origin !== s.base || !new URL(href).pathname.startsWith('/series/')) fail('parent series not found', 'NOT_FOUND');
      url = nativeUrl(s, href, lang);
      data = await read(url, 300000);
    }
    const result = parseDetail(data.body, url, s.platform, lang);
    if (!result.title || !result.episodes.length) fail('title or episodes not found', 'NOT_FOUND');
    return result;
  }
  async function json(url) {
    const response = await read(url);
    try { return JSON.parse(response.body); } catch { fail('invalid stream response', 'UPSTREAM'); }
  }
  async function resolve(req, ctx = {}) {
    if (req.type && req.type !== 'tv') fail('not available for movies; choose a short drama', 'NOT_FOUND');
    if (Number(req.season ?? 1) !== 1) fail('season not found; short dramas use their native episode list', 'NOT_FOUND');
    const { s, lang } = options({ ...ctx.params, ...Object.fromEntries(Object.entries(req).filter(([, v]) => v != null && v !== '')) });
    req = { ...req, server: req.server ?? config.defaultServers[s.platform] };
    if (req.server != null && (!Number.isInteger(Number(req.server)) || Number(req.server) < 0 || Number(req.server) > 3)) fail('invalid server number', 'BAD_REQUEST');
    const episode = Number(req.episode ?? 1);
    if (!Number.isInteger(episode) || episode < 1) fail('invalid episode number', 'BAD_REQUEST');
    let target = req.url || req.dramaId;
    if (!target && /^https:\/\//.test(req.id || '')) target = req.id;
    // req.id normally holds a TMDB ID. Never mistake it for a platform ID.
    if (!target) {
      const title = req.title || req.cartoonTitle || req.q;
      if (!title) fail('a title, dramaId or native URL is required', 'BAD_REQUEST');
      const found = await search(title, { platform: s.platform, lang });
      const matches = found.items.filter(item => norm(item.title) === norm(title));
      if (matches.length !== 1) fail(matches.length ? 'ambiguous title; use a native URL' : 'title not found', 'NOT_FOUND');
      target = matches[0].url;
    }
    const info = await detail(target, { platform: s.platform, lang });
    const ep = info.episodes.find(e => e.number === episode);
    if (!ep) fail(`episode ${episode} not found`, 'NOT_FOUND');
    const watch = new URL(ep.url);
    if (req.server != null) watch.searchParams.set(s.platform === 'dramabox' || s.platform === 'goodshort' || s.platform === 'stardusttv' ? 'sv' : 'server', String(req.server));
    const html = (await read(watch.href)).body;
    if (s.platform === 'dramafren') {
      // WordPress entries are often a full-series compilation. Their episode
      // list is authoritative; never synthesize individual episodes from it.
      const players = [];
      for (const m of html.matchAll(/data-em\s*=\s*["']([^"']+)["']/gi)) {
        try { const embed = Buffer.from(m[1], 'base64').toString('utf8'); const src = embed.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)/i)?.[1]; if (src) players.push(httpUrl(src, watch.href)); } catch {}
      }
      for (const m of html.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)/gi)) players.push(httpUrl(m[1], watch.href));
      let last;
      for (const player of [...new Set(players.filter(Boolean))].slice(0, 4)) {
        try {
          if (!rt.captureStream) fail('this player needs app playback', 'NEEDS_CHECK');
          const stream = await rt.captureStream(player, watch.href);
          return { provider: 'dramafren', platform: s.platform, lang, verified: false, qualities: [{ quality: 'auto', type: 'hls', url: `/api/hls?${new URLSearchParams({ url: stream.url, referer: stream.referer || player })}` }], subtitles: [] };
        } catch (e) { last = e; }
      }
      throw last || new DramaFrenError('no players found', 'NO_STREAM');
    }
    const id = watch.searchParams.get('id'), nativeEp = watch.searchParams.get('ep');
    const bakedEp = lastValue(html, 'currentEp');
    if (s.platform !== 'goodshort' && typeof bakedEp === 'number' && bakedEp !== Number(nativeEp)) fail('upstream returned a different episode; retry playback', 'NO_STREAM');
    let endpoints = [], payload;
    if (s.platform === 'dramabox') endpoints = lastValue(html, 'videoEndpointUrls') || [];
    if (s.platform === 'flickreels') endpoints = lastValue(html, 'streamEndpoints') || [];
    if (s.platform === 'dramabox' || s.platform === 'flickreels') endpoints = endpoints.map(endpoint => {
      const u = new URL(endpoint, watch);
      u.searchParams.set('id', id); u.searchParams.set('ep', nativeEp); u.searchParams.set('lang', lang);
      if (req.server != null) u.searchParams.set(s.platform === 'dramabox' ? 'sv' : 'server', String(req.server));
      return u.href;
    });
    if (s.platform === 'dramawave' || s.platform === 'netshort') {
      const bases = lastValue(html, s.platform === 'dramawave' ? 'sourceEndpoints' : 'watchActionEndpoints') || [];
      endpoints = bases.map(base => {
        const u = new URL(base, watch);
        u.search = new URLSearchParams({ action: s.platform === 'dramawave' ? 'watch_source' : 'resolve_watch', id, ep: nativeEp, server: String(req.server || lastValue(html, 'currentServer') || 1), lang }).toString();
        return u.href;
      });
    }
    if (s.platform === 'goodshort') {
      const url = lastValue(html, 'initialUrl');
      if (url && Number(lastValue(html, 'phpBakedEp')) === Number(nativeEp)) payload = { video_url: url, qualities: lastValue(html, 'availableQualities') || [] };
      else {
        const chapters = lastValue(html, 'chapterIds') || [], chapter = chapters[Number(nativeEp)];
        if (!chapter) fail('episode chapter not found', 'NOT_FOUND');
        endpoints = [s.base + '/index.php?' + new URLSearchParams({ action: 'get_video_url', id, chap_id: chapter, sv: String(req.server || 1), lang })];
      }
    }
    if (s.platform === 'stardusttv') {
      const encoded = lastValue(html, 'encryptedSrc');
      if (encoded) payload = { url: Buffer.from(encoded, 'base64').toString('utf8') };
      const tracks = [...html.matchAll(/<track\b[^>]*>/gi)].map(m => attrs(m[0]));
      if (payload) payload.subtitles = tracks.map(t => ({ url: t.src, lang: t.srclang, label: t.label }));
    }
    let last;
    for (const endpoint of payload ? [] : endpoints) {
      try { payload = await json(endpoint); const result = normalizeStream(payload, endpoint, watch.href, s.platform, lang); return { ...result, title: info.title, episode }; }
      catch (e) { last = e; }
    }
    if (payload && !endpoints.length) return { ...normalizeStream(payload, watch.href, watch.href, s.platform, lang), title: info.title, episode };
    throw last || new DramaFrenError('no playable source; the platform may have changed', 'NO_STREAM');
  }
  function platforms() {
    return Object.entries(sites).map(([id, s]) => ({ id, ...s, languages: LANGUAGES[id] || [], defaultLang: LANGUAGES[id]?.[0] || null }));
  }
  return { platforms, catalog, search, detail, resolve };
}

let source;
export function setup(rt, config) { source = createDramafrenSource(rt, config); }
function ready() { return source || fail('source has not been initialized', 'CONFIG'); }
export function platforms() { return ready().platforms(); }
export function catalog(options) { return ready().catalog(options); }
export function search(query, options) { return ready().search(query, options); }
export function detail(idOrUrl, options) { return ready().detail(idOrUrl, options); }
export function resolve(req, ctx) { return ready().resolve(req, ctx); }

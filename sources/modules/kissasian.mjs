// KissAsian: Korean catalog, native series IDs, numbered episodes and HLS.
// Standard source-pack setup/runtime contract; no site scripts are executed.
import { text, literals } from './dramafren.mjs';

let api;
export const DEFAULT_CONFIG = { base: 'https://kissasian.com.gr', playerHosts: ['catalog.dramavibe.cfd'], subtitleHosts: ['storage.dramavibe.cfd'], mediaHosts: ['cdn.dramav2.xyz', 'cdn.drama3.click'], country: 'south-korea' };
const error = (message, code = 'UPSTREAM') => Object.assign(new Error(`KissAsian: ${message}`), { code });
function attrs(value) {
  const a = {};
  for (const m of value.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[m[1].toLowerCase()] = text(m[2] ?? m[3]);
  return a;
}
function url(value, base) {
  if (!value || typeof value !== 'string') return null;
  try { const u = new URL(value, base); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function parseCatalog(html, base) {
  const main = html.split(/class=["']content-right["']/)[0];
  const items = new Map();
  for (const m of main.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = attrs(m[1]), href = url(a.href, base);
    if (!href || new URL(href).origin !== new URL(base).origin || !/^\/series\/[^/]+\/?$/.test(new URL(href).pathname)) continue;
    const img = attrs(m[2].match(/<img\b[^>]*>/i)?.[0] || '');
    const title = text(m[2].match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i)?.[1] || a.title || img.alt || '');
    if (!title) continue;
    const id = new URL(href).pathname.split('/')[2];
    const item = { id, title, url: href, platform: 'kissasian', lang: 'en', poster: url(img['data-original'] || img['data-src'] || img.src, base) };
    if (!items.has(id) || !items.get(id).poster) items.set(id, item);
  }
  const nextAttrs = [...html.matchAll(/<a\b[^>]*>/gi)].map(m => attrs(m[0])).find(a => /(?:^|\s)next(?:\s|$)/.test(a.rel || a.class || ''));
  const next = url(nextAttrs?.href, base);
  return { items: [...items.values()], next: next && new URL(next).origin === new URL(base).origin ? next : null };
}
export function parseDetail(html, base) {
  const section = html.match(/<div\b[^>]*class=["']details["'][^>]*>([\s\S]*?)(?:<div\b[^>]*class=["']slider-star|<div\b[^>]*class=["']block-tab)/i)?.[1] || html;
  const title = text(section.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const image = attrs(section.match(/<img\b[^>]*>/i)?.[0] || '');
  const description = text(section.match(/Description:\s*<\/span>\s*<\/p>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '');
  const country = text(section.match(/Country:\s*<\/span>\s*<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '');
  const scope = html.match(/<ul\b[^>]*class=["'][^"']*all-episode[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i)?.[1] || '';
  const episodes = new Map();
  for (const m of scope.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = attrs(m[1]), href = url(a.href, base);
    if (!href || new URL(href).origin !== new URL(base).origin) continue;
    const number = Number(text(m[2]).match(/\bEpisode\s+(\d+(?:\.\d+)?)/i)?.[1] || new URL(href).pathname.match(/-episode-(\d+(?:\.\d+)?)\/?$/)?.[1]);
    if (Number.isFinite(number) && number > 0) episodes.set(number, { number, title: `Episode ${number}`, url: href });
  }
  return { id: new URL(base).pathname.split('/')[2], title, description, country, platform: 'kissasian', lang: 'en', url: base, poster: url(image.src, base), episodes: [...episodes.values()].sort((a, b) => a.number - b.number) };
}

export function createKissAsianSource(rt = {}, overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides }, base = new URL(config.base).origin;
  const cache = new Map();
  const headers = ref => ({ 'User-Agent': rt.UA || 'Mozilla/5.0', Referer: ref, Origin: new URL(ref).origin });
  async function read(target, referer = base + '/', ttl = 0) {
    const hit = cache.get(target);
    if (hit?.until > Date.now()) return hit.body;
    let body;
    if (rt.readPage) body = await rt.readPage(target, { headers: headers(referer) });
    else {
      const r = await (rt.smartFetch || rt.dnsFetch || fetch)(target, { headers: headers(referer), signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw error(`upstream HTTP ${r.status}`);
      body = await r.text();
    }
    if (/just a moment|cf_chl_opt|Attention Required!.*Cloudflare/i.test(body)) throw error('platform verification required', 'NEEDS_CHECK');
    if (ttl) { if (cache.size >= 100) cache.delete(cache.keys().next().value); cache.set(target, { body, until: Date.now() + ttl }); }
    return body;
  }
  function series(value) {
    const target = url(value?.startsWith('https:') ? value : `/series/${value}/`, base);
    if (!target || new URL(target).origin !== base || !/^\/series\/[\w-]+\/?$/.test(new URL(target).pathname)) throw error('invalid series URL', 'BAD_REQUEST');
    return target;
  }
  async function catalog({ page = 1 } = {}) {
    if (!Number.isInteger(Number(page)) || Number(page) < 1 || Number(page) > 10000) throw error('invalid page', 'BAD_REQUEST');
    const target = `${base}/country/${config.country}/${Number(page) > 1 ? `page/${Number(page)}/` : ''}`;
    return { ...parseCatalog(await read(target, base + '/', 180000), target), page: Number(page) };
  }
  async function detail(value) {
    const target = series(value), result = parseDetail(await read(target, base + '/', 180000), target);
    if (!result.title || !result.episodes.length) throw error('series or episodes not found', 'NOT_FOUND');
    return result;
  }
  async function search(query) {
    if (!String(query || '').trim()) throw error('search query required', 'BAD_REQUEST');
    const found = parseCatalog(await read(`${base}/?${new URLSearchParams({ s: query, type: 'movies' })}`, base + '/', 60000), base);
    // Search spans the whole Asian catalog; verify the country on each series
    // so the K-drama page continues to show Korean titles only.
    if (config.anyCountry) return { items: found.items, next: null };
    const items = [], queue = [...found.items];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try { if (/south korea/i.test((await detail(item.url)).country)) items.push(item); } catch { /* an unavailable series does not hide other results */ }
      }
    }));
    return { items: found.items.filter(item => items.some(i => i.id === item.id)), next: null };
  }
  async function verify(target, referer, depth = 0) {
    if (depth > 3) throw error('invalid playlist nesting');
    const manifest = await read(target, referer);
    if (!manifest.trimStart().startsWith('#EXTM3U')) throw error('invalid video playlist');
    const first = manifest.split(/\r?\n/).find(s => s.trim() && !s.startsWith('#'))?.trim();
    if (!first) throw error('empty video playlist');
    if (manifest.includes('#EXT-X-STREAM-INF')) return verify(new URL(first, target).href, referer, depth + 1);
    const media = new URL(first, target).href;
    const init = { headers: { ...headers(referer), Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(12000) };
    if (rt.dnsFetchStream) {
      const r = await rt.dnsFetchStream(media, init);
      try { if (![200, 206].includes(r.statusCode)) throw error('video CDN is unavailable'); let size = 0; for await (const chunk of r.stream) { size += chunk.length; if (size) break; } if (!size) throw error('empty video segment'); }
      finally { r.stream.destroy(); }
    } else if (!rt.readPage) {
      const r = await fetch(media, init);
      const reader = r.body?.getReader();
      try { if (!r.ok || !reader || !(await reader.read()).value?.length) throw error('video CDN is unavailable'); }
      finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    }
  }
  /** The normal player asks by title and season; find the matching series page. */
  async function seriesFor(req) {
    const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const season = Number(req.season ?? 1);
    const wanted = norm(req.title);
    if (!wanted) throw error('title required', 'BAD_REQUEST');
    let found = (await search(req.title)).items;
    // Remakes share a name: the release year picks the right one.
    const dated = found.filter(t => req.year && norm(t.title).endsWith(String(req.year)));
    if (dated.length) found = dated;
    const named = t => norm(t.title).replace(/\s*\(\d{4}\)$/, '').replace(/ \d{4}$/, '');
    const hit = season > 1
      ? found.find(t => named(t) === `${wanted} season ${season}` || named(t) === `${wanted} ${season}`)
      : found.find(t => named(t) === wanted) || found.find(t => named(t) === `${wanted} season 1`);
    if (!hit) throw error('series not found', 'NOT_FOUND');
    return hit.url;
  }
  async function resolve(req) {
    const number = Number(req.episode ?? 1);
    if (!Number.isFinite(number) || number < 1) throw error('invalid episode', 'BAD_REQUEST');
    const info = await detail(req.url || req.dramaId || await seriesFor(req));
    const ep = info.episodes.find(e => e.number === number);
    if (!ep) throw error(`episode ${number} not found`, 'NOT_FOUND');
    const html = await read(ep.url);
    const sources = [...html.matchAll(/data-video=["']([^"']+)["']/gi)].map(m => url(m[1], ep.url));
    const frame = html.match(/class=["'][^"']*watch_video[^"']*["'][\s\S]*?<iframe\b([^>]*)>/i)?.[1];
    if (frame) sources.unshift(url(attrs(frame).src, ep.url));
    for (const player of [...new Set(sources.filter(Boolean))]) {
      if (!config.playerHosts.includes(new URL(player).hostname)) continue;
      try {
        const playerHtml = await read(player, ep.url);
        const id = new URL(player).searchParams.get('episode');
        if (!/^\d+$/.test(id || '')) continue;
        const endpoint = new URL(`/player_source.php?episode=${id}`, player).href;
        const payload = JSON.parse(await read(endpoint, player));
        if (!payload.ok || !Array.isArray(payload.list)) continue;
        const qualities = [];
        for (const link of [...new Set(payload.list)]) {
          const target = url(link, player);
          if (!target || !config.mediaHosts.includes(new URL(target).hostname)) continue;
          try { await verify(target, player); qualities.push({ quality: qualities.length ? `Server ${qualities.length + 1}` : 'auto', type: 'hls', url: target, cdn: new URL(target).host }); } catch { /* try the alternate CDN */ }
        }
        if (!qualities.length) continue;
        const subtitles = [];
        const subApi = literals(playerHtml, 'subApi').find(v => typeof v === 'string' && v);
        if (subApi && config.subtitleHosts.includes(new URL(subApi).hostname)) {
          try {
            const list = JSON.parse(await read(subApi, player));
            for (const sub of Array.isArray(list) ? list : []) {
              for (const candidate of sub.urls?.length ? sub.urls : [sub.url]) {
                const target = url(candidate, player);
                if (!target || ![...config.subtitleHosts, ...config.mediaHosts].includes(new URL(target).hostname)) continue;
                try { const content = await read(target, player); if (!/WEBVTT|\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(content)) continue; subtitles.push({ url: `/api/hls?${new URLSearchParams({ url: target, referer: player })}`, lang: sub.lang || 'en', label: sub.lang === 'en' ? 'English' : sub.lang, type: sub.format }); break; } catch { /* next subtitle origin */ }
              }
            }
          } catch { /* missing captions do not block video */ }
        }
        return { provider: 'kissasian', referer: player, cdn: qualities[0].cdn, qualities, subtitles, verified: true, title: info.title, episode: number };
      } catch { /* another advertised player may work */ }
    }
    throw error('no playable stream for this episode', 'NO_STREAM');
  }
  return { catalog, search, detail, resolve, platforms: () => [{ id: 'kissasian', label: 'KissAsian', languages: ['en'], defaultLang: 'en' }] };
}
export function setup(runtime, config) { api = createKissAsianSource(runtime, config); }
const ready = () => api || (api = createKissAsianSource());
export const catalog = options => ready().catalog(options);
export const search = (q, options) => ready().search(q, options);
export const detail = (id, options) => ready().detail(id, options);
export const resolve = req => ready().resolve(req);
export const platforms = () => ready().platforms();

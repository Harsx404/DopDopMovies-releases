// Game download addons. Never execute page scripts in the server or mix release builds.
import { text, literals } from './dramafren.mjs';

export const SITES = {
  astralgames: { label: 'AstralGames', base: 'https://astralgames.net', catalog: '/all-games', pattern: /^\/game\/([\w-]+)\/?$/ },
  gamebounty: { label: 'GameBounty', base: 'https://gamebounty.world', catalog: '/', pattern: /^\/([\w-]+)-free-pc-download\/?$/ },
  gogrevived: { label: 'GOG Revived', base: 'https://gog-rev.com', catalog: '/games', pattern: /^\/games\/([\w-]+)\/?$/ },
  ankergames: { label: 'AnkerGames', base: 'https://ankergames.net', catalog: '/games-list', pattern: /^\/game\/([\w-]+)\/?$/ },
  fitgirl: { label: 'FitGirl Repacks', base: 'https://fitgirl-repacks.site', catalog: '/', pattern: /^\/([\w-]+)\/$/ },
  m4ckd0ge: { label: 'M4CKD0GE Repacks', base: 'https://m4ckd0ge-repacks.site', catalog: '/all-releases.html', pattern: /^\/repacks\/([\w.!-]+)\.html$/ },
};
const fail = (message, code = 'UPSTREAM') => Object.assign(new Error(`Games: ${message}`), { code });
export const attrs = html => Object.fromEntries([...html.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], text(m[2] ?? m[3])]));
export function publicUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value, base);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !/^[a-z0-9.-]+$/i.test(u.hostname) || !u.hostname.includes('.') || /^\d/.test(u.hostname) && /^\d[\d.]+$/.test(u.hostname) || /^(localhost|.*\.localhost|.*\.local)$/.test(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}
const hostIs = (url, domains) => { const h = new URL(url).hostname; return domains.some(d => h === d || h.endsWith('.' + d)); };
const FILE_HOSTS = ['vikingfile.com', 'vik1ngfile.site', 'itsfileditchfiles.st', '0807.st', 'datanodes.to', 'filesyard.com', 'mocha.my', 'cloud.ovh.net', 'ankergames.net', 'fuckingfast.co', 'pixeldrain.com', 'gofile.io', '1fichier.com', 'mega.nz', 'drive.google.com', 'rootz.so', 'dlproxy.uk'];
const fileUrl = value => { const u = publicUrl(value); return u && hostIs(u, FILE_HOSTS) && !/\.torrent(?:$|[?#])/i.test(u) ? u : null; };
export { fileUrl as supportedDownloadUrl };
export function magnetUrl(value) {
  if (typeof value !== 'string' || !/^magnet:\?/i.test(value)) return null;
  try {
    const u = new URL(value);
    return u.searchParams.getAll('xt').some(xt => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(xt) || /^urn:btmh:1220[a-f0-9]{64}$/i.test(xt)) ? u.href : null;
  } catch { return null; }
}
function torrentUrl(value, base) {
  const u = publicUrl(value, base);
  return u && /\.torrent(?:$|[?#])/i.test(u) && (new URL(u).origin === new URL(base).origin || hostIs(u, FILE_HOSTS)) ? u : null;
}
// Bounded bencode reader: validate metadata, never start a torrent client.
export function validTorrent(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024) return false;
  let position = 0, nodes = 0;
  function parse(depth = 0) {
    if (depth > 32 || ++nodes > 100000 || position >= bytes.length) throw new Error('Invalid torrent');
    const type = bytes[position];
    if (type >= 48 && type <= 57) {
      const colon = bytes.indexOf(58, position);
      if (colon < 0 || colon - position > 8) throw new Error('Invalid string');
      const length = bytes.toString('ascii', position, colon);
      if (!/^\d+$/.test(length)) throw new Error('Invalid string');
      position = colon + 1;
      const end = position + Number(length);
      if (end > bytes.length) throw new Error('Truncated string');
      const value = bytes.subarray(position, end); position = end; return value;
    }
    if (type === 105) {
      const end = bytes.indexOf(101, ++position);
      const value = bytes.toString('ascii', position, end);
      if (end < 0 || !/^-?\d+$/.test(value)) throw new Error('Invalid integer');
      position = end + 1; return Number(value);
    }
    if (type !== 100 && type !== 108) throw new Error('Invalid bencode');
    position++;
    const value = type === 100 ? Object.create(null) : [];
    while (bytes[position] !== 101) {
      if (type === 100) { const key = parse(depth + 1); if (!Buffer.isBuffer(key)) throw new Error('Invalid key'); value[key.toString('utf8')] = parse(depth + 1); }
      else value.push(parse(depth + 1));
    }
    position++; return value;
  }
  try {
    const data = parse(), info = data.info;
    return position === bytes.length && !!info && Buffer.isBuffer(info.name) && Number.isSafeInteger(info['piece length']) && info['piece length'] > 0 &&
      (Buffer.isBuffer(info.pieces) && info.pieces.length % 20 === 0 && (Number.isSafeInteger(info.length) && info.length >= 0 || Array.isArray(info.files) && info.files.length > 0) || info['meta version'] === 2 && !!info['file tree']);
  } catch { return false; }
}
const challenge = s => /<title>\s*Just a moment|cf_chl_opt|Performing security verification/i.test(s);

// Read balanced JSON only, including Next's serialized Flight payloads. No eval.
function jsonAt(source, start) {
  let quote = false, escape = false, depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quote = false; }
    else if (c === '"') quote = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return { value: JSON.parse(source.slice(start, i + 1)), end: i + 1 };
  }
  throw new Error('Incomplete JSON');
}
export function pageObjects(html) {
  const roots = [], objects = [], seen = new Set();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attrs(m[1]).type === 'application/ld+json') { try { roots.push(JSON.parse(m[2])); } catch {} }
  }
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(/g)) {
    try { const p = jsonAt(html, m.index + m[0].length).value; if (p[0] === 1 && typeof p[1] === 'string') flight += p[1]; } catch {}
  }
  for (let i = 0; i < flight.length; i++) if (flight[i] === '{' || flight[i] === '[') {
    try { const p = jsonAt(flight, i); roots.push(p.value); i = p.end - 1; } catch {}
  }
  const walk = v => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (!Array.isArray(v)) objects.push(v);
    for (const x of Object.values(v)) walk(x);
  };
  roots.forEach(walk);
  return objects;
}
function meta(html, key) {
  return [...html.matchAll(/<meta\b[^>]*>/gi)].map(m => attrs(m[0])).find(a => a.property === key || a.name === key)?.content || '';
}
function anchors(html) { return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(m => ({ ...attrs(m[1]), body: m[2] })); }
function multiplayer(value, tags = []) {
  const onlineFix = /online[\s_-]*fix|\bOFME\b/i.test(value);
  return { onlineFix: onlineFix ? 'included' : 'unknown', online: onlineFix ? true : null, coOp: /co[ -]?op(?:erative)?/i.test(tags.join(' ')) ? true : null, multiplayer: /multiplayer/i.test(tags.join(' ')) ? true : null };
}
export function parseGameCatalog(provider, html, target) {
  const site = SITES[provider], items = new Map(), objects = pageObjects(html);
  const repack = provider === 'fitgirl' || provider === 'm4ckd0ge';
  const entries = provider === 'fitgirl' ? [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map(m => m[1]) : [];
  const listing = provider === 'fitgirl' ? (entries.length ? entries : [html]).flatMap(entry => [...entry.matchAll(/class=["'][^"']*entry-title[^"']*["'][^>]*>\s*(<a\b[\s\S]*?<\/a>)/gi)].map(m => m[1].replace('</a>', `${entry.match(/<img\b[^>]*>/i)?.[0] || ''}</a>`))).join('') : html;
  const pagination = objects.find(o => Array.isArray(o.initialGames) && Number.isFinite(o.initialTotal));
  if (provider === 'astralgames' && pagination) for (const g of pagination.initialGames) {
    if (!/^[\w-]+$/.test(g.slug || '') || !g.name) continue;
    items.set(g.slug, { id: g.slug, provider, title: text(g.name), url: new URL(`/game/${g.slug}`, target).href, poster: publicUrl(g.image, target), steamId: String(g.steam_id || '') || null, build: String(g.build_id || '') || null, multiplayer: multiplayer(g.credits || '', g.tags || []) });
  }
  // AnkerGames' cards keep the poster on a wrapper around the link, not on an <img> inside it.
  const cardImages = new Map([...html.matchAll(/data-game-url="([^"]+)"\s+data-game-image="([^"]+)"/g)].map(m => [m[1], m[2]]));
  for (const a of anchors(listing)) {
    const href = publicUrl(a.href, target);
    if (!href || new URL(href).origin !== new URL(target).origin) continue;
    const match = new URL(href).pathname.match(site.pattern);
    if (!match) continue;
    const img = attrs(a.body.match(/<img\b[^>]*>/i)?.[0] || '');
    const title = text(a.title || a.body.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i)?.[1] || img.alt || (provider === 'm4ckd0ge' && !text(a.body) ? match[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : a.body));
    if (!title || /view details|read more/i.test(title)) continue;
    if (provider === 'fitgirl' && /Upcoming Repacks|Repack Updated|Updates Digest|Site News/i.test(title)) continue;
    const object = objects.find(o => o.slug === match[1] && (o.name || o.title)) || {};
    const item = { id: match[1], provider, title: object.name || object.title || title, url: href, poster: publicUrl(object.image || img.src || img['data-src'] || cardImages.get(href), target), steamId: String(object.steam_id || '') || null, build: String(object.build_id || '') || null, multiplayer: multiplayer(object.credits || '', object.tags || []), ...(repack ? { releaseType: 'repack' } : {}) };
    if (!items.has(item.id) || !items.get(item.id).poster) items.set(item.id, item);
  }
  const next = anchors(html).find(a => a.rel === 'next' || /(?:^|\s)next(?:\s|$)/.test(a.class || '') || /^(?:Next|Next page|›|→)$/i.test(text(a.body)));
  const nextUrl = publicUrl(next?.href, target);
  const nextPage = pagination && pagination.currentPage * pagination.pageSize < pagination.initialTotal ? new URL(target) : null;
  if (nextPage) nextPage.searchParams.set('page', String(pagination.currentPage + 1));
  return { items: [...items.values()], next: nextPage?.href || (nextUrl && new URL(nextUrl).origin === new URL(target).origin ? nextUrl : null) };
}
export function decodeGogLinks(html) {
  const stack = attrs(html.match(/<[^>]+class="[^"]*downloads-stack[^>]*>/)?.[0] || '');
  const name = stack['data-link-runtime'];
  if (!name) return [];
  // Runtime key is a plain JSON object assigned to a named window property.
  let config;
  if (literals(html, 'linkRuntimeSlot').includes(name)) {
    config = { payloadAttribute: literals(html, 'linkPayloadAttribute').at(-1), key: literals(html, 'linkKey').at(-1) };
  }
  for (const m of html.matchAll(/window\[(['"])([^'"]+)\1\]\s*=\s*/g)) if (m[2] === name) { try { config = jsonAt(html, m.index + m[0].length).value; } catch {} }
  if (!config?.payloadAttribute || !Array.isArray(config.key) || !config.key.length) return [];
  return [...html.matchAll(/<(?:a|button)\b[^>]*>/gi)].map(m => attrs(m[0])).filter(a => a[config.payloadAttribute]).map(a => {
    try {
      const r = Buffer.from(a[config.payloadAttribute], 'base64url'), n = r[1], nonce = r.subarray(2, 2 + n), data = r.subarray(2 + n), out = Buffer.alloc(data.length);
      if (r[0] !== 1 || n < 8 || nonce.length !== n || !data.length) return null;
      for (let i = 0; i < data.length; i++) { const key = config.key[(i + nonce[i % n]) % config.key.length], v = data[i] ^ ((key + nonce[(i * 5 + 3) % n] + ((i * 31 + 17) & 255)) & 255), shift = i % 5 + 1; out[i] = ((v >>> shift) | (v << (8 - shift))) & 255; }
      const value = out.toString('utf8'), magnet = magnetUrl(value), torrent = torrentUrl(value, 'https://gog-rev.com');
      const target = magnet || torrent || fileUrl(value);
      return target ? { host: a['data-host'] || 'GOG Revived', url: target, ...(magnet ? { kind: 'magnet' } : torrent ? { kind: 'torrent' } : {}) } : null;
    } catch { return null; }
  }).filter(Boolean);
}
export function parseGameDetail(provider, html, target) {
  const objects = pageObjects(html), site = SITES[provider], id = new URL(target).pathname.match(site.pattern)?.[1];
  const holder = objects.find(o => o.game?.id && o.game?.name), game = holder?.game || {};
  const ld = objects.find(o => ['VideoGame', 'SoftwareApplication', 'Product'].includes(o['@type'])) || {};
  const title = text(game.name || (provider === 'fitgirl' ? html.match(/class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h[1-4]>/i)?.[1] : '') || (provider === 'gogrevived' ? meta(html, 'og:title') : '') || html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ld.name || meta(html, 'og:title')).replace(/\s*[-–|]\s*(?:Free PC Download|GoG Revived|AnkerGames).*$/i, '').trim();
  if (!id || !title) throw fail('game not found', 'NOT_FOUND');
  const main = html.split(/YOU MIGHT ALSO LIKE|Recommended For You|Similar Games/i)[0];
  const plain = text(main.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
  const credits = game.credits || (provider === 'm4ckd0ge' ? plain.match(/Repack Notes:?([\s\S]*?)Before Downloading/i)?.[1] : '') || plain.match(/(?:CREDITS|Credits)\s+(.{0,100}?)(?:POSTED|Posted|RELEASE|Release|GAME|Game|$)/)?.[1] || '';
  const included = /Online-Fix included|build ships with the online fix/i.test(plain) ? 'OnlineFix' : '';
  const tags = game.tags || ld.genre || [];
  const steam = String(game.steam_id || anchors(html).map(a => a.href || '').join(' ').match(/store\.steampowered\.com\/app\/(\d+)/)?.[1] || '') || null;
  let downloads = [];
  if (provider === 'gamebounty') downloads = anchors(html).filter(a => a.href?.includes('/api/dl/')).map(a => { try { const target = fileUrl(Buffer.from(a.href.split('/').at(-1), 'base64url').toString('utf8')); return target ? { host: new URL(target).hostname, url: target } : null; } catch { return null; } }).filter(Boolean);
  if (provider === 'gogrevived') downloads = decodeGogLinks(html);
  const repack = provider === 'fitgirl' || provider === 'm4ckd0ge';
  if (repack) downloads = anchors(main).map(a => {
    const url = fileUrl(a.href);
    if (!url) return null;
    let filename = ''; try { const u = new URL(url); filename = decodeURIComponent(u.hostname === 'fuckingfast.co' ? u.hash.slice(1) : /\.(rar|zip|7z|bin)$/i.test(u.pathname) ? u.pathname.split('/').at(-1) : ''); } catch {}
    return { host: new URL(url).hostname, url, ...(filename ? { filename, optional: /^fg-optional-|optional/i.test(filename), part: Number(filename.match(/\.part(\d+)/i)?.[1]) || null } : {}) };
  }).filter(Boolean);
  const torrents = downloads.filter(d => d.kind === 'magnet' || d.kind === 'torrent');
  downloads = downloads.filter(d => d.kind !== 'magnet' && d.kind !== 'torrent');
  for (const a of anchors(main)) {
    const magnet = magnetUrl(a.href), torrent = torrentUrl(a.href, target);
    if (magnet || torrent) torrents.push({ host: site.label, url: magnet || torrent, kind: magnet ? 'magnet' : 'torrent' });
  }
  for (const object of [game, ...objects.filter(o => o.game === game)]) for (const key of ['magnet', 'magnet_link', 'magnetUrl', 'torrent', 'torrent_url', 'torrent_link', 'torrentUrl']) {
    const magnet = magnetUrl(object[key]), torrent = torrentUrl(object[key], target);
    if (magnet || torrent) torrents.push({ host: site.label, url: magnet || torrent, kind: magnet ? 'magnet' : 'torrent' });
  }
  // AnkerGames is a direct-download source, including when signed-in pages
  // advertise actual torrent files or magnets.
  if (provider === 'ankergames') torrents.length = 0;
  const unique = [...new Map(downloads.map(d => [d.url, d])).values()];
  if (repack && !unique.length && !torrents.length) throw fail('Repack downloads not found', 'NOT_FOUND');
  const extra = repack ? {
    releaseType: 'repack',
    repackSize: plain.match(/(?:Repack Size|Download Size):?\s*(\d+(?:\.\d+)?(?:\s*[/-]\s*\d+(?:\.\d+)?)?\s*(?:GB|MB))/i)?.[1] || null,
    installSize: plain.match(/(?:Original Size|Install Size):?\s*(\d+(?:\.\d+)?\s*(?:GB|MB)(?:\s*[/+-]\s*\d+(?:\.\d+)?\s*(?:GB|MB))?)/i)?.[1] || null,
    archivePassword: provider === 'm4ckd0ge' ? plain.match(/password for the RAR archive is[^"']*["']([^"']+)["']/i)?.[1] || null : null,
  } : {};
  const downloadSize = provider === 'gogrevived' ? text(html.match(/class="download-size-badge"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '').match(/\d+(?:\.\d+)?\s*(?:GB|MB|GiB|MiB)/)?.[0] : null;
  return { ...extra, id, provider, title, url: target, poster: publicUrl(game.image || meta(html, 'og:image') || ld.image, target), description: text(meta(html, 'description') || ld.description || ''), steamId: steam, build: String(game.build_id || plain.match(/\bBuild\s+(\d+)/i)?.[1] || '') || null, version: plain.match(/\bV\s?(\d[\w.-]*)/i)?.[1] || null, size: extra.repackSize || holder?.fileSize || downloadSize || plain.match(/\b\d+(?:\.\d+)?\s*(?:GB|MB|GiB|MiB)\b/i)?.[0] || null, tags: Array.isArray(tags) ? tags : [tags], multiplayer: multiplayer(`${credits} ${included}`, Array.isArray(tags) ? tags : [tags]), downloads: unique, torrents: [...new Map(torrents.map(t => [t.url, t])).values()], ...(game.id ? { nativeId: game.id } : {}), ...(provider === 'ankergames' ? { downloadId: html.match(/generateDownloadUrl\((\d+)\)/)?.[1] || null } : {}) };
}

export function createGameSource(provider, rt = {}, config = {}) {
  const site = { ...SITES[provider], ...config }, base = new URL(site.base).origin, cache = new Map();
  const headers = { 'User-Agent': rt.UA || 'Mozilla/5.0', Referer: base + '/' };
  const validGame = value => {
    if (typeof value !== 'string' || !value.trim()) throw fail('game ID required', 'BAD_REQUEST');
    const prefix = provider === 'gamebounty' || provider === 'fitgirl' ? '/' : provider === 'gogrevived' ? '/games/' : provider === 'm4ckd0ge' ? '/repacks/' : '/game/';
    const suffix = provider === 'gamebounty' ? '-free-pc-download' : provider === 'm4ckd0ge' ? '.html' : provider === 'fitgirl' ? '/' : '';
    const target = publicUrl(value.startsWith('https:') ? value : `${prefix}${value}${suffix}`, base);
    if (!target || new URL(target).origin !== base || !site.pattern.test(new URL(target).pathname)) throw fail('invalid game URL', 'BAD_REQUEST');
    return target;
  };
  async function read(target, useCache = true) {
    if (useCache && cache.get(target)?.until > Date.now()) return cache.get(target).body;
    let body;
    if (rt.readPage) { const out = await rt.readPage(target); body = typeof out === 'string' ? out : out.body; }
    else {
      const r = await (rt.smartFetch || fetch)(target, { headers, signal: AbortSignal.timeout(20000) });
      body = await r.text();
      if (challenge(body)) {
        if (!rt.gamesBrowser) throw fail('Complete the source check in the desktop app', 'NEEDS_CHECK');
        body = (await rt.gamesBrowser({ provider, action: 'read', url: target })).body;
      } else if (!r.ok) throw fail(`HTTP ${r.status}`);
    }
    if (!body || challenge(body)) throw fail('Source check is required in the desktop app', 'NEEDS_CHECK');
    if (useCache) { if (cache.size >= 64) cache.delete(cache.keys().next().value); cache.set(target, { body, until: Date.now() + 120000 }); }
    return body;
  }
  async function catalog({ page = 1 } = {}) {
    if (!Number.isInteger(Number(page)) || Number(page) < 1 || Number(page) > 10000) throw fail('invalid page', 'BAD_REQUEST');
    const target = new URL(site.catalog, base); if (Number(page) > 1) target.searchParams.set('page', String(page));
    if (provider === 'fitgirl' && Number(page) > 1) { target.pathname = `/page/${Number(page)}/`; target.search = ''; }
    if (provider === 'm4ckd0ge') return repackCatalog(await read(base + site.catalog), Number(page));
    if (provider === 'gamebounty') {
      const payload = JSON.parse(await read(`${base}/api/v1/posts?page=${page}&limit=24`));
      if (!payload.success || !Array.isArray(payload.data)) throw fail('invalid catalog response');
      return { items: payload.data.map(bountyItem), page: Number(page), next: Number(page) * 24 < payload.total ? `${base}/?page=${Number(page) + 1}` : null };
    }
    if (provider === 'gogrevived') return gogCatalog(await read(base + '/games/'), Number(page));
    return { ...parseGameCatalog(provider, await read(target.href), target.href), page: Number(page) };
  }
  function bountyItem(game) {
    return { id: game.slug, provider, title: text(game.title), url: `${base}/${game.slug}-free-pc-download`, poster: publicUrl(game.library_capsule || game.banner), steamId: game.appid || null, build: String(game.version || '').match(/Build\s+(\d+)/i)?.[1] || null, version: game.version || null, size: game.size_human || null, multiplayer: multiplayer(game.sources || '', game.genres || []) };
  }
  function repackCatalog(html, page, q = '') {
    const found = parseGameCatalog(provider, html, base + site.catalog).items.filter(item => !q || item.title.toLowerCase().includes(q.toLowerCase()));
    return { items: found.slice((page - 1) * 24, page * 24), page, next: found.length > page * 24 ? `${base}${site.catalog}?page=${page + 1}${q ? `&q=${encodeURIComponent(q)}` : ''}` : null };
  }
  function gogCatalog(html, page, query = '') {
    const games = literals(html, 'games').find(Array.isArray) || literals(html, '__GAMES__').find(Array.isArray);
    if (!games) throw fail('catalog data unavailable');
    const found = [...games].reverse().filter(g => !query || String(g.title).toLowerCase().includes(query.toLowerCase()));
    const items = found.slice((page - 1) * 36, page * 36).map(g => ({ id: g.slug, provider, title: text(g.title), url: `${base}/games/${encodeURIComponent(g.slug)}`, poster: publicUrl(g.assets?.boxArt || g.coverImage), steamId: null, build: null, version: g.currentVersion || null, size: g.downloadSizeBadge || null, multiplayer: multiplayer('', g.genres || []) }));
    return { items, page, next: found.length > page * 36 ? `${base}/games/?page=${page + 1}${query ? `&q=${encodeURIComponent(query)}` : ''}` : null };
  }
  async function search(q, { page = 1 } = {}) {
    if (!String(q || '').trim() || String(q).length > 200 || !Number.isInteger(Number(page)) || Number(page) < 1) throw fail('invalid search', 'BAD_REQUEST');
    if (provider === 'm4ckd0ge') return repackCatalog(await read(base + site.catalog), Number(page), String(q).trim());
    if (provider === 'fitgirl') {
      const target = new URL(Number(page) > 1 ? `/page/${Number(page)}/` : '/', base); target.searchParams.set('s', String(q).trim());
      return { ...parseGameCatalog(provider, await read(target.href), target.href), page: Number(page) };
    }
    if (provider === 'ankergames') {
      if (Number(page) !== 1) throw fail('AnkerGames search pagination is not available', 'BAD_REQUEST');
      if (!rt.gamesBrowser) throw fail('AnkerGames search needs the desktop app', 'NEEDS_CHECK');
      const out = await rt.gamesBrowser({ provider, action: 'search', url: base + site.catalog, q: String(q), page: Number(page) });
      return parseGameCatalog(provider, out.body, base + site.catalog);
    }
    if (provider === 'gamebounty') {
      const payload = JSON.parse(await read(`${base}/api/v1/search?${new URLSearchParams({ q: String(q), page: String(page), size: '24' })}`));
      if (!payload.success || !Array.isArray(payload.data?.results)) throw fail('invalid search response');
      return { items: payload.data.results.map(bountyItem), page: Number(page), next: Number(page) * 24 < payload.data.total ? `${base}/search?q=${encodeURIComponent(q)}&page=${Number(page) + 1}` : null };
    }
    if (provider === 'gogrevived') return gogCatalog(await read(base + '/games/'), Number(page), String(q));
    const target = new URL('/search', base); target.searchParams.set('q', String(q).trim()); target.searchParams.set('page', String(page));
    const result = parseGameCatalog(provider, await read(target.href), target.href);
    if (!result.items.length) {
      if (!rt.gamesBrowser) throw fail('AstralGames search needs the desktop app', 'NEEDS_CHECK');
      const out = await rt.gamesBrowser({ provider, action: 'read', url: target.href });
      return parseGameCatalog(provider, out.body, target.href);
    }
    return result;
  }
  async function detail(value) { const target = validGame(value); return parseGameDetail(provider, await read(target), target); }
  async function probe(target) {
    if (!fileUrl(target)) throw fail('unsupported file host', 'BAD_REQUEST');
    const init = { headers: { ...headers, Range: 'bytes=0-31' }, signal: AbortSignal.timeout(15000) };
    let bytes, status, responseHeaders;
    if (rt.dnsFetchStream) {
      const r = await rt.dnsFetchStream(target, init); status = r.statusCode; responseHeaders = r.headers;
      try { for await (const chunk of r.stream) { bytes = Buffer.from(chunk).subarray(0, 32); break; } } finally { r.stream.destroy(); }
    } else {
      const r = await fetch(target, init); status = r.status; responseHeaders = Object.fromEntries(r.headers);
      const reader = r.body?.getReader(); try { bytes = Buffer.from((await reader?.read())?.value || []).subarray(0, 32); } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    }
    if (![200, 206].includes(status) || !bytes || !['504b0304', '52617221', '377abcaf', '4d5a'].some(s => bytes.toString('hex').startsWith(s))) throw fail('file is unavailable or is not a supported archive');
    const range = responseHeaders?.['content-range'] || '';
    return { verified: true, sizeBytes: range.match(/\/(\d+)$/) ? Number(range.match(/\/(\d+)$/)[1]) : null, acceptsRanges: status === 206 };
  }
  async function probeTorrent(target) {
    const limit = 4 * 1024 * 1024, chunks = [];
    let size = 0;
    const init = { headers: { ...headers, Range: `bytes=0-${limit}` }, signal: AbortSignal.timeout(15000) };
    const add = chunk => { size += chunk.length; if (size > limit) throw fail('Torrent metadata exceeds the size limit'); chunks.push(Buffer.from(chunk)); };
    if (rt.dnsFetchStream) {
      const r = await rt.dnsFetchStream(target, init);
      try { if (![200, 206].includes(r.statusCode)) throw fail('Torrent unavailable'); for await (const chunk of r.stream) add(chunk); }
      finally { r.stream.destroy(); }
    } else {
      const r = await fetch(target, init), reader = r.body?.getReader();
      try {
        if (!r.ok || !reader) throw fail('Torrent unavailable');
        while (true) { const chunk = await reader.read(); if (chunk.done) break; add(chunk.value); }
      } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    }
    if (!validTorrent(Buffer.concat(chunks))) throw fail('Invalid torrent metadata');
    return { verified: true, sizeBytes: size, verification: 'torrent-metadata' };
  }
  async function resolve(req = {}) {
    const transport = req.transport || 'all';
    if (!['all', 'direct', 'torrent'].includes(transport)) throw fail('Invalid download transport', 'BAD_REQUEST');
    const info = await detail(req.url || req.gameId || req.id), downloads = [];
    if (transport !== 'torrent') try {
    if (provider === 'astralgames') {
      if (!/^[\da-f-]{36}$/i.test(info.nativeId || '')) throw fail('game download ID missing');
      const data = JSON.parse(await read(`${base}/api/direct-download/${info.nativeId}`, false));
      const target = fileUrl(data.url);
      if (!target || !hostIs(target, ['mocha.my'])) throw fail('download unavailable', 'NO_DOWNLOAD');
      downloads.push({ host: new URL(target).hostname, url: target, kind: 'direct', expiresAt: Date.now() + Math.min(Number(data.expiresIn) || 3600, 86400) * 1000, ...await probe(target) });
    } else if (provider === 'ankergames') {
      if (!rt.gamesBrowser) throw fail('AnkerGames download generation needs the desktop app', 'NEEDS_CHECK');
      const out = await rt.gamesBrowser({ provider, action: 'resolve', url: info.url });
      const target = fileUrl(out.url);
      if (!target) throw fail('download link missing', 'NO_DOWNLOAD');
      const direct = hostIs(target, ['dlproxy.uk', 'datanodes.to']);
      downloads.push({ host: new URL(target).hostname, url: target, kind: 'direct', verified: direct, browserReady: true, ...(direct ? {} : { requiresBrowser: true }) });
    } else {
      for (const mirror of info.downloads) {
        const entry = { ...mirror, kind: 'mirror', verified: false };
        try {
          if (hostIs(mirror.url, ['pixeldrain.com']) && /^\/u\/[A-Za-z0-9]+$/.test(new URL(mirror.url).pathname)) {
            const id = new URL(mirror.url).pathname.split('/')[2], direct = `https://pixeldrain.com/api/file/${id}?download`;
            downloads.push({ ...mirror, mirror: mirror.url, url: direct, kind: 'direct', ...await probe(direct) });
          } else if (hostIs(mirror.url, ['vikingfile.com', 'vik1ngfile.site', 'fuckingfast.co'])) {
            // The host renders its link after its own browser verification.
            if (!rt.gamesBrowser) { entry.requiresBrowser = true; downloads.push(entry); continue; }
            const out = await rt.gamesBrowser({ provider, action: 'mirror', url: mirror.url });
            const direct = fileUrl(out.url);
            if (!direct || !hostIs(direct, ['vikingfile.com', 'vik1ngfile.site', 'fuckingfast.co'])) throw fail('invalid mirror redirect');
            downloads.push({ ...mirror, mirror: mirror.url, url: direct, kind: 'direct', ...await probe(direct) });
          } else if (/\.(?:zip|rar|7z|exe)(?:$|\?)/i.test(mirror.url)) downloads.push({ ...mirror, kind: 'direct', ...await probe(mirror.url) });
          else downloads.push(entry);
        } catch (e) { downloads.push({ ...entry, status: 'unverified', ...(e.code === 'NEEDS_CHECK' ? { requiresBrowser: true } : {}) }); }
      }
    }
    } catch (e) { if (transport === 'direct' || !info.torrents.length) throw e; }
    if (transport !== 'direct') for (const torrent of info.torrents) {
      const entry = { ...torrent, verified: false };
      if (torrent.kind === 'magnet' || torrent.isHandoff) downloads.push(entry);
      else { try { downloads.push({ ...entry, ...await probeTorrent(torrent.url) }); } catch { downloads.push({ ...entry, status: 'unverified' }); } }
    }
    if (!downloads.length) throw fail('No matching download options available', 'NO_DOWNLOAD');
    return { provider, game: info, multiplayer: info.multiplayer, downloads, verified: downloads.some(d => d.verified), generatedAt: Date.now() };
  }
  return { catalog, search, detail, resolve };
}

// StreamFree — live sports events and their streams.
//
// DopDop live addon. Loaded by src/lib/source-pack.mjs: setup() runs once with
// the app runtime and this module's config from index.json.

const QUALITY_ORDER = ['720p', '540p', '1080p', '2160p'];

export function createStreamFreeFetch({ fetch, dnsFetch, userAgent }) {
  return async (url, options = {}, retries = 3) => {
    const init = { ...options, headers: { 'User-Agent': userAgent, ...options.headers } };
    let error;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const r = await fetch(url, { ...init, signal: options.signal || AbortSignal.timeout(10000) });
        // Consume under the same timeout so a reset during the body is retried.
        const body = await r.arrayBuffer();
        return new Response(body, { status: r.status, headers: r.headers });
      } catch (e) { error = e; }
    }
    try { return await dnsFetch(url, init); }
    catch (e) { throw e || error; }
  };
}

export function parseStreamFreeEmbed(html, embedUrl) {
  const literal = name => html.match(new RegExp(`const\\s+${name}\\s*=\\s*(['"])(.*?)\\1`))?.[2];
  const suffix = literal('SOURCE_SUFFIX') || '';
  const quality = literal('QUALITY');
  const blob = html.match(/const\s+_0x\s*=\s*(\{[\s\S]*?\});/);
  if (!blob) throw new Error('StreamFree: player metadata is unavailable');
  let slug = new URL(embedUrl).pathname.split('/').filter(Boolean).pop() || '';
  if (suffix && slug.endsWith(suffix)) slug = slug.slice(0, -suffix.length);
  if (quality && slug.endsWith(quality)) slug = slug.slice(0, -quality.length);
  const streamKey = html.match(/['"]\/get-stream-key\/([^'"?]+)['"]/)?.[1]
    || html.match(/const\s+VARIANT\s*=\s*['"]([^'"]+)['"]\s*\+\s*QUALITY/)?.[1]
    || slug;
  return { streamKey, suffix, quality, tokens: JSON.parse(blob[1]) };
}

export function streamFreeManifestUrl(origin, streamKey, quality, suffix, route, token) {
  if (!token?._t || token._e == null || !token._n) throw new Error(`StreamFree: no signed token for ${quality}`);
  const server = route.server_name || 'origin';
  const path = server === 'externalcdn' ? 'live-externalcdn' : server === 'origin' ? 'live' : 'live-cdn';
  return `${origin}/${path}/${encodeURIComponent(streamKey + quality + suffix)}/index.m3u8?` +
    new URLSearchParams({ _t: token._t, _e: String(token._e), _n: token._n });
}

function liveQualities(status, source) {
  const row = status.sources?.[source];
  const qualities = row?.qualities || (source === '1' ? status.qualities : status.qualities2) || {};
  return QUALITY_ORDER.filter(q => qualities[q]);
}

export function createStreamFreeResolver({ fetch, base }) {
  async function json(url, referer) {
    const r = await fetch(url, { headers: { Accept: 'application/json', Referer: referer } });
    if (!r.ok) throw new Error(`StreamFree: metadata HTTP ${r.status}`);
    return r.json();
  }
  async function verify(result) {
    const r = await fetch(result.url, { headers: { Accept: 'application/vnd.apple.mpegurl,*/*', Referer: result.referer } });
    if (!r.ok) throw new Error(`StreamFree: provider refused this feed (HTTP ${r.status}). Try another feed or retry later.`);
    const text = await r.text();
    if (!text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U'))
      throw new Error('StreamFree: provider returned an invalid live playlist. Try another feed or retry later.');
    return { ...result, verified: true };
  }

  async function resolveEmbed(embedUrl, pageReferer, supplied) {
    const origin = new URL(embedUrl).origin;
    const response = await fetch(embedUrl, { headers: { Referer: pageReferer || origin + '/' } });
    if (!response.ok) throw new Error(`StreamFree: player page HTTP ${response.status}`);
    const meta = parseStreamFreeEmbed(await response.text(), embedUrl);
    const referer = embedUrl;
    const [status, route] = supplied || await Promise.all([
      json(`${origin}/api/stream-status/${encodeURIComponent(meta.streamKey)}`, referer),
      json(`${origin}/get-stream-key/${encodeURIComponent(meta.streamKey)}`, referer),
    ]);
    if (!status.available) throw new Error('StreamFree: this feed is not currently live');
    const source = meta.suffix || '1';
    const qualities = liveQualities(status, source);
    const quality = meta.quality || qualities[0];
    if (!quality || !qualities.includes(quality)) throw new Error('StreamFree: this quality is not currently live');
    if (route.is_external && route.external_url)
      return verify({ url: route.external_url, quality, source, referer, isExternal: true });
    const url = streamFreeManifestUrl(origin, meta.streamKey, quality, meta.suffix, route, meta.tokens[quality]);
    return verify({ url, quality, source, referer });
  }

  async function resolve(streamKey, category) {
    const player = `${base}/player/${encodeURIComponent(category)}/${encodeURIComponent(streamKey)}`;
    const [status, route] = await Promise.all([
      json(`${base}/api/stream-status/${encodeURIComponent(streamKey)}`, `${base}/`),
      json(`${base}/get-stream-key/${encodeURIComponent(streamKey)}`, player),
    ]);
    if (!status.available) throw new Error('StreamFree: this feed is not currently live');
    const sources = Object.keys(status.sources || { '1': { available: true } })
      .filter(n => status.sources?.[n]?.available ?? n === '1')
      .sort((a, b) => Number(a) - Number(b));
    let error;
    for (const source of sources) {
      const suffix = source === '1' ? '' : source;
      for (const quality of liveQualities(status, source)) {
        const path = `${base}/embed/${encodeURIComponent(category)}/${encodeURIComponent(streamKey)}`;
        // Current embeds include quality before the optional numbered source.
        // Older deployments use only the source suffix and expose all tokens.
        for (const url of [`${path}${quality}${suffix}`, `${path}${suffix}`]) {
          try { return await resolveEmbed(url, player, [status, route]); }
          catch (e) {
            if (!error || /provider refused|invalid live playlist/.test(e.message)) error = e;
          }
        }
      }
    }
    throw error || new Error('StreamFree: no live source is available');
  }
  return { resolve, resolveEmbed };
}

let cachedFetch, BASE, sfFetch, resolver, mirrors;

export function setup(rt, config) {
  cachedFetch = rt.cachedFetch;
  BASE = config.base;
  sfFetch = createStreamFreeFetch({ fetch: rt.fetch, dnsFetch: rt.dnsFetch, userAgent: rt.UA });
  resolver = createStreamFreeResolver({ fetch: sfFetch, base: BASE });
  mirrors = (config.mirrors || []).filter(b => b !== BASE).map(base => createStreamFreeResolver({ fetch: sfFetch, base }));
}

/** Retry-and-DoH fetch for hosts in this family; SportsIndX shares it. */
export const fetcher = () => sfFetch;

/** All live and upcoming events. */
export function events() {
  return cachedFetch("streamfree:events", 60_000, async () => {
    const r = await sfFetch(`${BASE}/api/v1/streams`, { headers: { Accept: "application/json" } });
    const data = await r.json();
    return data.streams || [];
  });
}

export const resolveEmbed = (url, referer) => resolver.resolveEmbed(url, referer);

export async function resolve({ key, category }) {
  let error;
  for (const candidate of [resolver, ...mirrors]) {
    try { return await candidate.resolve(key, category); }
    catch (e) { if (!error || /provider refused|invalid live playlist/.test(e.message)) error = e; }
  }
  throw error;
}

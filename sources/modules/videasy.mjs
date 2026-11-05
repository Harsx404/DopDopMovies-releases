// Videasy / Vidy (Yoru, Breach, Vyse) — encrypted-HLS city endpoints, with VidZen as fallback.
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs: setup() runs once
// with the app runtime and this module's config from index.json; resolve()
// runs per play. Hosts and endpoints live in index.json, not here.

let UA, dnsFetch, dnsFetchStream, getHeadersForHost, resolveUrl, VIDEASY_APIS, VIDEASY_ENDPOINTS, VIDEASY_CITIES, VIDZEN_API, VIDZEN_REFERER;

export function setup(rt, config) {
  ({ UA, dnsFetch, dnsFetchStream, getHeadersForHost, resolveUrl } = rt);
  // apis: tried in order. "city" = /<city>/sources (current vidy.st backend),
  // "legacy" = <endpoint>/sources-with-title (old speedracelight backend).
  VIDEASY_APIS = config.apis;
  VIDEASY_ENDPOINTS = { legacy: config.legacyEndpoints || {} };
  // City order per source: cities behind a dead CDN fail the playback check
  // and fall through to the next, like the official player's server list.
  VIDEASY_CITIES = config.cities;
  VIDZEN_API = config.vidzen.api;
  VIDZEN_REFERER = config.vidzen.referer;
}

// A stream counts as playing when its first segment answers. Only the first kilobyte is read:
// a whole segment is megabytes, and the check was waiting for all of it.
async function firstBytes(url, headers) {
  const options = { headers: { ...headers, Range: "bytes=0-1023" } };
  if (!dnsFetchStream) { const r = await dnsFetch(url, options); return r.ok; }
  const r = await dnsFetchStream(url, options);
  try {
    if (r.statusCode < 200 || r.statusCode >= 300) return false;
    for await (const chunk of r.stream) if (chunk.length) return true;
    return false;
  } finally { r.stream.destroy(); }
}

// --- Videasy decryption functions ---
const Hl = [1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580];

const _f = [1732584193,4023233417,2562383102,271733878];

const Js = 61, Sf = 8, ms = 2654435769, Ys = [109,118,109,49];

function ci(l){l>>>=0;l^=l>>>16;l=Math.imul(l,2246822507)>>>0;l^=l>>>13;l=Math.imul(l,3266489909)>>>0;l^=l>>>16;return l>>>0;}

function ps(l,o){l>>>=0;o&=31;if(o===0)return l>>>0;return((l<<o)|(l>>>(32-o)))>>>0;}

function bf(l){return(l*(l+1)&1)===0;}

function If(l){return(l*(l+1)&1)===1;}

function Af(l){let o=_f[0]>>>0;for(let e=0;e<l.length;e++)o=ps((o^Math.imul(l.charCodeAt(e),Hl[e&15]))>>>0,5);return ci(o);}

function wf(l){const o=new Array(256);for(let i=0;i<256;i++)o[i]=i;let e=0;for(let i=0;i<256;i++){e=(e+o[i]+l.charCodeAt(i%l.length))&255;const r=o[i];o[i]=o[e];o[e]=r;}return o;}

function vf(l){let o=2166136261;for(let e=0;e<l.length;e++)o=Math.imul(o^l.charCodeAt(e),16777619)>>>0;return ci(o);}

function Nf(l,o,e){return(((l^o)>>>0)|((l&o&e)>>>0))>>>0;}

function Rf(l,o){if(If(l.length))return{S:wf(l),acc:Af(l)};const e=new Array(Js);let i=ci(vf(l)^ci((o>>>0)^ms))>>>0;for(let r=0;r<Sf;r++){if(bf(r)){const n=i%Js;i=ps((i+ms)>>>0,7+(r&7));e[n]=(i^ci(i))>>>0;i=ci((i+n)>>>0);}else{e[r]=Hl[r&15];}}return{S:e,acc:ci(i^2779096485)>>>0};}

function Cf(s,o){const e=s.S;let i=s.acc;const r=i%Js;const n=0-+(r in e);const u=e[r]>>>0;const d=Math.imul(ms,o+1)>>>0;let g=Nf(i,(u^d)>>>0,n);g=(ps((g+i)>>>0,r&31)^ps(i,Math.imul(r,7)&31))>>>0;i=ci((g+ms)>>>0);e[r]=i>>>0;s.acc=i;return i>>>0;}

function xf(l,o,e){const s=Rf(l,o);const r=new Uint8Array(e);let n=0;for(let u=0;u<e;){const d=Cf(s,n++);r[u++]=d&255;if(u<e)r[u++]=(d>>>8)&255;if(u<e)r[u++]=(d>>>16)&255;if(u<e)r[u++]=(d>>>24)&255;}return r;}

function Df(l){const o=l.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(l.length/4)*4,"=");const e=Buffer.from(o,"base64");const i=new Uint8Array(e.length);for(let r=0;r<e.length;r++)i[r]=e[r];return i;}

function Pf(l,o,e){const i=Df(l);const r=xf(o,e,i.length);for(let n=0;n<i.length;n++)i[n]^=r[n];for(let n=0;n<Ys.length;n++){if(i[n]!==Ys[n])throw new Error("decrypt failed");}return new TextDecoder("utf-8").decode(i.subarray(Ys.length));}

// VidZen — vidcore.org's primary backend. /api/sources returns tokenized
// master playlists (relative /api/stream/... paths) plus a sourcePool keyed by
// server name; pool entries carry their own subtitles.
async function resolveVidZen(tmdbId, type, season, episode) {
  let url = `${VIDZEN_API}/api/sources?type=${type}&id=${tmdbId}`;
  if (type === "tv") url += `&season=${season || 1}&episode=${episode || 1}`;
  const r = await dnsFetch(url, { headers: { "User-Agent": UA, Referer: VIDZEN_REFERER } });
  if (!r.ok) throw new Error(`VidZen: HTTP ${r.status}`);
  const data = JSON.parse(await r.text());
  const pools = Object.values(data.sourcePool || {});
  const raw = [...(Array.isArray(data.sources) ? data.sources : []),
    ...pools.flatMap((p) => (p && Array.isArray(p.sources) ? p.sources : []))];
  const seen = new Set();
  const streams = [];
  for (const s of raw) {
    if (!s || !s.url) continue;
    const abs = s.url.startsWith("/") ? VIDZEN_API + s.url : s.url;
    if (!/^https?:\/\//.test(abs) || seen.has(abs)) continue;
    seen.add(abs);
    streams.push({ quality: s.quality || s.server || "auto", url: abs });
  }
  if (!streams.length) throw new Error("VidZen: no sources");

  // Same playback check as VidCore — manifest + first segment.
  const first = streams[0].url;
  const host = new URL(first).hostname;
  const sr = await dnsFetch(first, { headers: getHeadersForHost(host) });
  const st = await sr.text();
  let valid = st.includes("#EXTM3U");
  if (valid) {
    const segLine = st.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (segLine) {
      try {
        if (!(await firstBytes(resolveUrl(first, segLine), getHeadersForHost(host)))) valid = false;
      } catch { valid = false; }
    }
  }
  if (!valid) throw new Error(`VidZen: stream failed playback check (CDN ${host})`);

  const subtitles = [];
  for (const s of [...(data.subtitles || []), ...pools.flatMap((p) => (p && p.subtitles) || [])]) {
    const u = s && (s.url || s.file);
    if (u) subtitles.push({ url: u, lang: s.lang || s.language || s.label || "und", label: s.label || s.lang || "Sub" });
  }
  return {
    cdn: host,
    qualities: streams.map((s) => ({ quality: s.quality, url: s.url, cdn: new URL(s.url).hostname })),
    verified: true,
    subtitles,
    provider: "vidzen",
  };
}

// Videasy/Vidy encrypted-HLS API. The service rebranded vidking → videasy →
// vidy.st; the live backend is api.wecollege.net (speedracelight is dead).
// City endpoints differ by audio: miami/boise may carry 4K, delhi = Hindi,
// munich/berlin = German, paris = French, cancun = Spanish, rest = original.
// City endpoints on api.wecollege.net — ordered per provider. Cities behind a
// dead CDN fail the playback check and fall through to the next, the same way
// the official player iterates its server list.
async function resolveVideasy(provider, tmdbId, type, season, episode) {
  let lastErr = null;
  for (const base of VIDEASY_APIS) {
    try {
      return await resolveVideasyVia(base, provider, tmdbId, type, season, episode);
    } catch (e) {
      lastErr = e;
      console.log(`  videasy ${provider} via ${base.api}: ${e.message.slice(0, 70)}`);
    }
  }
  throw lastErr;
}

// Yoru, Vyse and Breach ask the same service, which limits how often it's asked. They share a
// title's seed for a little while, and after "too many requests" leave it alone for a few minutes
// (playback goes to the fallback meanwhile) instead of asking again on every play.
const SEED_TTL_MS = 2 * 60_000;
const LIMIT_PAUSE_MS = 5 * 60_000;
const seeds = new Map();
const limitedUntil = new Map();
async function seedFor(base, tmdbId, fresh = false) {
  if ((limitedUntil.get(base.api) ?? 0) > Date.now()) throw new Error("rate limited");
  const key = `${base.api}|${tmdbId}`;
  const hit = seeds.get(key);
  if (!fresh && hit && Date.now() - hit.at < SEED_TTL_MS) return hit.seed;
  const pending = dnsFetch(`${base.api}/seed?mediaId=${tmdbId}`, {
    headers: { "User-Agent": UA, Referer: base.referer, Origin: base.origin, Accept: "application/json" },
  }).then(async (r) => {
    if (r.status === 429) { limitedUntil.set(base.api, Date.now() + LIMIT_PAUSE_MS); throw new Error("rate limited"); }
    const seed = JSON.parse(await r.text()).seed;
    if (!seed) throw new Error("no seed");
    return seed;
  });
  seeds.set(key, { at: Date.now(), seed: pending });
  pending.catch(() => { if (seeds.get(key)?.seed === pending) seeds.delete(key); });
  if (seeds.size > 300) seeds.delete(seeds.keys().next().value);
  return pending;
}

async function resolveVideasyVia(base, provider, tmdbId, type, season, episode) {
  const endpoints = base.fmt === "city"
    ? (VIDEASY_CITIES[provider] || VIDEASY_CITIES["videasy-yoru"]).map((c) => `${c}/sources`)
    : [VIDEASY_ENDPOINTS.legacy[provider] || "cdn/sources-with-title"];

  // Title details and the seed don't depend on each other: ask for both at once.
  const [metaR, firstSeed] = await Promise.all([
    dnsFetch(`${base.db}/3/${type}/${tmdbId}?api_key=test`, { headers: { "User-Agent": UA, Referer: base.referer } }),
    seedFor(base, tmdbId),
  ]);
  let title = "Unknown", year = "2000", imdbId = "", totalSeasons = "";
  if (metaR.ok) {
    const meta = JSON.parse(await metaR.text());
    title = meta.title || meta.name || "Unknown";
    year = (meta.release_date || meta.first_air_date || "2000-01-01").slice(0, 4);
    imdbId = meta.imdb_id || "";
    totalSeasons = meta.number_of_seasons ? String(meta.number_of_seasons) : "";
  }

  let seed = firstSeed;

  // The official client encodeURIComponent()s the title before handing it to
  // the params serializer — it goes out double-encoded on the wire.
  const params = new URLSearchParams({
    title: encodeURIComponent(title), mediaType: type, year,
    episodeId: String(episode || 1), seasonId: String(season || 1),
    tmdbId: String(tmdbId), imdbId, enc: "2", seed,
  });
  if (totalSeasons) params.set("totalSeasons", totalSeasons);

  // Cities run in parallel (like the official player's "best server" race) —
  // a dead CDN would otherwise eat ~10s per city and blow the frontend's 20s
  // budget. Each attempt snapshots params so a concurrent seed refresh can't
  // desync its decryption key.
  const CITY_DEADLINE_MS = 12000;
  const tryCity = async (endpoint) => {
    const p = new URLSearchParams(params);
    const srcHeaders = { "User-Agent": UA, Referer: base.referer, Origin: base.origin, Accept: "*/*" };
    let r = await dnsFetch(`${base.api}/${endpoint}?${p}`, { headers: srcHeaders });
    let text = await r.text();

    // Retry with fresh seed on 401/500
    if (r.status === 401 || r.status === 500) {
      p.set("seed", await seedFor(base, tmdbId, true));
      r = await dnsFetch(`${base.api}/${endpoint}?${p}`, { headers: srcHeaders });
      text = await r.text();
    }

    if (!r.ok) throw new Error(`HTTP ${r.status} — ${text.slice(0, 80)}`);

    const data = JSON.parse(Pf(text, p.get("seed"), parseInt(tmdbId)));
    if (!data.sources || data.sources.length === 0) throw new Error("no sources");

    // Playback check: fetch the manifest and first segment so a CDN that
    // serves the playlist but 403s segments fails over to the next city.
    const first = data.sources[0].url;
    const firstHost = new URL(first).hostname;
    const streamHeaders = { "User-Agent": UA, Referer: base.referer, Origin: base.origin };
    try {
      const mr = await dnsFetch(first, { headers: streamHeaders });
      const mText = await mr.text();
      const segLine = mText.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
      const segOk = !segLine || await firstBytes(resolveUrl(first, segLine), streamHeaders);
      if (!mText.includes("#EXTM3U") || !segOk) throw new Error("bad stream");
    } catch {
      throw new Error(`stream failed playback check (CDN ${firstHost})`);
    }

    return {
      cdn: firstHost,
      qualities: data.sources.map(s => ({
        quality: s.quality || "auto",
        url: s.url,
        cdn: new URL(s.url).hostname,
      })),
      verified: true,
      subtitles: data.subtitles,
      referer: base.referer,
      provider: `videasy-${endpoint.split("/")[0]}`,
    };
  };

  // All cities fire in parallel, but we await them in preference order — a dead
  // first-choice city caps at CITY_DEADLINE_MS while later ones are already done.
  const pending = endpoints.map((endpoint) =>
    Promise.race([
      tryCity(endpoint),
      new Promise((_, rej) => setTimeout(() => rej(new Error("deadline")), CITY_DEADLINE_MS)),
    ]).then(
      (v) => { console.log(`  videasy ${provider} ${endpoint}: ok`); return { v }; },
      (e) => { console.log(`  videasy ${provider} ${endpoint}: ${String(e && e.message || e).slice(0, 70)}`); return { e }; },
    )
  );
  let lastErr = null;
  for (const p of pending) {
    const r = await p;
    if (r.v) return r.v;
    lastErr = r.e;
  }
  throw lastErr || new Error("Videasy: no sources");
}

export async function resolve(req, { source, params }) {
  const { id, type, season, episode } = req;
  const viaVideasy = resolveVideasy(source, id, type, season, episode);
  if (params.fallback !== "vidzen") return viaVideasy;
  return viaVideasy.catch((e) => {
    console.log("  videasy upstream down, vidzen fallback:", e.message.slice(0, 60));
    return resolveVidZen(id, type, season, episode);
  });
}

// VidZen alone, for sources that fall back to another module.
export { resolveVidZen };

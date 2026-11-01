// Pluto TV — free ad-supported channels and their schedule.
//
// DopDop live addon. The boot and channel APIs are region-locked, so calls go
// through the app's WireGuard bridge when configured, otherwise the geo worker.
// Hosts and the category map live in index.json.

let cachedFetch, geoFetch, proxiedFetch, plutoProxy, log, directFetch;
let PLUTO_BOOT, CATEGORY_MAP;

export function setup(rt, config) {
  ({ cachedFetch, geoFetch, proxiedFetch, plutoProxy, log } = rt);
  directFetch = rt.fetch ? (url, init = {}) => rt.fetch(url, { ...init, signal: AbortSignal.timeout(6000), headers: { 'User-Agent': rt.UA, ...init.headers } }) : null;
  PLUTO_BOOT = config.boot;
  CATEGORY_MAP = config.categories || {};
  plutoSession = null;
}

function sessionFetch(s, url, headers = {}) {
  if (s.via === 'wireguard') return proxiedFetch(url, { headers });
  if (s.via === 'system') return directFetch(url, { headers });
  // geoFetch accepts a header map, unlike fetch/proxiedFetch's init object.
  return geoFetch(url, headers);
}

let plutoSession = null;
export async function plutoBoot() {
  if (plutoSession && plutoSession.expires > Date.now()) return plutoSession;
  const params = new URLSearchParams({
    appName: "web", appVersion: "7.0.0", deviceVersion: "94.0.0",
    deviceModel: "web", deviceMake: "chrome", deviceType: "web",
    clientID: crypto.randomUUID(), clientModelNumber: "1.0.0", dnt: "0",
  });
  // Use an explicit app tunnel first. Otherwise try the machine's own route,
  // which includes a system-wide Proton VPN connection, before the worker.
  const url = `${PLUTO_BOOT}?${params}`;
  let d, via = plutoProxy() ? 'wireguard' : 'worker';
  if (!plutoProxy() && directFetch) {
    try {
      const r = await directFetch(url);
      const candidate = r.ok ? await r.json() : null;
      if (candidate?.sessionToken && candidate.session?.activeRegion) { d = candidate; via = 'system'; }
    } catch { /* Unsupported or unreachable locally: use the worker below. */ }
  }
  if (!d) {
    const r = plutoProxy() ? await proxiedFetch(url) : await geoFetch(url);
    if (!r.ok) throw new Error(`Pluto boot: HTTP ${r.status}`);
    d = await r.json();
  }
  if (!d.sessionToken) throw new Error("Pluto boot returned no session");
  plutoSession = {
    token: d.sessionToken,
    stitcherParams: d.stitcherParams,
    stitcher: d.servers.stitcher,
    channelsApi: d.servers.channels,
    region: d.session?.activeRegion || "?",
    via,
    // refreshInSec is ~8h — renew at half that to stay ahead of expiry
    // Recheck the system route soon if the person connects their VPN later.
    expires: Date.now() + (via === 'worker' ? 60_000 : Math.min((d.refreshInSec || 28800) * 500, 4 * 3600_000)),
  };
  return plutoSession;
}

export function channels() {
  return cachedFetch("pluto:channels", 30 * 60_000, async () => {
    // Pluto binds session tokens to the egress IP that created them, and the
    // Worker's egress rotates per request — retry boot+channels until they
    // land on the same egress IP (usually succeeds within a few tries).
    let chans = [], cats = [], lastErr = null;
    for (let attempt = 0; attempt < 6 && !chans.length; attempt++) {
      try {
        const s = await plutoBoot();
        const headers = { Authorization: `Bearer ${s.token}`, Accept: "application/json" };
        // Use the same egress as the boot call — sessions are bound to their IP
        const apiFetch = (u) => sessionFetch(s, u, headers);
        const [chR, catR] = await Promise.all([
          apiFetch(`${s.channelsApi}/v2/guide/channels?offset=0&limit=400&sort=number%3Aasc`),
          apiFetch(`${s.channelsApi}/v2/guide/categories`),
        ]);
        if (chR.status === 401) { plutoSession = null; lastErr = new Error("Pluto channels: HTTP 401"); continue; }
        if (!chR.ok) { lastErr = new Error(`Pluto channels: HTTP ${chR.status}`); continue; }
        chans = (await chR.json()).data || [];
        cats = catR.ok ? ((await catR.json()).data || []) : [];
      } catch (e) {
        lastErr = e;
        plutoSession = null;
      }
      if (!chans.length) await new Promise((r) => setTimeout(r, 600));
    }
    if (!chans.length) throw lastErr || new Error("Pluto returned an empty channel catalog");
    log(`pluto: api → ${chans.length} channels, ${cats.length} categories`);
    const catByChannel = new Map();
    for (const cat of cats) for (const id of cat.channelIDs || []) catByChannel.set(id, cat.name);
    // Tag with the session's region so the country filter reflects reality
    // (GB → UK per iptv-org convention)
    const region = plutoSession?.region === "GB" ? "UK" : plutoSession?.region || "UK";
    return mapChannels(chans, catByChannel, region);
  });
}

export function mapChannels(chans, catByChannel, region = "UK") {
  return chans.filter((c) => c.isStitched && c.stitched?.path).map((c) => {
    const catName = (catByChannel.get(c.id) || "Entertainment").toLowerCase();
    return {
      id: `pluto:${c.id}`,
      name: c.name,
      country: region, // iptv-org uses UK for United Kingdom — matches the country filter
      categories: [CATEGORY_MAP[catName] || "entertainment"],
      url: null,
      resolveUrl: `/api/pluto-stream?id=${c.id}`,
      logo: `https://images.pluto.tv/channels/${c.id}/colorLogoPNG.png`,
      quality: "HD",
      source: "Pluto TV",
      number: c.number,
    };
  });
}

/** Drop the session, e.g. after the WireGuard bridge changes egress. */
export function region() {
  return plutoSession?.region || null;
}

export function routing() {
  return plutoSession?.via || (plutoProxy() ? 'wireguard' : 'worker');
}

export function resetSession() {
  plutoSession = null;
}

/** What's on: for each channel id, its programmes from now over the next hours. */
export function guide(ids, hours = 4) {
  const key = ids.join(",");
  return cachedFetch(`pluto:guide:${key}`, 5 * 60_000, async () => {
    // Sessions are bound to the egress IP and the worker's rotates, so retry like channels().
    const start = new Date(Date.now() - 30 * 60_000).toISOString();
    const q = new URLSearchParams({ start, channelIds: key, duration: String(hours * 60) });
    let r;
    for (let attempt = 0; attempt < 6; attempt++) {
      const s = await plutoBoot();
      const headers = { Authorization: `Bearer ${s.token}`, Accept: "application/json" };
      const apiFetch = (u) => sessionFetch(s, u, headers);
      r = await apiFetch(`${s.channelsApi}/v2/guide/timelines?${q}`);
      if (r.status !== 401) break;
      plutoSession = null;
      await new Promise((done) => setTimeout(done, 400));
    }
    if (!r.ok) throw new Error(`Pluto guide: HTTP ${r.status}`);
    const out = {};
    for (const row of (await r.json()).data || []) {
      out[`pluto:${row.channelId}`] = (row.timelines || []).map((t) => ({ title: t.title, start: t.start, stop: t.stop, episode: t.episode?.name || undefined }));
    }
    return out;
  });
}

export async function resolve({ id }) {
  const s = await plutoBoot();
  return { url: `${s.stitcher}/v2/stitch/hls/channel/${id}/master.m3u8?jwt=${encodeURIComponent(s.token)}&masterJWTPassthrough=true&includeExtendedEvents=true`, type: "hls", quality: "HD" };
}

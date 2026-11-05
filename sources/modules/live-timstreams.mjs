// Tim Streams — 24/7 sports, news and entertainment channels.
//
// DopDop live addon. Free streams only: entries the site marks VIP are never
// listed. Stream links are signed inside the host's player, so the app's capture
// bridge opens it and reports the playlist (desktop app only). Hosts and the
// genre map live in index.json.

import { verifyLiveHls } from './live-media.mjs';

let UA, dnsFetch, dnsFetchStream, smartFetch, cachedFetch, captureStream, BASE, GENRES;
const resolved = new Map();
const pending = new Map();

export function setup(rt, config) {
  ({ UA, dnsFetch, dnsFetchStream, smartFetch, cachedFetch, captureStream } = rt);
  BASE = config.base;
  GENRES = config.genres || {};
  resolved.clear();
  pending.clear();
}

function catalog() {
  return cachedFetch("timstreams:channels", 30 * 60_000, async () => {
    const r = await dnsFetch(`${BASE}/api/channels`, { headers: { "User-Agent": UA, Referer: `${BASE}/`, Accept: "application/json" } });
    if (!r.ok) throw new Error(`Tim Streams: HTTP ${r.status}`);
    return (await r.json()).channels || [];
  });
}

/** Channels in the shape the guide uses. */
export async function channels() {
  const all = await catalog();
  return all
    .map((c) => ({ c, free: (c.streams || []).filter((s) => !s.vip) }))
    .filter(({ c, free }) => !c.vip && free.length)
    .map(({ c, free }) => ({
      id: `tim:${c.url}`,
      name: c.name,
      country: c.flag === "gb" ? "UK" : String(c.flag || "").toUpperCase(),
      categories: [GENRES[c.genre] || "entertainment"],
      url: null,
      resolveUrl: `/api/timstreams-resolve?id=${encodeURIComponent(c.url)}`,
      logo: c.logo || "",
      quality: "HD",
      source: "Tim Streams",
      options: free.map((s) => s.name),
    }));
}

/** Only channels the catalog lists can be opened, never an arbitrary address. */
export function resolve({ id, option = 0, fresh = false }) {
  const key = `${id}:${option}`;
  const cached = resolved.get(key);
  if (!fresh && cached?.expires > Date.now()) return Promise.resolve(cached.value);
  if (pending.has(key)) return pending.get(key);
  // Getting a link means loading the host's whole player. An older link is usually still good,
  // and checking it takes a moment; only a dead one costs the full trip.
  const recheck = !fresh && cached?.usableUntil > Date.now()
    ? verifyLiveHls(cached.value, { fetch: smartFetch || dnsFetch, fetchStream: dnsFetchStream, userAgent: UA })
    : Promise.reject();
  const work = recheck.catch(() => resolveChannel({ id, option })).then(value => {
    resolved.set(key, { value, expires: Date.now() + 5 * 60_000, usableUntil: Date.now() + 30 * 60_000 });
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}

async function resolveChannel({ id, option }) {
  const channel = (await catalog()).find((c) => c.url === id);
  const free = (channel?.streams || []).filter((s) => !s.vip);
  if (!free.length) throw new Error("Tim Streams: channel not found");
  // A channel's feed can be offline while its player still hands out a link,
  // so check the playlist and fall through to the channel's other free feeds.
  const first = Math.max(0, Math.min(free.length - 1, Math.trunc(Number(option)) || 0));
  const order = [...free.slice(first), ...free.slice(0, first)];
  let error;
  for (const stream of order) {
    try {
      const { url, referer } = await captureStream(stream.url, `${BASE}/channel/${id}`);
      return await verifyLiveHls({ url, referer, type: 'hls', quality: 'HD', option: stream.name }, {
        fetch: smartFetch || dnsFetch, fetchStream: dnsFetchStream, userAgent: UA,
      });
    } catch (e) {
      error = e;
      if (/needs app|window closed/i.test(e.message)) throw e;
      console.log(`Tim Streams ${channel.name} (${stream.name}): ${e.message}`);
    }
  }
  throw new Error(`Tim Streams: no working feed right now (${error?.message || 'offline'})`);
}

// Radio Browser — public directory of internet radio stations.
//
// DopDop audio addon. The mirror address lives in index.json, so a dead mirror
// is fixed by a pack update.

let dnsFetch, BASE, UA;

export function setup(rt, config) {
  dnsFetch = rt.dnsFetch;
  BASE = config.base;
  UA = config.userAgent;
}

async function call(path, params = {}) {
  const r = await dnsFetch(`${BASE}${path}?${new URLSearchParams(params)}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Radio Browser: HTTP ${r.status}`);
  return r.json();
}

export async function resolve({ q, tag, country, limit = 100 }) {
  const params = { limit, hidebroken: "true", order: "clickcount", reverse: "true" };
  if (q) params.name = q;
  if (tag) params.tag = tag;
  if (country) params.country = country;
  const stations = await call("/json/stations/search", params);
  return stations.map((s) => ({
    uuid: s.stationuuid,
    name: s.name,
    url: s.url_resolved || s.url,
    country: s.country,
    countrycode: s.countrycode,
    tags: (s.tags || "").split(",").filter(Boolean).slice(0, 5),
    codec: s.codec,
    bitrate: s.bitrate,
    favicon: s.favicon,
    votes: s.votes,
    clickcount: s.clickcount,
  }));
}

export const tags = (limit = 60) => call("/json/tags", { order: "stationcount", reverse: "true", limit });
export const countries = (limit = 60) => call("/json/countries", { order: "stationcount", reverse: "true", limit });

// KatDrama (k-drama.in): series by TMDB id, so titles never need matching. Its player
// page carries the streams and subtitles as plain JSON; no site scripts are executed.
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs. Hosts live in index.json.

let UA, dnsFetch, BASE;

export function setup(rt, config) {
  ({ UA, dnsFetch } = rt);
  BASE = config.base.replace(/\/+$/, "");
}

const rawUrl = (quality) => new URL(quality.url, "http://x").searchParams.get("url");

/** Some of the page's streams refuse anyone but their own player, so only the ones that answer are offered. */
async function answers(quality) {
  try {
    const res = await dnsFetch(rawUrl(quality), { headers: { "User-Agent": UA, Referer: `${BASE}/` }, signal: AbortSignal.timeout(8000) });
    return res.ok && (await res.text()).trimStart().startsWith("#EXTM3U");
  } catch { return false; }
}

const proxied = (url) => `/api/hls?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(`${BASE}/`)}`;

function listAfter(html, name) {
  const found = html.match(new RegExp(`const ${name} = (\\[.*?\\]);\\s*\\n`, "s"));
  if (!found) return [];
  try { return JSON.parse(found[1]); } catch { return []; }
}

/** Page data → the app's shape. One entry per stream: a source's qualities can all be the same adaptive playlist. */
export function parsePlayer(html) {
  const seen = new Set();
  const qualities = [];
  for (const s of listAfter(html, "SOURCES")) {
    if (!/^https:\/\//.test(s?.url || "") || s.type !== "hls" || seen.has(s.url)) continue;
    seen.add(s.url);
    const language = s.languageLabel || s.language;
    qualities.push({ quality: `Stream ${qualities.length + 1}${language ? ` · ${language}` : ""}`, url: proxied(s.url), type: "hls", lang: s.language || undefined });
  }
  const subtitles = listAfter(html, "SUBTITLES")
    .map((t) => ({ url: t.url || t.file, lang: t.lang || t.language || t.srclang || "en", label: t.label || t.lang || "Subtitles" }))
    .filter((t) => /^https:\/\//.test(t.url || ""))
    .map((t) => ({ ...t, url: proxied(t.url) }));
  return { qualities, subtitles };
}

export async function resolve(req) {
  if (req.type !== "tv") throw new Error("KatDrama: series only");
  const id = Number(req.id), season = Number(req.season) || 1, episode = Number(req.episode) || 1;
  if (!Number.isInteger(id) || id <= 0) throw new Error("KatDrama: TMDB id required");
  const res = await dnsFetch(`${BASE}/vid2.php/${id}/${season}/${episode}`, { headers: { "User-Agent": UA, Referer: `${BASE}/watch/tv/x-${id}-episode-${episode}`, Accept: "text/html" } });
  if (!res.ok) throw new Error(`KatDrama: HTTP ${res.status}`);
  const { qualities, subtitles } = parsePlayer(await res.text());
  const checks = await Promise.all(qualities.map(answers));
  const working = qualities.filter((_, i) => checks[i]);
  if (!working.length) throw new Error("KatDrama: no working stream for this episode");
  return { cdn: new URL(BASE).host, verified: true, qualities: working, subtitles };
}

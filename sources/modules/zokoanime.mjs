// ZokoAnime — Direct MyAnimeList (MAL) keyed anime resolver.
// DopDop Anime Source Pack Module.
//
// Endpoint: https://zokoanime.video/stream/mal/{malId}/{ep}/{mode}
// Zero-scraping, direct fast-path resolution when MAL ID is available.

let UA, dnsFetch, EMBED_URL;

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const XOR_KEY = Buffer.from("otaku-embed-v1");
// The player reaches streams through the backend, which adds the Referer they need.
const proxied = (url, referer) => `/api/hls?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`;

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The app knows titles by TMDB id, never MAL: find the MAL id for this title and season on AniList. */
async function findMalId(title, season) {
  const n = Number(season) || 1;
  const search = n > 1 ? `${title} season ${n}` : title;
  const query = `query($s:String){Page(perPage:10){media(search:$s,type:ANIME,isAdult:false){idMal format season title{romaji english}}}}`;
  const res = await dnsFetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { s: search } }),
  });
  if (!res.ok) throw new Error(`ZokoAnime: AniList HTTP ${res.status}`);
  const list = (await res.json())?.data?.Page?.media ?? [];
  const words = norm(title).split(" ");
  const seasonMark = new RegExp(`\\b(season ${n}|${n}(st|nd|rd|th) season|${n}|${["", "i", "ii", "iii", "iv", "v"][n] || n})\\b`);
  const fits = (m) => {
    if (!m.idMal || !["TV", "TV_SHORT", "ONA", "MOVIE"].includes(m.format)) return false;
    const names = [m.title?.english, m.title?.romaji].map(norm);
    return names.some((name) => words.every((w) => name.includes(w)) && (n === 1 ? !/\b(season [2-9]|[2-9](nd|rd|th) season)\b/.test(name) : seasonMark.test(name)));
  };
  // Nothing certain means no answer: another show must never play in its place.
  return list.find(fits)?.idMal ?? null;
}

// The embed marks every subtitle "en", whatever it is. Its label is what's right ("French (- Francais(France))").
const LANG_BY_NAME = { english: "en", arabic: "ar", french: "fr", german: "de", italian: "it", portuguese: "pt", russian: "ru", spanish: "es", indonesian: "id", malay: "ms", thai: "th", vietnamese: "vi", turkish: "tr", hindi: "hi", chinese: "zh", japanese: "ja", korean: "ko", polish: "pl", dutch: "nl", filipino: "tl", tagalog: "tl", tamil: "ta", telugu: "te", bengali: "bn" };
export function subtitleLanguage(s) {
  const name = String(s.label || "").trim().split(/[\s(-]/)[0].toLowerCase();
  return LANG_BY_NAME[name] || name || s.lang || "en";
}
/** "Spanish (- Espanol(Espana))" → "Espanol(Espana)": what tells two of a language apart. */
export const subtitleLabel = (s) => String(s.label || s.lang || "Subtitles").match(/\(-\s*(.+)\)\s*$/)?.[1] || s.label || s.lang || "Subtitles";

export function setup(rt, config = {}) {
  UA = rt.UA || DEFAULT_UA;
  dnsFetch = rt.dnsFetch || rt.smartFetch || rt.fetch || fetch;
  EMBED_URL = (config.embed || "https://zokoanime.video").replace(/\/+$/, "");
}

function deobfuscateBlob(b64) {
  try {
    const buf = Buffer.from(b64, "base64");
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
      out[i] = buf[i] ^ XOR_KEY[i % XOR_KEY.length];
    }
    return JSON.parse(out.toString("utf8"));
  } catch {
    return null;
  }
}

export async function resolve(req, ctx = {}) {
  const malId = req.malId || (await findMalId(req.cartoonTitle || req.title || req.q, req.season));
  if (!malId || !/^\d+$/.test(String(malId))) {
    throw new Error("ZokoAnime: couldn't identify this title");
  }

  const ep = parseInt(req.animeEp) || Number(req.episode) || 1;
  const mode = /dub/i.test(req.animeLang || "") ? "dub" : "sub";
  const embedUrl = `${EMBED_URL}/stream/mal/${malId}/${ep}/${mode}`;

  const res = await dnsFetch(embedUrl, {
    headers: {
      "User-Agent": UA,
      Referer: "https://hianime.at/",
    },
  });
  if (!res.ok) throw new Error(`ZokoAnime: HTTP ${res.status}`);
  const html = await res.text();

  const pMatch = html.match(/window\.__P="([^"]*)"/);
  if (!pMatch) throw new Error("ZokoAnime: stream configuration not found");

  const config = deobfuscateBlob(pMatch[1]);
  if (!config?.src) throw new Error("ZokoAnime: invalid stream manifest");

  const masterM3u8 = config.src;
  const subtitles = (config.subtitles || []).map((s) => ({
    label: subtitleLabel(s),
    lang: subtitleLanguage(s),
    url: proxied(s.src, embedUrl),
  }));

  const qualities = [
    {
      quality: `auto${mode === "dub" ? " · Dub" : ""}`,
      url: proxied(masterM3u8, embedUrl),
      type: "hls",
      lang: mode,
    },
  ];

  // Enumerate 1080p, 720p, 360p renditions
  try {
    const mRes = await dnsFetch(masterM3u8, {
      headers: { "User-Agent": UA, Referer: embedUrl },
    });
    if (mRes.ok) {
      const text = await mRes.text();
      const lines = text.split("\n");
      const baseDir = masterM3u8.substring(0, masterM3u8.lastIndexOf("/") + 1);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("#EXT-X-STREAM-INF")) {
          const resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
          const next = lines[i + 1]?.trim();
          if (resMatch && next && !next.startsWith("#")) {
            const variantUrl = next.startsWith("http") ? next : `${baseDir}${next}`;
            qualities.push({
              quality: `${resMatch[1]}p${mode === "dub" ? " · Dub" : ""}`,
              url: proxied(variantUrl, embedUrl),
              type: "hls",
              lang: mode,
            });
          }
        }
      }
    }
  } catch {}

  return {
    cdn: "hls.dramahot.top",
    verified: true,
    qualities,
    subtitles,
  };
}


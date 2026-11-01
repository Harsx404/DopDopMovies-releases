// JioSaavn — DopDop audio addon.
//
// Loaded by src/lib/source-pack.mjs: setup() runs once with the app runtime
// and this module's config from index.json, where its hosts live, so a site
// that moves is fixed by a pack update.
import { execFile } from "node:child_process";

let curlFetch;

export function setup(rt, config) {
  ({ curlFetch } = rt);
  if (config.SAAVN_API) SAAVN_API = config.SAAVN_API;
}

// --- Music provider: JioSaavn (320kbps) ---

// JioSaavn: DES-ECB decryption for encrypted_media_url. OpenSSL 3 only exposes
// single DES through the legacy provider, so decrypt every URL of a search in
// ONE child process instead of one spawn per song.
function jiosaavnDecryptAll(encryptedUrls) {
  if (!encryptedUrls.length) return Promise.resolve([]);
  const script = `
const crypto = require('crypto');
const key = Buffer.from('38346591', 'utf-8');
const out = JSON.parse(process.argv[1]).map((enc) => {
  try {
    const decipher = crypto.createDecipheriv('des-ecb', key, Buffer.alloc(0));
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf-8');
  } catch { return ''; }
});
process.stdout.write(JSON.stringify(out));`;
  return new Promise((resolve, reject) => {
    // ELECTRON_RUN_AS_NODE makes the packaged Electron binary act as Node —
    // harmless no-op under plain node.exe in dev. Electron's BoringSSL has
    // DES built in; plain Node's OpenSSL 3 needs the legacy-provider flag.
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    const nodeArgs = process.versions.electron
      ? ["-e", script, JSON.stringify(encryptedUrls)]
      : ["--openssl-legacy-provider", "-e", script, JSON.stringify(encryptedUrls)];
    execFile(process.execPath, nodeArgs, { encoding: "utf-8", timeout: 8000, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

const unescapeSaavn = (t) => String(t || "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#039;/g, "'");

// JioSaavn: search via saavn.sumit.co (returns download URLs directly).
// It sits behind Cloudflare and is blocked often; remember a failure for a few
// minutes so we go straight to the official API instead of paying a timeout.
let saavnMirrorDownUntil = 0;
export async function jiosaavnSearch(q) {
  if (Date.now() < saavnMirrorDownUntil) throw new Error("saavn mirror marked down");
  let d;
  try {
    const html = await curlFetch(`https://saavn.sumit.co/api/search/songs?query=${encodeURIComponent(q)}&limit=30`, {
      Accept: "application/json",
    });
    d = JSON.parse(html);
  } catch (e) {
    saavnMirrorDownUntil = Date.now() + 5 * 60_000;
    throw e;
  }
  const songs = (d.data?.results || []).map(s => ({
    id: s.id || "",
    title: s.name || "",
    artist: s.primaryArtists || s.artists?.primary?.map(a => a.name).join(", ") || "",
    album: s.album?.name || "",
    duration: s.duration ? Math.round(s.duration) : 0,
    thumb: s.image?.find(img => img.quality === "150x150")?.url || s.image?.[0]?.url || "",
    url: s.downloadUrl?.find(u => u.quality === "320kbps")?.url || s.downloadUrl?.[s.downloadUrl.length - 1]?.url || "",
  }));
  if (!songs.length) throw new Error("saavn mirror returned no songs");
  return { tracks: songs };
}

// JioSaavn: official search API + DES decryption of the media URL.
// search.getResults returns full song objects (encrypted_media_url, duration)
// unlike autocomplete.get, which needs a second getDetails round trip.
async function jiosaavnSearchFallback(q) {
  const html = await curlFetch(`https://www.jiosaavn.com/api.php?__call=search.getResults&q=${encodeURIComponent(q)}&_format=json&_marker=0&p=1&n=30&ctx=web6dot0`, {
    Accept: "application/json",
  });
  const d = JSON.parse(html);
  const results = d.results || [];
  const urls = await jiosaavnDecryptAll(results.map(s => s.encrypted_media_url || ""));
  const songs = results.map((s, i) => ({
    id: s.id,
    title: unescapeSaavn(s.song || s.title),
    artist: unescapeSaavn(s.primary_artists || s.singers || ""),
    album: unescapeSaavn(s.album || ""),
    duration: Number(s.duration) || 0,
    thumb: (s.image || "").replace("150x150", "500x500"),
    url: urls[i] ? urls[i].replace("_96", s["320kbps"] === "true" ? "_320" : "_160") : (s.vlink || ""),
  })).filter(s => s.url);
  return { tracks: songs };
}

// --- Music catalogue (JioSaavn official API) ----------------------------------
// Home modules, playlists, albums, artists, song recommendations and
// song/artist/featured radio stations. Everything is normalised to the
// Track / Card shapes the music page uses; media URLs are DES-decrypted in one
// batch per response. ctx=android unlocks reco + stations (web ctx returns []).
let SAAVN_API = "https://www.jiosaavn.com/api.php?_format=json&_marker=0&api_version=4";
const MUSIC_TTL = 20 * 60 * 1000;
const musicCache = new Map();

async function saavnCall(call, params = {}, { ctx = "web6dot0", lang, ttl = MUSIC_TTL } = {}) {
  const qs = new URLSearchParams({ __call: call, ctx, ...params }).toString();
  const key = `${qs}|${lang || ""}`;
  const hit = musicCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const body = await curlFetch(`${SAAVN_API}&${qs}`, {
    Accept: "application/json",
    ...(lang ? { Cookie: `L=${encodeURIComponent(lang)}` } : {}),
  });
  const data = JSON.parse(body);
  if (ttl > 0) musicCache.set(key, { at: Date.now(), data });
  if (musicCache.size > 400) musicCache.delete(musicCache.keys().next().value);
  return data;
}

const saavnImg = (u, size = "500x500") => String(u || "").replace(/\d{2,3}x\d{2,3}/, size).replace(/^http:/, "https:");

/** Song objects (api_version 4) → playable tracks. */
async function saavnTracks(songs) {
  const list = (songs || []).filter((s) => s && (s.type === "song" || s.more_info?.encrypted_media_url));
  const urls = await jiosaavnDecryptAll(list.map((s) => s.more_info?.encrypted_media_url || ""));
  return list.map((s, i) => {
    const m = s.more_info || {};
    const primary = m.artistMap?.primary_artists || [];
    return {
      id: s.id,
      title: unescapeSaavn(s.title || s.song),
      artist: unescapeSaavn(primary.map((a) => a.name).join(", ") || m.music || s.subtitle?.split(" - ")[0] || ""),
      artistIds: primary.map((a) => a.id).filter(Boolean),
      album: unescapeSaavn(m.album || ""),
      albumId: m.album_id || "",
      duration: Number(m.duration) || 0,
      year: s.year || "",
      language: s.language || "",
      thumb: saavnImg(s.image),
      url: urls[i] ? urls[i].replace("_96", m["320kbps"] === "true" ? "_320" : "_160") : "",
      bitrate: m["320kbps"] === "true" ? 320 : 160,
    };
  }).filter((t) => t.url);
}

/** Non-song entities (albums, playlists, artists, stations, channels) → browse cards. */
function saavnCard(x) {
  const m = x.more_info || {};
  const kind = x.type === "radio_station" ? (m.featured_station_type === "artist" ? "artist-radio" : "radio") : x.type;
  return {
    id: kind === "radio" ? (m.query || x.title || x.id) : kind === "artist-radio" ? (x.id || "") : x.id,
    kind,
    title: unescapeSaavn(x.title),
    subtitle: unescapeSaavn(x.subtitle || m.description || (x.type === "playlist" && m.song_count ? `${m.song_count} songs` : "")),
    image: saavnImg(x.image),
    language: x.language || m.language || "",
    query: m.query || "",
  };
}

export async function musicHome(lang) {
  const d = await saavnCall("webapi.getLaunchData", {}, { lang });
  const cards = (arr) => (arr || []).map(saavnCard).filter((c) => c.id && c.title);
  const trending = d.new_trending || [];
  return {
    trendingSongs: await saavnTracks(trending.filter((x) => x.type === "song")),
    trending: cards(trending.filter((x) => x.type !== "song")),
    newReleases: cards(d.new_albums),
    charts: cards(d.charts),
    playlists: cards(d.top_playlists),
    radio: cards(d.radio),
    artistRadio: cards(d.artist_recos),
    moods: cards(d.browse_discover).filter((c) => c.kind === "channel").slice(0, 16),
    artists: cards(d.city_mod).filter((c) => c.kind === "artist"),
  };
}

export async function musicList(kind, id) {
  if (kind === "album") {
    const d = await saavnCall("content.getAlbumDetails", { albumid: id });
    return { kind, id, title: unescapeSaavn(d.title), subtitle: unescapeSaavn(d.subtitle || d.more_info?.music || ""), image: saavnImg(d.image), year: d.year || "", tracks: await saavnTracks(d.list) };
  }
  const d = await saavnCall("playlist.getDetails", { listid: id, n: "80", p: "1" });
  return { kind: "playlist", id, title: unescapeSaavn(d.title), subtitle: unescapeSaavn(d.subtitle || d.header_desc || ""), image: saavnImg(d.image), followers: d.more_info?.follower_count || "", tracks: await saavnTracks(d.list) };
}

export async function musicArtist(id) {
  const d = await saavnCall("artist.getArtistPageDetails", { artistId: id, n_song: "20", n_album: "16", page: "0", sort_order: "", category: "" });
  return {
    id,
    name: unescapeSaavn(d.name),
    image: saavnImg(d.image),
    followers: d.follower_count || "",
    subtitle: unescapeSaavn(d.subtitle || d.dominantType || ""),
    topSongs: await saavnTracks(d.topSongs),
    albums: [...(d.topAlbums || []), ...(d.singles || [])].map(saavnCard).filter((c) => c.id),
    similar: (d.similarArtists || []).map((a) => ({ id: a.id, kind: "artist", title: unescapeSaavn(a.name), subtitle: "Artist", image: saavnImg(a.image_url || a.image), language: "", query: "" })).filter((a) => a.id),
  };
}

export async function musicReco(id) {
  const d = await saavnCall("reco.getreco", { pid: id }, { ctx: "android" });
  const list = Array.isArray(d) ? d : Object.values(d || {}).flat();
  return { tracks: await saavnTracks(list) };
}

/** Radio: seed songs (ids=a,b,c), an artist name, or a featured station name. */
export async function musicStation({ ids, artist, featured, language, count = 20 }) {
  let created;
  if (ids) created = await saavnCall("webradio.createEntityStation", { entity_id: JSON.stringify(ids.split(",").slice(0, 5)), entity_type: "queue" }, { ctx: "android", ttl: 0 });
  else if (artist) created = await saavnCall("webradio.createArtistStation", { artistid: "", name: artist, query: artist, language: language || "" }, { ctx: "android", ttl: 0 });
  else created = await saavnCall("webradio.createFeaturedStation", { name: featured, language: language || "" }, { ctx: "android", ttl: 0 });
  const d = created?.stationid ? await saavnCall("webradio.getSong", { stationid: created.stationid, k: String(count), next: "1" }, { ctx: "android", ttl: 0 }) : {};
  const songs = Object.values(d || {}).filter((x) => x && x.song).map((x) => x.song);
  if (songs.length || !featured) return { stationId: created?.stationid || "", tracks: await saavnTracks(songs) };
  // Featured (editorial / mood) stations currently answer "No new song found" —
  // fall back to the best-matching editorial playlist, shuffled like a station.
  let pick = null;
  for (const q of [`${featured} ${language || ""}`.trim(), featured, `${featured} songs`]) {
    const found = await saavnCall("search.getPlaylistResults", { q, n: "5", p: "1" }).catch(() => ({}));
    pick = (found.results || [])[0];
    if (pick) break;
  }
  if (!pick) throw new Error("Station unavailable");
  const list = await musicList("playlist", pick.id);
  const tracks = [...list.tracks];
  for (let i = tracks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tracks[i], tracks[j]] = [tracks[j], tracks[i]]; }
  return { stationId: "", tracks: tracks.slice(0, count) };
}

export async function musicFind(q) {
  const [songs, albums, artists, playlists] = await Promise.all([
    saavnCall("search.getResults", { q, n: "30", p: "1" }).catch(() => ({})),
    saavnCall("search.getAlbumResults", { q, n: "12", p: "1" }).catch(() => ({})),
    saavnCall("search.getArtistResults", { q, n: "12", p: "1" }).catch(() => ({})),
    saavnCall("search.getPlaylistResults", { q, n: "12", p: "1" }).catch(() => ({})),
  ]);
  return {
    tracks: await saavnTracks(songs.results),
    albums: (albums.results || []).map(saavnCard).filter((c) => c.id),
    artists: (artists.results || []).map((a) => ({ id: a.id, kind: "artist", title: unescapeSaavn(a.name || a.title), subtitle: "Artist", image: saavnImg(a.image), language: "", query: "" })).filter((a) => a.id),
    playlists: (playlists.results || []).map(saavnCard).filter((c) => c.id),
  };
}

/** Hi-Res: find the same recording on JioSaavn (320kbps) for a YouTube Music track. */
const hiresNorm = (s) => String(s || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/\b(feat|ft|from|official|audio|video|lyrical|remastered)\b.*$/i, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export async function musicHiRes(title, artist, duration) {
  const t = hiresNorm(title);
  const rawT = String(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const a = new Set(hiresNorm(artist).split(" ").filter((w) => w.length > 1));
  if (!t) return { track: null };
  const found = await saavnCall("search.getResults", { q: `${title} ${artist}`.trim(), n: "15", p: "1" });
  const cands = (await saavnTracks(found.results)).filter((s) => s.url);
  let best = null, bestScore = 0;
  for (const s of cands) {
    const st = hiresNorm(s.title);
    let score = st === t ? 3 : st.includes(t) || t.includes(st) ? 1.5 : 0;
    if (!score) continue;
    const sa = hiresNorm(s.artist).split(" ");
    const shared = sa.some((w) => a.has(w));
    if (a.size) score += shared ? 2 : -1.5;
    // Different artist AND the full title (bracketed bits included) differs → another recording / cover.
    if (a.size && !shared && rawT !== String(s.title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()) continue;
    if (duration && s.duration) {
      const d = Math.abs(s.duration - duration);
      score += d <= 3 ? 2 : d <= 8 ? 1 : d > 25 ? -2 : 0;
    }
    if (s.bitrate === 320) score += 0.5;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return { track: bestScore >= 4 ? best : null };
}

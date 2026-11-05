// KickAssAnime — title-keyed anime with sub/dub and subtitle tracks.
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs: setup() runs once
// with the app runtime and this module's config from index.json; resolve()
// runs per play. Hosts and endpoints live in index.json, not here.

let UA, dnsFetch, tmdbAbsoluteEpisode, tmdbSeasonName, KAA_BASE, KAA_HEADERS;

export function setup(rt, config) {
  ({ UA, dnsFetch, tmdbAbsoluteEpisode, tmdbSeasonName } = rt);
  KAA_BASE = config.base;
  KAA_HEADERS = { "User-Agent": UA, Accept: "application/json, text/plain, */*" };
}

// Word-overlap score between a query ("Tom and Jerry") and a candidate
// ("the-tom-and-jerry-cartoon-kit" slug or archive title). Returns 0..1.
function cartoonNorm(s) {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cartoonScore(query, candidate) {
  const qw = new Set(cartoonNorm(query).split(" ").filter(Boolean));
  const cw = new Set(cartoonNorm(candidate).split(" ").filter(Boolean));
  if (!qw.size || !cw.size) return 0;
  let hit = 0;
  for (const w of qw) if (cw.has(w)) hit++;
  // Recall drives the threshold; a small precision bonus breaks ties toward the
  // tightest title ("Doraemon" > "Doraemon Birthday Specials" — both have recall
  // 1 for a one-word query, so API order used to pick wrong).
  return hit / qw.size + (hit / cw.size) * 0.01;
}

// Shared title search and TMDB season mapping for animation providers.
function titleQueryVariants(title) {
  const words = cartoonNorm(title).split(" ").filter(Boolean);
  const variants = [title];
  for (let i = 1; i < words.length; i++) {
    const tail = words.slice(i).join(" ");
    if (tail.split(" ").length > 1 || (tail.length >= 4 && !/^\d+$/.test(tail))) variants.push(tail);
  }
  return variants;
}

// ============================================================================
// KickAssAnime (kaa.lt) — anime provider, title-keyed, clean JSON API.
// Ported from Zenda-Cross/vega-providers kickAssAnime.
// Flow: POST /api/fsearch → /api/show/{slug}/language → /api/show/{slug}/episodes
// → /api/show/{slug}/episode/ep-{n}-{epSlug} → servers[] → player page embeds
// "manifest":[0,"https://hls.host/...master.m3u8"] (+ subtitle tracks).
// The HLS CDN 403s without Referer=<player URL>, so every stream/subtitle URL
// is returned pre-wrapped in /api/hls?url=...&referer=... which propagates the
// referer to nested playlists and segments.
// ============================================================================

async function kaaJson(path, init = {}) {
  const r = await dnsFetch(`${KAA_BASE}${path}`, { ...init, headers: { ...KAA_HEADERS, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`KAA ${r.status} for ${path}`);
  return JSON.parse(await r.text());
}

function kaaFixUrl(raw, base) {
  let u = String(raw || "").trim();
  if (/^https?:/i.test(u)) return u.replace(/^(https?:)\/+/, "$1//");
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) {
    try { return new URL(base).origin + u; } catch { return KAA_BASE + u; }
  }
  return u;
}

const kaaProxied = (streamUrl, playerUrl) =>
  `/api/hls?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(playerUrl)}`;

async function kaaSearchBest(title, { exact = false } = {}) {
  let best = null;
  // `exact` skips tail variants — "season 2" tail of "X Season 2" would match
  // every unrelated "Y Season 2" entry on the site.
  for (const q of exact ? [title] : titleQueryVariants(title)) {
    const data = await kaaJson("/api/fsearch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, page: 1 }),
    }).catch(() => null);
    // Score the whole result page before deciding — KAA's ordering is loose,
    // and returning on the first ≥0.99 recall match picks the first superset
    // title (e.g. "Black Clover: Jump Festa Special" over "Black Clover").
    for (const s of data?.result || []) {
      const score = Math.max(cartoonScore(q, s.title_en || ""), cartoonScore(q, s.title || ""));
      if (!best || score > best.score) best = { s, score };
    }
    if (best?.score >= 0.8) return best; // strong hit — stop trying tail variants
  }
  return best;
}

// KAA often splits sequels into dedicated entries ("Black Clover 2nd Season")
// instead of continuing the main show's numbering. For season > 1, probe
// season-qualified titles first — a dedicated hit must beat a bare-title
// match (≥0.7 so the season words actually contributed; a fuzzy echo of the
// main title scores ~0.5 and falls back to absolute-episode mapping).
async function kaaSearchShow(title, season, seasonName) {
  const n = Number(season) || 0;
  if (n > 1) {
    const ord = { 2: "2nd", 3: "3rd" }[n] || `${n}th`;
    const probes = [`${title} Season ${n}`, `${title} ${ord} Season`, `${title} ${n}`];
    // TMDB names seasons after the arc ("Entertainment District Arc") and so
    // does KAA — without this probe "Demon Slayer S2" finds nothing.
    if (seasonName) probes.unshift(`${title} ${seasonName}`, seasonName);
    for (const q of probes) {
      const hit = await kaaSearchBest(q, { exact: true });
      if (hit && hit.score >= 0.7) return { ...hit, dedicated: true };
    }
  }
  const hit = await kaaSearchBest(title);
  return hit && hit.score >= 0.5 ? { ...hit, dedicated: false } : null;
}

// The show page serves episodes per language and KAA keeps sub/dub as separate
// episode playlists (different episode slugs, different manifests). Both are
// resolved in parallel — qualities carry lang:"sub"|"dub" so the player's Audio
// tab can switch between them (a quality switch preserves position).
async function resolveKaa(title, type, season, episode, tmdbId, animeLang) {
  if (!title) throw new Error("KickAssAnime: title required");
  const seasonName = type === "tv" && Number(season) > 1
    ? await tmdbSeasonName(tmdbId, season).catch(() => null)
    : null;
  const found = await kaaSearchShow(title, type === "tv" ? season : 0, seasonName);
  const show = found?.s;
  if (!show?.slug) throw new Error(`KickAssAnime: no match for "${title}"`);

  const langs = (await kaaJson(`/api/show/${show.slug}/language`).catch(() => null))?.result || [];
  const subLang = langs.find((l) => /^ja/i.test(l)) || langs[0] || "ja-JP";
  const dubLang = langs.find((l) => /^en/i.test(l));
  const preferDub = /dub|en/i.test(animeLang || "");
  const langOrder = [...new Set((preferDub ? [dubLang, subLang] : [subLang, dubLang]).filter(Boolean))];

  // KAA numbers one continuous run; TMDB may split into seasons — map through.
  // Dedicated season entries number from 1, so the mapping doesn't apply.
  let epNum = Number(episode) || 1;
  if (!found.dedicated && type === "tv" && Number(season) > 1) {
    const abs = await tmdbAbsoluteEpisode(tmdbId, season, episode).catch(() => null);
    if (abs) epNum = abs;
  }

  const qualities = [];
  const subtitles = [];
  const seenSub = new Set();

  async function kaaLangStreams(lang, tag) {
    // pages[] describes which episode range each page covers — jump straight there.
    const head = await kaaJson(`/api/show/${show.slug}/episodes?lang=${encodeURIComponent(lang)}&page=1`);
    let epRow = (head.result || []).find((e) => e.episode_number === epNum || Math.floor(parseFloat(e.episode_string)) === epNum);
    if (!epRow && Array.isArray(head.pages)) {
      const page = head.pages.find((p) => (p.eps || []).some((n) => Math.floor(n) === epNum));
      if (page && page.number !== 1) {
        const data = await kaaJson(`/api/show/${show.slug}/episodes?lang=${encodeURIComponent(lang)}&page=${page.number}`);
        epRow = (data.result || []).find((e) => e.episode_number === epNum || Math.floor(parseFloat(e.episode_string)) === epNum);
      }
    }
    if (!epRow) return [];

    const epData = await kaaJson(`/api/show/${show.slug}/episode/ep-${epNum}-${epRow.slug}`);
    const out = [];
    const dubSuffix = tag === "dub" ? " · Dub" : "";
    for (const srv of (epData.servers || []).slice(0, 3)) {
      const playerUrl = kaaFixUrl(srv.src, KAA_BASE);
      const html = await dnsFetch(playerUrl, { headers: { "User-Agent": UA, Referer: `${KAA_BASE}/` } })
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
      if (!html) continue;
      const clean = html.replace(/&quot;/g, '"');
      const mMatch = clean.match(/manifest":\[0,"((?:https?:)?\/\/[^"]+)"]/) || clean.match(/manifest":\[0,"([^"]+)"]/);
      if (!mMatch) continue;
      const manifest = kaaFixUrl(mMatch[1], playerUrl);
      if (manifest.includes(".mpd")) continue; // DASH — player only handles hls/mp4
      const playerOrigin = (() => { try { return new URL(playerUrl).origin; } catch { return KAA_BASE; } })();

      if (tag === "sub") {
        const trackRe = /"language":\[\d+,"([^"]+)"][^}]+?"name":\[\d+,"([^"]+)"][^}]+?"src":\[\d+,"([^"]+)"]/g;
        let t;
        while ((t = trackRe.exec(clean)) !== null) {
          const subUrl = kaaFixUrl(t[3].replace(/\\\//g, "/"), playerUrl);
          if (seenSub.has(t[2])) continue;
          seenSub.add(t[2]);
          subtitles.push({ label: `${t[2]} (${t[1]})`, lang: t[1], url: kaaProxied(subUrl, playerUrl) });
        }
      }

      out.push({ quality: `auto${dubSuffix}`, url: kaaProxied(manifest, playerUrl), type: "hls", lang: tag });

      // Enumerate renditions from the master playlist for the quality picker.
      try {
        const m3u8 = await dnsFetch(manifest, {
          headers: { "User-Agent": UA, Referer: playerUrl, Origin: playerOrigin },
        }).then((r) => (r.ok ? r.text() : ""));
        const lines = m3u8.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
          const res = lines[i].match(/RESOLUTION=\d+x(\d+)/);
          const next = lines[i + 1]?.trim();
          if (res && next && !next.startsWith("#")) {
            // Variant playlists are video-only — audio lives in the master's
            // EXT-X-MEDIA group. Serve the filtered master so every quality
            // keeps its audio track.
            out.push({
              quality: `${res[1]}p${dubSuffix}`,
              url: `${kaaProxied(manifest, playerUrl)}&pick=${res[1]}`,
              type: "hls",
              lang: tag,
            });
          }
        }
      } catch {}
      if (out.length) break; // first working server wins
    }
    return out;
  }

  const perLang = await Promise.all(langOrder.map((l) => kaaLangStreams(l, /^en/i.test(l) ? "dub" : "sub").catch(() => [])));
  for (const qs of perLang) qualities.push(...qs);
  if (!qualities.length) throw new Error("KickAssAnime: no playable streams");
  return { cdn: "kaa.lt", verified: true, qualities, subtitles };
}

export async function resolve(req) {
  return resolveKaa(req.cartoonTitle, req.type, req.season, req.episode, req.id, req.animeLang);
}

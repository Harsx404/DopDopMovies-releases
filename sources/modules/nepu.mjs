// Nepu — Cloudflare-managed site; pages load through the desktop app's bridge window when curl is challenged.
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs: setup() runs once
// with the app runtime and this module's config from index.json; resolve()
// runs per play. Hosts and endpoints live in index.json, not here.

let NEPU_RELAY, curlFetch, curlPost, resolveUrl, NEPU_BASE;

export function setup(rt, config) {
  ({ NEPU_RELAY, curlFetch, curlPost, resolveUrl } = rt);
  NEPU_BASE = config.base;
}

const NEPU_CHALLENGE_RE = /just a moment|security verification|challenge-platform/i;

// GET/POST a nepu.io URL: curl first (fast when unchallenged), then the
// Electron bridge window (same-origin fetch carrying cf_clearance). `ref`
// makes the bridge navigate to a referring page first — Nepu rejects /ajax/*
// POSTs whose Referer isn't the media page.
async function nepuPage(path, { method = "GET", body = null, ref = null } = {}) {
  const target = path.startsWith("http") ? path : NEPU_BASE + path;
  const headers = { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", Referer: ref ? (ref.startsWith("http") ? ref : NEPU_BASE + ref) : `${NEPU_BASE}/` };
  const direct = method === "POST"
    ? await curlPost(target, body ?? "", headers).catch(() => null)
    : await curlFetch(target, { Referer: `${NEPU_BASE}/` }).catch(() => null);
  if (direct && !NEPU_CHALLENGE_RE.test(direct)) return direct;

  const q = new URLSearchParams({ u: target, m: method });
  if (body != null) q.set("b", body);
  if (ref) q.set("ref", ref.startsWith("http") ? ref : NEPU_BASE + ref);
  const r = await fetch(`${NEPU_RELAY}/nepu-fetch?${q}`).catch(() => null);
  if (!r) throw new Error("Nepu is behind Cloudflare — needs the desktop app");
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(`Nepu bridge: ${d.error || `HTTP ${r.status}`}`);
  if (NEPU_CHALLENGE_RE.test(d.body || "")) throw new Error("Nepu: Cloudflare check pending — solve the prompt in the app window, then retry");
  return d.body;
}

// Movies (/movie/<slug>-<id>) and shows (/show/<slug>/season/<s>/episode/<e>)
// share the ebook embed flow: page → data-embed → POST /ajax/embed → a signed
// /ajax/hls relay URL. Played through /ext-hls so the bridge serves CF-gated
// playlist fetches.
async function resolveNepu(type, title, year, season, episode) {
  if (!title) throw new Error("Nepu: needs a title");
  const home = await nepuPage("/");
  const token = home.match(/name="_TOKEN"[^>]*value="([^"]+)"/)?.[1] || "";
  const html = await nepuPage("/search", {
    method: "POST",
    body: new URLSearchParams({ _ACTION: "search", _TOKEN: token, q: title }).toString(),
    ref: "/",
  });

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const wanted = type === "tv" ? "show" : "movie";
  const cards = new Map();
  const re = /<a href="(?:https?:\/\/nepu\.io)?\/(movie|show)\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, kind, slug, inner] = m;
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const e = cards.get(slug) || { kind, slug, title: "" };
    if (text && !e.title) e.title = text;
    cards.set(slug, e);
  }
  const tNorm = norm(title);
  const cands = [...cards.values()].filter((c) => c.kind === wanted);
  const pick =
    cands.find((c) => norm(c.title) === tNorm) ||
    cands.find((c) => norm(c.slug.replace(/-\d+$/g, "").replace(/-/g, " ")) === tNorm) ||
    cands.find((c) => norm(c.title).includes(tNorm) || (tNorm && norm(c.title) && tNorm.includes(norm(c.title)))) ||
    cands[0];
  if (!pick) throw new Error("Nepu: title not found");

  const pagePath = wanted === "show" ? `/show/${pick.slug}/season/${season || 1}/episode/${episode || 1}` : `/movie/${pick.slug}`;
  const page = await nepuPage(pagePath);
  const embed = page.match(/data-embed="([^"]+)"/)?.[1];
  if (!embed) throw new Error("Nepu: no playable source on this page");

  const embedHtml = await nepuPage("/ajax/embed", { method: "POST", body: `id=${encodeURIComponent(embed)}`, ref: pagePath });
  const raw =
    embedHtml.match(/relayManifestUrl\s*=\s*"([^"]+)"/)?.[1] ||
    embedHtml.match(/"file"\s*:\s*"([^"]+)"/)?.[1] ||
    embedHtml.match(/file\s*:\s*"([^"]+\.m3u8[^"]*)"/)?.[1];
  if (!raw) throw new Error("Nepu: embed returned no playlist");

  const unesc = (s) => String(s || "").replace(/\\u0026/g, "&").replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const toAbs = (u) => (u.startsWith("http") ? u : NEPU_BASE + (u.startsWith("/") ? "" : "/") + u);
  const wrapNepuUrl = (u) => (typeof window === "undefined" && typeof process !== "undefined" ? `/ext-hls?url=${encodeURIComponent(u)}` : u);

  const seenQ = new Set();
  const variants = [];

  // 1. Bracket format in Playerjs: "[1080p]url1,[720p]url2"
  const bracketMatches = [...raw.matchAll(/\[([0-9a-zA-Z]+)\]\s*([^,;'"\[\]]+)/g)];
  if (bracketMatches.length > 0) {
    for (const bm of bracketMatches) {
      const label = bm[1];
      const cleanUrl = toAbs(unesc(bm[2].trim()));
      const h = parseInt(label, 10);
      const qName = h >= 2000 ? "2160p" : h >= 1000 ? "1080p" : h >= 650 ? "720p" : h >= 450 ? "480p" : h >= 300 ? "360p" : label;
      variants.push({ h: h || 0, quality: qName, url: cleanUrl });
    }
  }

  // 2. JSON array format: file:[{"title":"1080p","file":"..."}, ...] or sources:[...]
  if (!variants.length) {
    const jsonMatch = embedHtml.match(/(?:file|sources)\s*:\s*(\[\s*\{[\s\S]*?\}\s*\])/);
    if (jsonMatch) {
      try {
        const arr = JSON.parse(jsonMatch[1]);
        for (const item of arr) {
          const file = item.file || item.src || item.url;
          const label = item.title || item.label || item.quality;
          if (file && label) {
            const cleanUrl = toAbs(unesc(file.trim()));
            const h = parseInt(label, 10);
            const qName = h >= 2000 ? "2160p" : h >= 1000 ? "1080p" : h >= 650 ? "720p" : h >= 450 ? "480p" : h >= 300 ? "360p" : String(label);
            variants.push({ h: h || 0, quality: qName, url: cleanUrl });
          }
        }
      } catch {}
    }
  }

  // Default / master playlist URL
  const firstUrlMatch = raw.match(/https?:\/\/[^\s,"'\]]+|\/[^\s,"'\]]+/);
  const primaryRaw = firstUrlMatch ? firstUrlMatch[0] : raw;
  const abs = toAbs(unesc(primaryRaw));

  // 3. If no explicit qualities extracted from embed response, inspect the playlist
  if (!variants.length) {
    try {
      const mText = await nepuPage(abs, { ref: pagePath });
      if (mText && mText.includes("#EXT-X-STREAM-INF")) {
        const lines = mText.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
            const res = lines[i].match(/RESOLUTION=\d+x(\d+)/);
            const bw = lines[i].match(/BANDWIDTH=(\d+)/)?.[1] ? parseInt(lines[i].match(/BANDWIDTH=(\d+)/)[1], 10) : 0;
            let j = i + 1;
            while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith("#"))) j++;
            if (j < lines.length && res) {
              const h = parseInt(res[1], 10);
              const qName = h >= 2000 ? "2160p" : h >= 1000 ? "1080p" : h >= 650 ? "720p" : h >= 450 ? "480p" : h >= 300 ? "360p" : `${h}p`;
              const vAbs = resolveUrl(abs, lines[j].trim());
              variants.push({ h, bw, quality: qName, url: vAbs });
            }
          }
        }
      }
    } catch {}
  }

  variants.sort((a, b) => b.h - a.h || (b.bw || 0) - (a.bw || 0));
  const qualities = [];
  for (const v of variants) {
    if (!seenQ.has(v.quality)) {
      seenQ.add(v.quality);
      qualities.push({ quality: v.quality, url: wrapNepuUrl(v.url), cdn: "nepu.io" });
    }
  }
  qualities.push({ quality: "auto", url: wrapNepuUrl(abs), cdn: "nepu.io" });

  return {
    cdn: "nepu.io",
    qualities,
    verified: true,
    subtitles: [],
    provider: "nepu",
  };
}

export async function resolve(req) {
  return resolveNepu(req.type, req.title, req.year, req.season, req.episode);
}

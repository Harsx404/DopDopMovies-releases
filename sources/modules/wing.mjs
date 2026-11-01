// Wing / Cinejoy — sealed-transport API (crush.wasm request sealing, AES-GCM responses).
//
// DopDop source addon. Loaded by src/lib/source-pack.mjs: setup() runs once
// with the app runtime and this module's config from index.json; resolve()
// runs per play. Hosts and endpoints live in index.json, not here.
import fs from "node:fs";
import path from "node:path";

let UA, dnsFetch, wingOriginFetch, WING_API, WING_WASM_FILE;

export function setup(rt, config) {
  ({ UA, dnsFetch, wingOriginFetch } = rt);
  WING_API = config.api;
  // The live wasm is fetched from the API and cached in user data.
  WING_WASM_FILE = path.join(rt.dataDir, "wing-crush.wasm");
}

// --- Wing (api.wing.st / Cinejoy) sealed-transport provider ---
// Their API encrypts requests through a WebAssembly "seal_request" function
// (crush.wasm) and returns AES-256-GCM encrypted responses.
// Envelope layout: [32B responseKey][1B keyId][65B P-256 pubkey][sealed body]
// Response layout:  [12B IV][ciphertext + 16B GCM tag]
// AAD = UTF8("lumen-gate-v2") || 0x00 || 0x02 || keyId || ephemeralPublic
const WING_DOMAIN = "lumen-gate-v2";

let wingExports = null;

let wingLoadPromise = null;

async function wingLoadWasm(force = false) {
  if (wingExports && !force) return wingExports;
  if (!force && wingLoadPromise) return wingLoadPromise;
  wingLoadPromise = (async () => {
    let buf = null;
    try {
      const r = await dnsFetch(WING_API + "/crush.wasm", { headers: { "User-Agent": UA } });
      if (r.ok) {
        buf = Buffer.from(await r.arrayBuffer());
        try { fs.writeFileSync(WING_WASM_FILE, buf); } catch {}
      }
    } catch {}
    if (!buf && fs.existsSync(WING_WASM_FILE)) buf = fs.readFileSync(WING_WASM_FILE);
    // Last resort: the copy shipped with this addon.
    if (!buf) buf = fs.readFileSync(new URL("./wing-crush.wasm", import.meta.url));
    if (!buf) throw new Error("Wing: crush.wasm unavailable");
    const { instance } = await WebAssembly.instantiate(buf, {});
    const ex = instance.exports;
    if (typeof ex.alloc !== "function" || typeof ex.dealloc !== "function" || typeof ex.seal_request !== "function")
      throw new Error("Wing: crush.wasm invalid ABI");
    wingExports = ex;
    return ex;
  })().finally(() => { wingLoadPromise = null; });
  return wingLoadPromise;
}

async function wingCall(wingPath, payload, retried = false) {
  const ex = await wingLoadWasm();
  const plain = new TextEncoder().encode(JSON.stringify({ path: wingPath, payload }));
  const rand = crypto.getRandomValues(new Uint8Array(44));
  const cap = plain.length + 512;
  const tp = ex.alloc(plain.length), rp = ex.alloc(rand.length), op = ex.alloc(cap);
  if (!tp || !rp || !op) throw new Error("Wing: wasm alloc failed");
  try {
    let mem = new Uint8Array(ex.memory.buffer);
    mem.set(plain, tp); mem.set(rand, rp);
    const n = ex.seal_request(tp, plain.length, rp, rand.length, op, cap);
    if (n <= 98 || n > cap) throw new Error("Wing: seal_request failed (" + n + ")");
    mem = new Uint8Array(ex.memory.buffer);
    const env = mem.slice(op, op + n);
    const responseKey = env.slice(0, 32), keyId = env[32];
    const eph = env.slice(33, 98), body = env.slice(98);
    const r = await dnsFetch(WING_API + "/g", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8", "User-Agent": UA },
      body,
    });
    if (r.status === 404 && !retried) {
      wingExports = null;
      await wingLoadWasm(true);
      return wingCall(wingPath, payload, true);
    }
    if (!r.ok) throw new Error("Wing: /g HTTP " + r.status);
    const resp = new Uint8Array(await r.arrayBuffer());
    if (resp.length < 28) throw new Error("Wing: invalid response envelope");
    const key = await crypto.subtle.importKey("raw", responseKey, "AES-GCM", false, ["decrypt"]);
    const dom = new TextEncoder().encode(WING_DOMAIN);
    const aad = new Uint8Array(dom.length + 3 + eph.length);
    aad.set(dom); aad.set([0, 2, keyId], dom.length); aad.set(eph, dom.length + 3);
    const dec = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: resp.slice(0, 12), additionalData: aad, tagLength: 128 },
      key, resp.slice(12));
    return JSON.parse(new TextDecoder().decode(dec));
  } finally {
    try { ex.dealloc(tp, plain.length); ex.dealloc(rp, rand.length); ex.dealloc(op, cap); } catch {}
  }
}

// Deep-check a wing playlist: master → first variant → init/segments must
// actually respond 200. Masters can be cached-alive while the media origin is
// dead (their CDN 502s "origin unavailable" on cache misses).
async function wingCheckPlayable(playlistUrl, depth = 0) {
  if (depth > 2) return false;
  try {
    const r = await wingOriginFetch(playlistUrl);
    const text = await r.text();
    if (!r.ok || !text.includes("#EXTM3U")) return false;
    if (text.includes("#EXT-X-STREAM-INF")) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === "" || lines[j].startsWith("#"))) j++;
        if (j < lines.length) {
          const variant = new URL(lines[j].trim(), playlistUrl).href;
          if (await wingCheckPlayable(variant, depth + 1)) return true;
        }
      }
      return false;
    }
    // Media playlist — probe init (EXT-X-MAP) and first segments (headers only)
    const probes = [];
    const map = text.match(/#EXT-X-MAP:URI="([^"]+)"/);
    if (map) probes.push(map[1]);
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) probes.push(t);
      if (probes.length >= 3) break;
    }
    for (const u of probes) {
      const abs = new URL(u, playlistUrl).href;
      const sr = await wingOriginFetch(abs);
      try { sr.body?.cancel(); } catch {}
      if (!sr.ok) return false;
    }
    return true;
  } catch { return false; }
}

async function resolveWing(tmdbId, type, season, episode, selfBase = "") {
  const sr = await dnsFetch(WING_API + "/servers", { headers: { "User-Agent": UA } });
  if (!sr.ok) throw new Error("Wing: /servers HTTP " + sr.status);
  const servers = (JSON.parse(await sr.text()).servers || []).filter(s => s.status === "ok");
  if (servers.length === 0) throw new Error("Wing: no servers available");
  const label = type === "tv" ? "series" : "movie";
  const errors = [];
  const attempt = async (s) => {
    const payload = { tmdb: String(tmdbId) };
    if (type === "tv") { payload.season = String(season || 1); payload.episode = String(episode || 1); }
    try {
      const res = await wingCall(`/${s.name}/${label}`, payload);
      const data = res?.data;
      const streams = Array.isArray(data?.stream) ? data.stream : [];
      for (const st of streams) {
        const u = st.playlist || st.url;
        if (!u || !/^https?:\/\//.test(u)) continue;
        const host = new URL(u).hostname;
        const vr = await wingOriginFetch(u);
        const vt = await vr.text();
        if (!vt.includes("#EXTM3U") && !vt.startsWith("WEBM") && vr.status !== 200) continue;
        // Master playlist alive isn't enough — verify init/segments too; a
        // dead media origin means this server can't actually play.
        if (!await wingCheckPlayable(u)) { errors.push(s.name + ": media origin unavailable"); continue; }
        // Route master playlists through the dead-rendition filter so the
        // player never lands on a 502'd quality. Each live resolution is also
        // exposed as its own quality (a filtered master keeps its audio group,
        // unlike loading the video-only variant directly).
        const isMaster = vt.includes("#EXT-X-STREAM-INF");
        let qualities;
        if (isMaster) {
          const enc = encodeURIComponent(u);
          const ress = [...new Set([...vt.matchAll(/RESOLUTION=\d+x(\d+)/g)].map(m => m[1]))].sort((a, b) => b - a);
          const base = selfBase ? `${selfBase}` : "";
          qualities = [{ quality: "auto", url: `${base}/wing-master?u=${enc}`, cdn: host },
            ...ress.map(r => ({ quality: r + "p", url: `${base}/wing-master?u=${enc}&only=${r}`, cdn: host }))];
        } else {
          qualities = [{ quality: "auto", url: u, cdn: host }];
        }
        return {
          cdn: host,
          qualities,
          verified: vt.includes("#EXTM3U"),
          subtitles: (st.captions || []).map(c => ({ lang: c.lang || c.language || "und", url: c.url, label: c.label || c.lang || "Sub" })),
          provider: "wing-" + String(s.name).toLowerCase(),
        };
      }
      if (data?.qualities && typeof data.qualities === "object") {
        const u = Object.values(data.qualities)[0];
        if (u && /^https?:\/\//.test(u)) {
          if (!await wingCheckPlayable(u)) throw new Error('media origin unavailable');
          const host = new URL(u).hostname;
          return { cdn: host, qualities: [{ quality: "auto", url: u, cdn: host }], verified: true, subtitles: [], provider: "wing-" + String(s.name).toLowerCase() };
        }
      }
      errors.push(s.name + ": " + (data?.error || "no stream"));
    } catch (e) {
      errors.push(s.name + ": " + e.message);
    }
    throw new Error('Server unavailable');
  };
  try { return await Promise.any(servers.map(attempt)); } catch {}
  // Upstream diagnostics contain URLs and query credentials. Keep them out
  // of the source picker; it only needs an actionable, bounded message.
  throw new Error('Cinejoy: no playable stream for this title; try another source');
}

// req.selfBase: this backend's origin — Wing's master playlists are served
// through its /wing-master route.
export async function resolve(req) {
  return resolveWing(req.id, req.type, req.season, req.episode, req.selfBase);
}

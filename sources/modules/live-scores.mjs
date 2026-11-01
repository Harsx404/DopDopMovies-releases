// Scores for followed matches, read from ESPN's public scoreboards.
//
// DopDop live addon. Hosts and the league → scoreboard map live in index.json,
// so a moved endpoint or a new league is fixed by a pack update.

let UA, dnsFetch, cachedFetch, BASE, LEAGUES, FALLBACK;

export function setup(rt, config) {
  ({ UA, dnsFetch, cachedFetch } = rt);
  BASE = config.base;
  LEAGUES = config.leagues || {};
  FALLBACK = config.fallback || {};
}

const words = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["the", "club"].includes(w));

/** Do two team names share a distinctive word? "Man United" / "Manchester United" share "united". */
function sameTeam(a, b) {
  const set = new Set(words(a));
  return words(b).some((w) => set.has(w));
}

function board(path) {
  return cachedFetch(`scores:${path}`, 45_000, async () => {
    const r = await dnsFetch(`${BASE}/${path}/scoreboard`, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) throw new Error(`Scoreboard ${path}: HTTP ${r.status}`);
    return (await r.json()).events || [];
  });
}

/** The score of one match, or null when no scoreboard lists it. */
export async function resolve({ category, league, home, away }) {
  const path = LEAGUES[league] || FALLBACK[category];
  if (!path || !home || !away) return null;
  const events = await board(path);
  for (const e of events) {
    const teams = e.competitions?.[0]?.competitors || [];
    const a = teams.find((t) => sameTeam(t.team?.displayName, home));
    const b = teams.find((t) => t !== a && sameTeam(t.team?.displayName, away));
    if (a && b) {
      return {
        home: a.score ?? null,
        away: b.score ?? null,
        state: e.status?.type?.state || "pre",
        detail: e.status?.type?.shortDetail || "",
      };
    }
  }
  return null;
}

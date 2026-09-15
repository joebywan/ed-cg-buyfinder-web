// Community goal discovery: Frontier's feed plus the journal's
// CommunityGoal events. A port of the destination half of cg.py.

export const FRONTIER_URL = "https://api.orerve.net/2.0/website/initiatives/list?lang=en";

/** Frontier's initiatives feed -> goal dicts. Undocumented, so tolerant. */
export function parseLive(d) {
  const list = Array.isArray(d?.activeInitiatives) ? d.activeInitiatives : [];
  return list.map((it) => {
    const commodities = String(it.target_commodity_list || "")
      .split(",").map((c) => c.trim()).filter(Boolean);
    const num = (k) => {
      const n = Number(it[k] ?? 0);
      return Number.isInteger(n) ? n : 0;
    };
    return {
      id: it.id ?? null, title: it.title ?? null,
      station: it.market_name ?? null, system: it.starsystem_name ?? null,
      expiry: it.expiry ?? null, activity: it.activityType ?? null, commodities,
      target_qty: num("target_qty"), qty: num("qty"),
      // A trade goal names commodities and is typed "tradelist".
      is_trade: commodities.length > 0 && it.activityType === "tradelist",
    };
  });
}

/** Every CommunityGoal sample in the given journal lines, oldest first. */
export function historyFromLines(lines) {
  const out = [];
  for (const line of lines) {
    if (!line.includes('"CommunityGoal"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.event !== "CommunityGoal") continue;
    for (const g of e.CurrentGoals || []) {
      out.push({
        ts: e.timestamp ?? null, cgid: g.CGID ?? null, title: g.Title ?? null,
        station: g.MarketName ?? null, system: g.SystemName ?? null, expiry: g.Expiry ?? null,
        contribution: g.PlayerContribution ?? null, band: g.PlayerPercentileBand ?? null,
        total: g.CurrentTotal ?? null, contributors: g.NumContributors ?? null,
        tier: g.TierReached ?? null,
      });
    }
  }
  return out;
}

/** The goal this commander joined, with commodities from the live feed. */
export function joinedGoal(history, live = []) {
  const cur = history?.at(-1);
  if (!cur?.station || !cur?.system) return null;
  const match = (live || []).find((g) => g.is_trade
    && g.station === cur.station && g.system === cur.system);
  const commodities = match ? [...match.commodities] : [];
  return {
    station: cur.station, system: cur.system, commodities, title: cur.title, expiry: cur.expiry,
    source: commodities.length ? "joined CG" : "joined CG (no commodity list)",
  };
}

/**
 * [destination or null, other live trade goals]: the joined goal, else the
 * first live trade goal flagged as not joined, else nothing.
 */
export function suggestDestination(history, live = []) {
  const trade = (live || []).filter((g) => g.is_trade);
  const joined = joinedGoal(history, live);
  if (joined?.commodities.length) {
    return [joined, trade.filter((g) => g.station !== joined.station || g.system !== joined.system)];
  }
  if (trade.length) {
    const g = trade[0];
    return [{ station: g.station, system: g.system, commodities: [...g.commodities],
              title: g.title, expiry: g.expiry, source: "live CG (not joined)" }, trade.slice(1)];
  }
  return [null, []];
}

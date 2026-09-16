// Contribute market data back to EDDN.
//
// This page reads Ardent on every search, Ardent is built from EDDN, and
// EDDN is built from commanders running uploaders. Reading that pool without
// ever adding to it is the asymmetry this closes: the market you just docked
// at is a fresher reading than anything the page showed you.
//
// A port of the desktop app's eddn.py - the same schema, the same filtering
// and the same local validation, because a malformed message published under
// a software name is worse than no message at all.
//
// Only the commodity table goes: system, station, and the prices the game
// itself wrote to Market.json. The commander name is the uploader ID, as
// EDMC and every other uploader does it.

export const EDDN_URL = "https://eddn.edcd.io:4430/upload/";
export const SCHEMA = "https://eddn.edcd.io/schemas/commodity/3";
export const SOFTWARE = "cgbuy-web";

// Limpets are not tradeable market goods and must not be sent.
const NON_MARKET_NAMES = new Set(["drones"]);
const NON_MARKET_CATEGORIES = new Set(["nonmarketable"]);

// Exactly what commodity/3 permits per entry. It sets additionalProperties
// false, so one stray key rejects the whole message.
const ALLOWED_COMMODITY_KEYS = new Set([
  "name", "meanPrice", "buyPrice", "stock", "stockBracket", "sellPrice",
  "demand", "demandBracket", "statusFlags", "Producer", "Rare", "id",
]);
const REQUIRED_COMMODITY_KEYS = [
  "name", "meanPrice", "buyPrice", "stock", "stockBracket", "sellPrice",
  "demand", "demandBracket",
];
const REQUIRED_MESSAGE_KEYS = [
  "systemName", "stationName", "marketId", "timestamp", "commodities",
];
const ALLOWED_MESSAGE_KEYS = new Set([
  ...REQUIRED_MESSAGE_KEYS, "stationType", "horizons", "odyssey", "economies",
  "prohibited", "carrierDockingAccess",
]);

/** "$gold_name;" -> "gold". Already-plain names pass through. */
export function normName(raw) {
  let n = String(raw ?? "").trim().toLowerCase();
  if (n.startsWith("$")) n = n.slice(1);
  if (n.endsWith(";")) n = n.slice(0, -1);
  if (n.endsWith("_name")) n = n.slice(0, -5);
  return n;
}

const int = (v) => {
  const n = Math.trunc(Number(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

/** Turn a parsed Market.json into an EDDN commodity/3 envelope. */
export function buildMessage(market, { commander, horizons = null, odyssey = null,
                                       softwareVersion = "0" } = {}) {
  const commodities = [];
  for (const it of market?.Items ?? []) {
    const name = normName(it.Name);
    const category = normName(it.Category).replace("market_category_", "");
    // The station's whole price table goes, not just what is in stock:
    // filtering to stock would throw away the sell side other commanders
    // need.
    if (!name || NON_MARKET_NAMES.has(name)) continue;
    if (NON_MARKET_CATEGORIES.has(category)) continue;
    const entry = {
      name,
      meanPrice: int(it.MeanPrice),
      buyPrice: int(it.BuyPrice),
      stock: int(it.Stock),
      stockBracket: it.StockBracket ?? 0,
      sellPrice: int(it.SellPrice),
      demand: int(it.Demand),
      demandBracket: it.DemandBracket ?? 0,
    };
    if (it.Rare) entry.statusFlags = ["Rare"];
    commodities.push(entry);
  }

  for (const k of ["StarSystem", "StationName", "MarketID", "timestamp"]) {
    if (market?.[k] == null || market[k] === "") {
      throw new Error(`Market.json missing ${k}`);
    }
  }

  const message = {
    systemName: market.StarSystem,
    stationName: market.StationName,
    marketId: market.MarketID,
    timestamp: market.timestamp,
    commodities,
  };
  if (market.StationType) message.stationType = market.StationType;
  if (horizons != null) message.horizons = !!horizons;
  if (odyssey != null) message.odyssey = !!odyssey;

  return {
    $schemaRef: SCHEMA,
    header: {
      uploaderID: commander || "unknown",
      softwareName: SOFTWARE,
      softwareVersion,
    },
    message,
  };
}

/** EDDN uses these to keep Live and Legacy data apart. */
export function addGameVersion(envelope, gameversion, gamebuild) {
  if (gameversion) envelope.header.gameversion = gameversion;
  if (gamebuild) envelope.header.gamebuild = gamebuild;
  return envelope;
}

/** Catch schema violations here rather than having EDDN reject them. */
export function validate(envelope) {
  const problems = [];
  const msg = envelope?.message ?? {};
  const missing = REQUIRED_MESSAGE_KEYS.filter((k) => !(k in msg));
  if (missing.length) problems.push(`message missing ${missing.join(", ")}`);
  const extra = Object.keys(msg).filter((k) => !ALLOWED_MESSAGE_KEYS.has(k));
  if (extra.length) problems.push(`message has undeclared ${extra.sort().join(", ")}`);
  for (const h of ["uploaderID", "softwareName", "softwareVersion"]) {
    if (!envelope?.header?.[h]) problems.push(`header missing ${h}`);
  }
  const items = msg.commodities ?? [];
  for (let i = 0; i < Math.min(items.length, 400); i++) {
    const c = items[i];
    const miss = REQUIRED_COMMODITY_KEYS.filter((k) => !(k in c));
    if (miss.length) { problems.push(`commodity ${i} missing ${miss.join(", ")}`); break; }
    const bad = Object.keys(c).filter((k) => !ALLOWED_COMMODITY_KEYS.has(k));
    if (bad.length) { problems.push(`commodity ${i} undeclared ${bad.sort().join(", ")}`); break; }
    const notInt = ["meanPrice", "buyPrice", "stock", "sellPrice", "demand"]
      .find((k) => !Number.isInteger(c[k]));
    if (notInt) { problems.push(`commodity ${i} ${notInt} is not an integer`); break; }
  }
  if (!items.length) problems.push("no commodities");
  return problems;
}

/**
 * POST to EDDN. Returns {ok, detail}.
 *
 * Sent uncompressed: the endpoint takes either, and gzip in a browser means
 * CompressionStream, which is one more thing to be unavailable on somebody's
 * machine for no gain on a message this size.
 */
export async function upload(envelope, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(EDDN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const detail = (await res.text().catch(() => "")).slice(0, 200).trim();
    return { ok: res.ok, detail: `${res.status} ${detail}`.trim() };
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
}

/**
 * How stale a Market.json may be and still be worth sending.
 *
 * Chrome and Edge tail the folder, so the file is read seconds after the
 * game writes it. Firefox hands over a snapshot taken whenever the button
 * was last pressed, which can be hours old - and an hours-old supply figure
 * republished as current is exactly what this tool exists to complain about.
 */
export const MAX_AGE_MS = 60 * 60 * 1000;

export function tooOld(timestamp, now = Date.now(), maxAge = MAX_AGE_MS) {
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return true;
  return now - t > maxAge;
}

/** Remembers what has already gone, so a re-read never republishes. */
export class Sender {
  static MAX_SEEN = 400;

  constructor(seen = []) {
    this.order = seen.map((x) => String(x)).slice(-Sender.MAX_SEEN);
    this.seen = new Set(this.order);
    this.sent = 0;
    this.failed = 0;
    this.last = "";
  }

  toList() {
    return this.order.slice(-Sender.MAX_SEEN);
  }

  /** Send one Market.json, unless it is a repeat, stale or malformed. */
  async maybeSend(market, { commander, horizons, odyssey, gameversion, gamebuild,
                            softwareVersion = "0", now = Date.now(),
                            fetchImpl = fetch, dryRun = false } = {}) {
    if (market?.MarketID == null || !market?.timestamp) {
      return { ok: false, detail: "Market.json missing MarketID/timestamp" };
    }
    const key = `${market.MarketID}/${market.timestamp}`;
    if (this.seen.has(key)) return { ok: false, detail: "already sent" };
    if (tooOld(market.timestamp, now)) {
      // Remembered so it is not reconsidered on every poll.
      this.#remember(key);
      this.last = "skipped: that market reading is over an hour old";
      return { ok: false, detail: this.last };
    }

    let env;
    try {
      env = addGameVersion(
        buildMessage(market, { commander, horizons, odyssey, softwareVersion }),
        gameversion, gamebuild);
    } catch (err) {
      this.failed++;
      this.last = `bad market data: ${err.message}`;
      return { ok: false, detail: this.last };
    }
    const problems = validate(env);
    if (problems.length) {
      this.failed++;
      this.last = `invalid: ${problems[0]}`;
      return { ok: false, detail: this.last };
    }
    const n = env.message.commodities.length;

    if (dryRun) {
      this.last = `DRY RUN ${market.StationName} (${n} items)`;
      return { ok: true, detail: this.last };
    }

    const { ok, detail } = await upload(env, { fetchImpl });
    if (ok) {
      this.#remember(key);
      this.sent++;
      this.last = `sent ${market.StationName} (${n} items)`;
    } else {
      this.failed++;
      this.last = `failed: ${detail.slice(0, 80)}`;
    }
    return { ok, detail: this.last };
  }

  #remember(key) {
    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > Sender.MAX_SEEN) {
      for (const gone of this.order.splice(0, this.order.length - Sender.MAX_SEEN)) {
        this.seen.delete(gone);
      }
    }
  }

  summary() {
    if (!this.sent && !this.failed) return "";
    return `EDDN: ${this.sent} sent${this.failed ? `, ${this.failed} failed` : ""}`;
  }
}

// The uploader. Ported from test_cgbuy.py's TestBuildMessage,
// TestValidateCatchesProblems and the Sender's dedup rules.
//
// This is the one module whose mistakes are published under our name, so the
// bar is what EDDN would reject, not what we happen to send.
import test from "node:test";
import assert from "node:assert/strict";
import * as eddn from "../src/eddn.js";

const NOW = Date.parse("2025-01-01T12:00:30Z");

/** A miniature Market.json: two real goods, limpets, and a salvage item. */
const fakeMarket = (over = {}) => ({
  timestamp: "2025-01-01T12:00:00Z",
  event: "Market",
  MarketID: 3223343616,
  StationName: "Metz Enterprise",
  StarSystem: "Ega",
  StationType: "Coriolis",
  Items: [
    { id: 128049153, Name: "$gold_name;", Name_Localised: "Gold",
      Category: "$MARKET_category_Metals;", BuyPrice: 9000, SellPrice: 9500,
      MeanPrice: 9400, StockBracket: 2, DemandBracket: 3, Stock: 1200,
      Demand: 4000, Consumer: true, Producer: false, Rare: false },
    { id: 128049204, Name: "$palladium_name;",
      Category: "$MARKET_category_Metals;", BuyPrice: 0, SellPrice: 13800,
      MeanPrice: 13300, StockBracket: 0, DemandBracket: 3, Stock: 0,
      Demand: 9000, Rare: false },
    { id: 128049519, Name: "$drones_name;",
      Category: "$MARKET_category_Utility;", BuyPrice: 101, SellPrice: 100,
      MeanPrice: 101, StockBracket: 3, DemandBracket: 0, Stock: 9999,
      Demand: 0 },
    { id: 128666752, Name: "$USSCargoBlackBox_name;",
      Category: "$MARKET_category_NonMarketable;", BuyPrice: 0, SellPrice: 0,
      MeanPrice: 0, StockBracket: 0, DemandBracket: 0, Stock: 0, Demand: 0 },
  ],
  ...over,
});

const build = (market = fakeMarket(), over = {}) =>
  eddn.buildMessage(market, { commander: "TestCmdr", horizons: true,
                              odyssey: false, softwareVersion: "1.0", ...over });

// -- names --------------------------------------------------------------------

test("game symbols become plain commodity names", () => {
  assert.equal(eddn.normName("$gold_name;"), "gold");
  assert.equal(eddn.normName("$Palladium_Name;"), "palladium");
  assert.equal(eddn.normName("Gold"), "gold");
  assert.equal(eddn.normName(""), "");
  assert.equal(eddn.normName(null), "");
});

// -- the envelope --------------------------------------------------------------

test("the envelope names the schema and who sent it", () => {
  const env = build();
  assert.equal(env.$schemaRef, eddn.SCHEMA);
  assert.equal(env.header.uploaderID, "TestCmdr");
  assert.equal(env.header.softwareName, eddn.SOFTWARE);
  assert.equal(env.header.softwareVersion, "1.0");
});

test("the message carries what the station is and when", () => {
  const m = build().message;
  assert.equal(m.systemName, "Ega");
  assert.equal(m.stationName, "Metz Enterprise");
  assert.equal(m.marketId, 3223343616);
  assert.equal(m.timestamp, "2025-01-01T12:00:00Z");
  assert.equal(m.stationType, "Coriolis");
  assert.equal(m.horizons, true);
  assert.equal(m.odyssey, false);
});

test("limpets and non-marketable salvage are not market goods", () => {
  const names = build().message.commodities.map((c) => c.name);
  assert.deepEqual(names, ["gold", "palladium"]);
});

test("a commodity with no stock is kept for its sell side", () => {
  // Filtering to what is in stock would throw away exactly the half another
  // commander needs when deciding where to sell.
  const pal = build().message.commodities[1];
  assert.equal(pal.stock, 0);
  assert.equal(pal.demand, 9000);
});

test("every price is an integer and every key is declared", () => {
  const gold = build().message.commodities[0];
  for (const k of ["meanPrice", "buyPrice", "stock", "sellPrice", "demand"]) {
    assert.ok(Number.isInteger(gold[k]), `${k} is ${typeof gold[k]}`);
  }
  assert.equal(gold.buyPrice, 9000);
  assert.equal(gold.sellPrice, 9500);
  assert.equal(gold.stock, 1200);
  assert.ok(!("statusFlags" in gold), "an ordinary good carries no flags");
});

test("rare goods are flagged", () => {
  const m = fakeMarket();
  m.Items[0].Rare = true;
  assert.deepEqual(build(m).message.commodities[0].statusFlags, ["Rare"]);
});

test("unknown game flags are left out rather than guessed", () => {
  const m = build(fakeMarket(), { horizons: null, odyssey: null }).message;
  assert.ok(!("horizons" in m));
  assert.ok(!("odyssey" in m));
});

test("a market missing what identifies it is refused", () => {
  for (const k of ["StarSystem", "StationName", "MarketID", "timestamp"]) {
    const m = fakeMarket();
    delete m[k];
    assert.throws(() => build(m), new RegExp(k), `${k} should be required`);
  }
});

test("the game version rides in the header, to keep Live and Legacy apart", () => {
  const env = eddn.addGameVersion(build(), "4.4.1.1", "r332841/r0");
  assert.equal(env.header.gameversion, "4.4.1.1");
  assert.equal(env.header.gamebuild, "r332841/r0");
});

test("an absent game version adds nothing", () => {
  const env = eddn.addGameVersion(build(), null, "");
  assert.ok(!("gameversion" in env.header));
  assert.ok(!("gamebuild" in env.header));
});

// -- local validation ----------------------------------------------------------

test("a well-formed envelope has nothing to complain about", () => {
  assert.deepEqual(eddn.validate(build()), []);
});

test("an undeclared key would reject the whole message, so it is caught here", () => {
  // commodity/3 sets additionalProperties false.
  const env = build();
  env.message.somethingNew = 1;
  assert.match(eddn.validate(env)[0], /undeclared/);
  const env2 = build();
  env2.message.commodities[0].somethingNew = 1;
  assert.match(eddn.validate(env2)[0], /undeclared/);
});

test("a missing header field is caught", () => {
  const env = build();
  env.header.uploaderID = "";
  assert.match(eddn.validate(env).join(" "), /uploaderID/);
});

test("a market with nothing tradeable is not worth sending", () => {
  const m = fakeMarket({ Items: [] });
  assert.match(eddn.validate(build(m)).join(" "), /no commodities/);
});

test("a price that is not a whole number is caught", () => {
  const env = build();
  env.message.commodities[0].buyPrice = 9000.5;
  assert.match(eddn.validate(env)[0], /not an integer/);
});

// -- staleness -----------------------------------------------------------------

test("a market reading older than an hour is not republished as current", () => {
  assert.equal(eddn.tooOld("2025-01-01T12:00:00Z", NOW), false);
  assert.equal(eddn.tooOld("2025-01-01T10:00:00Z", NOW), true);
  assert.equal(eddn.tooOld("nonsense", NOW), true);
  assert.equal(eddn.tooOld(undefined, NOW), true);
});

// -- the sender ----------------------------------------------------------------

function fakeUpload({ ok = true, status = 200 } = {}) {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return { ok, status, text: async () => (ok ? "OK" : "Bad Request") };
  };
  return { fetchImpl, sent };
}

const send = (sender, market, over = {}) =>
  sender.maybeSend(market, { commander: "TestCmdr", horizons: true, odyssey: false,
                             softwareVersion: "1.0", now: NOW, ...over });

test("a market is sent once", async () => {
  const { fetchImpl, sent } = fakeUpload();
  const s = new eddn.Sender();
  const r = await send(s, fakeMarket(), { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, eddn.EDDN_URL);
  assert.equal(sent[0].body.message.stationName, "Metz Enterprise");
  assert.equal(s.sent, 1);
});

test("re-reading the same file does not republish it", async () => {
  const { fetchImpl, sent } = fakeUpload();
  const s = new eddn.Sender();
  await send(s, fakeMarket(), { fetchImpl });
  const again = await send(s, fakeMarket(), { fetchImpl });
  assert.equal(again.ok, false);
  assert.match(again.detail, /already sent/);
  assert.equal(sent.length, 1);
});

test("the same station at a later reading is new data", async () => {
  const { fetchImpl, sent } = fakeUpload();
  const s = new eddn.Sender();
  await send(s, fakeMarket(), { fetchImpl });
  await send(s, fakeMarket({ timestamp: "2025-01-01T12:00:20Z" }), { fetchImpl });
  assert.equal(sent.length, 2);
});

test("what has been sent survives a reload", async () => {
  const { fetchImpl, sent } = fakeUpload();
  const s = new eddn.Sender();
  await send(s, fakeMarket(), { fetchImpl });
  const revived = new eddn.Sender(s.toList());
  const again = await send(revived, fakeMarket(), { fetchImpl });
  assert.equal(again.ok, false);
  assert.equal(sent.length, 1);
});

test("a stale reading is refused, and not reconsidered every poll", async () => {
  const { fetchImpl, sent } = fakeUpload();
  const s = new eddn.Sender();
  const old = fakeMarket({ timestamp: "2025-01-01T09:00:00Z" });
  const r = await send(s, old, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.detail, /over an hour old/);
  assert.equal(sent.length, 0);
  assert.equal(s.failed, 0, "stale is not a failure, it is a decline");
  const again = await send(s, old, { fetchImpl });
  assert.match(again.detail, /already sent/);
});

test("a market with no MarketID is refused before anything is built", async () => {
  const { fetchImpl, sent } = fakeUpload();
  const s = new eddn.Sender();
  const r = await send(s, fakeMarket({ MarketID: undefined }), { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(sent.length, 0);
});

test("a malformed market is caught here, not by EDDN", async () => {
  const { fetchImpl, sent } = fakeUpload();
  const s = new eddn.Sender();
  const r = await send(s, fakeMarket({ StarSystem: "" }), { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.detail, /bad market data/);
  assert.equal(sent.length, 0, "nothing invalid reaches the network");
});

test("a rejected upload is not remembered as sent", async () => {
  const { fetchImpl } = fakeUpload({ ok: false, status: 400 });
  const s = new eddn.Sender();
  const r = await send(s, fakeMarket(), { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(s.failed, 1);
  // so a later retry can still go
  const { fetchImpl: ok, sent } = fakeUpload();
  await send(s, fakeMarket(), { fetchImpl: ok });
  assert.equal(sent.length, 1);
});

test("a dry run builds and validates but sends nothing", async () => {
  const { fetchImpl, sent } = fakeUpload();
  const s = new eddn.Sender();
  const r = await send(s, fakeMarket(), { fetchImpl, dryRun: true });
  assert.equal(r.ok, true);
  assert.match(r.detail, /DRY RUN/);
  assert.equal(sent.length, 0);
});

test("the seen list is bounded", async () => {
  const s = new eddn.Sender(Array.from({ length: 500 }, (_, i) => `old/${i}`));
  assert.equal(s.toList().length, eddn.Sender.MAX_SEEN);
});

test("a network failure is reported, not thrown", async () => {
  const s = new eddn.Sender();
  const fetchImpl = async () => { throw new Error("offline"); };
  const r = await send(s, fakeMarket(), { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.detail, /offline/);
});

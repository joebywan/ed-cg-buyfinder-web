// Ported from cg.py's fetch_live parsing, read_history, joined_goal and
// suggest_destination.
import test from "node:test";
import assert from "node:assert/strict";
import { historyFromLines, joinedGoal, parseLive, suggestDestination } from "../src/cg.js";

const FEED = {
  activeInitiatives: [
    { id: "859", title: "Wreaken Calls", market_name: "Metz Enterprise",
      starsystem_name: "Ega", expiry: "2026-09-17 11:00:00", activityType: "tradelist",
      target_commodity_list: "Palladium, Gold ,Silver,", target_qty: "1000", qty: "250" },
    { id: "860", title: "Bounty hunt", market_name: "Somewhere", starsystem_name: "Sol",
      activityType: "bounty", target_commodity_list: "" },
    { id: "861", title: "Second trade goal", market_name: "Other Port",
      starsystem_name: "Lave", activityType: "tradelist", target_commodity_list: "Water",
      target_qty: "nope" },
  ],
};

test("the live feed is parsed and trade goals are flagged", () => {
  const live = parseLive(FEED);
  assert.equal(live.length, 3);
  assert.deepEqual(live[0].commodities, ["Palladium", "Gold", "Silver"]);
  assert.equal(live[0].is_trade, true);
  assert.equal(live[0].station, "Metz Enterprise");
  assert.equal(live[0].system, "Ega");
  assert.equal(live[0].target_qty, 1000);
  assert.equal(live[1].is_trade, false);
  assert.equal(live[2].target_qty, 0);
  assert.deepEqual(parseLive(null), []);
  assert.deepEqual(parseLive({}), []);
});

const cgLine = (goal, when = "2026-09-14T12:00:00Z") =>
  JSON.stringify({ timestamp: when, event: "CommunityGoal", CurrentGoals: [goal] });

test("history reads CommunityGoal events and skips everything else", () => {
  const h = historyFromLines([
    '{"timestamp":"2026-09-14T11:00:00Z","event":"FSDJump","StarSystem":"Ega"}',
    "{broken",
    cgLine({ CGID: 859, Title: "Wreaken", SystemName: "Ega", MarketName: "Metz Enterprise",
             Expiry: "2026-09-17T11:00:00Z", PlayerContribution: 100 }),
  ]);
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].cgid, h[0].station, h[0].system, h[0].contribution],
    [859, "Metz Enterprise", "Ega", 100]);
});

test("the joined goal takes its commodity list from the feed", () => {
  const live = parseLive(FEED);
  const h = historyFromLines([cgLine({ CGID: 859, Title: "Wreaken", SystemName: "Ega",
                                       MarketName: "Metz Enterprise" })]);
  const d = joinedGoal(h, live);
  assert.deepEqual(d.commodities, ["Palladium", "Gold", "Silver"]);
  assert.equal(d.source, "joined CG");
  assert.equal(joinedGoal([], live), null);
});

test("suggest: joined goal first, else a live trade goal flagged not joined, else none", () => {
  const live = parseLive(FEED);
  const joined = historyFromLines([cgLine({ SystemName: "Lave", MarketName: "Other Port" })]);
  const [d1, others1] = suggestDestination(joined, live);
  assert.equal(d1.station, "Other Port");
  assert.deepEqual(others1.map((g) => g.station), ["Metz Enterprise"]);

  const [d2, others2] = suggestDestination([], live);
  assert.equal(d2.station, "Metz Enterprise");
  assert.equal(d2.source, "live CG (not joined)");
  assert.deepEqual(others2.map((g) => g.station), ["Other Port"]);

  // joined a goal that is no longer in the feed: no commodity list, fall back
  const gone = historyFromLines([cgLine({ SystemName: "Nowhere", MarketName: "Gone" })]);
  assert.equal(suggestDestination(gone, live)[0].station, "Metz Enterprise");

  assert.deepEqual(suggestDestination([], []), [null, []]);
});

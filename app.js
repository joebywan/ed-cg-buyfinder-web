// The page: wires the pure modules in src/ to the DOM, localStorage and the
// journal folder. Everything worth testing lives in src/.
import { buildRows, defaultFetchJson } from "./src/ardent.js";
import { folderTooltip } from "./src/browser.js";
import { FRONTIER_URL, historyFromLines, parseLive, suggestDestination } from "./src/cg.js";
import { JournalState } from "./src/journal.js";
import { JournalTail, readJournalFiles } from "./src/tail.js";
import { MAX_AGE_DEFAULT, ageTag, ageText, buildMixed, compareValues, mixedSortValue, padForShip }
  from "./src/model.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("en-US"));

const DEFAULTS = { hold: 64, range: 30, jump_empty: 20, jump_laden: 15, min_supply: 200,
                   pad: "L", carriers: false, max_age_days: MAX_AGE_DEFAULT };
const FIELDS = Object.keys(DEFAULTS);
const SHIP_FIELDS = ["hold", "jump_empty", "jump_laden", "pad"];
const CACHE_FRESH_MINUTES = 10;
const TOP_STATIONS = 40;
const EXPANDED_BY_DEFAULT = 5;
const POLL_MS = 2000;
const JOURNAL_FILES = 12;
// Chrome and Edge can keep a folder open and tail it. Firefox can only be
// handed a snapshot of one through <input webkitdirectory>.
const CAN_TAIL = "showDirectoryPicker" in window;
const CAN_SNAPSHOT = "webkitdirectory" in document.createElement("input");

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ }
  },
};

const S = {
  settings: { ...DEFAULTS, ...store.get("cgbuy.settings", {}) },
  manualDest: store.get("cgbuy.dest", null),
  live: [],
  cgLines: [],
  dest: null,
  journal: null,
  tail: null,
  shipKey: null,
  result: store.get("cgbuy.result", null),
  view: "mixed",
  sort: { mixed: null, single: { key: "cr_per_min", desc: true } },
  expanded: null,
  searching: false,
  noticeDismissed: false,
};

// -- tiny DOM helper ---------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// -- status -------------------------------------------------------------------

function setStatus(text, bad = false) {
  $("status").textContent = text;
  $("status").classList.toggle("bad", bad);
}

function ageShort(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function toast(text, ev) {
  const t = $("toast");
  t.textContent = text;
  t.style.left = `${Math.min(ev.clientX + 12, window.innerWidth - 200)}px`;
  t.style.top = `${ev.clientY + 12}px`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 1500);
}

// -- ship and controls ----------------------------------------------------------

/** What the journal says about the ship, or null with no ship to go on. */
function shipFigures() {
  const j = S.journal;
  if (!j?.ship) return null;
  const f = { name: j.shipName || j.ship, pad: padForShip(j.ship) };
  if (j.cargoCapacity) f.hold = j.cargoCapacity;
  if (j.maxJumpRange) f.jump_empty = Math.round(j.maxJumpRange * 10) / 10;
  const laden = j.ladenRange();
  if (laden) f.jump_laden = Math.round(laden * 10) / 10;
  return f;
}

function params() {
  const p = { ...S.settings, dest: S.dest };
  const f = shipFigures();
  if (f) for (const k of SHIP_FIELDS) if (f[k] != null) p[k] = f[k];
  return p;
}

function renderControls() {
  const f = shipFigures();
  for (const k of FIELDS) {
    const el = $(`f-${k}`);
    const locked = !!f && SHIP_FIELDS.includes(k) && f[k] != null;
    const v = locked ? f[k] : S.settings[k];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v;
    el.disabled = locked;
    const label = el.closest("label");
    label.classList.toggle("locked", locked);
    label.title = locked ? `From your journal: ${f.name}` : "";
  }
}

function readControls() {
  for (const k of FIELDS) {
    const el = $(`f-${k}`);
    if (el.disabled) continue;
    if (el.type === "checkbox") S.settings[k] = el.checked;
    else if (el.tagName === "SELECT") S.settings[k] = el.value;
    else {
      const n = Number(el.value);
      if (el.value !== "" && Number.isFinite(n) && n >= 0) S.settings[k] = n;
    }
  }
  store.set("cgbuy.settings", S.settings);
}

// -- destination --------------------------------------------------------------

async function loadLive() {
  try { S.live = parseLive(await defaultFetchJson(FRONTIER_URL)); } catch { S.live = []; }
  const sel = $("d-live");
  sel.replaceChildren(h("option", { value: "" }, S.live.some((g) => g.is_trade) ? "— pick one —" : "none running"));
  S.live.filter((g) => g.is_trade).forEach((g, i) =>
    sel.append(h("option", { value: String(i) }, `${g.title} — ${g.station}, ${g.system}`)));
}

/** Work out where we're selling. Returns true when it changed. */
function resolveDest() {
  const [auto] = suggestDestination(historyFromLines(S.cgLines), S.live);
  const next = S.manualDest ? { ...S.manualDest, source: "set by hand" } : auto;
  const changed = JSON.stringify(next) !== JSON.stringify(S.dest);
  S.dest = next;
  if (changed) S.noticeDismissed = false;
  renderDest();
  return changed;
}

function renderDest() {
  const d = S.dest;
  const line = $("dest-line");
  if (!d) {
    line.replaceChildren("No destination yet — ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); $("dest-panel").open = true; } }, "set one"));
    document.title = "cgbuy";
  } else {
    const prices = S.result && sameDest(S.result.p.dest, d)
      ? Object.entries(S.result.cg).map(([c, v]) => `${c}: ${fmt(v.sell)} cr/t`).join("\n") : "";
    line.replaceChildren(
      `${d.station}, ${d.system}`,
      h("span", { class: "sub" }, `  ${d.title ? `· ${d.title} ` : ""}· ${d.source}`),
      S.result ? h("span", { class: "sub" }, `  · data ${ageShort(S.result.at)} old`) : null);
    line.title = prices ? `What the destination pays:\n${prices}` : "";
    document.title = `cgbuy — ${d.station}`;
  }
  const notJoined = d?.source === "live CG (not joined)";
  $("notice").hidden = !notJoined || S.noticeDismissed;
  if (notJoined) {
    $("notice-text").textContent = `You haven't joined "${d.title}". Sign up at the goal board at ${d.station} first — deliveries made before you register don't count.`;
  }
  $("d-system").placeholder = d?.system || "Ega";
  $("d-station").placeholder = d?.station || "Metz Enterprise";
}

const sameDest = (a, b) => !!a && !!b && a.system === b.system && a.station === b.station
  && JSON.stringify(a.commodities) === JSON.stringify(b.commodities);

// -- search ---------------------------------------------------------------------

async function search() {
  if (S.searching) {
    // A dock or a ship swap mid-search must not be lost: run again after.
    S.rerun = true;
    return;
  }
  S.rerun = false;
  readControls();
  const p = params();
  if (!p.dest) {
    setStatus("No destination: open DESTINATION and set one.");
    return;
  }
  S.searching = true;
  $("search").disabled = true;
  $("progress").hidden = false;
  $("progress-bar").style.width = "0";
  setStatus(`Searching ${p.dest.commodities.length} commodities around ${p.dest.system}…`);
  try {
    const res = await buildRows(p, {
      cal: S.journal?.cal ?? null,
      onProgress: (done, total, name) => {
        $("progress-bar").style.width = `${(100 * done) / total}%`;
        setStatus(`Searching… ${done}/${total} ${name}`);
      },
    });
    S.result = { ...res, p, at: Date.now() };
    S.expanded = null;
    store.set("cgbuy.result", S.result);
    render();
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, true);
  } finally {
    S.searching = false;
    $("search").disabled = false;
    $("progress").hidden = true;
    if (S.rerun) search();
  }
}

// -- tables ---------------------------------------------------------------------

const MIXED_COLS = [
  ["system", "SYSTEM"], ["ly", "LY", true], ["station", "STATION"], ["ls", "LS", true],
  ["updated", "AGE", true], ["cr_per_min", "CR/MIN", true], ["total", "VALUE", true],
  ["tonnes", "TONNES", true], ["buy", "BUY", true, false], ["profit_per_t", "PROFIT/T", true, false],
];
const SINGLE_COLS = [
  ["commodity", "COMMODITY"], ["system", "SYSTEM"], ["station", "STATION"], ["ly", "LY", true],
  ["ls", "LS", true], ["supply", "SUPPLY", true], ["loads_available", "LOADS", true],
  ["buy", "BUY", true], ["profit_per_t", "PROFIT/T", true], ["trip_minutes", "TRIP", true],
  ["cr_per_min", "CR/MIN", true], ["t_per_min", "T/MIN", true], ["updated", "AGE", true],
];

function sorted(items, sort) {
  if (!sort) return items;
  const dir = sort.desc ? -1 : 1;
  return [...items].sort((a, b) =>
    dir * compareValues(mixedSortValue(a, sort.key), mixedSortValue(b, sort.key)));
}

function headRow(view, cols) {
  const cur = S.sort[view];
  return h("thead", {}, h("tr", {}, cols.map(([key, label, num, sortable = true]) =>
    h("th", {
      class: [num && "num", sortable && "sortable"].filter(Boolean).join(" "),
      onclick: sortable ? () => {
        S.sort[view] = cur?.key === key ? { key, desc: !cur.desc } : { key, desc: true };
        render();
      } : null,
    }, label, cur?.key === key ? (cur.desc ? " ▼" : " ▲") : ""))));
}

function copySystem(ev) {
  const tr = ev.target.closest("tr[data-system]");
  if (!tr || ev.target.closest("button")) return;
  navigator.clipboard?.writeText(tr.dataset.system).then(
    () => toast(`Copied ${tr.dataset.system}`, ev),
    () => toast("Clipboard blocked", ev));
}

const stationLabel = (x) => [x.station, x.carrier ? h("span", { class: "fc" }, " FC") : null];
const ageCell = (x) => h("td", { class: `num ${ageTag(x.updated)}` }, ageText(x.updated));

function renderMixed(r) {
  const hold = r.p.hold;
  const plans = buildMixed(r.rows, hold).slice(0, TOP_STATIONS);
  const key = (x) => `${x.station} ${x.system}`;
  const best = plans[0] && key(plans[0]);
  if (!S.expanded) S.expanded = new Set(plans.slice(0, EXPANDED_BY_DEFAULT).map(key));
  const body = h("tbody", { onclick: copySystem });
  for (const plan of sorted(plans, S.sort.mixed)) {
    const k = key(plan);
    const open = S.expanded.has(k);
    body.append(h("tr", { class: `row head${k === best ? " top" : ""}`, "data-system": plan.system },
      h("td", {}, plan.system),
      h("td", { class: "num" }, plan.ly),
      h("td", { class: "station" },
        h("button", { class: "toggle", type: "button", "aria-expanded": String(open),
          onclick: () => { open ? S.expanded.delete(k) : S.expanded.add(k); render(); } }, open ? "▾" : "▸"),
        stationLabel(plan)),
      h("td", { class: "num" }, fmt(plan.ls)),
      ageCell(plan),
      h("td", { class: "num" }, fmt(plan.cr_per_min)),
      h("td", { class: "num" }, fmt(plan.total)),
      h("td", { class: `num${plan.short > 0 ? " short" : ""}`, title: plan.short > 0 ? `${fmt(plan.short)} t short of your hold` : null }, fmt(plan.tonnes)),
      h("td"), h("td")));
    if (!open) continue;
    for (const m of plan.mix) {
      body.append(h("tr", { class: "child", "data-system": plan.system },
        h("td"), h("td"), h("td", { class: "station" }, m.commodity), h("td"), h("td"), h("td"),
        h("td", { class: "num" }, fmt(m.value)), h("td", { class: "num" }, fmt(m.tonnes)),
        h("td", { class: "num" }, fmt(m.buy)), h("td", { class: "num" }, fmt(m.profit_per_t))));
    }
  }
  $("t-mixed").replaceChildren(headRow("mixed", MIXED_COLS), body);
  return plans.length;
}

function renderSingle(r) {
  const body = h("tbody", { onclick: copySystem });
  for (const x of sorted(r.rows, S.sort.single)) {
    body.append(h("tr", { class: "row", "data-system": x.system },
      h("td", {}, x.commodity), h("td", {}, x.system), h("td", {}, stationLabel(x)),
      h("td", { class: "num" }, x.ly), h("td", { class: "num" }, fmt(x.ls)),
      h("td", { class: "num" }, fmt(x.supply)), h("td", { class: "num" }, x.loads_available),
      h("td", { class: "num" }, fmt(x.buy)), h("td", { class: "num" }, fmt(x.profit_per_t)),
      h("td", { class: "num" }, x.trip_minutes), h("td", { class: "num" }, fmt(x.cr_per_min)),
      h("td", { class: "num" }, x.t_per_min), ageCell(x)));
  }
  $("t-single").replaceChildren(headRow("single", SINGLE_COLS), body);
}

function render() {
  $("wrap-mixed").hidden = S.view !== "mixed";
  $("wrap-single").hidden = S.view !== "single";
  $("tab-mixed").setAttribute("aria-selected", String(S.view === "mixed"));
  $("tab-single").setAttribute("aria-selected", String(S.view === "single"));
  renderDest();
  renderCalibration();
  const r = S.result;
  const stale = r && S.dest && !sameDest(r.p.dest, S.dest);
  if (!r) {
    $("empty").hidden = false;
    $("empty").textContent = S.dest ? "No results yet — press SEARCH." : "Set a destination to search.";
    $("t-mixed").replaceChildren();
    $("t-single").replaceChildren();
    $("age-line").textContent = "";
    return;
  }
  const stations = renderMixed(r);
  renderSingle(r);
  $("empty").hidden = r.rows.length > 0;
  $("empty").textContent = "Nothing within range makes a profit. Try a wider radius, a lower minimum supply, or carriers.";
  const maxAge = r.p.max_age_days;
  $("age-line").textContent = !maxAge ? "Age filter off: showing sources of any age."
    : r.allStale ? `Every source is older than ${maxAge} days — showing them anyway.`
    : r.hiddenStale ? `Hid ${fmt(r.hiddenStale)} of ${fmt(r.hiddenStale + r.rows.length)} sources older than ${maxAge} days.`
    : `Nothing hidden: every source is within ${maxAge} days.`;
  const errs = r.errors?.length ? `  ·  failed: ${r.errors.join("; ")}` : "";
  setStatus(`${stations} stations, ${fmt(r.rows.length)} sources for ${r.p.dest.station}${stale ? " (for a previous destination — search again)" : ""}${errs}`, !!errs);
}

function renderCalibration() {
  $("calibration").textContent = S.journal
    ? `Trip timings: ${S.journal.cal.summary()}`
    : "Trip timings: estimates. Add your journal folder to calibrate them to your flying.";
}

// -- journal --------------------------------------------------------------------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("cgbuy", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kv(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", value === undefined ? "readonly" : "readwrite");
    const req = value === undefined ? tx.objectStore("kv").get(key) : tx.objectStore("kv").put(value, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const shipKey = () => (S.journal ? `${S.journal.ship}|${S.journal.shipId}|${S.journal.cargoCapacity}` : "");

function renderJournal() {
  const j = S.journal;
  const when = S.snapshotAt
    ? ` · read at ${new Date(S.snapshotAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, load again after docking to refresh`
    : "";
  $("journal-status").textContent = j
    ? `CMDR ${j.commander || "?"} · ${j.shipName || j.ship || "no ship seen"}${j.ship && !j.cargoCapacity ? " (waiting for loadout)" : ""}${j.system ? ` · ${j.system}` : ""}${when}`
    : "";
  $("journal-btn").textContent = CAN_TAIL
    ? (j ? "Change folder" : "Connect journal folder")
    : (j ? "Load journal folder again" : "Load journal folder");
}

/** A fresh journal reader: the state, the goal lines it saw, and its sink. */
function newJournal() {
  const state = new JournalState();
  const lines = [];
  const sink = (line, live) => {
    state.handle(line, live);
    if (line.includes('"CommunityGoal"')) lines.push(line);
  };
  return { state, lines, sink };
}

/** Make a freshly read journal the one the page uses. */
function adoptJournal({ state, lines }) {
  S.journal = state;
  S.cgLines = lines;
  S.shipKey = shipKey();
  state.onDocked = (station, system) => {
    if (S.dest && station === S.dest.station && system === S.dest.system) {
      S.noticeDismissed = false;       // docking unregistered is when the reminder matters
      search();
    }
  };
  renderControls();
  renderJournal();
  if (resolveDest() || S.result) search();
}

/** Firefox: read a one-off snapshot of the folder. Nothing updates after. */
async function loadSnapshot(files) {
  clearTimeout(S.pollTimer);
  S.tail = null;
  const j = newJournal();
  $("journal-status").textContent = "Reading journals…";
  let n;
  try {
    n = await readJournalFiles(files, j.sink, JOURNAL_FILES);
  } catch (err) {
    $("journal-status").textContent = `Couldn't read that folder (${err.name}). Load it again.`;
    return;
  }
  if (!n) {
    $("journal-status").textContent = "No Journal.*.log files in that folder.";
    return;
  }
  S.snapshotAt = Date.now();
  adoptJournal(j);
}

async function connectJournal(dir) {
  clearTimeout(S.pollTimer);
  const j = newJournal();
  const tail = new JournalTail(dir, j.sink);
  $("journal-status").textContent = "Reading journals…";
  let n;
  try {
    n = await tail.prime(JOURNAL_FILES);
  } catch (err) {
    // A remembered folder that was moved or deleted: forget it rather than
    // failing the same way on every visit.
    if (err.name === "NotFoundError") {
      try { await kv("journalDir", null); } catch { /* nothing remembered */ }
    }
    $("journal-status").textContent = `Couldn't read that folder (${err.name}). Connect it again.`;
    return;
  }
  if (!n) {
    $("journal-status").textContent = "No Journal.*.log files in that folder.";
    return;
  }
  S.tail = tail;
  S.snapshotAt = null;
  adoptJournal(j);
  const loop = async () => {
    try {
      if (await S.tail.poll()) {
        renderControls();
        renderJournal();
        renderCalibration();
        const k = shipKey();
        const shipChanged = k !== S.shipKey && !!S.journal.cargoCapacity;
        if (k !== S.shipKey && S.journal.cargoCapacity) S.shipKey = k;
        if (resolveDest() || shipChanged) search();
      }
    } catch (err) {
      $("journal-status").textContent = `Journal read failed: ${err.message}`;
    }
    S.pollTimer = setTimeout(loop, POLL_MS);
  };
  S.pollTimer = setTimeout(loop, POLL_MS);
}

async function pickJournal() {
  try {
    const dir = await window.showDirectoryPicker({ id: "elite-journal", mode: "read" });
    try { await kv("journalDir", dir); } catch { /* remembered next time, or not */ }
    await connectJournal(dir);
  } catch (err) {
    if (err.name !== "AbortError") $("journal-status").textContent = `Could not open folder: ${err.message}`;
  }
}

/** Decided before anything loads, so a quick click never finds a dead button. */
function setupJournalButton() {
  const btn = $("journal-btn");
  btn.title = "Usually C:\\Users\\<you>\\Saved Games\\Frontier Developments\\Elite Dangerous";
  if (CAN_TAIL) {
    btn.onclick = pickJournal;
  } else if (CAN_SNAPSHOT) {
    btn.title = folderTooltip(navigator);
    const input = $("journal-files");
    btn.onclick = () => input.click();
    input.onchange = () => {
      const files = [...input.files];
      input.value = "";                 // so picking the same folder again still fires
      if (files.length) loadSnapshot(files);
    };
  } else {
    btn.hidden = true;
    $("journal-status").textContent = "This browser can't read the journal folder: enter your ship's figures by hand.";
  }
  renderJournal();
}

async function restoreJournal() {
  if (!CAN_TAIL) return;
  const btn = $("journal-btn");
  let dir;
  try { dir = await kv("journalDir"); } catch { return; }
  if (!dir) return;
  if (await dir.queryPermission({ mode: "read" }) === "granted") {
    await connectJournal(dir);
    return;
  }
  // The browser needs a click before it will hand the folder back.
  btn.textContent = "Reconnect journal folder";
  btn.onclick = async () => {
    btn.onclick = pickJournal;
    if (await dir.requestPermission({ mode: "read" }) === "granted") await connectJournal(dir);
  };
}

// -- wiring ---------------------------------------------------------------------

function bind() {
  $("controls").addEventListener("submit", (e) => { e.preventDefault(); search(); });
  $("controls").addEventListener("change", (e) => {
    readControls();
    if (e.target.id === "f-max_age_days") search();   // hidden rows aren't kept anywhere
  });
  $("tab-mixed").onclick = () => { S.view = "mixed"; render(); };
  $("tab-single").onclick = () => { S.view = "single"; render(); };
  $("notice-close").onclick = () => { S.noticeDismissed = true; renderDest(); };
  $("d-live").onchange = () => {
    const g = S.live.filter((x) => x.is_trade)[Number($("d-live").value)];
    if (!g) return;
    $("d-system").value = g.system;
    $("d-station").value = g.station;
    $("d-commodities").value = g.commodities.join(", ");
  };
  $("d-use").onclick = () => {
    const system = $("d-system").value.trim();
    const station = $("d-station").value.trim();
    const commodities = $("d-commodities").value.split(",").map((c) => c.trim()).filter(Boolean);
    if (!system || !station || !commodities.length) {
      setStatus("A destination needs a system, a station and at least one commodity.", true);
      return;
    }
    const g = S.live.find((x) => x.system === system && x.station === station);
    S.manualDest = { system, station, commodities, title: g?.title || "", expiry: g?.expiry || null };
    store.set("cgbuy.dest", S.manualDest);
    $("dest-panel").open = false;
    resolveDest();
    search();
  };
  $("d-auto").onclick = () => {
    S.manualDest = null;
    store.set("cgbuy.dest", null);
    $("dest-panel").open = false;
    resolveDest();
    search();
  };
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("dest-panel").open = false;
  });
  setInterval(() => renderDest(), 30000);
}

async function main() {
  bind();
  setupJournalButton();
  renderControls();
  render();
  await loadLive();
  resolveDest();
  render();
  try {
    await restoreJournal();
  } catch (err) {
    $("journal-status").textContent = `Couldn't reopen the journal folder (${err.name}). Connect it again.`;
  }
  const r = S.result;
  const fresh = r && sameDest(r.p.dest, S.dest) && (Date.now() - r.at) / 60000 < CACHE_FRESH_MINUTES;
  if (S.dest && !fresh && !S.searching) search();
}

main();

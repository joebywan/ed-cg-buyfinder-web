// Journal folder reading through the File System Access API: learn from
// recent history once, then tail the newest journal.

const JOURNAL = /^Journal\..+\.log$/;
const MARKET = "Market.json";

/** Parse a Market.json File, or null if it is missing or mid-write.

 The game truncates and rewrites in place, so a read landing inside a write
 sees half a document. That is normal; the next one gets a whole one. */
async function parseMarket(file) {
  try {
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

/** Complete lines in `bytes` and how many bytes they used; a partial last
 *  line is left for the next read, since the game may be mid-write. */
export function takeLines(bytes) {
  const end = bytes.lastIndexOf(10);
  if (end < 0) return { lines: [], used: 0 };
  const text = new TextDecoder().decode(bytes.subarray(0, end + 1));
  return { lines: text.split("\n").slice(0, -1).map((l) => l.replace(/\r$/, "")), used: end + 1 };
}

// Journal names embed their start time, so name order is age order.
async function listJournals(dir) {
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file" && JOURNAL.test(name)) out.push({ name, handle });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export class JournalTail {
  /** `sink(line, live)` receives every complete line. */
  constructor(dir, sink) {
    this.dir = dir;
    this.sink = sink;
    this.name = null;
    this.pos = 0;
  }

  async #read(handle, from, live) {
    const file = await handle.getFile();
    if (file.size < from) from = 0;             // truncated or replaced
    const { lines, used } = takeLines(new Uint8Array(await file.slice(from).arrayBuffer()));
    for (const line of lines) {
      try { this.sink(line, live); } catch { /* one bad line must not stop the tail */ }
    }
    return { count: lines.length, pos: from + used };
  }

  /** Read the newest `files` journals, oldest first. Returns lines read. */
  async prime(files = 12) {
    let n = 0;
    for (const j of (await listJournals(this.dir)).slice(-files)) {
      const r = await this.#read(j.handle, 0, false);
      n += r.count;
      this.name = j.name;
      this.pos = r.pos;
    }
    return n;
  }

  /** The market the game last wrote, from the folder we already hold.

   Market.json sits beside the journals, so the permission granted for one
   covers the other - nothing extra is asked of the user. */
  async market() {
    try {
      const handle = await this.dir.getFileHandle(MARKET);
      return await parseMarket(await handle.getFile());
    } catch {
      return null;                              // not docked yet, or no file
    }
  }

  /** Read whatever is new, following the game onto a new journal. */
  async poll() {
    const newest = (await listJournals(this.dir)).at(-1);
    if (!newest) return 0;
    if (newest.name !== this.name) {
      this.name = newest.name;
      this.pos = 0;
    }
    const r = await this.#read(newest.handle, this.pos, true);
    this.pos = r.pos;
    return r.count;
  }
}

/**
 * Read the newest `files` journals from a one-off folder snapshot, oldest
 * first: Firefox has no directory handles, only <input webkitdirectory>,
 * which hands over File objects once and cannot be tailed.
 */
export async function readJournalFiles(fileList, sink, files = 12) {
  const journals = [...fileList].filter((f) => JOURNAL.test(f.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(-files);
  let n = 0;
  for (const f of journals) {
    const { lines } = takeLines(new Uint8Array(await f.arrayBuffer()));
    for (const line of lines) {
      try { sink(line, false); } catch { /* one bad line must not stop the read */ }
    }
    n += lines.length;
  }
  return n;
}

/** Market.json out of a one-off folder snapshot, or null if it is not there. */
export async function readMarketFile(fileList) {
  const f = [...fileList].find((x) => x.name === MARKET);
  return f ? parseMarket(f) : null;
}

// Journal folder tailing against a fake FileSystemDirectoryHandle.
import test from "node:test";
import assert from "node:assert/strict";
import { JournalTail, takeLines } from "../src/tail.js";

const enc = (s) => new TextEncoder().encode(s);

test("takeLines keeps a partial last line back, counting bytes not characters", () => {
  const { lines, used } = takeLines(enc('{"a":"Zillig Örbital"}\n{"b":2}\n{"c":'));
  assert.deepEqual(lines, ['{"a":"Zillig Örbital"}', '{"b":2}']);
  assert.equal(used, enc('{"a":"Zillig Örbital"}\n{"b":2}\n').length);
  assert.deepEqual(takeLines(enc("no newline yet")), { lines: [], used: 0 });
  assert.deepEqual(takeLines(enc("crlf\r\n")).lines, ["crlf"]);
});

function fakeDir(files) {
  return {
    async *entries() {
      for (const name of Object.keys(files)) {
        yield [name, { kind: "file", name,
          getFile: async () => new File([files[name].text], name, { lastModified: files[name].t }) }];
      }
    },
  };
}

test("prime reads the newest journals oldest first, then poll tails the newest", async () => {
  const files = {
    "Journal.2026-09-13T100000.01.log": { text: "old1\n", t: 1 },
    "Journal.2026-09-14T100000.01.log": { text: "mid1\nmid2\n", t: 2 },
    "Journal.2026-09-15T100000.01.log": { text: "new1\npart", t: 3 },
    "Status.json": { text: "{}\n", t: 4 },
    "Journal.2026-09-12T100000.01.log": { text: "ancient\n", t: 0 },
  };
  const got = [];
  const tail = new JournalTail(fakeDir(files), (line, live) => got.push([line, live]));
  assert.equal(await tail.prime(3), 4);
  assert.deepEqual(got, [["old1", false], ["mid1", false], ["mid2", false], ["new1", false]]);

  got.length = 0;
  assert.equal(await tail.poll(), 0);          // "part" is still being written
  files["Journal.2026-09-15T100000.01.log"].text += "ial\nnew3\n";
  assert.equal(await tail.poll(), 2);
  assert.deepEqual(got, [["partial", true], ["new3", true]]);

  got.length = 0;
  files["Journal.2026-09-15T110000.01.log"] = { text: "rotated\n", t: 5 };
  await tail.poll();
  assert.deepEqual(got, [["rotated", true]]);
});

test("an empty folder primes nothing and polls quietly", async () => {
  const tail = new JournalTail(fakeDir({}), () => assert.fail("no lines expected"));
  assert.equal(await tail.prime(), 0);
  assert.equal(await tail.poll(), 0);
  assert.equal(tail.name, null);
});

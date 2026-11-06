const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { classifyBook, filterWiredBooks, MIN_TARGET_CHAPTERS } = require("../automation/long_novel_policy");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-long-novel-"));
  for (const [id, target] of [["long", 100], ["short", 6], ["missing", null]]) {
    const dir = path.join(root, "serial", "books", id);
    fs.mkdirSync(dir, { recursive: true });
    if (target !== null) fs.writeFileSync(path.join(dir, "book.json"), JSON.stringify({ targetChapters: target }));
  }
  return root;
}

test("only target chapter counts at or above the long-novel threshold are eligible", () => {
  const root = fixture();
  assert.equal(MIN_TARGET_CHAPTERS, 50);
  assert.equal(classifyBook("long", root).eligible, true);
  assert.equal(classifyBook("short", root).eligible, false);
  assert.equal(classifyBook("missing", root).eligible, false);
});

test("daily queue filtering keeps manual queue entries but excludes short novels", () => {
  const root = fixture();
  const result = filterWiredBooks([
    { book: "long", platform: "fanqie", url: "long-url" },
    { book: "short", platform: "fanqie", url: "short-url" },
  ], root);
  assert.deepEqual(result.eligible.map(item => item.book), ["long"]);
  assert.equal(result.skipped[0].book, "short");
  assert.match(result.skipped[0].reason, /targetChapters=6/);
});

test("explicit autoUpdate false remains excluded even for a long novel", () => {
  const root = fixture();
  const file = path.join(root, "serial", "books", "long", "book.json");
  fs.writeFileSync(file, JSON.stringify({ targetChapters: 100, autoUpdate: false }));
  assert.equal(classifyBook("long", root).eligible, false);
});

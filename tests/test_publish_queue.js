const assert = require("node:assert/strict");
const { parseArgs, templateUrl, acquirePublishLock } = require("../automation/publish_queue");

const args = parseArgs([
  "--platform", "qimao",
  "--book-id", "lianai-daka",
  "--chapter", "7",
  "--dry-run",
]);
assert.equal(args.platform, "qimao");
assert.equal(args.bookId, "lianai-daka");
assert.equal(args.chapter, "7");
assert.equal(args.dryRun, true);
assert.equal(
  templateUrl("https://example.test/{bookId}/{storyId}/{chapter}", {
    bookId: "book-a",
    storyId: "serial-book-a",
    chapter: 7,
  }),
  "https://example.test/book-a/serial-book-a/7",
);
const releaseLock = acquirePublishLock("qimao-test");
assert.throws(
  () => acquirePublishLock("qimao-test"),
  /平台发布任务已在运行/,
);
releaseLock();
const releaseSecondLock = acquirePublishLock("qimao-test");
releaseSecondLock();
process.stdout.write("Publish queue helpers passed.\n");

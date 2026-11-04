const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");
const limits = require("../automation/platform_limits");
const publisher = require("../automation/publish_queue");
const auto = require("../automation/auto_publish");

(async () => {
  const now = new Date("2026-11-04T03:40:00Z");
  const rejection = {code: "-1020", message: "更新连载模式作品数超出每日上限"};
  const outcome = limits.classifyPublishResponse(rejection, 200, now);
  assert.equal(outcome.status, "waiting_platform_limit");
  assert.equal(outcome.retryAfter, "2026-11-04T16:00:00.000Z");
  assert.equal(limits.classifyPublishResponse({code: "-1020", message: "其他错误"}, 200).status, "failed");
  assert.equal(limits.classifyPublishResponse({code: 0}, 500).status, "failed");
  assert.equal(limits.classifyPublishResponse(null, 200).status, "failed");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "platform-limit-"));
  const browser = await chromium.launch({headless: true});
  try {
    limits.recordPlatformLimit("fanqie", outcome, tmp);
    assert.equal(limits.activePlatformLimit("fanqie", tmp, now).code, "-1020");
    assert.equal(limits.activePlatformLimit("fanqie", tmp, new Date("2026-11-04T16:00:00Z")), null);
    const write = (book, n, state, legacy = false) => {
      const folder = path.join(tmp, "serial/books", book, "runs");
      fs.mkdirSync(folder, {recursive: true});
      const file = path.join(folder, "2026-11-03" + (legacy ? "" : "-chapter-" + String(n).padStart(4, "0")) + ".json");
      fs.writeFileSync(file, JSON.stringify({chapter: n, platforms: {fanqie: state}}));
      return file;
    };
    const first = write("book", 1, {status:"published",updatedAt:"2026-11-03T01:00:00Z"});
    write("book", 2, {...outcome, retryAfter:outcome.retryAfter});
    assert.ok(auto.nextChapter("book", tmp, now).blocked);
    assert.equal(auto.nextChapter("book", tmp, new Date("2026-11-05T01:10:00Z")).chapter, 2);
    write("book", 2, {status:"pending"}, true);
    assert.equal(auto.nextChapter("book", tmp, new Date("2026-11-05T01:10:00Z")).chapter, 2);
    write("book", 1, {status:"published",updatedAt:now.toISOString()});
    assert.match(auto.nextChapter("book", tmp, now).blocked, /今天已发布/);
    write("gap", 2, {status:"draft_saved"});
    assert.match(auto.nextChapter("gap", tmp, now).blocked, /前置章节缺少/);
    for (const [book, stamp] of [["serial-0002-mianguang", now.toISOString()], ["old", "2026-11-01T01:00:00Z"]]) {
      write(book, 1, {status:"published",updatedAt:stamp});
    }
    assert.deepEqual(auto.orderedBooks([{book:"book",platform:"fanqie"}, {book:"old",platform:"fanqie"},
      {book:"serial-0002-mianguang",platform:"fanqie"}], tmp).map(w=>w.book),
      ["serial-0002-mianguang","old","book"]);
    publisher.updateLedger(first, "fanqie", "waiting_platform_limit", outcome.message, {retryAfter:outcome.retryAfter});
    assert.equal(JSON.parse(fs.readFileSync(first)).platforms.fanqie.retryAfter, outcome.retryAfter);
    const page = await browser.newPage();
    let payload = rejection, submissions = 0;
    await page.route("https://fanqienovel.com/**", route => {
      if (route.request().url().includes("/api/author/publish_article/v0/")) {
        submissions++;
        return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(payload)});
      }
      return route.fulfill({contentType:"text/html",body:
        '<button onclick="fetch(\'/api/author/publish_article/v0/\',{method:\'POST\'})">确认发布</button>'});
    });
    await page.goto("https://fanqienovel.com/fixture");
    await assert.rejects(() => publisher.submitFanqiePublish(page, page.getByRole("button")), error => {
      assert.equal(error.platformOutcome.status, "waiting_platform_limit");
      assert.equal(error.message, rejection.message);
      return true;
    });
    assert.equal(submissions, 1);
    payload = {code:0,message:"success"};
    assert.equal((await publisher.submitFanqiePublish(page, page.getByRole("button"))).status, "accepted");
    assert.equal(submissions, 2);
    payload = {code:-1,message:"需要验证"};
    await assert.rejects(() => publisher.submitFanqiePublish(page, page.getByRole("button")), /需要验证/);
    assert.equal(submissions, 3);
    console.log("PLATFORM_LIMIT_FIXTURES_OK: HTTP200 rejection, one submit per call, midnight retry, daily idempotency, priority, gap and ledger protection");
  } finally {
    await browser.close();
    fs.rmSync(tmp,{recursive:true,force:true});
  }
})().catch(error => {console.error(error);process.exitCode=1;});

#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { beijingDay, activePlatformLimit } = require("./platform_limits");

const ROOT = path.resolve(__dirname, "..");
function chapterRecords(bookDir, root = ROOT) {
  const runsDir = path.join(root, "serial", "books", bookDir, "runs");
  const records = new Map();
  for (const name of fs.readdirSync(runsDir).sort()) {
    const modern = /^\d{4}-\d{2}-\d{2}-chapter-\d{4}\.json$/.test(name);
    if (!modern && !/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const rec = JSON.parse(fs.readFileSync(path.join(runsDir, name), "utf8"));
    if (!Number.isInteger(rec.chapter) || rec.chapter < 1) throw new Error("章节台账号无效：" + name);
    if (!records.has(rec.chapter) || modern) {
      records.set(rec.chapter, { ...rec.platforms?.fanqie, modern });
    }
  }
  return records;
}

function nextChapter(bookDir, root = ROOT, now = new Date()) {
  const records = chapterRecords(bookDir, root);
  if ([...records.values()].some(r => r.status === "published" && r.updatedAt &&
      beijingDay(new Date(r.updatedAt)) === beijingDay(now))) {
    return { blocked: "本书今天已发布，保持每天1章" };
  }
  let expected = 1;
  for (const [n, r] of [...records.entries()].sort((a, b) => a[0] - b[0])) {
    if (n !== expected) return { blocked: "前置章节缺少台账：" + expected };
    expected++;
    if (r.status === "published") continue;
    if (r.status === "draft_saved") return { chapter: n };
    if (r.status === "waiting_platform_limit" && Number.isFinite(Date.parse(r.retryAfter)) &&
        Date.parse(r.retryAfter) <= now.getTime()) return { chapter: n };
    return { blocked: "第" + n + "章状态为" + r.status + "，等待处理或重试时间" };
  }
  return { blocked: "没有待发布的章节" };
}

function orderedBooks(wired, root = ROOT) {
  const latest = book => Math.max(0, ...[...chapterRecords(book, root).values()]
    .filter(r => r.status === "published").map(r => Date.parse(r.updatedAt) || 0));
  return wired.filter(w => w.platform === "fanqie").map(w => ({
    ...w, priority: w.publishPriority ?? (w.book === "serial-0002-mianguang" ? 100 : 0),
    latest: latest(w.book),
  })).sort((a, b) => b.priority - a.priority || a.latest - b.latest);
}

function main() {
  const dry = process.argv.includes("--dry");
  const wired = JSON.parse(fs.readFileSync(path.join(ROOT, "automation", "wired_books.json"), "utf8"));
  let acted = 0, failed = 0, waiting = false;
  for (const w of orderedBooks(wired)) {
    const limit = activePlatformLimit("fanqie");
    if (limit) {
      console.log("AUTO_PUBLISH_WAIT platform=fanqie retryAfter=" + limit.retryAfter + " reason=" + limit.message);
      waiting = true;
      break;
    }
    const next = nextChapter(w.book);
    if (!next.chapter) { console.log(w.book, "跳过：", next.blocked); continue; }
    if (dry) { console.log("DRY " + w.book + " → 将发布第" + next.chapter + "章"); continue; }
    const r = spawnSync(process.execPath, [
      "automation/publish_queue.js", "--platform", "fanqie", "--book-id", w.book,
      "--chapter", String(next.chapter), "--url", w.url, "--headless", "--publish",
    ], { cwd: ROOT, stdio: "inherit", env: { ...process.env, READER_HEADLESS: "1" } });
    const state = chapterRecords(w.book).get(next.chapter)?.status;
    if (r.status === 0 && state === "published") {
      console.log("AUTO_PUBLISH_OK " + w.book + " chapter=" + next.chapter);
      acted++;
    } else if (state === "waiting_platform_limit" || activePlatformLimit("fanqie")) {
      console.log("AUTO_PUBLISH_WAIT " + w.book + " chapter=" + next.chapter);
      waiting = true;
      break;
    } else {
      console.log("AUTO_PUBLISH_FAIL " + w.book + " chapter=" + next.chapter + " exit=" + r.status + " ledger=" + state);
      failed++;
    }
  }
  console.log("AUTO_PUBLISH_DONE acted=" + acted + " failed=" + failed + " waiting=" + waiting + " dry=" + dry);
  if (failed) process.exitCode = 1;
}

module.exports = { chapterRecords, nextChapter, orderedBooks };
if (require.main === module) {
  try { main(); } catch (error) { console.error("AUTO_PUBLISH_FAIL", error.message); process.exitCode = 1; }
}

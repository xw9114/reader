#!/usr/bin/env node
// 每日自动发布：给 wired_books.json 里的每本书发布 1 章（由 daily_sync.sh 在 READER_AUTO_PUBLISH=1 时调用）。
// 选章规则（与控制台发布按钮一致）：按章号顺序，第一个状态为 draft_saved 且前面章节都已 published 的章；
// 若排头的是 pending/failed（还没存成草稿）→ 本书跳过并说明。单本失败不影响其他书（汇总退出码 0 除非全失败于异常）。
// 用法: node automation/auto_publish.js [--dry]   --dry 只打印每本的决策，不执行发布。
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = "/root/reader";
const DRY = process.argv.includes("--dry");
const log = (...a) => console.log(new Date().toISOString(), ...a);

function nextChapter(bookDir) {
  const runsDir = path.join(ROOT, "serial", "books", bookDir, "runs");
  const byChapter = {};
  for (const f of fs.readdirSync(runsDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(runsDir, f), "utf8"));
      const st = rec && rec.platforms && rec.platforms.fanqie && rec.platforms.fanqie.status;
      if (st && rec.chapter) byChapter[rec.chapter] = st;
    } catch (e) { /* ignore */ }
  }
  const nums = Object.keys(byChapter).map(Number).sort((a, b) => a - b);
  for (const n of nums) {
    const st = byChapter[n];
    if (st === "published") continue;
    if (st === "draft_saved") return { chapter: n };
    return { blocked: `第 ${n} 章状态为 ${st}，还没存成草稿` };
  }
  return { blocked: "没有待发布的章节（全部已发布或无台账）" };
}

function ledgerStatus(bookDir, chapter) {
  const runsDir = path.join(ROOT, "serial", "books", bookDir, "runs");
  for (const f of fs.readdirSync(runsDir)) {
    if (!f.includes(`chapter-${String(chapter).padStart(4, "0")}`)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(runsDir, f), "utf8"));
      return rec.platforms.fanqie.status;
    } catch (e) { /* ignore */ }
  }
  return null;
}

const wired = JSON.parse(fs.readFileSync(path.join(ROOT, "automation", "wired_books.json"), "utf8"));
let acted = 0;
for (const w of wired) {
  if (w.platform !== "fanqie") { log(w.book, "跳过：非番茄平台暂不支持自动发布"); continue; }
  const next = nextChapter(w.book);
  if (!next.chapter) { log(w.book, "跳过：", next.blocked); continue; }
  if (DRY) { console.log(`DRY ${w.book} → 将发布第 ${next.chapter} 章`); acted++; continue; }
  log(w.book, `开始发布第 ${next.chapter} 章`);
  const r = spawnSync("/usr/local/bin/node", [
    "automation/publish_queue.js", "--platform", "fanqie", "--book-id", w.book,
    "--chapter", String(next.chapter), "--url", w.url, "--headless", "--publish",
  ], { cwd: ROOT, stdio: "inherit", env: { ...process.env, READER_HEADLESS: "1" } });
  const st = ledgerStatus(w.book, next.chapter);
  if (r.status === 0 && st === "published") { console.log(`AUTO_PUBLISH_OK ${w.book} chapter=${next.chapter}`); acted++; }
  else console.log(`AUTO_PUBLISH_FAIL ${w.book} chapter=${next.chapter} exit=${r.status} ledger=${st}`);
}
console.log(`AUTO_PUBLISH_DONE acted=${acted} dry=${DRY}`);

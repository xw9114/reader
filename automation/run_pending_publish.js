#!/usr/bin/env node

const path = require("node:path");
const process = require("node:process");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === "publish") result.publish = true;
    else result[key] = argv[++index];
  }
  return result;
}

function readJson(file) {
  return JSON.parse(require("node:fs").readFileSync(file, "utf8"));
}

function selectPending(bookId, platform) {
  const booksRoot = path.join(ROOT, "serial", "books");
  const bookDirs = bookId
    ? [path.join(booksRoot, bookId)]
    : require("node:fs").readdirSync(booksRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(booksRoot, entry.name));
  const candidates = [];
  const seen = new Map();
  for (const bookDir of bookDirs) {
    const runs = path.join(bookDir, "runs");
    if (!require("node:fs").existsSync(runs)) continue;
    for (const name of require("node:fs").readdirSync(runs)) {
      const isNewFormat = /^\d{4}-\d{2}-\d{2}-chapter-\d{4}\.json$/.test(name);
      const isLegacyFormat = /^\d{4}-\d{2}-\d{2}\.json$/.test(name);
      if (!isNewFormat && !isLegacyFormat) continue;
      const file = path.join(runs, name);
      const record = readJson(file);
      const state = record.platforms?.[platform]?.status || "pending";
      const candidate = { bookId: path.basename(bookDir), chapter: record.chapter, date: name.slice(0, 10) };
      const key = `${candidate.bookId}:${candidate.chapter}`;
      const existing = seen.get(key);
      if (!existing || (isNewFormat && !existing.isNewFormat)) {
        seen.set(key, { ...candidate, isNewFormat, status: record.status, state });
      }
    }
  }
  candidates.push(...[...seen.values()]
    .filter(({ status, state }) => status === "published" && ["pending", "failed"].includes(state))
    .map(({ isNewFormat, status, state, ...rest }) => rest));
  // Fill earlier gaps before preparing later chapters for sequential publication.
  candidates.sort((a, b) => a.chapter - b.chapter || a.date.localeCompare(b.date) || a.bookId.localeCompare(b.bookId));
  return candidates[0];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.platform || !["fanqie", "qimao"].includes(args.platform)) {
    throw new Error("请传 --platform fanqie 或 qimao");
  }
  const selected = selectPending(args.bookId, args.platform);
  if (!selected) {
    console.log(JSON.stringify({ ok: true, status: "nothing_pending", platform: args.platform }, null, 2));
    return;
  }
  const script = path.join(__dirname, "publish_queue.js");
  const command = [script, "--platform", args.platform, "--book-id", selected.bookId, "--chapter", String(selected.chapter)];
  if (args.publish) command.push("--publish");
  if (args.url) command.push("--url", args.url);
  if (process.env.READER_HEADLESS === "1") command.push("--headless");
  const result = require("node:child_process").spawnSync(process.execPath, command, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  process.exitCode = result.status || 0;
}

module.exports = { selectPending };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`待发布任务失败：${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { selectPending };

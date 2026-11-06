#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const MIN_TARGET_CHAPTERS = 50;
const ROOT = path.resolve(__dirname, "..");

function readBookMetadata(bookId, root = ROOT) {
  const file = path.join(root, "serial", "books", bookId, "book.json");
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function classifyBook(bookId, root = ROOT) {
  const metadata = readBookMetadata(bookId, root);
  if (!metadata) return { eligible: false, reason: "book.json missing or invalid" };
  if (metadata.autoUpdate === false) return { eligible: false, reason: "autoUpdate=false" };
  const target = Number(metadata.targetChapters);
  if (!Number.isFinite(target)) return { eligible: false, reason: "targetChapters missing" };
  if (target < MIN_TARGET_CHAPTERS) {
    return { eligible: false, reason: `targetChapters=${target}<${MIN_TARGET_CHAPTERS}` };
  }
  return { eligible: true, targetChapters: target };
}

function filterWiredBooks(wired, root = ROOT) {
  const eligible = [];
  const skipped = [];
  for (const item of wired) {
    const result = classifyBook(item.book, root);
    if (result.eligible) eligible.push({ ...item, targetChapters: result.targetChapters });
    else skipped.push({ ...item, reason: result.reason });
  }
  return { eligible, skipped };
}

function printDailyQueue(wiredFile, root = ROOT) {
  const wired = JSON.parse(fs.readFileSync(wiredFile, "utf8"));
  const { eligible, skipped } = filterWiredBooks(wired, root);
  for (const item of skipped) console.error(`LONG_NOVEL_SKIP ${item.book} reason=${item.reason}`);
  for (const item of eligible) console.log(`${item.book}\t${item.platform}\t${item.url}`);
}

if (require.main === module) {
  const file = process.argv[2] || path.join(ROOT, "automation", "wired_books.json");
  try { printDailyQueue(file); }
  catch (error) { console.error(`LONG_NOVEL_FILTER_FAIL ${error.message}`); process.exitCode = 1; }
}

module.exports = { MIN_TARGET_CHAPTERS, readBookMetadata, classifyBook, filterWiredBooks };

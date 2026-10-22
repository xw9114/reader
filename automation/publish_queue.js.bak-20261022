#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PLATFORM_NAMES = { fanqie: "番茄", qimao: "七猫" };
const PLATFORM_HOSTS = {
  fanqie: /fanqienovel\.com|muyewx\.com/i,
  qimao: /qimao\.com/i,
};

function parseArgs(argv) {
  const result = { publish: false, dryRun: false, headless: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--publish") result.publish = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--headless") result.headless = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = argv[++index];
    }
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquirePublishLock(platform) {
  const lockDir = path.join(ROOT, ".runtime", "locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, `publish-${platform}.lock`);
  const staleAfterMs = Number(process.env.READER_LOCK_STALE_MS || 24 * 60 * 60 * 1000);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockFile, "wx");
      fs.writeFileSync(descriptor, JSON.stringify({
        pid: process.pid,
        platform,
        startedAt: new Date().toISOString(),
      }) + "\n", "utf8");
      return () => {
        try {
          fs.closeSync(descriptor);
        } catch {
          // The descriptor may already be closed after an interrupted run.
        }
        try {
          fs.unlinkSync(lockFile);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (error.code !== "EEXIST") throw error;
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      } catch {
        // A partially written or corrupt lock can only be reclaimed by age.
      }
      const age = Date.now() - fs.statSync(lockFile).mtimeMs;
      let ownerAlive = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 0 && owner.pid !== process.pid) {
        try {
          process.kill(owner.pid, 0);
          ownerAlive = true;
        } catch {
          ownerAlive = false;
        }
      }
      if (ownerAlive || age < staleAfterMs) {
        throw new Error(`平台发布任务已在运行：${platform}（锁文件：${lockFile}）`);
      }
      fs.unlinkSync(lockFile);
    }
  }
  throw new Error(`无法取得平台发布锁：${platform}`);
}

function findBook(bookId) {
  const booksRoot = path.join(ROOT, "serial", "books");
  const candidates = fs.readdirSync(booksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(booksRoot, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, "book.json")));
  const directory = candidates.find((candidate) => path.basename(candidate) === bookId);
  if (!directory) throw new Error(`找不到长篇目录：${bookId}`);
  return { directory, metadata: readJson(path.join(directory, "book.json")) };
}

function findChapter(book, number, allowMissingRun = false) {
  const published = path.join(book.directory, "published");
  const suffix = `chapter-${String(number).padStart(4, "0")}.md`;
  const matches = fs.readdirSync(published).filter((name) => name.endsWith(suffix));
  if (matches.length > 1) throw new Error(`章节 ${number} 存在多个日期文件`);
  const filename = matches[0];
  if (!filename) throw new Error(`找不到已构建章节：${number}`);
  const date = filename.slice(0, 10);
  const runFile = path.join(book.directory, "runs", `${date}.json`);
  if (!allowMissingRun && !fs.existsSync(runFile)) throw new Error(`找不到章节运行记录：${runFile}`);
  return { date, runFile, filename };
}

function loadChapter(bookId, chapterNumber, allowMissingRun = false) {
  const book = findBook(bookId);
  const chapter = findChapter(book, chapterNumber, allowMissingRun);
  const data = readJson(path.join(ROOT, "dist", "data.json"));
  const storyId = book.metadata.readerId || `serial-${bookId}`;
  const story = data.stories.find((item) => item.id === storyId);
  const content = story?.chapters?.find((item) => item.id === `chapter-${chapterNumber}`);
  if (!content) throw new Error(`dist/data.json 中找不到 ${storyId} 第${chapterNumber}章`);
  return { book, chapter, content };
}

function templateUrl(template, values) {
  return String(template).replace(/\{(bookId|chapter|storyId)\}/g, (_, key) => values[key]);
}

function assertPageReady(page, platform) {
  const url = page.url();
  if (!PLATFORM_HOSTS[platform].test(url) && !url.startsWith("file:")) {
    throw new Error(`${PLATFORM_NAMES[platform]}页面地址不符合预期：${url}`);
  }
}

async function detectBlockedPage(page) {
  const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 12000);
  if (/\/login(?:[/?#]|$)|\/signin(?:[/?#]|$)/i.test(page.url()) || /验证码|短信验证|安全验证|请先登录/.test(text)) {
    throw new Error("平台要求登录或验证码验证");
  }
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const locator = candidates.nth(index);
      if (await locator.isVisible()) return locator;
    }
  }
  return null;
}

async function fillTextControl(locator, value) {
  if (!locator) throw new Error("未识别输入控件");
  await locator.scrollIntoViewIfNeeded();
  if (await locator.getAttribute("contenteditable") !== null) {
    await locator.evaluate((element, text) => {
      element.focus();
      element.innerHTML = "";
      for (const paragraph of text.split(/\n{2,}/)) {
        const node = document.createElement("p");
        node.textContent = paragraph;
        element.append(node);
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  } else {
    await locator.fill(value);
  }
}

async function fillChapter(page, platform, chapter) {
  const title = await firstVisible(page, platform === "qimao"
    ? ["#chapter-title", "input[placeholder*=章节名称]", "input[placeholder*=章节标题]", "input[aria-label*=章节]", "input[name*=title]", "input:not([type=number]):not([inputmode=numeric])"]
    : ["#chapter-title", "input[placeholder*=章节标题]", "input[aria-label*=章节标题]", "input[name*=title]", "input:not([type=number]):not([inputmode=numeric])"]);
  const body = await firstVisible(page, platform === "qimao"
    ? [".chapter-con .edit-mask[contenteditable=true]", ".chapter-con [contenteditable=true]", "[contenteditable=true]"]
    : ["[contenteditable=true]:not([data-placeholder*=有话说]):not([id*=message])", ".chapter-editor[contenteditable=true]", "[contenteditable=true]"]);
  if (!title || !body) throw new Error("未识别章节标题框或正文编辑器");
  await fillTextControl(title, chapter.title);
  await fillTextControl(body, chapter.body);
}

async function clickSafeAction(page, publish) {
  const patterns = publish
    ? [/立即发布/, /发布章节/, /^发布$/]
    : [/保存草稿/, /存草稿/, /^保存$/, /保存章节/];
  for (const pattern of patterns) {
    const buttons = page.getByRole("button", { name: pattern });
    if (await buttons.count()) {
      const button = buttons.first();
      if (await button.isVisible()) {
        await button.click();
        return publish ? "published" : "draft_saved";
      }
    }
  }
  throw new Error(publish ? "未找到安全的发布按钮" : "未找到保存草稿按钮");
}

function updateLedger(runFile, platform, status, error) {
  const lockFile = `${runFile}.lock`;
  const staleAfterMs = Number(process.env.READER_LEDGER_LOCK_STALE_MS || 10 * 60 * 1000);
  let descriptor;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      descriptor = fs.openSync(lockFile, "wx");
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString() }) + "\n", "utf8");
      break;
    } catch (lockError) {
      if (lockError.code !== "EEXIST") throw lockError;
      let owner = null;
      let age = 0;
      try {
        owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        age = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        // A concurrent cleanup will be retried on the next iteration.
      }
      let ownerAlive = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 0 && owner.pid !== process.pid) {
        try {
          process.kill(owner.pid, 0);
          ownerAlive = true;
        } catch {
          ownerAlive = false;
        }
      }
      if (age >= staleAfterMs && !ownerAlive) {
        try {
          fs.unlinkSync(lockFile);
          continue;
        } catch (unlinkError) {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        }
      }
      sleepSync(25);
    }
  }
  if (descriptor === undefined) throw new Error(`运行记录正在被其他任务更新：${runFile}`);
  try {
    const record = readJson(runFile);
    const platforms = record.platforms || {
      fanqie: { status: "pending" },
      qimao: { status: "pending" },
    };
    platforms[platform] = {
      status,
      ...(error ? { error: String(error).slice(0, 500) } : {}),
      updatedAt: new Date().toISOString(),
    };
    record.platforms = platforms;
    writeJsonAtomic(runFile, record);
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lockFile);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = args.platform;
  const bookId = args.bookId;
  const chapterNumber = Number(args.chapter);
  if (!PLATFORM_NAMES[platform] || !bookId || !Number.isInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error("用法：node automation/publish_queue.js --platform fanqie|qimao --book-id <目录> --chapter <编号> [--url <地址>] [--publish]");
  }
  const template = args.url || process.env[`${platform.toUpperCase()}_CHAPTER_URL`];
  if (!template) throw new Error(`缺少章节地址，请传 --url 或设置 ${platform.toUpperCase()}_CHAPTER_URL`);
  const payload = loadChapter(bookId, chapterNumber, args.dryRun);
  const storyId = payload.book.metadata.readerId || `serial-${bookId}`;
  const url = templateUrl(template, { bookId, chapter: chapterNumber, storyId });
  const releaseLock = acquirePublishLock(platform);
  let context;
  let page;
  try {
    const profile = args.profile || process.env.READER_BROWSER_PROFILE || path.join(ROOT, ".runtime", "browser-profiles", platform);
    fs.mkdirSync(profile, { recursive: true });
    context = await chromium.launchPersistentContext(profile, {
      headless: args.headless,
      channel: process.env.READER_BROWSER_CHANNEL || undefined,
      viewport: { width: 1440, height: 1000 },
    });
    page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1000);
    assertPageReady(page, platform);
    await detectBlockedPage(page);
    await fillChapter(page, platform, payload.content);
    if (args.dryRun) {
      console.log(JSON.stringify({ ok: true, mode: "dry-run", platform, bookId, chapter: chapterNumber }, null, 2));
      return;
    }
    const status = await clickSafeAction(page, args.publish);
    updateLedger(payload.chapter.runFile, platform, status);
    console.log(JSON.stringify({ ok: true, mode: status, platform, bookId, chapter: chapterNumber }, null, 2));
  } catch (error) {
    const failureDir = path.join(ROOT, ".runtime", "automation-failures");
    fs.mkdirSync(failureDir, { recursive: true });
    const screenshot = path.join(failureDir, `${platform}-${bookId}-${chapterNumber}.png`);
    if (page) await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    if (!args.dryRun && fs.existsSync(payload.chapter.runFile)) updateLedger(payload.chapter.runFile, platform, "failed", error.message);
    throw new Error(`${error.message}（截图：${screenshot}）`);
  } finally {
    if (context) await context.close();
    releaseLock();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`发布任务失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  templateUrl,
  acquirePublishLock,
  normalizeChapterNumber: (value) => String(value).replace(/^第|章$/g, ""),
};

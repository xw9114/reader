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
  const runsDir = path.join(book.directory, "runs");
  // 新格式：一章一文件 runs/YYYY-MM-DD-chapter-NNNN.json（与 published 命名对称，不再受"一天一章"限制）；
  // 旧格式 runs/YYYY-MM-DD.json 在章节号对得上时继续兼容读取。
  const chapterRunFile = path.join(runsDir, `${date}-chapter-${String(number).padStart(4, "0")}.json`);
  const legacyRunFile = path.join(runsDir, `${date}.json`);
  let runFile = chapterRunFile;
  if (!fs.existsSync(chapterRunFile) && fs.existsSync(legacyRunFile)) {
    try {
      if (readJson(legacyRunFile).chapter === number) runFile = legacyRunFile;
    } catch {
      // 旧台账不可读时按新格式处理。
    }
  }
  if (!allowMissingRun && !fs.existsSync(runFile)) throw new Error(`找不到章节运行记录：${chapterRunFile}`);
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
    // 首选真实输入通道（点击→全选→删除→insertText）：DOM 注入（innerHTML 拼 <p>）
    // 在番茄新书编辑器上经常不被文档模型采纳，表现为标题在、正文 0 字的空壳草稿
    // （阴司临时工 30 章批量存稿实测，2026-10-22）。真实输入后回读编辑器文本
    // 长度校验采纳，未采纳才回退到旧的 DOM 注入。
    const page = locator.page();
    let adopted = false;
    try {
      await locator.click({ timeout: 10000 });
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Delete");
      await page.keyboard.insertText(value);
      for (let i = 0; i < 5 && !adopted; i += 1) {
        await page.waitForTimeout(1200);
        const now = await locator.evaluate((element) => (element.innerText || "").replace(/\s/g, "").length).catch(() => 0);
        const want = String(value).replace(/\s/g, "").length;
        adopted = want === 0 || now >= want * 0.9;
      }
    } catch (error) {
      adopted = false;
    }
    if (!adopted) {
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
    }
  } else {
    await locator.fill(value);
  }
}

function chineseNumeralToInt(text) {
  const digits = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let result = 0;
  let current = 0;
  for (const ch of text) {
    if (ch in digits) current = digits[ch];
    else if (ch === "十") { result += (current || 1) * 10; current = 0; }
    else if (ch === "百") { result += (current || 1) * 100; current = 0; }
    else return null;
  }
  return result + current;
}

function splitChapterTitle(title) {
  const match = String(title).match(/^\s*第\s*(\d+|[零一二三四五六七八九十百]+)\s*章[\s、：:．.]*(.+)$/);
  if (!match) return { number: null, title: String(title).trim() };
  const parsed = /^\d+$/.test(match[1]) ? match[1] : chineseNumeralToInt(match[1]);
  if (parsed === null || parsed === "") return { number: null, title: String(title).trim() };
  return { number: String(parsed), title: match[2].trim() };
}

async function dismissFanqieEditorOverlays(page) {
  // 新书首次打开编辑器会叠两层一次性浮层：平台规则弹窗（按钮「我知道了」）与
  // 新手引导卡片（带 1/3 步数标记，按钮「下一步」）。不关掉它们，填入的标题
  // 会被编辑器迟到的初始化清掉。引导的「下一步」与编辑器右上角同名按钮靠
  // 步数标记区分，只在引导卡片可见时才点。
  for (let round = 0; round < 10; round += 1) {
    let clicked = false;
    // 上次会话异常退出时，编辑器会先弹「有刚刚更新的草稿，是否继续编辑？」，
    // 不处理它编辑会话不初始化、填什么都不会被采纳（新书第1章三度失败的原因）。
    const resume = page.getByText("继续编辑", { exact: true });
    if (await resume.first().isVisible().catch(() => false)) {
      await resume.first().click().catch(() => {});
      await page.waitForTimeout(2500);
      clicked = true;
    }
    const ack = page.getByText("我知道了", { exact: true });
    if (await ack.first().isVisible().catch(() => false)) {
      await ack.first().click().catch(() => {});
      clicked = true;
    }
    if (!clicked) {
      const stepMark = page.locator("text=/^[1-3]\/3$/");
      if (await stepMark.first().isVisible().catch(() => false)) {
        const next = page.getByText("下一步", { exact: true });
        if (await next.last().isVisible().catch(() => false)) {
          await next.last().click().catch(() => {});
          clicked = true;
        }
      }
    }
    if (!clicked) break;
    await page.waitForTimeout(700);
  }
}

async function fillChapterFanqie(page, chapter) {
  // 番茄新版编辑器：标题拆为「章节序号」输入框 +「请输入标题」输入框，
  // 且没有保存草稿按钮，内容靠编辑器自动保存进草稿箱。
  await dismissFanqieEditorOverlays(page);
  const body = await firstVisible(page, ["[contenteditable=true]:not([data-placeholder*=有话说]):not([id*=message])", ".chapter-editor[contenteditable=true]", "[contenteditable=true]"]);
  const titleInput = await firstVisible(page, ["input[placeholder*=请输入标题]", "input[placeholder*=章节标题]"]);
  if (!titleInput || !body) throw new Error("未识别新版编辑器的标题框或正文编辑器");
  const { number, title } = splitChapterTitle(chapter.title);
  const locateNumberInput = async () => {
    const handle = await titleInput.evaluateHandle((element) => {
      const inputs = [...document.querySelectorAll("input")].filter((item) => item.offsetParent);
      const index = inputs.indexOf(element);
      return index > 0 ? inputs[index - 1] : null;
    });
    return handle.asElement();
  };
  if (number) {
    const numberInput = await locateNumberInput();
    if (!numberInput) throw new Error("未识别新版编辑器的章节序号框");
    await fillTextControl(numberInput, number);
  }
  await fillTextControl(titleInput, title);
  await fillTextControl(body, chapter.body);
  // 实测（2026-10-22）：编辑器打开后约 5 秒内会用异步加载的表单状态重置
  // 序号/标题输入框，填得太早会被清空（正文编辑器是另一套组件，不受影响）；
  // 约 20 秒后状态稳定。因此填完后等待并回读校验，被清就重填，最多 3 轮。
  for (let round = 0; round < 3; round += 1) {
    await page.waitForTimeout(6000);
    const titleNow = (await titleInput.inputValue().catch(() => "")).trim();
    let numberNow = "";
    if (number) {
      const current = await locateNumberInput();
      if (current) numberNow = (await current.inputValue().catch(() => "")).trim();
    }
    if (titleNow === title.trim() && (!number || numberNow === String(number).trim())) break;
    if (number) {
      const refill = await locateNumberInput();
      if (refill) await fillTextControl(refill, number);
    }
    await fillTextControl(titleInput, title);
  }
  // 正文采纳兜底：若编辑器文本远短于正文（填入未被采纳的空壳状态），重填一次。
  const bodyLen = await body.evaluate((element) => (element.innerText || "").replace(/\s/g, "").length).catch(() => 0);
  const wantLen = String(chapter.body || "").replace(/\s/g, "").length;
  if (wantLen > 0 && bodyLen < wantLen * 0.9) {
    await fillTextControl(body, chapter.body);
  }
}

async function confirmFanqieDraftSaved(page, chapter) {
  const { title } = splitChapterTitle(chapter.title);
  // 必须等到「已保存到云端」：仅本地「已保存」时草稿还不在服务器草稿箱里，
  // 且会话在同步前关闭会把正文丢掉（阴司第30章曾因此存成空壳草稿、标题在而正文不在）。
  const deadline = Date.now() + 120000;
  let cloudSaved = false;
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (/已保存到云端/.test(text)) { cloudSaved = true; break; }
    await page.waitForTimeout(2000);
  }
  if (!cloudSaved) throw new Error("等待草稿同步到云端超时");
  const match = page.url().match(/main\/writer\/(\d+)/);
  if (!match) return "draft_saved";
  const checkPage = await page.context().newPage();
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await checkPage.goto(`https://fanqienovel.com/main/writer/chapter-manage/${match[1]}?type=2`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await checkPage.waitForTimeout(4000);
      const text = await checkPage.locator("body").innerText().catch(() => "");
      if (text.includes(title)) return "draft_saved";
      await checkPage.waitForTimeout(3000);
    }
  } finally {
    await checkPage.close().catch(() => {});
  }
  throw new Error("未能在草稿箱中确认本章草稿已保存");
}

async function findFanqieDraftEditUrl(page, chapter) {
  const { title } = splitChapterTitle(chapter.title);
  const match = page.url().match(/main\/writer\/(\d+)/);
  if (!match) return null;
  const finder = await page.context().newPage();
  try {
    await finder.goto(`https://fanqienovel.com/main/writer/chapter-manage/${match[1]}?type=2`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await finder.waitForTimeout(4000);
    return await finder.evaluate((titleText) => {
      const rows = [...document.querySelectorAll("tr")];
      const row = rows.find((r) => r.innerText.includes(titleText));
      if (!row) return null;
      const anchor = [...row.querySelectorAll("a[href]")].find((a) => /\/publish\//.test(a.href));
      return anchor ? anchor.href : null;
    }, title);
  } finally {
    await finder.close().catch(() => {});
  }
}

async function publishFanqieChapter(page, chapter) {
  // 番茄新版发布流程（2026-10-22 实测）：草稿编辑页 → 下一步 → 错别字弹窗提交
  // → 内容检测（全面检测优先，额度不足时基础检测）→ 发布设置选 AI 声明 → 确认发布。
  const { title } = splitChapterTitle(chapter.title);
  let editUrl = await findFanqieDraftEditUrl(page, chapter);
  if (!editUrl) {
    await fillChapter(page, "fanqie", chapter);
    await confirmFanqieDraftSaved(page, chapter);
    editUrl = await findFanqieDraftEditUrl(page, chapter);
    if (!editUrl) throw new Error("草稿已保存但未找到草稿编辑地址，无法发布");
  }
  await page.goto(editUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4500);
  await page.getByRole("button", { name: /下一步/ }).first().click();
  let settingsSeen = false;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await page.waitForTimeout(3000);
    const text = await page.locator("body").innerText().catch(() => "");
    if (/发布设置/.test(text) && /确认发布/.test(text)) { settingsSeen = true; break; }
    const typoSubmit = page.getByRole("button", { name: /^提交$/ }).first();
    if ((await typoSubmit.count()) && (await typoSubmit.isVisible().catch(() => false))) { await typoSubmit.click(); continue; }
    const fullCheck = page.getByRole("button", { name: /全面检测/ }).first();
    if ((await fullCheck.count()) && (await fullCheck.isVisible().catch(() => false))) {
      const disabled = await fullCheck.evaluate((b) => b.disabled || b.classList.contains("arco-btn-disabled")).catch(() => false);
      if (!disabled) { await fullCheck.click(); continue; }
      const basicCheck = page.getByRole("button", { name: /仅基础检测/ }).first();
      if (await basicCheck.count()) { await basicCheck.click(); continue; }
    }
  }
  if (!settingsSeen) throw new Error("发布流程未进入发布设置");
  const dialog = page.locator("div.arco-modal, div[role=dialog]").filter({ hasText: "发布设置" }).last();
  const aiText = process.env.READER_AI_DECLARATION || "是";
  const aiRadio = dialog.locator("label.arco-radio").filter({ hasText: new RegExp(`^${aiText}$`) }).first();
  if ((await aiRadio.count()) === 0) throw new Error("发布设置中未找到 AI 声明选项");
  await aiRadio.click();
  await page.waitForTimeout(800);
  const aiChecked = await aiRadio.evaluate((el) => el.classList.contains("arco-radio-checked") || Boolean(el.querySelector("input") && el.querySelector("input").checked)).catch(() => false);
  if (!aiChecked) throw new Error("AI 声明未能选中，已中止发布");
  if (process.env.READER_PUBLISH_STOP_BEFORE_CONFIRM === "1") {
    await page.screenshot({ path: path.join(ROOT, ".runtime", "publish-stop-before-confirm.png"), fullPage: true }).catch(() => {});
    return "validated_before_confirm";
  }
  await dialog.getByRole("button", { name: /确认发布/ }).first().click();
  await page.waitForTimeout(8000);
  const bookMatch = editUrl.match(/main\/writer\/(\d+)/);
  await page.goto(`https://fanqienovel.com/main/writer/chapter-manage/${bookMatch[1]}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  const listText = await page.locator("body").innerText().catch(() => "");
  if (!listText.includes(title)) throw new Error("发布后未在章节列表中找到本章");
  const draftCheck = await page.context().newPage();
  try {
    await draftCheck.goto(`https://fanqienovel.com/main/writer/chapter-manage/${bookMatch[1]}?type=2`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await draftCheck.waitForTimeout(4000);
    const draftText = await draftCheck.locator("body").innerText().catch(() => "");
    if (draftText.includes(title)) throw new Error("发布后本章仍在草稿箱，状态不明确");
  } finally {
    await draftCheck.close().catch(() => {});
  }
  return "published";
}

async function fillChapter(page, platform, chapter) {
  if (platform === "fanqie") return fillChapterFanqie(page, chapter);
  const title = await firstVisible(page, ["#chapter-title", "input[placeholder*=章节名称]", "input[placeholder*=章节标题]", "input[aria-label*=章节]", "input[name*=title]", "input:not([type=number]):not([inputmode=numeric])"]);
  const body = await firstVisible(page, [".chapter-con .edit-mask[contenteditable=true]", ".chapter-con [contenteditable=true]", "[contenteditable=true]"]);
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
    let status;
    if (platform === "fanqie" && args.publish && !args.dryRun) {
      status = await publishFanqieChapter(page, payload.content);
    } else {
      await fillChapter(page, platform, payload.content);
      if (args.dryRun) {
        console.log(JSON.stringify({ ok: true, mode: "dry-run", platform, bookId, chapter: chapterNumber }, null, 2));
        return;
      }
      status = platform === "fanqie"
        ? await confirmFanqieDraftSaved(page, payload.content)
        : await clickSafeAction(page, args.publish);
    }
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
  splitChapterTitle,
  fillChapter,
  confirmFanqieDraftSaved,
  findFanqieDraftEditUrl,
  publishFanqieChapter,
  findChapter,
  loadChapter,
};

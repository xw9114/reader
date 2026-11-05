#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { chromium } = require("playwright");
const { classifyPublishResponse, recordPlatformLimit, activePlatformLimit } = require("./platform_limits");

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

async function dismissVersionConflict(page) {
  // 番茄编辑器在本地与云端草稿不一致时会弹「版本冲突提示」模态框
  // （2026-11-05 阴司第 13 章失败的直接原因：该框遮住一切指针事件，
  // 「全面检测」点 30 秒超时，整趟发布失败）。
  // 本地版本就是本趟刚校验过的源稿，选本地；选完后流程仍会回读正文校验，
  // 不一致会重填，不会把错版发出去。
  const keepLocal = page.getByText("继续编辑本地", { exact: true });
  if (await keepLocal.first().isVisible().catch(() => false)) {
    await keepLocal.first().click().catch(() => {});
    await page.waitForTimeout(2500);
    return true;
  }
  return false;
}

async function clickWithRetry(locator, label) {
  // 弹窗遮挡、动画未结束等瞬时状态会让单次 click 吃满 30 秒超时并抛错，
  // 直接杀死整趟发布。改成短超时多轮重试，轮间给遮挡消失留时间。
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await locator.click({ timeout: 10000 });
      return;
    } catch (error) {
      lastError = error;
      await locator.page().waitForTimeout(2500);
    }
  }
  throw new Error(`点击「${label}」多次失败（可能仍被弹窗遮挡）：${lastError ? String(lastError.message).split("\n")[0] : ""}`);
}

async function dismissFanqieEditorOverlays(page) {
  // 新书首次打开编辑器会叠两层一次性浮层：平台规则弹窗（按钮「我知道了」）与
  // 新手引导卡片（带 1/3 步数标记，按钮「下一步」）。不关掉它们，填入的标题
  // 会被编辑器迟到的初始化清掉。引导的「下一步」与编辑器右上角同名按钮靠
  // 步数标记区分，只在引导卡片可见时才点。
  for (let round = 0; round < 10; round += 1) {
    let clicked = false;
    // 版本冲突框也可能在编辑器打开时就挡着（见 dismissVersionConflict）。
    if (await dismissVersionConflict(page)) clicked = true;
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
  const actual = await body.evaluate(element => (element.innerText || "").replace(/\s/g, ""));
  const expected = String(chapter.body || "").replace(/\s/g, "");
  if (actual.normalize("NFC") !== expected.normalize("NFC")) throw new Error("编辑器正文与源稿不一致，已停止提交");
}

async function findFanqieChapterRow(page, chapter) {
  const { number, title } = splitChapterTitle(chapter.title);
  const seen = new Set();
  for (let index = 0; index < 100; index += 1) {
    const rows = await page.locator("tr").allInnerTexts();
    const fingerprint = JSON.stringify(rows);
    if (seen.has(fingerprint)) throw new Error("章节列表翻页未前进，状态不明确");
    seen.add(fingerprint);
    const match = await page.locator("tr").evaluateAll((elements, expected) => {
      const compact = text => String(text).replace(/\s/g, "").normalize("NFC");
      const found = elements.find(row => {
        const text = row.innerText || "";
        return compact(text).includes(compact(expected.title)) &&
          (!expected.number || new RegExp("第\\s*" + expected.number + "\\s*章").test(text));
      });
      if (!found) return null;
      const anchor = [...found.querySelectorAll("a[href]")].find(link => /\/publish\//.test(link.href));
      return { text: found.innerText, editUrl: anchor ? anchor.href : null };
    }, {number, title});
    if (match) return match;
    const next = page.locator(".arco-pagination-item-next:not(.arco-pagination-item-disabled)").first();
    if (!(await next.count())) return null;
    await next.click();
    await page.waitForFunction(previous => JSON.stringify([...document.querySelectorAll("tr")].map(row => row.innerText)) !== previous,
                               fingerprint, {timeout: 15000});
    await page.waitForTimeout(500);
  }
  throw new Error("章节列表超过安全翻页上限，保留现场");
}

async function confirmFanqieDraftSaved(page, chapter) {
  const { title } = splitChapterTitle(chapter.title);
  // 必须等到「已保存到云端」：仅本地「已保存」时草稿还不在服务器草稿箱里，
  // 且会话在同步前关闭会把正文丢掉（阴司第30章曾因此存成空壳草稿、标题在而正文不在）。
  const deadline = Date.now() + 120000;
  let cloudSaved = false;
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (/已保存到云端/.test(text.replace(/\s/g, ""))) { cloudSaved = true; break; }
    await page.waitForTimeout(2000);
  }
  if (!cloudSaved) {
    // 120 秒没等到「已保存到云端」不一定是没存上（2026-11-03 阴司第 12 章
    // 就是指示器没刷出来）：不直接判失败，改走下面的草稿箱实证——
    // 草稿箱里找得到、打开正文一致，才算存上；找不到再判失败。
    console.log("未等到云端保存指示，改用草稿箱实证确认");
  }
  const match = page.url().match(/main\/writer\/(\d+)/);
  if (!match) throw new Error("无法识别书籍ID，不能确认草稿云端状态");
  const checkPage = await page.context().newPage();
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await checkPage.goto(`https://fanqienovel.com/main/writer/chapter-manage/${match[1]}?type=2`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await checkPage.waitForTimeout(4000);
      const row = await findFanqieChapterRow(checkPage, chapter);
      if (row && row.editUrl) {
        await checkPage.goto(row.editUrl, {waitUntil:"domcontentloaded",timeout:60000});
        await checkPage.waitForTimeout(4500);
        const editor = await firstVisible(checkPage, ["[contenteditable=true]:not([data-placeholder*=有话说]):not([id*=message])", ".chapter-editor[contenteditable=true]", "[contenteditable=true]"]);
        if (!editor) throw new Error("无法回读云端草稿正文");
        const saved = await editor.evaluate(element => (element.innerText || "").replace(/\s/g, ""));
        if (saved.normalize("NFC") !== String(chapter.body || "").replace(/\s/g, "").normalize("NFC")) {
          throw new Error("云端草稿正文与源稿不一致，停止发布");
        }
        return "draft_saved";
      }
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
    await finder.waitForTimeout(3500);
    const row = await findFanqieChapterRow(finder, chapter);
    return row ? row.editUrl : null;
  } finally {
    await finder.close().catch(() => {});
  }
}

async function publishFanqieChapter(page, chapter) {
  // 番茄新版发布流程（2026-10-22 实测）：草稿编辑页 → 下一步 → 错别字弹窗提交
  // → 内容检测（全面检测优先，额度不足时基础检测）→ 发布设置选 AI 声明 → 确认发布。
  const { title } = splitChapterTitle(chapter.title);
  // 防重发守门：若本章其实已在已发布列表里（上一趟提交成功、但列表校验
  // 没刷出来造成的假失败），直接认 published，不再提交一次。
  try {
    const guardMatch = page.url().match(/main\/writer\/(\d+)/);
    if (guardMatch) {
      const guardPage = await page.context().newPage();
      try {
        await guardPage.goto(`https://fanqienovel.com/main/writer/chapter-manage/${guardMatch[1]}`, { waitUntil: "domcontentloaded", timeout: 60000 });
        await guardPage.waitForTimeout(4000);
        if (await findFanqieChapterRow(guardPage, chapter)) return "published";
      } finally {
        await guardPage.close().catch(() => {});
      }
    }
  } catch {
    // 守门查不到（网络、翻页异常）不阻断正常发布，继续走原流程。
  }
  let editUrl = await findFanqieDraftEditUrl(page, chapter);
  if (!editUrl) {
    await fillChapter(page, "fanqie", chapter);
    await confirmFanqieDraftSaved(page, chapter);
    editUrl = await findFanqieDraftEditUrl(page, chapter);
    if (!editUrl) throw new Error("草稿已保存但未找到草稿编辑地址，无法发布");
  }
  await page.goto(editUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4500);
  await dismissFanqieEditorOverlays(page);
  const bodyEditor = await firstVisible(page, ["[contenteditable=true]:not([data-placeholder*=有话说]):not([id*=message])", ".chapter-editor[contenteditable=true]", "[contenteditable=true]"]);
  const currentBody = bodyEditor
    ? await bodyEditor.evaluate((element) => (element.innerText || "").replace(/\s/g, "")).catch(() => "")
    : "";
  const targetBody = String(chapter.body || "").replace(/\s/g, "");
  if (currentBody.normalize("NFC") !== targetBody.normalize("NFC")) {
    await fillChapter(page, "fanqie", chapter);
  }
  await confirmFanqieDraftSaved(page, chapter);
  await dismissVersionConflict(page);
  await clickWithRetry(page.getByRole("button", { name: /下一步/ }).first(), "下一步");
  let settingsSeen = false;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await page.waitForTimeout(3000);
    // 版本冲突框可能在流程中途才弹出来（编辑器自动保存与云端打架），
    // 每轮先清它，否则后面的按钮一样点不下去。
    await dismissVersionConflict(page);
    const text = await page.locator("body").innerText().catch(() => "");
    if (/发布设置/.test(text) && /确认发布/.test(text)) { settingsSeen = true; break; }
    const typoSubmit = page.getByRole("button", { name: /^提交$/ }).first();
    if ((await typoSubmit.count()) && (await typoSubmit.isVisible().catch(() => false))) { await clickWithRetry(typoSubmit, "提交"); continue; }
    const fullCheck = page.getByRole("button", { name: /全面检测/ }).first();
    if ((await fullCheck.count()) && (await fullCheck.isVisible().catch(() => false))) {
      const disabled = await fullCheck.evaluate((b) => b.disabled || b.classList.contains("arco-btn-disabled")).catch(() => false);
      if (!disabled) { await clickWithRetry(fullCheck, "全面检测"); continue; }
      const basicCheck = page.getByRole("button", { name: /仅基础检测/ }).first();
      if (await basicCheck.count()) { await clickWithRetry(basicCheck, "仅基础检测"); continue; }
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
  await submitFanqiePublish(page, dialog.getByRole("button", { name: /确认发布/ }).first());
  try {
  await page.waitForTimeout(8000);
  const bookMatch = editUrl.match(/main\/writer\/(\d+)/);
  // 发布接口已接受不等于列表立刻可见：2026-11-02 大荒第 4 章、2026-11-04
  // 面光第 8 章都是提交成功但列表一次没刷出来，导致误判失败、次日重发。
  // 改成最长约 5 分钟轮询，列表滞后不再算失败。
  let publishedRow = null;
  for (let round = 0; round < 12 && !publishedRow; round += 1) {
    await page.goto(`https://fanqienovel.com/main/writer/chapter-manage/${bookMatch[1]}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    publishedRow = await findFanqieChapterRow(page, chapter).catch(() => null);
    if (!publishedRow) await page.waitForTimeout(20000);
  }
  if (!publishedRow) throw new Error("发布后未在章节列表中找到本章");
  const draftCheck = await page.context().newPage();
  try {
    // 草稿被消费也可能有滞后，同样轮询 3 次再定性，避免把已发布判成状态不明。
    let draftRow = null;
    for (let round = 0; round < 3; round += 1) {
      await draftCheck.goto(`https://fanqienovel.com/main/writer/chapter-manage/${bookMatch[1]}?type=2`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await draftCheck.waitForTimeout(4000);
      draftRow = await findFanqieChapterRow(draftCheck, chapter).catch(() => null);
      if (!draftRow) break;
      await draftCheck.waitForTimeout(10000);
    }
    if (draftRow) throw new Error("发布后本章仍在草稿箱，状态不明确");
  } finally {
    await draftCheck.close().catch(() => {});
  }
  return "published";
  } catch (error) {
    error.platformOutcome = { status: "publication_unknown", message: error.message };
    throw error;
  }
}

async function submitFanqiePublish(page, button) {
  // Subscribe before clicking: an HTTP 200 response can still reject publication.
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return /(^|\.)fanqienovel\.com$/.test(url.hostname) &&
      url.pathname === "/api/author/publish_article/v0/" &&
      response.request().method() === "POST";
  }, { timeout: 30000 }).catch(() => null);
  try {
    await button.click();
  } catch (error) {
    error.platformOutcome = { status: "publication_unknown", message: error.message };
    throw error;
  }
  const response = await responsePromise;
  if (!response) {
    const error = new Error("未收到发布接口确认，结果不明确；保留现场，禁止盲目重复提交");
    error.platformOutcome = { status: "publication_unknown", message: error.message };
    throw error;
  }
  const payload = await response.json().catch(() => null);
  if (!payload || payload.code === undefined || response.status() >= 500) {
    const error = new Error("发布接口响应不可确认；保留现场，禁止盲目重复提交");
    error.platformOutcome = { status: "publication_unknown", message: error.message };
    throw error;
  }
  const outcome = classifyPublishResponse(payload, response.status());
  if (outcome.status === "accepted") return outcome;
  const error = new Error(outcome.message);
  error.platformOutcome = outcome;
  throw error;
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

function updateLedger(runFile, platform, status, error, details = {}) {
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
      ...details,
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
    if (args.publish && !args.dryRun) {
      const limit = activePlatformLimit(platform);
      if (limit) {
        console.log(JSON.stringify({ ok: true, mode: "waiting_platform_limit", platform, ...limit }));
        return;
      }
    }
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
      if (platform === "fanqie" && !args.dryRun) {
        const existingDraftUrl = await findFanqieDraftEditUrl(page, payload.content);
        if (existingDraftUrl) {
          await page.goto(existingDraftUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.waitForTimeout(3000);
        }
      }
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
    const outcome = error.platformOutcome;
    if (outcome?.status === "waiting_platform_limit") recordPlatformLimit(platform, outcome);
    if (!args.dryRun && fs.existsSync(payload.chapter.runFile)) {
      updateLedger(payload.chapter.runFile, platform, outcome?.status || "failed", error.message,
        outcome ? { platformCode: outcome.code, retryAfter: outcome.retryAfter,
                    retryPolicy: outcome.retryPolicy } : {});
    }
    if (outcome?.status === "waiting_platform_limit") {
      console.log(JSON.stringify({ ok: true, mode: outcome.status, platform, bookId,
        chapter: chapterNumber, ...outcome }));
      return;
    }
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
  dismissVersionConflict,
  clickWithRetry,
  findFanqieDraftEditUrl,
  findFanqieChapterRow,
  publishFanqieChapter,
  submitFanqiePublish,
  updateLedger,
  findChapter,
  loadChapter,
};

#!/usr/bin/env node
// 番茄一键建书：控制台「接入并建书」调用。
// 用法: node automation/create_book_fanqie.js --book <仓库书目> [--title <平台短书名>] [--protagonist <主角>] [--dry]
// 行为: 作品管理 → 创建新书 → 创建书本 → 填表(书名/频道/主分类/标签/主角/简介/封面) → 提交 →
//       捕获新书 ID 并追加到 automation/wired_books.json（接入每日队列）。
// 退出码: 0 成功(或 --dry 填表完成) / 2 今日建书额度已用完 / 3 某步未验证(看日志+截图) / 4 前置条件不满足。
// 截图与日志: 控制台任务日志即 stdout; 截图存 /root/control-panel/logs/create-<book>-*.png。
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { resolveCreateMetadata, missingCreateFields } = require("./book_create_metadata");

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BOOK = arg("--book");
const DRY = args.includes("--dry");
const ROOT = "/root/reader";
const SHOT = (n) => `/root/control-panel/logs/create-${BOOK}-${n}.png`;
const log = (...a) => console.log(new Date().toISOString(), ...a);

function die(code, msg) { console.error("CREATE_FAIL", code, msg); process.exit(code); }
if (!BOOK) die(4, "missing --book");

const bookDir = path.join(ROOT, "serial", "books", BOOK);
const meta = JSON.parse(fs.readFileSync(path.join(bookDir, "book.json"), "utf8"));
const cfgFile = path.join(ROOT, "automation", "create_books.json");
const cfgAll = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
const cfg = resolveCreateMetadata(meta, cfgAll[BOOK]);
const title = arg("--title", meta.title);
const protagonist = arg("--protagonist", cfg.protagonist || "");
const synopsis = arg("--synopsis", cfg.synopsis);
const audience = cfg.audience;
const categories = cfg.categories || [];
const tags = cfg.tags || [];
const missing = missingCreateFields({ ...cfg, protagonist: protagonist.trim(), synopsis: synopsis.trim() });
if (missing.length) die(4, `建书资料未完整：${missing.join("、")}`);
if ([...title].length > 15) die(4, `书名「${title}」共 ${[...title].length} 字，超过番茄 15 字上限，请在控制台填写平台短书名`);
let cover = null;
for (const ext of ["jpg", "png", "jpeg"]) {
  const c = path.join(ROOT, "covers", `${meta.readerId}.${ext}`);
  if (fs.existsSync(c)) { cover = c; break; }
}
if (!cover) die(4, `封面缺失（covers/${meta.readerId}.jpg|png）`);
log("建书参数:", JSON.stringify({ BOOK, title, protagonist, audience, categories, tags, cover, DRY }));

(async () => {
  const browser = await chromium.launchPersistentContext(
    path.join(ROOT, ".runtime", "browser-profiles", "fanqie"),
    { headless: true, viewport: { width: 1440, height: 1100 } }
  );
  const page = browser.pages()[0] || (await browser.newPage());
  const shot = async (n) => { await page.screenshot({ path: SHOT(n), fullPage: true }).catch(() => {}); };
  try {
    await page.goto("https://fanqienovel.com/main/writer/book-manage", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    if (/login|passport/.test(page.url())) die(3, "番茄登录已失效，需要在 VPS 浏览器重新登录");
    await page.locator("text=创建新书").first().click();
    await page.waitForTimeout(1500);
    let freqHit = null;
    page.on("response", async (res) => {
      if (res.url().includes("check_frequency")) {
        try { const j = await res.json(); if (j && j.data && j.data.hit_create_book) freqHit = j.data.hit_create_book_message || "创建作品数超出每日上限"; } catch (e) { /* ignore */ }
      }
    });
    const item = page.locator(".write-button-dropdown-item").filter({ hasText: "创建书本" }).first();
    await item.click();
    // 等额度检查结果或表单出现；两者都没有 = 被拦下
    let formReady = false;
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(1000);
      if (freqHit) break;
      formReady = await page.evaluate(() => document.querySelectorAll(".arco-form-item").length > 0);
      if (formReady) break;
    }
    if (freqHit) { await shot("limit"); die(2, `平台提示：${freqHit} — 明天再点这本书的建书按钮`); }
    if (!formReady) { await shot("blocked"); die(2, "点了创建书本但没进入建书表单（多半是今日建书额度已用完），看截图 create-" + BOOK + "-blocked.png"); }
    const formDump = await page.evaluate(() => {
      const vis = (el) => !!(el.offsetWidth || el.offsetHeight);
      const out = [];
      document.querySelectorAll(".arco-form-item").forEach((el) => {
        if (!vis(el)) return;
        const label = (el.querySelector(".arco-form-item-label")?.innerText || "").trim();
        const ph = el.querySelector("input,textarea")?.placeholder || "";
        const ctrl = (el.querySelector(".arco-form-item-control")?.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
        out.push({ label, ph, ctrl });
      });
      return out;
    });
    log("表单结构:", JSON.stringify(formDump));
    await shot("form");

    // 2026-10-23 fix1: 实测番茄建书表单所有 .arco-form-item-label 均为空字符串（见 2026-10-23 12:37 失败日志的表单结构转储），
    // 改为按 input/textarea 的 placeholder 属性与控件可见文本定位，不再依赖 label 文本。
    const itemByText = (re) => page.locator(".arco-form-item").filter({ hasText: re }).first();
    const formItems = page.locator(".arco-form-item");
    const readTagItem = formItems.nth(3);    // 阅读标签（内含主分类单选）
    const contentTagItem = formItems.nth(4); // 内容标签
    const clickChip = async (text) => {
      const loc = page.getByText(text, { exact: true });
      const n = await loc.count();
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); return true; }
      }
      return false;
    };
    const closePicker = async () => { await page.keyboard.press("Escape").catch(() => {}); await page.mouse.click(100, 100).catch(() => {}); await page.waitForTimeout(500); };
    // 标签类弹窗（阅读标签/内容标签）必须点「确认」才会把已选 chip 提交到表单，Escape/点外部会丢弃选择
    const confirmPicker = async (title) => {
      const modal = page.locator(".arco-modal").filter({ hasText: title }).first();
      const btn = modal.locator("button, [class*=btn]").filter({ hasText: /确认/ }).first();
      if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(900); return true; }
      await closePicker();
      return false;
    };

    // fix1b: 表单打开即弹「签约模式说明」模态框，会拦截后续所有点击，先点「知道了」关掉
    const knowBtn = page.locator(".arco-modal").filter({ hasText: "签约模式说明" }).locator("button, [class*=btn]").filter({ hasText: /知道了/ }).first();
    if (await knowBtn.count()) { await knowBtn.click().catch(() => {}); await page.waitForTimeout(800); log("已关闭签约模式说明弹窗"); }

    // 书名（placeholder=「请输入作品名称」）
    const titleInput = page.locator('input[placeholder*="作品名称"]').first();
    await titleInput.fill(title);
    log("书名已填:", await titleInput.inputValue());

    // 签约模式（必填、默认未选）：选「连载模式」
    const modeItem = itemByText(/连载模式/);
    if (await modeItem.count()) {
      await modeItem.locator("text=连载模式").first().click().catch(() => {});
      await page.waitForTimeout(400);
      log("签约模式已选: 连载模式");
    } else { log("未找到签约模式项，跳过"); }

    // 频道/目标读者
    const audItem = itemByText(/男频/); // 频道项控件文本为「男频 女频」
    if (await audItem.count()) {
      await audItem.locator(`text=${audience}`).first().click().catch(() => {});
      await page.waitForTimeout(400);
      const audOk = await page.evaluate((a) => [...document.querySelectorAll(".arco-radio")].some((el) => (el.innerText || "").trim() === a && !!((el.querySelector("input") || {}).checked)), audience);
      log("频道已选:", audience, "verified=", audOk);
    } else { log("未找到频道项，跳过"); }

    // 主分类：在「阅读标签」选择器（.category-choose-list）中单选第一个命中的候选
    let catOk = false;
    if (await readTagItem.count()) {
      await readTagItem.locator(".arco-form-item-control").first().click().catch(() => {});
      await page.waitForTimeout(1500);
      const options = await page.evaluate(() => {
        const root = document.querySelector(".category-choose-list");
        return root ? [...root.querySelectorAll("*")].filter((e) => e.children.length === 0).map((e) => (e.innerText || "").trim()).filter(Boolean) : [];
      });
      log("阅读标签可选项:", JSON.stringify([...new Set(options)].slice(0, 60)));
      let chosenCand = null;
      for (const cand of categories) {
        if (options.includes(cand) && (await clickChip(cand))) { chosenCand = cand; break; }
      }
      await page.waitForTimeout(500);
      await confirmPicker("阅读标签");
      if (chosenCand) {
        const ctrl = await readTagItem.evaluate((el) => (el.querySelector(".arco-form-item-control")?.innerText || "").trim()).catch(() => "");
        if (ctrl.includes(chosenCand)) { catOk = true; log("主分类已选:", chosenCand); }
        else { log("主分类确认后控件未显示所选:", chosenCand, "| 控件:", ctrl.slice(0, 60)); }
      }
    }
    if (!catOk) { await shot("category"); die(3, `主分类未匹配成功（候选 ${categories.join("/")}），看截图 create-${BOOK}-category.png`); }

    // 内容标签：弹窗内用搜索框逐个定位 chip 点选，最后点「确认」提交（尽力而为，单个未匹配不中断）
    if (tags.length && (await contentTagItem.count())) {
      await contentTagItem.locator(".arco-form-item-control").first().click().catch(() => {});
      await page.waitForTimeout(1500);
      const tagSearch = page.locator('.arco-modal input[placeholder*="搜索标签"]').first();
      for (const t of tags.slice(0, 5)) {
        let hit = false;
        if (await tagSearch.count()) {
          await tagSearch.fill(t).catch(() => {});
          await page.waitForTimeout(800);
          hit = await clickChip(t);
          await tagSearch.fill("").catch(() => {});
          await page.waitForTimeout(300);
        }
        if (!hit) hit = await clickChip(t);
        log(hit ? "内容标签已点选:" : "内容标签未匹配:", t);
        await page.waitForTimeout(300);
      }
      await confirmPicker("内容标签");
      const tagCtrl = await contentTagItem.evaluate((el) => (el.querySelector(".arco-form-item-control")?.innerText || "").trim().replace(/\s+/g, " ").slice(0, 120)).catch(() => "");
      log("内容标签现状:", tagCtrl);
    } else { log("未找到内容标签项，跳过标签"); }

    // 主角
    if (protagonist) {
      const heroInput = page.locator('input[placeholder*="主角名"]').first();
      if (await heroInput.count()) {
        await heroInput.fill(protagonist);
        if ((await heroInput.inputValue()).trim() !== protagonist.trim()) throw new Error("主角名填入校验失败");
        log("主角已填:", protagonist);
      } else { throw new Error("未找到主角名输入框，已停止建书"); }
    }

    // 简介
    const synTa = page.locator('textarea[placeholder*="作品简介"]').first();
    if (await synTa.count()) {
      await synTa.fill(synopsis.trim());
      if ((await synTa.inputValue()).trim() !== synopsis.trim()) throw new Error("简介填入校验失败");
      log("简介已填，字数:", (await synTa.inputValue()).length);
    } else { throw new Error("未找到简介输入框，已停止建书"); }

    // 封面：新版需先点「选择封面」打开弹窗，弹窗内才有 file input，选完文件点「确定」生效
    let fileInput = page.locator('input[type="file"]').first();
    if (!(await fileInput.count())) {
      const coverBtn = page.locator("text=选择封面").first();
      if (await coverBtn.count()) { await coverBtn.click().catch(() => {}); await page.waitForTimeout(1500); fileInput = page.locator('input[type="file"]').first(); }
    }
    if (await fileInput.count()) {
      await fileInput.setInputFiles(cover);
      await page.waitForTimeout(2500);
      const okBtn = page.locator(".arco-modal button, .arco-modal [class*=btn]").filter({ hasText: /确定/ }).first();
      if (await okBtn.count()) { await okBtn.click().catch(() => {}); await page.waitForTimeout(1500); }
      log("封面已上传:", cover);
    } else { log("未找到封面上传控件"); }

    // AI 声明（如表单有）
    const aiItem = itemByText(/AI|人工智能|生成内容/);
    if (await aiItem.count()) {
      await aiItem.locator("text=是").first().click().catch(() => {});
      log("AI 声明已尝试选「是」");
    }

    await shot("filled");
    if (DRY) { console.log("DRY_DONE 已填表未提交"); await browser.close(); process.exit(0); }

    // 提交
    // fix2 (2026-10-23): 13:14 实跑 CREATE_FAIL——与 /创建|提交|立即发布|确定/ 匹配的 primary 按钮有两个：
    // 表单底部可见的「立即创建」(1212,797 96x36) 与封面弹窗内隐藏的「确定」(0x0, offsetParent=null)，
    // 原 .last() 命中隐藏按钮，click 等可见性 30s 超时。改为先精确匹配「立即创建」，否则在原正则候选里
    // 取第一个可见+可用的；点击前 scrollIntoViewIfNeeded，其余提交后流程（确认弹窗/ID 捕获/接入队列）不变。
    let submit = page.locator("button").filter({ hasText: /^立即创建$/ }).first();
    if (!(await submit.count()) || !(await submit.isVisible().catch(() => false))) {
      const cands = page.locator("button").filter({ hasText: /创建|提交|立即发布|确定/ });
      submit = null;
      for (let i = 0; i < (await cands.count()); i++) {
        const el = cands.nth(i);
        if ((await el.isVisible().catch(() => false)) && (await el.isEnabled().catch(() => false))) { submit = el; break; }
      }
    }
    if (!submit) { await shot("nosubmit"); die(3, "未找到可见可用的提交按钮，看截图 create-" + BOOK + "-nosubmit.png"); }
    log("提交按钮:", (await submit.innerText().catch(() => "")).trim());
    await submit.scrollIntoViewIfNeeded().catch(() => {});
    await submit.click();
    await page.waitForTimeout(2500);
    const confirm = page.locator(".arco-modal button, [class*=modal] button").filter({ hasText: /确认|确定|创建/ }).first();
    if (await confirm.count()) { await confirm.click().catch(() => {}); await page.waitForTimeout(2500); }
    await shot("submitted");

    // 成功判定：URL 出现 book-info/<id>，或作品列表出现书名
    let newId = null;
    for (let i = 0; i < 10 && !newId; i++) {
      const m = page.url().match(/book-info\/(\d+)/);
      if (m) { newId = m[1]; break; }
      await page.waitForTimeout(3000);
    }
    if (!newId) {
      await page.goto("https://fanqienovel.com/main/writer/book-manage", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(4000);
      newId = await page.evaluate((t) => {
        const links = [...document.querySelectorAll("a")];
        const hit = links.find((a) => (a.href || "").includes("chapter-manage") && (a.closest("div")?.parentElement?.innerText || "").includes(t));
        const m = hit && hit.href.match(/chapter-manage\/(\d+)/);
        return m ? m[1] : null;
      }, title);
    }
    if (!newId) { await shot("unverified"); die(3, "提交后未确认新书 ID，看截图 create-" + BOOK + "-unverified.png，可能卡在校验或审核提示"); }
    log("新书 ID:", newId);

    // 接入队列
    const wiredPath = path.join(ROOT, "automation", "wired_books.json");
    const wired = JSON.parse(fs.readFileSync(wiredPath, "utf8"));
    if (!wired.some((w) => w.book === BOOK)) {
      wired.push({ book: BOOK, platform: "fanqie", url: `https://fanqienovel.com/main/writer/${newId}/publish/?enter_from=newchapter_1` });
      fs.writeFileSync(wiredPath, JSON.stringify(wired, null, 2) + "\n");
    }
    console.log(`CREATE_OK book=${BOOK} id=${newId} url=https://fanqienovel.com/main/writer/book-info/${newId}?type=1`);
    await browser.close();
    process.exit(0);
  } catch (e) {
    await shot("error").catch(() => {});
    console.error("CREATE_FAIL 3", e.message);
    await browser.close().catch(() => {});
    process.exit(3);
  }
})();

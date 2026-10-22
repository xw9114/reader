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
const cfgAll = JSON.parse(fs.readFileSync(path.join(ROOT, "automation", "create_books.json"), "utf8"));
const cfg = cfgAll[BOOK] || {};
const title = arg("--title", meta.title);
const protagonist = arg("--protagonist", cfg.protagonist || "");
const audience = cfg.audience || "男频";
const categories = cfg.categories || [];
const tags = cfg.tags || [];
if ([...title].length > 15) die(4, `书名「${title}」共 ${[...title].length} 字，超过番茄 15 字上限，请在控制台填写平台短书名`);
let cover = null;
for (const ext of ["jpg", "png", "jpeg"]) {
  const c = path.join(ROOT, "covers", `${meta.readerId}.${ext}`);
  if (fs.existsSync(c)) { cover = c; break; }
}
if (!cover) die(4, `封面缺失（covers/${meta.readerId}.jpg|png）`);
if (!meta.synopsis) die(4, "book.json 缺简介");
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
    const item = page.locator(".write-button-dropdown-item").filter({ hasText: "创建书本" }).first();
    await item.click();
    await page.waitForTimeout(4000);
    const toast = await page.evaluate(() => {
      const els = document.querySelectorAll(".arco-message, [class*=message], [class*=toast]");
      return [...els].map((e) => (e.innerText || "").trim()).filter(Boolean).join(" ");
    });
    if (/上限|频繁/.test(toast) || page.url().includes("book-manage") && /上限/.test(await page.evaluate(() => document.body.innerText.slice(0, 2000)))) {
      await shot("limit");
      die(2, "平台提示今日建书额度已用完（创建作品数超出每日上限），明天再点这本书的建书按钮");
    }
    // 等待表单出现
    await page.waitForFunction(() => document.querySelectorAll("input,textarea").length >= 3, { timeout: 20000 }).catch(() => {});
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

    const itemByLabel = (re) => page.locator(".arco-form-item").filter({ has: page.locator(".arco-form-item-label", { hasText: re }) }).first();

    // 书名
    const titleInput = itemByLabel(/书名|作品名称/).locator("input").first();
    await titleInput.fill(title);
    log("书名已填:", await titleInput.inputValue());

    // 频道/目标读者
    const audItem = itemByLabel(/目标读者|频道|作品频道/);
    if (await audItem.count()) {
      await audItem.locator(`text=${audience}`).first().click().catch(() => {});
      log("频道已选:", audience);
    } else { log("未找到频道项，跳过"); }

    // 主分类
    let catOk = false;
    const catItem = itemByLabel(/主分类|作品分类|分类/);
    if (await catItem.count()) {
      await catItem.locator(".arco-select, [class*=select]").first().click().catch(async () => { await catItem.locator("input").first().click().catch(() => {}); });
      await page.waitForTimeout(1200);
      const options = await page.evaluate(() => [...document.querySelectorAll(".arco-select-option, [class*=option]")].map((e) => (e.innerText || "").trim()).filter(Boolean));
      log("分类可选项:", JSON.stringify(options.slice(0, 40)));
      for (const cand of categories) {
        const hit = options.find((o) => o === cand || o.includes(cand));
        if (hit) {
          await page.locator(".arco-select-option, [class*=option]").filter({ hasText: hit }).first().click();
          await page.waitForTimeout(600);
          catOk = true;
          log("主分类已选:", hit);
          break;
        }
      }
    }
    if (!catOk) { await shot("category"); die(3, `主分类未匹配成功（候选 ${categories.join("/")}），看截图 create-${BOOK}-category.png`); }

    // 标签：逐个输入并回车/点建议
    for (const t of tags.slice(0, 5)) {
      const tagItem = itemByLabel(/标签/);
      if (!(await tagItem.count())) { log("未找到标签项，跳过标签"); break; }
      const inp = tagItem.locator("input").first();
      if (!(await inp.count())) break;
      await inp.click().catch(() => {});
      await inp.fill(t).catch(() => {});
      await page.waitForTimeout(700);
      const sug = page.locator(".arco-select-option, [class*=suggest], [class*=dropdown] li").filter({ hasText: t }).first();
      if (await sug.count()) await sug.click().catch(() => {});
      else await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      log("标签已尝试:", t);
    }

    // 主角
    if (protagonist) {
      const heroItem = itemByLabel(/主角|主人公|角色名/);
      if (await heroItem.count()) {
        const inp = heroItem.locator("input").first();
        await inp.fill(protagonist).catch(() => {});
        log("主角已填:", protagonist);
      } else { log("未找到主角项，跳过"); }
    }

    // 简介
    const synItem = itemByLabel(/简介|内容简介/);
    if (await synItem.count()) {
      const ta = synItem.locator("textarea").first();
      await ta.fill(meta.synopsis.trim()).catch(() => {});
      log("简介已填，字数:", (await ta.inputValue()).length);
    } else { log("未找到简介项"); }

    // 封面
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count()) {
      await fileInput.setInputFiles(cover);
      await page.waitForTimeout(3500);
      log("封面已上传:", cover);
    } else { log("未找到封面上传控件"); }

    // AI 声明（如表单有）
    const aiItem = itemByLabel(/AI|人工智能|生成内容/);
    if (await aiItem.count()) {
      await aiItem.locator("text=是").first().click().catch(() => {});
      log("AI 声明已尝试选「是」");
    }

    await shot("filled");
    if (DRY) { console.log("DRY_DONE 已填表未提交"); await browser.close(); process.exit(0); }

    // 提交
    const submit = page.locator("button").filter({ hasText: /创建|提交|立即发布|确定/ }).last();
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

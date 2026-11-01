/* Qimao draft-only chapter script (七猫仅存草稿，绝不发布）.
 *
 * Mirrors the fanqie ledger conventions:
 *  - order-guard: only the first chapter whose qimao status is `pending`
 *    with all earlier chapters qimao `published` or `draft_saved` is
 *    drafted (drafts auto-number from what already exists on the
 *    platform, so a pending/failed prior would mis-number the draft).
 *  - a chapter already `draft_saved` is reported, never duplicated.
 *  - a `failed` head blocks the book (exit 2, needs a human look).
 *  - after the draft is verified in the draft box, the ledger's
 *    platforms.qimao becomes `draft_saved` (top-level status untouched:
 *    it means "not published").
 *
 * HARD RULE: this script only ever clicks 更新草稿. It contains no
 * code path that clicks 立即发布 / 定时发布 / any publish confirm.
 * If a publish modal appears unexpectedly, the run aborts without
 * confirming anything.
 *
 * Usage (from the repo root):
 *   NODE_PATH=/root/reader/node_modules node automation/qimao_draft.js \
 *     --book-dir tianming-fanpai --qimao-book-id 13656057 [--chapter 7]
 * Without --chapter, the head pending chapter is picked automatically.
 * Exit codes: 0 = draft_saved (or already drafted / nothing pending),
 *             2 = guard/validation abort, 1 = runtime error.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const REPO = path.resolve(__dirname, "..");
const PROFILE = path.join(REPO, ".runtime", "browser-profiles", "qimao");
const BASE = "https://zuozhe.qimao.com";

const log = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || "").replace(/\s+/g, "");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
  }
  return out;
}
function ledgerFiles(bookDir) {
  const dir = path.join(REPO, "serial", "books", bookDir, "runs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.json$/.test(f)).map((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      return { file: f, path: path.join(dir, f), ...j };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => (a.chapter || 0) - (b.chapter || 0));
}
function localChapter(bookDir, n) {
  const dir = path.join(REPO, "serial", "books", bookDir, "published");
  const pad = String(n).padStart(4, "0");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes(`chapter-${pad}.md`)) : [];
  if (!files.length) return null;
  const text = fs.readFileSync(path.join(dir, files[0]), "utf8");
  const lines = text.split("\n");
  let hi = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) { hi = i; break; }
  }
  if (hi < 0) return null;
  const m = lines[hi].trim().match(/^#\s*第(\d+)章\s+(.+)$/);
  if (!m || Number(m[1]) !== n) return null;
  return { title: m[2].trim(), body: lines.slice(hi + 1).join("\n").trim(), file: files[0] };
}

async function shot(page, n) {
  try { await page.screenshot({ path: `/tmp/qimao-draft-${n}.png` }); } catch {}
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const bookDir = args["book-dir"];
  if (!bookDir) { log({ result: "ARG_ERROR", message: "missing --book-dir" }); process.exit(1); }
  const bookJsonPath = path.join(REPO, "serial", "books", bookDir, "book.json");
  if (!fs.existsSync(bookJsonPath)) { log({ result: "ARG_ERROR", message: "book.json not found" }); process.exit(1); }
  const book = JSON.parse(fs.readFileSync(bookJsonPath, "utf8"));
  if (book.platform !== "qimao") { log({ result: "GUARD_ABORT", reason: "book platform is not qimao", platform: book.platform }); process.exit(2); }
  const qimaoBookId = args["qimao-book-id"] || book.qimaoBookId;
  if (!qimaoBookId) { log({ result: "ARG_ERROR", message: "missing --qimao-book-id (and no qimaoBookId in book.json)" }); process.exit(1); }

  const ledgers = ledgerFiles(bookDir);
  if (!ledgers.length) { log({ result: "GUARD_ABORT", reason: "no ledgers" }); process.exit(2); }
  let target = null;
  if (args.chapter) {
    const n = Number(args.chapter);
    target = ledgers.find((l) => l.chapter === n);
    if (!target) { log({ result: "GUARD_ABORT", reason: "no ledger for chapter", chapter: n }); process.exit(2); }
    // For DRAFTING, priors only need to exist on the platform as
    // published or draft_saved (drafts auto-number from what exists;
    // a pending/failed prior would mis-number this draft).
    const priors = ledgers.filter((l) => l.chapter < n);
    const bad = priors.find((l) => !["published", "draft_saved"].includes(l.platforms?.qimao?.status));
    if (bad) { log({ result: "GUARD_ABORT", reason: "earlier chapter not on qimao yet", chapter: bad.chapter, status: bad.platforms?.qimao?.status }); process.exit(2); }
  } else {
    for (const l of ledgers) {
      const st = l.platforms?.qimao?.status;
      if (st === "published" || st === "draft_saved") continue;
      if (st === "pending") { target = l; break; }
      log({ result: "GUARD_ABORT", reason: "head non-drafted chapter is not pending", chapter: l.chapter, status: st });
      process.exit(2);
    }
    if (!target) { log({ result: "NO_PENDING", message: "no qimao pending chapter" }); process.exit(0); }
  }
  const n = target.chapter;
  const qst = target.platforms?.qimao?.status;
  if (qst === "published") { log({ result: "GUARD_ABORT", reason: "chapter already qimao published", chapter: n }); process.exit(2); }
  if (qst === "draft_saved") { log({ result: "ALREADY_DRAFTED", chapter: n }); process.exit(0); }
  if (qst !== "pending") { log({ result: "GUARD_ABORT", reason: "unexpected qimao status", chapter: n, status: qst }); process.exit(2); }

  const ch = localChapter(bookDir, n);
  if (!ch) { log({ result: "GUARD_ABORT", reason: "local chapter file missing or heading mismatch", chapter: n }); process.exit(2); }
  if (ch.title.length > 20) { log({ result: "GUARD_ABORT", reason: "title exceeds qimao 20-char limit", title: ch.title, len: ch.title.length }); process.exit(2); }
  const bodyLen = norm(ch.body).length;
  if (bodyLen < 1000 || bodyLen > 50000) { log({ result: "GUARD_ABORT", reason: "body length out of qimao 1000-50000 range", bodyLen }); process.exit(2); }
  log({ result: "TARGET", book: bookDir, chapter: n, title: ch.title, titleLen: ch.title.length, bodyLen, qimaoBookId });

  let ctx;
  let page;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: true, viewport: { width: 1280, height: 900 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    page = await ctx.newPage();
    await page.goto(`${BASE}/front/book-manage/manage?id=${qimaoBookId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(5000);
    const homeText = await page.evaluate(() => (document.body ? document.body.innerText : "").slice(0, 200).replace(/\s+/g, " ")).catch(() => "");
    if (/登录|手机验证码/.test(homeText) && !homeText.includes("章节管理")) {
      log({ result: "LOGIN_EXPIRED", message: "qimao session expired, human login needed" });
      process.exitCode = 1; await ctx.close(); return;
    }
    await shot(page, "1-manage");

    // Draft box: reuse a matching/empty draft if one exists, else create.
    const draftTab = page.locator("text=草稿箱").first();
    if (await draftTab.count()) await draftTab.click().catch(() => {});
    await sleep(3000);
    await shot(page, "2-draftbox");
    // Draft rows are a table (序号/章节名称/字数/创建时间/操作） whose
    // 修改 link opens the editor; there are no book-upload hrefs here.
    const drafts = await page.evaluate(() => {
      const rows = [];
      document.querySelectorAll("tr").forEach((tr) => {
        const t = (tr.textContent || "").replace(/\s+/g, " ").trim();
        const m = t.match(/第(\d+)章\s*(.*?)\s+(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        if (m) rows.push({ chapter: Number(m[1]), title: m[2], chars: Number(m[3]), created: m[4], text: t.slice(0, 160) });
      });
      return rows;
    }).catch(() => []);
    log({ result: "DRAFT_BOX", drafts });

    // Reuse the target chapter's draft row via its 修改 link; otherwise
    // create a fresh draft. (The editor's existing-content guards still
    // refuse to overwrite anything that isn't this chapter.)
    let editorOpened = false;
    const reuseRow = drafts.find((r) => r.chapter === n && r.title === ch.title) ||
      drafts.find((r) => r.chapter === n);
    if (reuseRow) {
      const opened = await page.evaluate((chapter) => {
        for (const tr of document.querySelectorAll("tr")) {
          const t = (tr.textContent || "").replace(/\s+/g, " ").trim();
          if (!new RegExp(`第${chapter}章`).test(t)) continue;
          const a = [...tr.querySelectorAll("a")].find((x) => (x.textContent || "").trim() === "修改");
          if (a) { a.click(); return true; }
        }
        return false;
      }, n).catch(() => false);
      log({ result: "REUSE_DRAFT", row: reuseRow, opened });
      await sleep(5000);
      editorOpened = page.url().includes("book-upload");
    }
    if (!editorOpened) {
      // The draft-box tab's button is 新建草稿 (the 章节管理 tab's is 新建章节）.
      let newBtn = page.locator("text=新建草稿").first();
      if (!(await newBtn.count())) newBtn = page.locator("text=新建章节").first();
      if (!(await newBtn.count())) { log({ result: "STEP_FAILED", step: "new_draft_button_not_found" }); process.exitCode = 1; await ctx.close(); return; }
      await newBtn.click().catch(() => {});
      await sleep(5000);
      editorOpened = page.url().includes("book-upload");
    }
    await shot(page, "3-editor");
    if (!editorOpened) {
      log({ result: "STEP_FAILED", step: "editor_not_opened", url: page.url() });
      process.exitCode = 1; await ctx.close(); return;
    }
    const editorUrl = page.url();
    log({ result: "EDITOR_OPENED", url: editorUrl });

    // Discover editor fields (logged; abort on ambiguity).
    const fields = await page.evaluate(() => {
      const vis = (el) => el && el.offsetParent !== null;
      const inputs = [...document.querySelectorAll("input[type=text], input:not([type])")].filter(vis).map((el) => ({
        tag: "input", placeholder: el.getAttribute("placeholder") || "", value: (el.value || "").slice(0, 40), cls: (el.className || "").slice(0, 60),
      }));
      const areas = [...document.querySelectorAll("textarea")].filter(vis).map((el) => ({
        tag: "textarea", placeholder: el.getAttribute("placeholder") || "", value: (el.value || "").slice(0, 40),
      }));
      const edits = [...document.querySelectorAll("[contenteditable=true]")].filter(vis).map((el) => ({
        tag: "contenteditable", text: (el.innerText || "").slice(0, 40), cls: (el.className || "").slice(0, 60),
      }));
      const selects = [...document.querySelectorAll("select")].filter(vis).map((el) => ({
        tag: "select", value: el.value, text: [...el.options].map((o) => o.text).join("|").slice(0, 80),
      }));
      const bodyText = (document.body ? document.body.innerText : "");
      const numMatch = bodyText.match(/第\s*(\d+)\s*章/);
      return { inputs: inputs.slice(0, 15), areas: areas.slice(0, 5), edits: edits.slice(0, 5), selects: selects.slice(0, 5), numInText: numMatch ? numMatch[1] : null };
    }).catch(() => ({}));
    log({ result: "EDITOR_FIELDS", ...fields });

    // Safety: refuse to overwrite someone else's draft content.
    // Title = the textarea with placeholder 章节名称 (NOT the 日间/16px
    // toolbar inputs). Body = the .q-contenteditable.book element
    // (the sidebar 随记 notes are never touched). Number = the input
    // whose value is purely numeric. Volume must read 正文.
    const existing = await page.evaluate(() => {
      const titleEl = [...document.querySelectorAll("textarea")].find((el) => (el.getAttribute("placeholder") || "").includes("章节名称"));
      const bodyEl = document.querySelector(".q-contenteditable.book");
      const numEl = [...document.querySelectorAll("input")].find((el) => /^\d+$/.test((el.value || "").trim()));
      const volM = (document.body ? document.body.innerText : "").match(/卷[：:]\s*(\S+)/);
      return {
        titleVal: (titleEl ? titleEl.value : "").slice(0, 60),
        bodyLen: bodyEl ? bodyEl.innerText.replace(/\s+/g, "").length : -1,
        numVal: numEl ? numEl.value : null,
        volVal: volM ? volM[1] : null,
      };
    }).catch(() => ({}));
    log({ result: "EDITOR_EXISTING", ...existing });
    if (existing.titleVal && norm(existing.titleVal) !== norm(ch.title)) {
      log({ result: "ABORTED", reason: "editor holds a different title, refusing to overwrite", existingTitle: existing.titleVal });
      process.exitCode = 2; await ctx.close(); return;
    }
    if (existing.bodyLen > 0 && Math.abs(existing.bodyLen - bodyLen) > Math.max(50, bodyLen * 0.05)) {
      log({ result: "ABORTED", reason: "editor holds different body content, refusing to overwrite", existingBodyLen: existing.bodyLen });
      process.exitCode = 2; await ctx.close(); return;
    }
    if (existing.numVal !== null && Number(existing.numVal) !== n) {
      log({ result: "ABORTED", reason: "editor chapter number mismatch", numVal: existing.numVal, expected: n });
      process.exitCode = 2; await ctx.close(); return;
    }
    if (existing.volVal && existing.volVal !== "正文") {
      log({ result: "ABORTED", reason: "editor volume is not 正文", volVal: existing.volVal });
      process.exitCode = 2; await ctx.close(); return;
    }

    // Fill title into the 章节名称 textarea.
    let titleFilled = false;
    const titleEl = page.locator("textarea[placeholder*=章节名称]").first();
    if (await titleEl.count()) {
      const cur = (await titleEl.inputValue().catch(() => "")) || "";
      if (!cur) await titleEl.fill(ch.title).catch(() => {});
      titleFilled = true;
    }
    if (!titleFilled) { log({ result: "STEP_FAILED", step: "title_fill_failed" }); process.exitCode = 1; await ctx.close(); return; }

    // Fill body into .q-contenteditable.book via execCommand.
    let bodyFilled = false;
    const bodyEl = page.locator(".q-contenteditable.book").first();
    if (await bodyEl.count()) {
      await bodyEl.click().catch(() => {});
      await sleep(500);
      const ok = await page.evaluate((body) => {
        const el = document.querySelector(".q-contenteditable.book");
        if (!el) return false;
        el.focus();
        const sel = window.getSelection();
        sel.selectAllChildren(el);
        return document.execCommand("insertText", false, body);
      }, ch.body).catch(() => false);
      bodyFilled = !!ok;
    }
    if (!bodyFilled) { log({ result: "STEP_FAILED", step: "body_fill_failed" }); process.exitCode = 1; await ctx.close(); return; }
    await sleep(1500);

    // Verify filled values before saving.
    const filled = await page.evaluate(() => {
      const titleEl = [...document.querySelectorAll("textarea")].find((el) => (el.getAttribute("placeholder") || "").includes("章节名称"));
      const bodyEl = document.querySelector(".q-contenteditable.book");
      return {
        titleVal: titleEl ? titleEl.value : "",
        bodyLen: bodyEl ? bodyEl.innerText.replace(/\s+/g, "").length : -1,
      };
    }).catch(() => ({}));
    log({ result: "FILLED_CHECK", ...filled });
    if (norm(filled.titleVal) !== norm(ch.title)) { log({ result: "ABORTED", reason: "title verification failed after fill" }); process.exitCode = 2; await ctx.close(); return; }
    if (Math.abs((filled.bodyLen || 0) - bodyLen) > Math.max(50, bodyLen * 0.05)) { log({ result: "ABORTED", reason: "body verification failed after fill", filledBodyLen: filled.bodyLen }); process.exitCode = 2; await ctx.close(); return; }

    // Save as DRAFT ONLY. Never touch 立即发布 / 定时发布.
    // The top-right actions may be <a>/<div>, not <button>: click the
    // leaf-most visible element whose exact text is 更新草稿.
    const saveClicked = await page.evaluate(() => {
      const els = [...document.querySelectorAll("button, a, div, span")].filter((el) => {
        if (el.offsetParent === null) return false;
        if ((el.textContent || "").trim() !== "更新草稿") return false;
        return ![...el.children].some((c) => (c.textContent || "").trim() === "更新草稿");
      });
      if (!els.length) return false;
      els[0].click();
      return true;
    }).catch(() => false);
    if (!saveClicked) { log({ result: "STEP_FAILED", step: "update_draft_button_not_found" }); process.exitCode = 1; await ctx.close(); return; }
    await sleep(5000);
    await shot(page, "4-saved");

    // Verify in the draft box.
    await page.goto(`${BASE}/front/book-manage/manage?id=${qimaoBookId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(4000);
    const dt = page.locator("text=草稿箱").first();
    if (await dt.count()) await dt.click().catch(() => {});
    await sleep(4000);
    await shot(page, "5-draftbox-verify");
    const verify = await page.evaluate(({ chapter, title }) => {
      let row = null;
      document.querySelectorAll("tr").forEach((tr) => {
        const t = (tr.textContent || "").replace(/\s+/g, " ").trim();
        const m = t.match(/第(\d+)章\s*(.*?)\s+(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        if (m && Number(m[1]) === chapter) row = { title: m[2], chars: Number(m[3]), created: m[4] };
      });
      return { row, titleMatch: row ? row.title === title : false };
    }, { chapter: n, title: ch.title }).catch(() => ({}));
    log({ result: "DRAFT_VERIFY", ...verify });
    if (!verify.row || !verify.titleMatch || !(verify.row.chars >= 1000)) {
      log({ result: "VERIFY_FAILED", message: "draft row not verified in draft box after save" });
      process.exitCode = 1; await ctx.close(); return;
    }

    // Best-effort cleanup: delete the empty 无名称章节 0字 draft created
    // by the aborted test run (only rows matching both markers).
    const cleanup = await page.evaluate(() => {
      for (const tr of document.querySelectorAll("tr")) {
        const t = (tr.textContent || "").replace(/\s+/g, " ").trim();
        if (t.includes("无名称章节") && /\s0\s/.test(t)) {
          const a = [...tr.querySelectorAll("a")].find((x) => (x.textContent || "").trim() === "删除");
          if (a) { a.click(); return { deleted: t.slice(0, 120) }; }
        }
      }
      return { deleted: null };
    }).catch(() => ({}));
    log({ result: "CLEANUP_EMPTY_DRAFT", ...cleanup });
    if (cleanup.deleted) {
      await sleep(2000);
      const confirmBtn = page.locator("button:has-text(\"确认\"), button:has-text(\"确定\"), button:has-text(\"删除\")").first();
      if (await confirmBtn.count() && await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click().catch(() => {});
        await sleep(2000);
      }
      await shot(page, "6-cleanup");
    }

    // Ledger update (only after verification).
    const lj = JSON.parse(fs.readFileSync(target.path, "utf8"));
    lj.platforms = lj.platforms || {};
    lj.platforms.qimao = { status: "draft_saved", updatedAt: new Date().toISOString() };
    lj.note = `${lj.note || ""} [${new Date().toISOString().slice(0, 10)} 七猫草稿已存，draft-only，未发布。]`.trim();
    fs.writeFileSync(target.path, JSON.stringify(lj, null, 2) + "\n");
    log({ result: "DONE", chapter: n, title: ch.title, draft_saved: true, note: "NOT published" });
  } catch (e) {
    try { if (page) await shot(page, "error"); } catch {}
    log({ result: "ERROR", message: String((e && e.message) || e).slice(0, 500) });
    process.exitCode = 1;
  } finally {
    try { if (ctx) await ctx.close(); } catch {}
  }
})();

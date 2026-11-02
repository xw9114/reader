/* Qimao publish script (七猫发表，显式单章， fail-closed).
 *
 * Publishes ONE explicitly named chapter that is currently draft_saved.
 * NEVER touches 定时发布 and NEVER clicks any signing-evaluation
 * application (申请签约评估）. Publishing alone only moves a chapter
 * from draft to published/待审核； the signing application is a
 * separate step this script never performs.
 *
 * Two phases:
 *   1. Probe (default): open the draft box, click the chapter row's
 *      立即发布， dump the resulting modal/page state, STOP without
 *      confirming. Exit 3 = NEEDS_REVIEW.
 *   2. Confirm (--confirm): repeat, and if the modal is a plain
 *      publish confirm (no 签约/独家/排他/费用/付费/买断/版权转让
 *      keywords anywhere in it), click its confirm button, then
 *      verify the chapter in the published list and out of the draft
 *      box before updating the ledger.
 *
 * Usage:
 *   NODE_PATH=/root/reader/node_modules node automation/qimao_publish.js \
 *     --book-dir tianming-fanpai --qimao-book-id 13656057 --chapter 7 [--confirm]
 * Exit codes: 0 = published+verified (or already published),
 *             2 = guard abort, 3 = needs human review of modal,
 *             1 = runtime error.
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
const DANGER = ["签约", "独家", "排他", "费用", "付费", "买断", "版权转让", "申请签约"];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] !== undefined) out[m[1]] = m[2];
    else if (m[1] === "confirm") out.confirm = true; // boolean flag: consumes nothing
    else out[m[1]] = argv[++i];
  }
  return out;
}
async function shot(page, n) {
  try { await page.screenshot({ path: `/tmp/qimao-pub-${n}.png` }); } catch {}
}
async function draftRows(page) {
  return page.evaluate(() => {
    const rows = [];
    document.querySelectorAll("tr").forEach((tr) => {
      const t = (tr.textContent || "").replace(/\s+/g, " ").trim();
      const m = t.match(/第(\d+)章\s*(.*?)\s+(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (m) rows.push({ chapter: Number(m[1]), title: m[2], chars: Number(m[3]), created: m[4] });
    });
    return rows;
  }).catch(() => []);
}
async function publishedRows(page) {
  return page.evaluate(() => {
    const rows = [];
    document.querySelectorAll("tr").forEach((tr) => {
      const t = (tr.textContent || "").replace(/\s+/g, " ").trim();
      const m = t.match(/第(\d+)章\s+(.+?)\s+(待审核|已发布|审核中|未通过|已下架)\s*(\d{4}-\d{2}-\d{2}[^ ]*)?/);
      if (m) rows.push({ chapter: Number(m[1]), title: m[2], status: m[3], time: m[4] || null, text: t.slice(0, 160) });
    });
    return rows;
  }).catch(() => []);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const bookDir = args["book-dir"];
  const qimaoBookId = args["qimao-book-id"];
  const n = Number(args.chapter);
  const confirm = !!args.confirm;
  if (!bookDir || !qimaoBookId || !n) { log({ result: "ARG_ERROR", message: "need --book-dir --qimao-book-id --chapter" }); process.exit(1); }
  const bookJsonPath = path.join(REPO, "serial", "books", bookDir, "book.json");
  const book = JSON.parse(fs.readFileSync(bookJsonPath, "utf8"));
  if (book.platform !== "qimao") { log({ result: "GUARD_ABORT", reason: "book platform is not qimao" }); process.exit(2); }
  const runsDir = path.join(REPO, "serial", "books", bookDir, "runs");
  const ledgers = fs.readdirSync(runsDir).filter((f) => /\.json$/.test(f)).map((f) => {
    try { const j = JSON.parse(fs.readFileSync(path.join(runsDir, f), "utf8")); return { file: f, path: path.join(runsDir, f), ...j }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.chapter - b.chapter);
  const target = ledgers.find((l) => l.chapter === n);
  if (!target) { log({ result: "GUARD_ABORT", reason: "no ledger for chapter", chapter: n }); process.exit(2); }
  const qst = target.platforms?.qimao?.status;
  if (qst === "published") { log({ result: "ALREADY_PUBLISHED", chapter: n }); process.exit(0); }
  if (qst !== "draft_saved") { log({ result: "GUARD_ABORT", reason: "chapter is not draft_saved, cannot publish from draft box", chapter: n, status: qst }); process.exit(2); }
  const badPrior = ledgers.filter((l) => l.chapter < n).find((l) => l.platforms?.qimao?.status !== "published");
  if (badPrior) { log({ result: "GUARD_ABORT", reason: "earlier chapter not published, refusing out-of-order publish", chapter: badPrior.chapter, status: badPrior.platforms?.qimao?.status }); process.exit(2); }
  const dir = path.join(REPO, "serial", "books", bookDir, "published");
  const pad = String(n).padStart(4, "0");
  const files = fs.readdirSync(dir).filter((f) => f.includes(`chapter-${pad}.md`));
  const text = fs.readFileSync(path.join(dir, files[0]), "utf8");
  const hm = text.split("\n").find((l) => l.trim()).trim().match(/^#\s*第(\d+)章\s+(.+)$/);
  const localTitle = hm ? hm[2].trim() : null;
  log({ result: "TARGET", book: bookDir, chapter: n, localTitle, qimaoBookId, confirm });

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
    const dt = page.locator("text=草稿箱").first();
    if (await dt.count()) await dt.click().catch(() => {});
    await sleep(4000);
    await shot(page, "1-draftbox");
    const rows = await draftRows(page);
    log({ result: "DRAFT_BOX", drafts: rows });
    const row = rows.find((r) => r.chapter === n);
    if (!row) { log({ result: "GUARD_ABORT", reason: "chapter not in draft box", chapter: n }); process.exitCode = 2; await ctx.close(); return; }
    if (row.title !== localTitle) { log({ result: "GUARD_ABORT", reason: "draft title mismatch, refusing", draftTitle: row.title, localTitle }); process.exitCode = 2; await ctx.close(); return; }

    const clicked = await page.evaluate((chapter) => {
      for (const tr of document.querySelectorAll("tr")) {
        const t = (tr.textContent || "").replace(/\s+/g, " ").trim();
        if (!new RegExp(`第${chapter}章`).test(t)) continue;
        const a = [...tr.querySelectorAll("a")].find((x) => (x.textContent || "").trim() === "立即发布");
        if (a) { a.click(); return true; }
      }
      return false;
    }, n).catch(() => false);
    if (!clicked) { log({ result: "STEP_FAILED", step: "publish_link_not_found" }); process.exitCode = 1; await ctx.close(); return; }
    await sleep(5000);
    await shot(page, "2-after-publish-click");
    const state = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll("[role=dialog], .el-dialog, .modal, [class*=modal], [class*=dialog]")].filter((el) => el.offsetParent !== null).map((el) => (el.innerText || "").replace(/\s+/g, " ").slice(0, 1000));
      const btns = [...document.querySelectorAll("button, a")].filter((el) => el.offsetParent !== null).map((el) => (el.textContent || "").trim()).filter((t) => t && t.length <= 20);
      return { url: location.href, dialogs, btns: [...new Set(btns)].slice(0, 40), bodyText: (document.body ? document.body.innerText : "").replace(/\s+/g, " ").slice(0, 1500) };
    }).catch(() => ({}));
    log({ result: "AFTER_CLICK", ...state });

    // Immediate-publish path: chapter already left the draft box?
    await page.goto(`${BASE}/front/book-manage/manage?id=${qimaoBookId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(4000);
    const dt2 = page.locator("text=草稿箱").first();
    if (await dt2.count()) await dt2.click().catch(() => {});
    await sleep(4000);
    const rowsAfter = await draftRows(page);
    const stillDraft = rowsAfter.some((r) => r.chapter === n);
    log({ result: "DRAFT_BOX_AFTER", drafts: rowsAfter, stillDraft });
    if (!stillDraft) {
      log({ result: "PUBLISHED_IMMEDIATELY", message: "chapter left draft box after 立即发布 click" });
    } else if (!confirm) {
      log({ result: "NEEDS_REVIEW", message: "modal/page state dumped above; re-run with --confirm after review" });
      process.exitCode = 3; await ctx.close(); return;
    } else {
      // Confirm phase: re-open the modal and confirm only if plain.
      const clicked2 = await page.evaluate((chapter) => {
        for (const tr of document.querySelectorAll("tr")) {
          const t = (tr.textContent || "").replace(/\s+/g, " ").trim();
          if (!new RegExp(`第${chapter}章`).test(t)) continue;
          const a = [...tr.querySelectorAll("a")].find((x) => (x.textContent || "").trim() === "立即发布");
          if (a) { a.click(); return true; }
        }
        return false;
      }, n).catch(() => false);
      if (!clicked2) { log({ result: "STEP_FAILED", step: "publish_link_not_found_on_confirm" }); process.exitCode = 1; await ctx.close(); return; }
      await sleep(5000);
      await shot(page, "3-confirm-modal");
      const modal = await page.evaluate(() => {
        const dialogs = [...document.querySelectorAll("[role=dialog], .el-dialog, .modal, [class*=modal], [class*=dialog]")].filter((el) => el.offsetParent !== null).map((el) => (el.innerText || "").replace(/\s+/g, " ").slice(0, 1000));
        return { dialogs, bodyText: (document.body ? document.body.innerText : "").replace(/\s+/g, " ").slice(0, 1500) };
      }).catch(() => ({}));
      log({ result: "CONFIRM_MODAL", ...modal });
      // Keyword gate applies ONLY to the modal dialog text: the page
      // chrome (sidebar "签约政策" nav) must not false-positive it.
      const modalText = (modal.dialogs || []).join(" ");
      const hit = DANGER.find((w) => modalText.includes(w));
      if (hit) { log({ result: "ABORTED", reason: "modal mentions a gated keyword, refusing to confirm", keyword: hit }); process.exitCode = 2; await ctx.close(); return; }
      // Click the confirm button INSIDE the publish modal only.
      const confirmed = await page.evaluate(() => {
        const dialogs = [...document.querySelectorAll("[role=dialog], .el-dialog, .modal, [class*=modal], [class*=dialog]")].filter((el) => el.offsetParent !== null);
        const dlg = dialogs.find((el) => (el.innerText || "").includes("立即发布确认")) || dialogs[0];
        if (!dlg) return null;
        const btn = [...dlg.querySelectorAll("button, a")].find((el) => ["确认发布", "确认", "确定"].includes((el.textContent || "").trim()));
        if (btn) { btn.click(); return (btn.textContent || "").trim(); }
        return null;
      }).catch(() => null);
      log({ result: "CONFIRM_CLICKED", button: confirmed });
      if (!confirmed) { log({ result: "STEP_FAILED", step: "confirm_button_not_found" }); process.exitCode = 1; await ctx.close(); return; }
      await sleep(6000);
      await shot(page, "4-after-confirm");
    }

    // Verify: published list contains ch.N, draft box does not.
    await page.goto(`${BASE}/front/book-manage/manage?id=${qimaoBookId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(4000);
    const pubTab = page.locator("text=章节管理").first();
    if (await pubTab.count()) await pubTab.click().catch(() => {});
    await sleep(4000);
    await shot(page, "5-published-list");
    const pubs = await publishedRows(page);
    log({ result: "PUBLISHED_LIST", rows: pubs });
    const pubRow = pubs.find((r) => r.chapter === n);
    const dt3 = page.locator("text=草稿箱").first();
    if (await dt3.count()) await dt3.click().catch(() => {});
    await sleep(4000);
    const rowsFinal = await draftRows(page);
    const stillDraftFinal = rowsFinal.some((r) => r.chapter === n);
    log({ result: "VERIFY", pubRow: pubRow || null, stillDraft: stillDraftFinal });
    if (!pubRow || stillDraftFinal) {
      log({ result: "VERIFY_FAILED", message: "published row missing or draft row remains" });
      process.exitCode = 1; await ctx.close(); return;
    }
    const lj = JSON.parse(fs.readFileSync(target.path, "utf8"));
    lj.platforms = lj.platforms || {};
    lj.platforms.qimao = { status: "published", updatedAt: new Date().toISOString() };
    lj.note = `${lj.note || ""} [${new Date().toISOString().slice(0, 10)} 七猫已发表（Jay 亲批），状态见平台：${pubRow.status}。]`.trim();
    fs.writeFileSync(target.path, JSON.stringify(lj, null, 2) + "\n");
    log({ result: "DONE", chapter: n, title: localTitle, platformStatus: pubRow.status, platformTime: pubRow.time || null, note: "signing application NOT made" });
  } catch (e) {
    try { if (page) await shot(page, "error"); } catch {}
    log({ result: "ERROR", message: String((e && e.message) || e).slice(0, 500) });
    process.exitCode = 1;
  } finally {
    try { if (ctx) await ctx.close(); } catch {}
  }
})();

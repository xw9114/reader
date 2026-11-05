// bilibili_comment.js — post Bilibili comments carrying the exact Aileader short link,
// verify each comment is actually visible, and save a screenshot proof per comment.
// Usage (on the VPS):
//   NODE_PATH=/root/reader/node_modules node automation/bilibili_comment.js --count 1
//   NODE_PATH=/root/reader/node_modules node automation/bilibili_comment.js --count 9
// Rules enforced: target videos are AI-related (search ai/gpt/claude/grok) with play > 6000;
// the short link is byte-identical in every comment; one comment per video; never auto-solve
// any captcha (abort on captcha); a comment that is not visible after posting is recorded
// as failed, never reposted on the same video.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILE = '/root/reader/.runtime/browser-profiles/bilibili';
const LINK = 'https://aileaderme.top/r/BRX2R';
const OUT_DIR = '/root/reader/.runtime/bilibili-proofs';
const STATE_FILE = '/root/reader/.runtime/bilibili-posted.json';
const KEYWORDS = ['AI 充值', 'claude', 'gpt', 'grok', 'AI 工具'];
const COMMENTS = [
  '我最近在用 Aileader，入口在这里：https://aileaderme.top/r/BRX2R',
  '用了一段时间，体验还行，需要的自取：https://aileaderme.top/r/BRX2R',
  '不想折腾支付的话可以试试这个，我就是这么开的：https://aileaderme.top/r/BRX2R',
  'UP 讲得很清楚，补充一个我常用的 AI 充值入口：https://aileaderme.top/r/BRX2R',
  'AI 工具充值我走的这个入口，亲测能用：https://aileaderme.top/r/BRX2R',
  '之前找了好久能用的入口，最后用的这个：https://aileaderme.top/r/BRX2R',
  '同款需求，分享一个我自己在用的入口：https://aileaderme.top/r/BRX2R',
  '充值这块我踩过坑，现在固定走这个：https://aileaderme.top/r/BRX2R',
  '需要的可以看看这个入口，我用着还行：https://aileaderme.top/r/BRX2R',
  '补充一个渠道，AI 充值入口在这里：https://aileaderme.top/r/BRX2R',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function args() {
  const a = {};
  for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  return a;
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { posted: [], failed: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function searchVideosApi(keyword, exclude) {
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', Referer: 'https://search.bilibili.com/' } });
  const text = await res.text();
  const j = JSON.parse(text);
  if (j.code !== 0) throw new Error(`search api code ${j.code} for keyword ${keyword}`);
  return (j.data?.result || [])
    .map((r) => ({ bvid: r.bvid, title: (r.title || '').replace(/<[^>]+>/g, ''), play: Number(r.play) || 0, author: r.author }))
    .filter((v) => v.bvid && v.play > 6000 && !exclude.has(v.bvid));
}

function parsePlay(s) {
  s = (s || '').trim();
  if (s.endsWith('万')) return Math.round(parseFloat(s) * 10000);
  if (s.endsWith('亿')) return Math.round(parseFloat(s) * 100000000);
  return Number(s.replace(/[^0-9.]/g, '')) || 0;
}

// Browser search fallback (uses the logged-in session; the bare API fetch is flaky).
async function searchVideosBrowser(page, keyword, exclude) {
  await page.goto(`https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(4000);
  const cards = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.bili-video-card').forEach((c) => {
      const a = c.querySelector('a[href*="/video/BV"]');
      const m = a ? a.getAttribute('href').match(/BV[a-zA-Z0-9]+/) : null;
      const stats = c.querySelector('.bili-video-card__stats--left');
      const playText = stats ? stats.innerText.replace(/\n/g, ' ') : '';
      const titleEl = c.querySelector('.bili-video-card__info--tit');
      out.push({ bvid: m ? m[0] : null, title: titleEl ? titleEl.innerText.trim() : '', playText });
    });
    return out;
  });
  return cards
    .map((c) => ({ ...c, play: parsePlay(c.playText.split(' ')[0] || c.playText) }))
    .filter((v) => v.bvid && v.play > 6000 && !exclude.has(v.bvid));
}

async function searchVideos(page, keyword, exclude) {
  try { return await searchVideosApi(keyword, exclude); }
  catch (e) { console.log(`api search failed (${String(e.message).slice(0, 80)}), falling back to browser search`); return await searchVideosBrowser(page, keyword, exclude); }
}

async function main() {
  const { count: countArg } = args();
  const count = Math.max(1, parseInt(countArg || '1', 10));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const state = loadState();
  const exclude = new Set([...state.posted, ...state.failed]);
  const manifestPath = path.join(OUT_DIR, `${new Date().toISOString().slice(0, 10)}.json`);
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* fresh */ }

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await ctx.newPage();
  try {
    // Login check via nav API (navigate + parse body, fetch from about:blank is CORS-blocked).
    await page.goto('https://api.bilibili.com/x/web-interface/nav', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const navText = await page.evaluate(() => document.body.innerText);
    const nav = JSON.parse(navText);
    const login = nav.data || {};
    if (!login.isLogin) { console.log(JSON.stringify({ ok: false, error: 'NOT_LOGGED_IN' })); return; }
    console.log(`logged in as ${login.uname} (${login.mid})`);

    let done = 0, ki = 0, commentIdx = manifest.length % COMMENTS.length;
    while (done < count) {
      // Find a fresh >6000-view video, rotating keywords.
      let video = null, tries = 0;
      while (!video && tries < KEYWORDS.length * 2) {
        const kw = KEYWORDS[ki % KEYWORDS.length]; ki++;
        const list = await searchVideos(page, kw, exclude);
        console.log(`search "${kw}": ${list.length} fresh videos over 6000 views`);
        video = list[0] || null;
        tries++;
        if (!video) await sleep(2000);
      }
      if (!video) { console.log(JSON.stringify({ ok: false, error: 'NO_FRESH_VIDEO' })); break; }
      const comment = COMMENTS[commentIdx % COMMENTS.length]; commentIdx++;
      console.log(`posting to ${video.bvid} (${video.title}, ${video.play} views)`);

      const result = { bvid: video.bvid, title: video.title, play: video.play, author: video.author, comment, posted_at: new Date().toISOString(), verified: false, screenshot: null, error: null };
      try {
        await page.goto(`https://www.bilibili.com/video/${video.bvid}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await sleep(4000);
        // Captcha guard: never auto-solve.
        const captchaCount = await page.locator('.geetest_holder, .captcha, iframe[src*="captcha"]').count();
        const verifyText = await page.getByText('请完成验证').count();
        if (captchaCount > 0 || verifyText > 0) { result.error = 'CAPTCHA'; console.log('captcha detected, aborting'); manifest.push(result); break; }
        // Scroll stepwise so the lazy comment section renders (probe v2 proved
        // that without scrolling the publisher is not in the DOM at all).
        await page.evaluate(async () => {
          const h = document.body.scrollHeight;
          for (let y = 0; y <= Math.min(h, 12000); y += 1000) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 400)); }
        });
        await sleep(3000);
        // Find the publisher: visible textarea, contenteditable, or the placeholder
        // bar (click it to open the editor, then retry).
        async function findEditor() {
          const tas = page.locator('textarea');
          for (let i = 0; i < await tas.count(); i++) { const t = tas.nth(i); if (await t.isVisible()) return t; }
          const ces = page.locator('[contenteditable="true"]');
          for (let i = 0; i < await ces.count(); i++) { const c = ces.nth(i); if (await c.isVisible()) return c; }
          return null;
        }
        let box = await findEditor();
        if (!box) {
          const bar = page.locator('div').filter({ hasText: /发一条友善|创造快乐/ }).first();
          if (await bar.count() > 0 && await bar.isVisible().catch(() => false)) { await bar.click(); await sleep(2500); box = await findEditor(); }
        }
        if (!box) throw new Error('COMMENT_BOX_NOT_FOUND');
        await box.click();
        await sleep(1000);
        await page.keyboard.type(comment, { delay: 25 });
        await sleep(1000);
        // Submit: the real control is a <button> named 发布 inside a shadow DOM.
        // Use getByRole (pierces shadow DOM, auto-waits) instead of an instant
        // count() check, which raced the button's late render.
        let submitted = null;
        for (const name of ['发布', '发表']) {
          try {
            await page.getByRole('button', { name, exact: true }).first().click({ timeout: 15000 });
            submitted = name;
            break;
          } catch { /* try the next label */ }
        }
        if (!submitted) throw new Error('SUBMIT_NOT_FOUND');
        await sleep(5000);
        // Verify: the short link text appears in the comment list (reload once to be sure).
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        await sleep(4000);
        await page.evaluate(() => { const el = document.querySelector('#comment, .comment-container, .bb-comment'); if (el) el.scrollIntoView(); });
        await sleep(2000);
        const hit = page.locator(`text=${LINK}`).first();
        const visible = await hit.count() > 0 && await hit.isVisible().catch(() => false);
        if (visible) {
          result.verified = true;
          const shot = path.join(OUT_DIR, `${new Date().toISOString().slice(0, 10)}-${video.bvid}.png`);
          try { await hit.screenshot({ path: shot }); result.screenshot = shot; }
          catch { const fb = path.join(OUT_DIR, `${new Date().toISOString().slice(0, 10)}-${video.bvid}-area.png`); await page.screenshot({ path: fb }); result.screenshot = fb; }
          state.posted.push(video.bvid);
          console.log(`OK ${video.bvid} verified`);
        } else {
          result.error = 'NOT_VISIBLE_AFTER_POST';
          state.failed.push(video.bvid);
          console.log(`NOT VISIBLE ${video.bvid} (not reposting)`);
        }
      } catch (e) {
        result.error = String(e.message || e).slice(0, 200);
        state.failed.push(video.bvid);
        console.log(`FAILED ${video.bvid}: ${result.error}`);
      }
      exclude.add(video.bvid);
      manifest.push(result);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      saveState(state);
      done++;
      if (done < count) await sleep(60000 + Math.floor(Math.random() * 30000)); // pacing between posts
    }
    console.log(JSON.stringify({ ok: true, posted: manifest.filter((m) => m.verified).length, total: manifest.length, manifest: manifestPath }));
  } finally {
    await ctx.close();
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

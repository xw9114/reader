// Bilibili login waiter (VPS): holds a persistent browser context open, shows a QR,
// polls until Jay scans with his app (or timeout). Human gate: Jay scans, never password/SMS.
// Run: node /root/reader/automation/bilibili_login.js  (background, absolute path)
// Status: /tmp/bilibili-login-status.json ; QR: /root/reader/.runtime/bilibili-qr-v<n>.png
// QR keys live only ~3 min server-side, so the page is reloaded for a fresh QR every 150s
// (plus immediately when the page shows an expiry overlay) — always send the newest version.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = "/root/reader";
const PROFILE = path.join(ROOT, ".runtime", "browser-profiles", "bilibili");
const STATUS = "/tmp/bilibili-login-status.json";
const QR_PREFIX = path.join(ROOT, ".runtime", "bilibili-qr");
const LOGIN_URL = "https://passport.bilibili.com/login";
const TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 3000;
const REFRESH_MS = 150000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function writeStatus(obj) {
  fs.writeFileSync(STATUS, JSON.stringify({ ts: new Date().toISOString(), ...obj }, null, 2));
}

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, viewport: { width: 1280, height: 900 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await ctx.newPage();
  let qrVersion = 0;
  const shotQR = async () => {
    qrVersion += 1;
    const file = `${QR_PREFIX}-v${qrVersion}.png`;
    await page.screenshot({ path: file });
    return file;
  };
  const checkLogin = async () => {
    try {
      const r = await page.evaluate(async () => {
        try {
          const res = await fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" });
          const j = await res.json();
          if (j && j.data && j.data.isLogin) return { isLogin: true, uname: j.data.uname || null, mid: j.data.mid || null };
        } catch {}
        return { isLogin: false };
      });
      if (r.isLogin) return r;
    } catch {}
    // After a successful scan passport usually redirects to www.bilibili.com.
    if (page.url().startsWith("https://www.bilibili.com")) {
      try {
        const r2 = await page.evaluate(async () => {
          try {
            const res = await fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" });
            const j = await res.json();
            return j && j.data ? { isLogin: !!j.data.isLogin, uname: j.data.uname || null, mid: j.data.mid || null } : { isLogin: false };
          } catch { return { isLogin: false }; }
        });
        if (r2.isLogin) return r2;
      } catch {}
      return { isLogin: true, uname: null, mid: null, via: "redirect" };
    }
    return { isLogin: false };
  };
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(3000);
    let login = await checkLogin();
    if (login.isLogin) {
      writeStatus({ state: "LOGGED_IN", uname: login.uname, mid: login.mid, note: "session already valid" });
      await ctx.close(); return;
    }
    let qrFile = await shotQR();
    let lastShot = Date.now();
    writeStatus({ state: "QR_READY", qrFile, qrVersion });
    const start = Date.now();
    let lastBeat = 0;
    while (Date.now() - start < TIMEOUT_MS) {
      await sleep(POLL_MS);
      login = await checkLogin();
      if (login.isLogin) {
        writeStatus({ state: "LOGGED_IN", uname: login.uname, mid: login.mid, via: login.via || "api", qrVersion });
        await ctx.close(); return;
      }
      const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
      if (/已失效|已过期|二维码过期|点击刷新/.test(bodyText)) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await sleep(3000);
        qrFile = await shotQR();
        lastShot = Date.now();
        writeStatus({ state: "QR_REFRESHED", qrFile, qrVersion, note: "expiry overlay" });
        continue;
      }
      if (/按住滑块|拖动滑块|请完成验证/.test(bodyText)) {
        const cap = path.join(ROOT, ".runtime", "bilibili-captcha.png");
        await page.screenshot({ path: cap }).catch(() => {});
        writeStatus({ state: "CAPTCHA", captchaFile: cap, qrVersion });
        await ctx.close(); return;
      }
      if (Date.now() - lastShot > REFRESH_MS) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await sleep(3000);
        qrFile = await shotQR();
        lastShot = Date.now();
        writeStatus({ state: "QR_REFRESHED", qrFile, qrVersion, note: "periodic 150s refresh" });
        continue;
      }
      if (Date.now() - lastBeat > 30000) {
        lastBeat = Date.now();
        writeStatus({ state: "WAITING", qrFile, qrVersion });
      }
    }
    writeStatus({ state: "TIMEOUT", qrVersion });
    await ctx.close();
  } catch (e) {
    writeStatus({ state: "ERROR", error: String((e && e.message) || e) });
    try { await ctx.close(); } catch {}
    process.exitCode = 1;
  }
})();

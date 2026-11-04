const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const limitFile = root => path.join(root, "automation", "platform_limits.json");

function beijingDay(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

function classifyPublishResponse(payload, httpStatus, now = new Date()) {
  const code = String(payload?.code ?? "");
  const message = String(payload?.message ?? payload?.msg ?? "").slice(0, 500);
  if (code === "-1020" && /更新连载模式作品数超出每日上限/.test(message)) {
    const tomorrow = new Date(Date.parse(beijingDay(now) + "T00:00:00+08:00") + 86400000);
    return { status: "waiting_platform_limit", code, message,
      observedAt: now.toISOString(), retryAfter: tomorrow.toISOString(),
      retryPolicy: "next_beijing_day_not_guaranteed_reset" };
  }
  if (httpStatus >= 200 && httpStatus < 300 && code === "0") return { status: "accepted", code };
  return { status: "failed", code, message: message || "平台发布响应无有效成功码" };
}

function recordPlatformLimit(platform, limit, root = ROOT) {
  const file = limitFile(root);
  const records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  records[platform] = limit;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(records, null, 2) + "\n");
  fs.renameSync(file + ".tmp", file);
}

function activePlatformLimit(platform, root = ROOT, now = new Date()) {
  const file = limitFile(root);
  if (!fs.existsSync(file)) return null;
  const limit = JSON.parse(fs.readFileSync(file, "utf8"))[platform];
  if (!limit) return null;
  if (!Number.isFinite(Date.parse(limit.retryAfter))) throw new Error("平台限制重试时间无效，保留现场");
  return Date.parse(limit.retryAfter) > now.getTime() ? limit : null;
}

module.exports = { beijingDay, classifyPublishResponse, recordPlatformLimit, activePlatformLimit };

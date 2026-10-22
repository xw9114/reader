#!/bin/bash
# 小说日更流水线（由青龙每日任务经 SSH 在宿主机执行）：
# 拉取 GitHub 最新 → 重建 dist → 补缺失台账 → 各书队列存草稿 → 每日自动发布（可选） → 本地状态提交并回推。
# 队列名单读 automation/wired_books.json（控制台「接入并建书」成功后会自动追加）。
# 自动发布仅当 READER_AUTO_PUBLISH=1 时执行（青龙 09:10 包装脚本会带上；控制台「立即同步」不带，手动同步不发文）。
# 任一环节失败即停（set -e），失败原因留在青龙日志里；单本书存草稿/发布失败不阻塞（|| true）。
set -e
cd /root/reader
export GIT_SSH_COMMAND="ssh -i /root/.ssh/github-deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

commit_if_dirty() {
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -q -m "$1" || true
  fi
}

echo "[1/6] 提交本地状态并拉取"
commit_if_dirty "chore(auto): sync local state $(date +%F)"
git pull --rebase origin main

echo "[2/6] 重建 dist"
python3 tools/build_publish.py

echo "[3/6] 补建缺失台账"
python3 automation/sync_ledgers.py

echo "[4/6] 队列存草稿（名单来自 wired_books.json）"
python3 - << 'PYEOF' > /tmp/wired-list.txt
import json
try:
    rows = json.load(open("automation/wired_books.json"))
except Exception as e:
    print("# wired_books.json 读取失败:", e)
    rows = []
for r in rows:
    print("\t".join([r["book"], r["platform"], r["url"]]))
PYEOF
while IFS=$'\t' read -r book platform url; do
  [ -z "$book" ] && continue
  case "$book" in \#*) echo "  跳过：$book"; continue;; esac
  echo "  → $book（$platform）"
  READER_HEADLESS=1 node automation/run_pending_publish.js --platform "$platform" --book-id "$book" --url "$url" || true
done < /tmp/wired-list.txt

echo "[5/6] 每日自动发布（每本 1 章）"
if [ "$READER_AUTO_PUBLISH" = "1" ]; then
  node automation/auto_publish.js || true
else
  echo "  未开启（READER_AUTO_PUBLISH != 1），跳过"
fi

echo "[6/6] 提交并回推"
commit_if_dirty "chore(auto): daily run $(date +%F)"
git push origin main
echo "DAILY_SYNC_OK"

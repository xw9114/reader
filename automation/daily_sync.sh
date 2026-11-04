#!/bin/bash
# 小说日更流水线（由青龙每日任务经 SSH 在宿主机执行）：
# 拉取 GitHub 最新 → 重建 dist → 补缺失台账 → 各书队列存草稿 → 每日自动发布（可选） → 本地状态提交并回推。
# 队列名单读 automation/wired_books.json（控制台「接入并建书」成功后会自动追加）。
# 自动发布仅当 READER_AUTO_PUBLISH=1 时执行（青龙 09:10 包装脚本会带上；控制台「立即同步」不带，手动同步不发文）。
# 基础环节失败即停；单书失败继续处理其他书并同步台账，最终以部分失败退出。
set -e
cd /root/reader
export GIT_SSH_COMMAND="ssh -i /root/.ssh/github-deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes"
mkdir -p .runtime/locks
exec 9>.runtime/locks/daily-sync.lock
if ! flock -n 9; then
  echo "DAILY_SYNC_ALREADY_RUNNING"
  exit 0
fi
partial_failures=0

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
rows = json.load(open("automation/wired_books.json"))
for r in rows:
    print("\t".join([r["book"], r["platform"], r["url"]]))
PYEOF
while IFS=$'\t' read -r book platform url; do
  [ -z "$book" ] && continue
  case "$book" in \#*) echo "  跳过：$book"; continue;; esac
  echo "  → $book（$platform）"
  if ! READER_HEADLESS=1 node automation/run_pending_publish.js --platform "$platform" --book-id "$book" --url "$url"; then
    echo "DRAFT_SAVE_FAIL $book"
    partial_failures=$((partial_failures + 1))
  fi
done < /tmp/wired-list.txt

echo "[5/6] 每日自动发布（每本 1 章）"
if [ "$READER_AUTO_PUBLISH" = "1" ]; then
  if ! node automation/auto_publish.js; then
    partial_failures=$((partial_failures + 1))
  fi
else
  echo "  未开启（READER_AUTO_PUBLISH != 1），跳过"
fi

echo "[6/6] 提交并回推"
commit_if_dirty "chore(auto): daily run $(date +%F)"
python3 automation/sync_git.py
if [ "$partial_failures" -gt 0 ]; then
  echo "DAILY_SYNC_PARTIAL_FAILURE count=$partial_failures"
  exit 1
fi
echo "DAILY_SYNC_OK"

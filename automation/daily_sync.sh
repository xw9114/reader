#!/bin/bash
# 小说日更流水线（由青龙每日任务经 SSH 在宿主机执行）：
# 拉取 GitHub 最新 → 重建 dist → 补缺失台账 → 各书队列存草稿 → 本地状态提交并回推。
# 任一环节失败即停（set -e），失败原因留在青龙日志里。
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

echo "[4/6] 队列存草稿：《旧城清算》（番茄）"
READER_HEADLESS=1 node automation/run_pending_publish.js --platform fanqie --book-id 旧城清算 --url "https://fanqienovel.com/main/writer/7688994762841394200/publish/?enter_from=newchapter_1" || true

echo "[5/6] 队列存草稿：《我在规则怪谈里搞绩效考核》（番茄）"
READER_HEADLESS=1 node automation/run_pending_publish.js --platform fanqie --book-id yinsi-linshigong --url "https://fanqienovel.com/main/writer/7699380588012112920/publish/?enter_from=newchapter_1" || true

echo "[6/6] 提交并回推"
commit_if_dirty "chore(auto): daily run $(date +%F)"
git push origin main
echo "DAILY_SYNC_OK"

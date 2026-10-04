# 《旧城清算》每日连载

本项目支持多部长篇并存。每本书的配置、已发布正文和运行记录分别保存在 `books/<作品目录>/book.json`、`books/<作品目录>/published/` 与 `books/<作品目录>/runs/`。《旧城清算》目标为 100 章，每章约 2500 个汉字。

定时任务在北京时间 17:00、19:00、21:00 尝试运行 `ops/daily-serial.py`。脚本持有独立锁，从 2026-09-20 起选择最早缺失的日期；一个日期只对应一章。章节少于 2000 个汉字或 InkOS 状态异常时不会发布。成功后只提交 `serial/` 路径，并核对 GitHub `main` 与本地提交。

21:30 的 `ops/healthcheck.py` 核对当日章节、正文长度、InkOS 源文件、发布记录及 GitHub 提交。小说 API 密钥由 `ops/inkos-with-secret.py` 在进程内读取 OpenClaw Secret Store，不写入仓库。

手动运行（腾讯云 VPS）：

```bash
cd /srv/projects/inkos-novels/serial
python3 ops/daily-serial.py
python3 ops/healthcheck.py
```

脚本默认处理《旧城清算》。需要为其他书运行时设置作品目录名：

```bash
SERIAL_BOOK_ID='另一部作品' python3 ops/daily-serial.py
SERIAL_BOOK_ID='另一部作品' python3 ops/healthcheck.py
```

写作日志位于 `/var/log/openclaw-jobs/serial-chapter-*.log`。切换前的短篇脚本、`daily/` 成品和定时任务配置备份保留在原项目中。

本连载需要给 InkOS 1.8.0 的 `provider.js` 应用 `ops/provider-serial.patch`：基础文件 SHA-256 为 `4380a5bc8b02d8e8b82941c256874d7bdc9dfc1a8f1cfaa9a5c218a402dc6c54`，打补丁后应为 `bff513da7fa7b4c8e5a6da82bbbb98186b36da19ae7d158015e0419f3bc3781f`。补丁只在进程设置 `INKOS_SERIAL_MAX_TOKENS` 时限制输出上限，同时修正 HTTP 524 的错误分类。服务器的已部署副本和旧版备份分别位于 `../ops/inkos-1.8.0-patched/provider.js` 与 `../ops/backups/20260920-serial-novel/provider.js`。

回滚时恢复 `../ops/backups/20260920-serial-novel/` 中的旧 provider、短篇脚本及两份 cron 配置；旧短篇成品一直保留在 `daily/`。

## InkOS 发布标签

新建作品必须通过密钥包装器运行 InkOS。InkOS 完成大纲、角色卡和世界观等基础文件后，包装器会调用同一模型生成结构化发布标签，并写入新作品的 `book.json`：

```bash
cd /srv/projects/inkos-novels/serial
python3 ops/inkos-with-secret.py book create --title "作品名" --genre urban --platform tomato --brief brief.md
```

`publishingHint` 包含读者方向、1 至 2 个阅读标签、1 至 4 个内容标签，以及情节、情感、人设、世界观四组标签。顶层 `volumes` 保存卷号、卷名和连续的起止章节。现实背景允许世界观为空，不会为了填满数量强加言情、系统、复仇、重生或穿越标签。`tools/build_publish.py` 会校验标签和分卷范围；新连载缺少字段、超过数量限制、卷号断档或章节范围不连续时停止构建。

旧作品需要重建标签时运行：

```bash
python3 ops/inkos-with-secret.py publishing refresh <book-id>
```

Reader 扩展优先显示 `book.json` 的 InkOS 标签，并明确标记来源。只有没有 `publishingHint` 的旧 Markdown 作品才使用标题和正文推断。在番茄章节管理页，扩展进入“番茄 · 分卷”模式；选择规划中的卷并打开平台的“编辑分卷”或“新建分卷”表单后，可填入卷名，最终保存仍需人工确认。

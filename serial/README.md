# 《旧城清算》每日连载

本项目在同一部长篇中每天续写一章。目标为 100 章，每章约 2500 个汉字。正文分别发布到 `published/YYYY-MM-DD-chapter-NNNN.md`，`books/旧城清算/` 保存 InkOS 的全书设定、人物卡、章节和连续性状态。

定时任务在北京时间 17:00、19:00、21:00 尝试运行 `ops/daily-serial.py`。脚本持有独立锁，从 2026-09-20 起选择最早缺失的日期；一个日期只对应一章。章节少于 2000 个汉字或 InkOS 状态异常时不会发布。成功后只提交 `serial/` 路径，并核对 GitHub `main` 与本地提交。

21:30 的 `ops/healthcheck.py` 核对当日章节、正文长度、InkOS 源文件、发布记录及 GitHub 提交。小说 API 密钥由 `ops/inkos-with-secret.py` 在进程内读取 OpenClaw Secret Store，不写入仓库。

手动运行（腾讯云 VPS）：

```bash
cd /srv/projects/inkos-novels/serial
python3 ops/daily-serial.py
python3 ops/healthcheck.py
```

写作日志位于 `/var/log/openclaw-jobs/serial-chapter-*.log`。切换前的短篇脚本、`daily/` 成品和定时任务配置备份保留在原项目中。回滚时恢复旧定时任务命令及 `ops/backups/20260920-serial-novel/` 中的 InkOS provider，并同步旧运行器中的 provider 哈希。

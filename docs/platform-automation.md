# 平台自动上传

Reader 的平台自动化分为两步：

1. `automation/publish_queue.js` 打开已登录的浏览器配置，填写指定章节并保存草稿。
2. `automation/run_pending_publish.js` 扫描 `runs/*.json`，选择最新处于 `pending` 或 `failed` 的章节执行，避免首次启用时回放整个历史 backlog。

## 首次配置

先用 Edge 或 Chromium 登录番茄/七猫作者后台。登录配置会保存在：

```text
.runtime/browser-profiles/fanqie
.runtime/browser-profiles/qimao
```

不要把这些目录提交到 Git。

为每个平台设置章节地址模板：

```powershell
$env:FANQIE_CHAPTER_URL = "https://fanqienovel.com/main/writer/<作品>/publish/<章节>"
$env:QIMAO_CHAPTER_URL = "https://zuozhe.qimao.com/<作品>/chapter/<章节>"
```

模板支持 `{bookId}`、`{storyId}` 和 `{chapter}`。

## 手动试运行

默认只保存草稿：

```powershell
npm run publish:pending -- --platform fanqie --book-id lianai-daka
```

明确传入 `--publish` 才会尝试点击发布按钮：

```powershell
npm run publish:pending -- --platform fanqie --book-id lianai-daka --publish
```

检测到登录页、验证码、安全验证、缺少标题框、缺少正文框或缺少安全保存按钮时，任务会失败并写入对应运行记录，不会继续点击其他按钮。

同一平台同时只允许一个发布任务运行。任务启动时会创建 `.runtime/locks/publish-fanqie.lock` 或 `.runtime/locks/publish-qimao.lock`；重复启动会直接失败，任务正常结束后自动释放。

## 定时运行

Windows 任务计划程序或 Linux cron 都可以调用 `npm run publish:pending`。建议先只保存草稿，连续验证几天后再考虑启用 `--publish`。平台页面改版后，应先使用 `--dry-run` 验证，不要直接恢复无人值守发布。

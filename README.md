# Reader

`serial/books/<作品目录>/published/` 中的章节会按作品分别合并成长篇，`daily/` 中的短篇和单文件小说也会保留在发布页。

## 使用方式

1. 每部长篇使用独立的 `serial/books/<作品目录>/book.json` 与 `published/`；短篇仍在 `daily/`。
2. GitHub Actions 将每本书的章节分别归档，并部署 GitHub Pages。
3. 手机打开 `https://xw9114.github.io/reader/`，选择作品和章节。
4. 点击“复制标题”或“复制正文”，粘贴到作者平台；也可以安装电脑端导入工具自动填入番茄或七猫后台。

短篇的首个一级标题作为作品名，二级标题作为章节名。长篇章节的一级标题作为章节名，作品名、Reader ID、标签和分卷来自同目录的 `book.json`。

## 多长篇书库

每部长篇使用一个独立目录：

```text
serial/books/<作品目录>/
├─ book.json
├─ published/
│  ├─ 2026-10-04-chapter-0001.md
│  └─ 2026-10-05-chapter-0002.md
└─ runs/                 # 自动连载记录，可选
```

`book.json` 至少需要作品名、稳定的 `readerId`、发布标签和覆盖完整目标章节数的分卷计划。章节编号必须从 1 连续递增，不同作品可以各自拥有第 1 章。示例见 [`docs/serial-book-template.json`](docs/serial-book-template.json)。添加第二部长篇时复制模板到新的作品目录，再把章节放入该目录的 `published/`。

《旧城清算》保留 `readerId: "serial-main"`，因此已有封面 `covers/serial-main.png`、下载链接和扩展选择记录继续有效。未填写 `readerId` 时，构建器使用 `serial-<作品目录名>`；正式发布后不要再修改这个 ID。

导入其他 AI 生成的长篇时：

1. 新建 `serial/books/<新作品名>/published/`。
2. 将模板复制为同目录的 `book.json`，填写作品名、唯一 `readerId`、实际标签、目标章节数和分卷范围；`publishingHint.source` 使用 `external-ai`。
3. 每章保存为 `published/YYYY-MM-DD-chapter-NNNN.md`，正文第一行使用 `# 第N章 标题`，编号从 `0001` 连续递增。
4. 运行 `python tools/build_publish.py`；Reader 会把它作为一部独立长篇加入作品选择框。

不同长篇的章节编号、分卷和更新日期互不影响。封面仍放在 `covers/<readerId>.png`。

每次自动连载运行会在 `runs/YYYY-MM-DD.json` 中记录本地发布状态，以及番茄和七猫各自的上传状态：

```json
{
  "platforms": {
    "fanqie": {"status": "pending"},
    "qimao": {"status": "pending"}
  }
}
```

平台状态可用 `pending`、`draft_saved`、`published` 和 `failed` 表示。平台自动化任务应根据章节内容哈希和平台状态重试，避免重复上传；遇到登录失效或验证码时应停在 `failed` 并通知人工处理。

## 平台自动上传

可以使用 `automation/publish_queue.js` 自动打开已经登录的浏览器配置、填写章节并保存草稿：

```powershell
$env:FANQIE_CHAPTER_URL = "https://fanqienovel.com/main/writer/<作品>/publish/<章节>"
npm run publish:queue -- --platform fanqie --book-id lianai-daka --chapter 7
```

地址模板支持 `{bookId}`、`{storyId}` 和 `{chapter}`。默认只保存草稿；确认平台页面和选择器稳定后，才使用 `--publish` 开启最终发布。浏览器配置保存在 `.runtime/browser-profiles/<platform>`，不要把该目录提交到 Git。检测到登录页、验证码或找不到安全按钮时，任务会记录为 `failed` 并停止。

发布页同时提供整篇 TXT、原始 Markdown、逐章 ZIP、每篇作品对应的竖版封面和电脑端导入扩展。扩展在番茄、七猫的作品信息或短故事页面中显示封面预览；打开平台封面上传控件后，点击“填入封面”即可选择当前作品的图片，最终保存仍由作者确认。

构建器会为没有自定义图片的作品生成独立默认封面。要替换封面，可以把 `PNG/JPEG/WebP/SVG` 放进 `covers/`，文件名使用作品 `id`（例如 `serial-main.png`），然后重新构建。

也可以使用已经配置好的 Sub2API 图片接口批量生成封面。脚本默认调用
`https://api.xw9114.online/v1/images/generations`，模型为 `gpt-image-2`，只需在本机临时设置当前 Gateway Token：

```powershell
python tools/build_publish.py
$env:READER_IMAGE_API_KEY = "当前 Gateway Token"
python tools/generate_covers.py
python tools/build_publish.py
$env:READER_IMAGE_API_KEY = $null
```

可通过 `--story-id serial-main` 只生成指定作品；已有图片默认跳过，需重做时加 `--force`。如需切换其他 OpenAI 兼容服务，可覆盖 `READER_IMAGE_BASE_URL`、`READER_IMAGE_MODEL`、`READER_IMAGE_SIZE` 和 `READER_IMAGE_OUTPUT_FORMAT`。Gateway Token 不写入仓库、网页或扩展。

## 本地预览

```powershell
python tools/build_publish.py
python -m http.server 8000 -d dist
```

打开 `http://localhost:8000`。

## 电脑端小说平台导入工具

1. 在发布页下载“电脑导入工具”并解压。
2. Chrome 或 Edge 打开扩展管理页，开启开发者模式。
3. 点击“加载已解压的扩展程序”，选择解压目录。
4. 登录番茄网页作者后台或七猫作者中心。
5. 在右下角“Reader 导入助手”中选择作品。番茄支持章节和短故事；七猫支持作品信息和章节编辑页。

扩展会自动识别平台和当前编辑器类型。七猫作品信息模式填写作品名称与简介草稿，分类、读者方向、标签、角色等仍需人工选择；扩展不会代替作者确认创建或点击最终发布。

在番茄或七猫章节编辑页，助手会为当前章节显示一条不超过 42 字的“章末互动”。文案会在剧情讨论、人物站队、轻松闲聊、阅读习惯和简短感谢之间稳定轮换，不要求每章都提问或求评论。先在平台上打开“作者有话说”“有话说”或“章末寄语”输入区，再点击“填入章末互动”；助手只填文字，不会保存或发布，也不会写进七猫随记。

构建输出和扩展消息格式见 [`docs/publishing-import-contract.md`](docs/publishing-import-contract.md)。

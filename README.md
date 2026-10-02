# Reader

`serial/published/` 中的长篇章节会合并为同一部作品，`daily/` 中的旧短篇也会保留在手机发布页。

## 使用方式

1. 长篇每天新增一个 `serial/published/YYYY-MM-DD-chapter-NNNN.md` 文件；旧短篇仍在 `daily/`。
2. GitHub Actions 将连载章节归到同一部作品，并部署 GitHub Pages。
3. 手机打开 `https://xw9114.github.io/reader/`，选择作品和章节。
4. 点击“复制标题”或“复制正文”，粘贴到作者平台；也可以安装电脑端导入工具自动填入番茄或七猫后台。

旧短篇的首个一级标题作为作品名，二级标题作为章节名。长篇章节的一级标题作为章节名，作品名来自 `serial/books/*/book.json`。

发布页同时提供整篇 TXT、原始 Markdown、逐章 ZIP 和电脑端导入扩展。

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

构建输出和扩展消息格式见 [`docs/publishing-import-contract.md`](docs/publishing-import-contract.md)。

# Reader

`serial/published/` 中的长篇章节会合并为同一部作品，`daily/` 中的旧短篇也会保留在手机发布页。

## 使用方式

1. 长篇每天新增一个 `serial/published/YYYY-MM-DD-chapter-NNNN.md` 文件；旧短篇仍在 `daily/`。
2. GitHub Actions 将连载章节归到同一部作品，并部署 GitHub Pages。
3. 手机打开 `https://xw9114.github.io/reader/`，选择作品和章节。
4. 点击“复制标题”或“复制正文”，粘贴到番茄作家助手。

旧短篇的首个一级标题作为作品名，二级标题作为章节名。长篇章节的一级标题作为章节名，作品名来自 `serial/books/*/book.json`。

## 本地预览

```powershell
python tools/build_publish.py
python -m http.server 8000 -d dist
```

打开 `http://localhost:8000`。

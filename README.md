# Reader

`daily/` 中的 Markdown 小说会自动构建为适合手机使用的章节发布页。

## 使用方式

1. 将小说 Markdown 文件提交到 `daily/`。
2. GitHub Actions 自动拆分二级标题章节并部署 GitHub Pages。
3. 手机打开 `https://xw9114.github.io/reader/`，选择作品和章节。
4. 点击“复制标题”或“复制正文”，粘贴到番茄作家助手。

文件首个一级标题作为作品名，二级标题作为章节名。没有二级标题的文件会作为单章处理。

## 本地预览

```powershell
python tools/build_publish.py
python -m http.server 8000 -d dist
```

打开 `http://localhost:8000`。

#!/usr/bin/env python3
"""补建缺失的章节台账（runs/），供小说自动上传队列使用。

规则：
- 只补缺失的台账文件，绝不覆盖或修改已有台账。
- 字数 = 正文（去掉首行标题后）的汉字数；sha256 = 章节 md 文件的哈希。
  （已用《旧城清算》原始台账校准无误。）
- 平台状态：某平台只要在本书任一已有台账中被标为 skipped，新台账里继续
  skipped（防误投）；否则一律 pending。新书（无任何台账）按 book.json 的
  platform 决定目标平台 pending、另一平台 skipped。
- 特殊书的人工结论都体现在已有台账的 skipped 标记里，本脚本只继承、不推翻。
"""
import datetime, glob, hashlib, io, json, os, re, sys

BOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "serial", "books")
CJK = re.compile(r"[\u4e00-\u9fff]")

def cjk_body(text):
    if "\n## " in text:
        body = text[text.index("\n## ") + 1:]
    else:
        lines = text.split("\n")
        body = "\n".join(lines[1:]) if lines and lines[0].startswith("#") else text
    return len(CJK.findall(body))

def main():
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    created = []
    for book_dir in sorted(glob.glob(os.path.join(BOOKS, "*"))):
        if not os.path.isdir(book_dir):
            continue
        name = os.path.basename(book_dir)
        runs_dir = os.path.join(book_dir, "runs")
        os.makedirs(runs_dir, exist_ok=True)
        existing = {}
        skipped = set()
        for f in glob.glob(os.path.join(runs_dir, "*.json")):
            try:
                rec = json.load(io.open(f, encoding="utf8"))
            except Exception:
                continue
            existing[rec.get("chapter")] = f
            for platform, info in (rec.get("platforms") or {}).items():
                if isinstance(info, dict) and info.get("status") == "skipped":
                    skipped.add(platform)
        bj = json.load(io.open(os.path.join(book_dir, "book.json"), encoding="utf8"))
        target = "fanqie" if bj.get("platform") == "tomato" else "qimao"
        other = "qimao" if target == "fanqie" else "fanqie"
        if not existing:
            skipped = {other}
        for pub in sorted(glob.glob(os.path.join(book_dir, "published", "*.md"))):
            fname = os.path.basename(pub)
            m = re.search(r"chapter-(\d+)\.md$", fname)
            if not m:
                continue
            chapter = int(m.group(1))
            if chapter in existing:
                continue
            date = fname[:10]
            text = io.open(pub, encoding="utf8").read()
            platforms = {}
            for platform in ("fanqie", "qimao"):
                status = "skipped" if platform in skipped else "pending"
                platforms[platform] = {"status": status, "updatedAt": now}
            rec = {
                "date": date,
                "chapter": chapter,
                "bookId": name,
                "createdAt": now,
                "status": "published",
                "characters": cjk_body(text),
                "sha256": hashlib.sha256(io.open(pub, "rb").read()).hexdigest(),
                "publishedAt": now,
                "platforms": platforms,
                "note": "台账由 sync_ledgers.py 于 %s 自动补建（正文已入库、台账缺失）；平台状态继承本书已有台账的 skipped 标记，其余为 pending。createdAt/publishedAt 为补建时间。" % now[:10],
            }
            out = os.path.join(runs_dir, "%s-chapter-%04d.json" % (date, chapter))
            with io.open(out, "w", encoding="utf8") as fh:
                json.dump(rec, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            created.append("%s ch%d" % (name, chapter))
    print(json.dumps({"created": created, "count": len(created)}, ensure_ascii=False))

if __name__ == "__main__":
    main()

import json
import tempfile
import unittest
from pathlib import Path

from tools.build_publish import build, parse_story


class BuildPublishTests(unittest.TestCase):
    def test_splits_story_into_plain_text_chapters(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "2026-09-19-example.md"
            path.write_text(
                "# 测试小说\n\n## 第1章 开始\n\n这是**正文**。\n\n## 第2章 继续\n\n[链接文字](https://example.com)\n",
                encoding="utf-8",
            )

            story = parse_story(path)

        self.assertEqual(story["title"], "测试小说")
        self.assertEqual(story["date"], "2026-09-19")
        self.assertEqual(len(story["chapters"]), 2)
        self.assertEqual(story["chapters"][0]["body"], "这是正文。")
        self.assertEqual(story["chapters"][1]["body"], "链接文字")

    def test_build_writes_data_and_bom_txt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "daily"
            site = root / "site"
            output = root / "dist"
            source.mkdir()
            site.mkdir()
            (source / "2026-09-19-example.md").write_text(
                "# 测试小说\n\n正文内容。\n",
                encoding="utf-8",
            )
            (site / "index.html").write_text("ok", encoding="utf-8")

            stories = build(source, site, output)
            payload = json.loads((output / "data.json").read_text(encoding="utf-8"))
            txt = (output / stories[0]["download"]).read_bytes()

        self.assertEqual(payload["storyCount"], 1)
        self.assertEqual(payload["stories"][0]["chapters"][0]["body"], "正文内容。")
        self.assertTrue(txt.startswith(b"\xef\xbb\xbf"))


if __name__ == "__main__":
    unittest.main()

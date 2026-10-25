import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.import_novel_studio import import_book


class ImportNovelStudioTests(unittest.TestCase):
    def test_import_normalizes_final_manuscript_before_saving(self):
        with tempfile.TemporaryDirectory() as directory:
            serial = Path(directory) / "serial"
            with patch("tools.import_novel_studio.fetch_json", side_effect=[
                {"title": "面光", "genre": "女性成长"},
                {"status": "PASS"},
                [{"number": 1, "title": "第一章 四十天", "word_count": 2000}],
                {"final": "# 第一章 四十天\n\n最终正文。", "draft": "草稿正文。"},
            ]):
                result = import_book(
                    "https://example.test", ("test", "test"),
                    "project", "serial-test", serial, "2026-10-24", False,
                )
            chapter = serial / "books" / "serial-test" / "published" / "2026-10-24-chapter-0001.md"
            self.assertEqual(chapter.read_text(encoding="utf-8"), "# 第1章 四十天\n\n最终正文。\n")
            self.assertNotIn(b"\r\n", chapter.read_bytes())
            self.assertEqual(result["chapters"], 1)

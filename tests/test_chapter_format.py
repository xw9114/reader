import unittest

from tools.chapter_format import normalize_chapter


class ChapterFormatTests(unittest.TestCase):
    def test_removes_matching_heading_with_chinese_or_arabic_number(self):
        for duplicate in ("# 第一章 四十天", "## 第１章：四十天", "Chapter 1 四十天"):
            with self.subTest(duplicate=duplicate):
                self.assertEqual(
                    normalize_chapter(1, "四十天", f"{duplicate}\n\n正文。\n\n第二段。"),
                    ("第1章 四十天", "正文。\n\n第二段。"),
                )

    def test_collapses_nested_numbers_in_title_and_body(self):
        self.assertEqual(
            normalize_chapter(
                10, "第10章 第十章 实名",
                "# 第10章 第十章 实名\r\n\r\n# 第十章 实名\r\n\r\n第十三天上午。\r\n",
            ),
            ("第10章 实名", "第十三天上午。"),
        )

    def test_keeps_different_headings_and_prose(self):
        for body in (
            "第一章正文。\n\n下一段。",
            "# 第二章 四十天\n\n正文。",
            "# 第一章 另一个标题\n\n正文。",
            "四十天\n\n这是人物的一句话。",
            "第十三天上午八点四十分，窗口还没开。",
            "正文。\n\n---\n\n尾声。\n\n**一段强调**。",
        ):
            with self.subTest(body=body):
                self.assertEqual(normalize_chapter(1, "四十天", body), ("第1章 四十天", body))

    def test_title_can_contain_other_numbers(self):
        self.assertEqual(
            normalize_chapter(6, "第七行代码", "正文。"),
            ("第6章 第七行代码", "正文。"),
        )

    def test_normalization_is_idempotent(self):
        first = normalize_chapter(12, "第十二章 重签", "# 第十二章 重签\n\n正文。")
        self.assertEqual(normalize_chapter(12, *first), first)

    def test_builder_preserves_existing_title_style(self):
        for title in ("第一章 四十天", "第1章 四十天", "Chapter 1 四十天", "四十天"):
            with self.subTest(title=title):
                self.assertEqual(
                    normalize_chapter(1, title, "正文。", preserve_title_style=True),
                    (title, "正文。"),
                )

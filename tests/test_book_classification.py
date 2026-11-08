import json
import tempfile
import unittest
from pathlib import Path

from reader_schema import book_manuscript_status, book_writing_mode
from tools.build_publish import parse_serial_book, write_story_downloads
from tools.import_novel_studio import imported_writing_mode


class BookClassificationTests(unittest.TestCase):
    def test_classifies_planned_length_instead_of_current_chapters(self):
        self.assertEqual(book_writing_mode({"targetChapters": 6}), "short")
        self.assertEqual(book_writing_mode({"targetChapters": 49}), "short")
        self.assertEqual(book_writing_mode({"targetChapters": 50}), "long")
        self.assertEqual(book_writing_mode({"targetChapters": 100}), "long")
        self.assertEqual(book_writing_mode({"writingMode": "long", "targetChapters": 6}), "long")
        self.assertEqual(book_writing_mode({}), "long")
        with self.assertRaises(ValueError):
            book_writing_mode({"writingMode": "unknown"})

    def test_completion_is_independent_from_automation_status(self):
        self.assertEqual(book_manuscript_status({"status": "active", "targetChapters": 6}, 6), "complete")
        self.assertEqual(book_manuscript_status({"status": "active", "targetChapters": 100}, 15), "ongoing")
        self.assertEqual(book_manuscript_status({"targetChapters": 6, "manuscriptStatus": "ongoing"}, 6), "ongoing")
        self.assertEqual(book_manuscript_status({"status": "active"}, 6), "ongoing")

    def test_import_prefers_explicit_source_length_contract(self):
        self.assertEqual(imported_writing_mode({"target_word_count": 15000}, 6), "short")
        self.assertEqual(imported_writing_mode({"target_word_count": 400000}, 6), "long")
        self.assertEqual(imported_writing_mode({}, 160), "long")
        self.assertEqual(imported_writing_mode({}, 6, {"targetChapters": 100}), "long")
        self.assertEqual(imported_writing_mode({"target_word_count": 15000}, 6, {"writingMode": "long"}), "long")

    def test_serial_storage_keeps_ids_volumes_text_and_downloads_for_both_lengths(self):
        for target, mode, status in [(6, "short", "complete"), (100, "long", "ongoing")]:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                serial = root / "serial"
                book_dir = serial / "books" / "same-book"
                published = book_dir / "published"
                published.mkdir(parents=True)
                book_path = book_dir / "book.json"
                book = {
                    "readerId": "same-reader-id", "title": "测试作品", "targetChapters": target,
                    "publishingHint": {"schemaVersion": 1, "source": "manual", "audience": "女频",
                        "readingTags": ["现实题材"], "contentTags": ["成长"],
                        "tagDimensions": {"plot": [], "emotion": [], "persona": [], "worldview": []}},
                    "volumes": [{"number": 1, "title": "全书", "startChapter": 1, "endChapter": target}],
                }
                book_path.write_text(json.dumps(book, ensure_ascii=False), encoding="utf-8")
                for number in range(1, 7):
                    (published / f"2026-11-03-chapter-{number:04d}.md").write_text(
                        f"# 第{number}章 测试\n\n保留正文{number}。\n", encoding="utf-8")
                story, paths = parse_serial_book(book_path, published, serial)
                self.assertEqual(story["id"], "same-reader-id")
                self.assertEqual(story["kind"], "daily" if mode == "short" else "serial")
                self.assertEqual(story["storageKind"], "serial")
                self.assertEqual(story["writingMode"], mode)
                self.assertEqual(story["manuscriptStatus"], status)
                self.assertEqual(len(story["chapters"]), 6)
                self.assertEqual(story["chapters"][5]["body"], "保留正文6。")
                (root / "downloads").mkdir()
                write_story_downloads(story, paths, root)
                self.assertIn("保留正文6。", (root / story["downloads"]["md"]).read_text(encoding="utf-8-sig"))

    def test_single_chapter_short_from_serial_keeps_book_title_in_download(self):
        from tools.build_publish import story_downloads
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "downloads").mkdir()
            source = root / "chapter.md"
            source.write_text("# 第1章 结局\n\n正文。", encoding="utf-8")
            story = {"id": "book", "title": "作品名", "kind": "daily", "storageKind": "serial",
                "downloads": story_downloads("book"), "fullText": "第1章 结局\n\n正文。",
                "chapters": [{"title": "第1章 结局", "body": "正文。"}]}
            write_story_downloads(story, [source], root)
            self.assertTrue((root / story["downloads"]["md"]).read_text(encoding="utf-8-sig").startswith("# 作品名"))


if __name__ == "__main__":
    unittest.main()

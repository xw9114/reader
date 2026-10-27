import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.import_novel_studio import import_book
from tools.publishing_metadata import resolve_publishing_metadata


class PublishingMetadataTests(unittest.TestCase):
    def test_verified_viewpoint_names_for_all_imported_projects(self):
        books = json.loads((Path(__file__).parent / "fixtures/novel_studio_metadata.json").read_text(encoding="utf-8"))
        expected = {
            "面光": "苏禾", "深井档案": "程蔚", "捕雾塔的第七行代码": "齐湄",
            "停摆的陀飞轮": "关雨舟", "缓存的春天": "温晓",
            "采样瓶上的编号": "杜明霞", "晒场上的一九九一": "梁满仓", "光谱下的第七层": "许知蔓",
        }
        for book in books:
            with self.subTest(book=book["title"]):
                metadata = resolve_publishing_metadata(
                    {"premise": book["premise"]}, {}, book["opening"],
                )
                self.assertEqual(metadata["protagonist"], expected[book["title"]])
                self.assertGreater(len(metadata["synopsis"]), 60)
                self.assertNotIn("分章走向", metadata["synopsis"])
                self.assertNotIn("全书6章", metadata["synopsis"])
                self.assertNotIn("主要人物", metadata["synopsis"])
                self.assertNotIn("人物共", metadata["synopsis"])

    def test_ambiguous_or_uncorroborated_viewpoint_is_rejected(self):
        for premise in (
            "张三与李四反复交谈，张三说话，李四回答。",
            "始终跟随工程师张三。张三与李四交谈。",
            "始终跟随工程师张三。张三交谈。始终跟随会计李四。李四回答。",
        ):
            manuscript = "李四回答。" if premise.startswith("始终跟随工程师张三。张三与") else premise
            with self.subTest(premise=premise), self.assertRaisesRegex(ValueError, "主角名"):
                resolve_publishing_metadata({"premise": premise, "synopsis": "Explicit synopsis"}, {}, manuscript)

    def test_explicit_fields_and_authored_metadata_are_preserved(self):
        result = resolve_publishing_metadata(
            {"protagonist": "new", "synopsis": "new"}, {"protagonist": "saved", "summary": "authored"}, "",
        )
        self.assertEqual(result, {"protagonist": "saved", "synopsis": "authored"})
        result = resolve_publishing_metadata(
            {"synopsis": "explicit"}, {}, "苏禾进门。",
            [{"full_name": "顾云裳", "role": "配角"}, {"full_name": "苏禾", "role": "主角"}],
        )
        self.assertEqual(result["protagonist"], "苏禾")


class ImportNovelStudioTests(unittest.TestCase):
    def import_fixture(self, serial, *, project=None, force=False):
        with patch("tools.import_novel_studio.fetch_json", side_effect=[
            project or {"title": "面光", "genre": "女性成长", "protagonist": "苏禾", "synopsis": "既有简介"},
            {"status": "PASS"},
            [{"number": 1, "title": "第一章 四十天", "word_count": 2000}],
            [],
            {"final": "# 第一章 四十天\n\n最终正文。", "draft": "草稿正文。"},
        ]):
            return import_book(
                "https://example.test", ("test", "test"), "project", "serial-test",
                serial, "2026-10-24", force,
            )

    def test_import_normalizes_final_manuscript_before_saving(self):
        with tempfile.TemporaryDirectory() as directory:
            serial = Path(directory) / "serial"
            result = self.import_fixture(serial)
            chapter = serial / "books/serial-test/published/2026-10-24-chapter-0001.md"
            self.assertEqual(chapter.read_text(encoding="utf-8"), "# 第1章 四十天\n\n最终正文。\n")
            self.assertNotIn(b"\r\n", chapter.read_bytes())
            self.assertEqual(result["chapters"], 1)
            metadata = json.loads((chapter.parent.parent / "book.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["protagonist"], "苏禾")
            self.assertEqual(metadata["synopsis"], "既有简介")
            self.assertEqual(metadata["sourceProjectId"], "project")

    def test_missing_metadata_fails_before_creating_any_book_files(self):
        with tempfile.TemporaryDirectory() as directory:
            serial = Path(directory) / "serial"
            with self.assertRaisesRegex(ValueError, "主角名.*简介"):
                self.import_fixture(serial, project={"title": "面光"})
            self.assertFalse(serial.exists())

    def test_force_import_retains_authored_fields_and_publication_state(self):
        with tempfile.TemporaryDirectory() as directory:
            serial = Path(directory) / "serial"
            book_dir = serial / "books/serial-test"
            book_dir.mkdir(parents=True)
            saved = {
                "protagonist": "saved", "synopsis": "authored", "audience": "男频",
                "publishingHint": {"audience": "男频", "readingTags": ["都市"]},
                "platformBookId": "123", "customField": {"keep": True},
            }
            (book_dir / "book.json").write_text(json.dumps(saved), encoding="utf-8")
            self.import_fixture(serial, force=True)
            result = json.loads((book_dir / "book.json").read_text(encoding="utf-8"))
            for key, value in saved.items():
                self.assertEqual(result[key], value)

    def test_failed_force_import_does_not_modify_existing_chapters(self):
        with tempfile.TemporaryDirectory() as directory:
            serial = Path(directory) / "serial"
            book_dir = serial / "books/serial-test"
            (book_dir / "published").mkdir(parents=True)
            metadata_file = book_dir / "book.json"
            metadata_file.write_bytes(b'{"title":"unchanged"}')
            chapter = book_dir / "published/2026-10-24-chapter-0001.md"
            chapter.write_bytes(b"existing manuscript")
            with self.assertRaises(ValueError):
                self.import_fixture(serial, project={"title": "missing"}, force=True)
            self.assertEqual(metadata_file.read_bytes(), b'{"title":"unchanged"}')
            self.assertEqual(chapter.read_bytes(), b"existing manuscript")


if __name__ == "__main__":
    unittest.main()

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "serial" / "ops" / "publishing_metadata.py"
SPEC = importlib.util.spec_from_file_location("reader_publishing_metadata", MODULE_PATH)
publishing_metadata = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(publishing_metadata)


class PublishingMetadataTests(unittest.TestCase):
    def test_validates_and_normalizes_generated_metadata(self):
        hint = publishing_metadata.validate_publishing_hint({
            "audience": " 女频 ",
            "readingTags": ["都市悬疑", "都市悬疑"],
            "contentTags": ["调查取证", "现实题材"],
            "tagDimensions": {
                "plot": ["推理", "调查取证"],
                "emotion": ["亲情"],
                "persona": ["女强", "理性清醒"],
                "worldview": [],
            },
        })

        self.assertEqual(hint["schemaVersion"], 1)
        self.assertEqual(hint["source"], "inkos")
        self.assertEqual(hint["readingTags"], ["都市悬疑"])
        self.assertEqual(hint["tagDimensions"]["worldview"], [])

    def test_rejects_dimensions_over_platform_limit(self):
        with self.assertRaisesRegex(ValueError, "emotion"):
            publishing_metadata.validate_publishing_hint({
                "audience": "男频",
                "readingTags": ["都市生活"],
                "contentTags": ["现实题材"],
                "tagDimensions": {
                    "plot": [],
                    "emotion": ["亲情", "友情", "爱情"],
                    "persona": [],
                    "worldview": [],
                },
            })

    def test_parses_fenced_model_json(self):
        content = """```json
        {"publishingHint":{"audience":"方向待定","readingTags":["都市悬疑"],
        "contentTags":["调查取证"],"tagDimensions":{"plot":["推理"],
        "emotion":[],"persona":[],"worldview":[]}},"volumes":[
        {"number":1,"title":"名字被谁写走","startChapter":1,"endChapter":100}]}
        ```"""

        parsed = publishing_metadata.parse_model_json(content, 100)

        self.assertEqual(parsed["publishingHint"]["audience"], "方向待定")
        self.assertEqual(parsed["publishingHint"]["tagDimensions"]["plot"], ["推理"])
        self.assertEqual(parsed["volumes"][0]["endChapter"], 100)

    def test_rejects_volume_gaps(self):
        with self.assertRaisesRegex(ValueError, "continuous"):
            publishing_metadata.validate_volumes([
                {"number": 1, "title": "第一卷", "startChapter": 1, "endChapter": 20},
                {"number": 2, "title": "第二卷", "startChapter": 22, "endChapter": 40},
            ], 40)

    def test_uses_foundations_and_roles_without_chapter_prose(self):
        with tempfile.TemporaryDirectory() as directory:
            book_dir = Path(directory)
            (book_dir / "story" / "roles" / "主要角色").mkdir(parents=True)
            (book_dir / "story" / "brief.md").write_text("都市调查主线", encoding="utf-8")
            (book_dir / "story" / "roles" / "主要角色" / "许知微.md").write_text(
                "职业：审计师", encoding="utf-8"
            )
            (book_dir / "story" / "chapters").mkdir()
            (book_dir / "story" / "chapters" / "chapter-0001.md").write_text(
                "不应读取的章节正文", encoding="utf-8"
            )

            context = publishing_metadata.foundation_context(book_dir)

        self.assertIn("都市调查主线", context)
        self.assertIn("职业：审计师", context)
        self.assertNotIn("不应读取的章节正文", context)

    def test_writes_validated_hint_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            book_dir = Path(directory)
            (book_dir / "book.json").write_text(
                json.dumps({"title": "测试书", "createdAt": "2026-10-03T00:00:00.000Z"}),
                encoding="utf-8",
            )
            publishing_metadata.write_book_metadata(book_dir, {
                "publishingHint": {
                    "audience": "女频",
                    "readingTags": ["都市悬疑"],
                    "contentTags": ["调查取证"],
                    "tagDimensions": {
                        "plot": ["推理"], "emotion": [], "persona": [], "worldview": [],
                    },
                },
                "volumes": [{
                    "number": 1, "title": "名字被谁写走", "startChapter": 1, "endChapter": 100,
                }],
            })

            book = json.loads((book_dir / "book.json").read_text(encoding="utf-8"))

        self.assertEqual(book["publishingHint"]["source"], "inkos")
        self.assertEqual(book["volumes"][0]["title"], "名字被谁写走")
        self.assertFalse((book_dir / "book.json.tmp").exists())

    def test_preserves_external_metadata_source(self):
        hint = publishing_metadata.validate_publishing_hint({
            "schemaVersion": 1,
            "source": "external-ai",
            "audience": "女频",
            "readingTags": ["都市生活"],
            "contentTags": ["现实题材"],
            "tagDimensions": {"plot": [], "emotion": [], "persona": [], "worldview": []},
        })

        self.assertEqual(hint["source"], "external-ai")


if __name__ == "__main__":
    unittest.main()

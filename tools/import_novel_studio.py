#!/usr/bin/env python3
"""Import Novel Studio books that have passed whole-book review."""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.chapter_format import normalize_chapter
from tools.publishing_metadata import resolve_publishing_metadata

DEFAULT_ACCESS_FILE = ROOT.parent / "novel-studio" / "artifacts" / "vps" / "access.json"
BOOKS = {
    "停摆的陀飞轮-自动0009-47c27b": "serial-0009-tingbaidetuofeilun",
    "面光-自动0002-049717": "serial-0002-mianguang",
    "采样瓶上的编号-自动0011-8468a4": "serial-0011-caiyangpingshangdebianhao",
    "缓存的春天-自动0010-de2461": "serial-0010-huancundechuntian",
    "捕雾塔的第七行代码-自动0005-341a73": "serial-0005-buwutadediqixingdaima",
    "晒场上的一九九一-自动0013-ab2c6d": "serial-0013-shaichangdeyijiuyiyi",
    "光谱下的第七层-自动0015-ed6886": "serial-0015-guangpuxiadiqiceng",
    "深井档案-自动0001-854849": "serial-0001-shenjingdangan",
}

TAG_PRESETS = {
    "现实悬疑": {
        "reading": ["现实悬疑"],
        "content": ["调查取证", "现实题材"],
        "plot": ["推理", "调查取证"],
        "emotion": ["亲情"],
        "persona": ["理性清醒", "坚韧成长"],
    },
    "女性成长": {
        "reading": ["女性成长"],
        "content": ["职业成长", "现实题材"],
        "plot": ["成长", "调查取证"],
        "emotion": ["亲情"],
        "persona": ["女强", "理性清醒", "坚韧成长"],
    },
    "年代经营": {
        "reading": ["年代经营"],
        "content": ["经营", "现实题材"],
        "plot": ["经营", "成长"],
        "emotion": ["亲情"],
        "persona": ["务实", "坚韧成长"],
    },
    "都市职业": {
        "reading": ["职业成长"],
        "content": ["职场", "现实题材"],
        "plot": ["调查取证", "职业成长"],
        "emotion": ["师徒情", "亲情"],
        "persona": ["理性清醒", "坚韧成长"],
    },
    "轻科幻": {
        "reading": ["轻科幻"],
        "content": ["调查取证", "现实题材", "职业成长"],
        "plot": ["推理", "调查取证"],
        "emotion": ["师徒情"],
        "persona": ["理性清醒", "坚韧成长"],
    },
}


def fetch_json(url: str, username: str, password: str) -> object:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Basic {token}",
            "User-Agent": "reader-novel-import/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def project_url(base_url: str, project_id: str, suffix: str = "") -> str:
    encoded = urllib.parse.quote(project_id, safe="")
    return f"{base_url.rstrip('/')}/api/projects/{encoded}{suffix}"


def clean_title(value: str) -> str:
    return re.sub(r"·自动\d{4}-[0-9a-f]+$", "", value).strip()


def preset_for(genre: str) -> dict[str, list[str]]:
    return TAG_PRESETS.get(
        genre,
        {
            "reading": ["现实题材"],
            "content": ["现实题材"],
            "plot": ["成长"],
            "emotion": ["亲情"],
            "persona": ["坚韧成长"],
        },
    )


def import_book(
    base_url: str,
    auth: tuple[str, str],
    project_id: str,
    reader_id: str,
    serial_root: Path,
    publish_date: str,
    force: bool,
) -> dict:
    username, password = auth
    project = fetch_json(project_url(base_url, project_id), username, password)
    review = fetch_json(project_url(base_url, project_id, "/book-review"), username, password)
    if review.get("status") != "PASS":
        raise ValueError(f"{project_id}: whole-book review is {review.get('status')!r}, expected PASS")

    chapters = fetch_json(project_url(base_url, project_id, "/chapters"), username, password)
    chapters = sorted(chapters, key=lambda item: int(item["number"]))
    if not chapters:
        raise ValueError(f"{project_id}: no chapters found")

    book_dir = serial_root / "books" / reader_id
    published_dir = book_dir / "published"
    if book_dir.exists() and not force:
        raise FileExistsError(f"{book_dir} already exists; use --force to replace it")
    metadata_file = book_dir / "book.json"
    existing = json.loads(metadata_file.read_text(encoding="utf-8")) if metadata_file.exists() else {}
    characters = fetch_json(project_url(base_url, project_id, "/characters"), username, password)

    manuscripts = []
    word_counts = []
    for chapter in chapters:
        number = int(chapter["number"])
        stages = fetch_json(
            project_url(base_url, project_id, f"/chapters/{number}/stages"),
            username,
            password,
        )
        body = stages.get("final") or stages.get("revised") or stages.get("draft")
        if not isinstance(body, str) or not body.strip():
            raise ValueError(f"{project_id}: chapter {number} has no readable manuscript stage")
        title, body = normalize_chapter(number, str(chapter["title"]), body)
        if not body:
            raise ValueError(f"{project_id}: chapter {number} contains only a heading")
        manuscripts.append((number, title, body))
        word_counts.append(int(chapter.get("word_count") or 0))

    publishing_metadata = resolve_publishing_metadata(
        project, existing, "\n".join(body for _, _, body in manuscripts), characters,
    )
    genre = str(project.get("genre") or "现实题材").strip()
    tags = preset_for(genre)
    book = {
        **existing,
        "id": reader_id,
        "readerId": reader_id,
        "title": clean_title(str(project.get("title") or project_id)),
        "platform": "tomato",
        "genre": {
            "现实悬疑": "suspense",
            "女性成长": "women-growth",
            "年代经营": "period-business",
            "都市职业": "urban",
            "轻科幻": "sci-fi",
        }.get(genre, "urban"),
        "status": "active",
        "targetChapters": len(chapters),
        "chapterWordCount": round(sum(word_counts) / max(1, len(word_counts))),
        "language": "zh",
        "publishingHint": {
            "schemaVersion": 1,
            "source": "external-ai",
            "audience": "女频",
            "readingTags": tags["reading"],
            "contentTags": tags["content"],
            "tagDimensions": {
                "plot": tags["plot"],
                "emotion": tags["emotion"],
                "persona": tags["persona"],
                "worldview": [],
            },
        },
        "volumes": [
            {
                "number": 1,
                "title": "全书",
                "startChapter": 1,
                "endChapter": len(chapters),
            }
        ],
    }
    # Force imports must retain authored metadata and publishing configuration.
    if existing.get("publishingHint"):
        book["publishingHint"] = existing["publishingHint"]
    book.update(publishing_metadata)
    book["sourceProjectId"] = project_id
    published_dir.mkdir(parents=True, exist_ok=True)
    for number, title, body in manuscripts:
        target = published_dir / f"{publish_date}-chapter-{number:04d}.md"
        target.write_text(f"# {title}\n\n{body}\n", encoding="utf-8", newline="\n")
    metadata_file.write_text(
        json.dumps(book, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return {
        "title": book["title"],
        "readerId": reader_id,
        "chapters": len(manuscripts),
        "words": sum(word_counts),
        "directory": str(book_dir),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--access-file", type=Path, default=DEFAULT_ACCESS_FILE)
    parser.add_argument("--base-url", default="")
    parser.add_argument("--date", default=date.today().isoformat())
    parser.add_argument("--project-id", action="append", dest="project_ids")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    access = json.loads(args.access_file.read_text(encoding="utf-8"))
    base_url = args.base_url or access["web_url"]
    project_ids = args.project_ids or list(BOOKS)
    results = []
    for project_id in project_ids:
        if project_id not in BOOKS:
            raise ValueError(f"No stable Reader ID configured for {project_id}")
        results.append(
            import_book(
                base_url,
                (access["username"], access["password"]),
                project_id,
                BOOKS[project_id],
                ROOT / "serial",
                args.date,
                args.force,
            )
        )
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

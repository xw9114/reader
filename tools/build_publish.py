#!/usr/bin/env python3
"""Build the Reader publishing page, downloads, and browser extension bundle."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import zipfile
from dataclasses import dataclass
from pathlib import Path


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")
SERIAL_FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-chapter-(\d{4})\.md$")
INVALID_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
PUBLISHING_AUDIENCES = {"男频", "女频", "方向待定"}
PUBLISHING_DIMENSION_LIMITS = {"plot": 4, "emotion": 2, "persona": 4, "worldview": 1}
MAX_VOLUMES = 12
MAX_INTERACTION_LENGTH = 60
COVER_EXTENSIONS = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}


@dataclass
class Section:
    title: str
    body: str


def publishing_string_list(value: object, field: str, minimum: int, maximum: int) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(f"{field} contains an empty or non-string value")
        normalized = item.strip()
        if normalized not in result:
            result.append(normalized)
    if not minimum <= len(result) <= maximum:
        raise ValueError(f"{field} must contain {minimum}-{maximum} unique values")
    return result


def validate_publishing_hint(value: object) -> dict:
    """Validate the InkOS-to-Reader publishing metadata contract."""
    if not isinstance(value, dict):
        raise ValueError("Serial book publishingHint must be an object")
    if value.get("schemaVersion") != 1:
        raise ValueError("Serial book publishingHint.schemaVersion must be 1")
    if value.get("source") != "inkos":
        raise ValueError("Serial book publishingHint.source must be inkos")
    audience = value.get("audience")
    if isinstance(audience, str):
        audience = audience.strip()
    if audience not in PUBLISHING_AUDIENCES:
        raise ValueError("Serial book publishingHint.audience is invalid")
    dimensions = value.get("tagDimensions")
    if not isinstance(dimensions, dict):
        raise ValueError("Serial book publishingHint.tagDimensions must be an object")
    return {
        "schemaVersion": 1,
        "source": "inkos",
        "audience": audience,
        "readingTags": publishing_string_list(
            value.get("readingTags"), "publishingHint.readingTags", 1, 2
        ),
        "contentTags": publishing_string_list(
            value.get("contentTags"), "publishingHint.contentTags", 1, 4
        ),
        "tagDimensions": {
            key: publishing_string_list(
                dimensions.get(key), f"publishingHint.tagDimensions.{key}", 0, limit
            )
            for key, limit in PUBLISHING_DIMENSION_LIMITS.items()
        },
    }


def validate_volumes(value: object, target_chapters: object = None) -> list[dict]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_VOLUMES:
        raise ValueError(f"Serial book volumes must contain 1-{MAX_VOLUMES} items")
    volumes: list[dict] = []
    expected_start = 1
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"Serial book volumes[{index - 1}] must be an object")
        number = item.get("number")
        title = item.get("title")
        start = item.get("startChapter")
        end = item.get("endChapter")
        if number != index:
            raise ValueError("Serial book volume numbers must be consecutive from 1")
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 30:
            raise ValueError(f"Serial book volumes[{index - 1}].title is invalid")
        if not isinstance(start, int) or isinstance(start, bool) or start != expected_start:
            raise ValueError("Serial book volume chapter ranges must be continuous from chapter 1")
        if not isinstance(end, int) or isinstance(end, bool) or end < start:
            raise ValueError(f"Serial book volumes[{index - 1}].endChapter is invalid")
        volumes.append({
            "number": number,
            "title": title.strip(),
            "startChapter": start,
            "endChapter": end,
        })
        expected_start = end + 1
    if isinstance(target_chapters, int) and target_chapters > 0 and volumes[-1]["endChapter"] != target_chapters:
        raise ValueError("Serial book volume plan must end at targetChapters")
    return volumes


def inline_to_text(value: str) -> str:
    value = re.sub(r"!\[([^]]*)\]\([^)]+\)", r"\1", value)
    value = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", value)
    value = re.sub(r"<https?://[^>]+>", "", value)
    value = re.sub(r"<[^>]+>", "", value)
    value = re.sub(r"(?<!\\)[*_~]{1,2}", "", value)
    value = re.sub(r"`([^`]*)`", r"\1", value)
    value = value.replace("\\*", "*").replace("\\_", "_")
    return html.unescape(value).strip()


def markdown_lines_to_text(lines: list[str]) -> str:
    output: list[str] = []
    in_fence = False

    for raw_line in lines:
        line = raw_line.rstrip()
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue

        if not in_fence:
            heading = HEADING_RE.match(line)
            if heading:
                line = heading.group(2)
            line = re.sub(r"^\s*>\s?", "", line)
            line = re.sub(r"^\s*[-*+]\s+", "• ", line)
            line = re.sub(r"^\s*(\d+)\.\s+", r"\1. ", line)
            line = inline_to_text(line)

        output.append(line.rstrip())

    text = "\n".join(output)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def safe_filename(value: str, fallback: str) -> str:
    name = INVALID_FILENAME_RE.sub("_", value).strip().rstrip(".")
    return name[:80] or fallback


def story_downloads(stem: str) -> dict[str, str]:
    return {
        "txt": f"downloads/{stem}.txt",
        "md": f"downloads/{stem}.md",
        "zip": f"downloads/{stem}.zip",
    }


def chapter_interaction(title: str, body: str) -> str:
    """Create a short plot-linked question for a platform author-note field."""
    topic = re.sub(
        r"^(?:第\s*[0-9０-９一二三四五六七八九十百千万零〇两]+\s*[章回节篇]|chapter\s*[0-9０-９]+)\s*[：:、，,.。\-—_]*\s*",
        "",
        str(title or ""),
        flags=re.IGNORECASE,
    ).strip("《》“”\"'：:、，,.。!?！？—-_ ")
    topic = topic[:12] or "这一章"
    source = f"{title}\n{body}"[:6000]
    if re.search(r"线索|证据|调查|名单|档案|账目|账本|台账|案件|案发|案卷|秘密|真相|嫌疑|签收|复核", source):
        note = f"本章围绕“{topic}”推进了关键线索。你觉得哪个细节最值得追查？欢迎留言聊聊。"
    elif re.search(r"爱情|婚|前夫|前妻|恋|喜欢|心动|重逢|感情|爱人", source):
        note = f"“{topic}”让人物关系有了变化。你更理解谁的选择？欢迎留言聊聊。"
    else:
        note = f"“{topic}”把故事又往前推了一步。你最期待接下来发生什么？欢迎留言聊聊。"
    return note[:MAX_INTERACTION_LENGTH]


def split_cover_title(title: str, line_length: int = 7, maximum_lines: int = 4) -> list[str]:
    compact = re.sub(r"\s+", "", title).strip()
    return [compact[index:index + line_length] for index in range(0, len(compact), line_length)][:maximum_lines] or ["未命名作品"]


def fallback_cover_svg(story: dict) -> str:
    """Create a deterministic vertical cover when no custom image exists."""
    digest = hashlib.sha256(str(story["id"]).encode("utf-8")).digest()
    hue = int.from_bytes(digest[:2], "big") % 360
    accent_hue = (hue + 38 + digest[2] % 60) % 360
    title_lines = split_cover_title(str(story.get("title") or "未命名作品"))
    title_markup = "".join(
        f'<text x="72" y="{330 + index * 78}" fill="#fffaf0" font-size="58" font-weight="700">{html.escape(line)}</text>'
        for index, line in enumerate(title_lines)
    )
    date = html.escape(str(story.get("date") or "READER"))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024" viewBox="0 0 768 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl({hue} 48% 16%)"/>
      <stop offset="1" stop-color="hsl({accent_hue} 58% 30%)"/>
    </linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="34"/></filter>
  </defs>
  <rect width="768" height="1024" fill="url(#bg)"/>
  <circle cx="650" cy="170" r="210" fill="hsl({accent_hue} 80% 66% / .24)" filter="url(#blur)"/>
  <circle cx="130" cy="880" r="250" fill="hsl({hue} 84% 72% / .16)" filter="url(#blur)"/>
  <path d="M0 760 C180 630 310 820 470 690 C590 592 675 625 768 560 L768 1024 L0 1024 Z" fill="#071c19" opacity=".42"/>
  <rect x="72" y="252" width="54" height="7" rx="3.5" fill="hsl({accent_hue} 88% 68%)"/>
  {title_markup}
  <text x="72" y="905" fill="#dce9e5" font-size="24" letter-spacing="5">READER ORIGINAL</text>
  <text x="72" y="950" fill="#aac3bc" font-size="20">{date}</text>
</svg>'''


def cover_dimensions(path: Path) -> tuple[int, int]:
    """Read dimensions from supported cover files, falling back to the legacy size."""
    if path.suffix.lower() == ".png":
        header = path.read_bytes()[:24]
        if header[:8] == b"\x89PNG\r\n\x1a\n" and header[12:16] == b"IHDR":
            width = int.from_bytes(header[16:20], "big")
            height = int.from_bytes(header[20:24], "big")
            if width > 0 and height > 0:
                return width, height
    return 768, 1024


def attach_story_cover(story: dict, cover_dir: Path, output_dir: Path) -> None:
    destination_dir = output_dir / "covers"
    destination_dir.mkdir(parents=True, exist_ok=True)
    custom = next(
        (cover_dir / f"{story['id']}{extension}" for extension in COVER_EXTENSIONS if (cover_dir / f"{story['id']}{extension}").is_file()),
        None,
    )
    if custom is not None:
        extension = custom.suffix.lower()
        destination = destination_dir / f"{story['id']}{extension}"
        shutil.copy2(custom, destination)
        source = "custom"
    else:
        extension = ".svg"
        destination = destination_dir / f"{story['id']}{extension}"
        destination.write_text(fallback_cover_svg(story), encoding="utf-8")
        source = "generated-default"
    width, height = cover_dimensions(destination)
    story["cover"] = {
        "url": destination.relative_to(output_dir).as_posix(),
        "mimeType": COVER_EXTENSIONS[extension],
        "source": source,
        "width": width,
        "height": height,
    }


def parse_story(path: Path) -> dict:
    markdown = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    lines = markdown.splitlines()
    title = path.stem
    title_index = None

    for index, line in enumerate(lines):
        heading = HEADING_RE.match(line)
        if heading and len(heading.group(1)) == 1:
            title = inline_to_text(heading.group(2))
            title_index = index
            break

    content_lines = lines[:]
    if title_index is not None:
        content_lines.pop(title_index)

    sections: list[Section] = []
    prelude: list[str] = []
    current_title: str | None = None
    current_lines: list[str] = []

    for line in content_lines:
        heading = HEADING_RE.match(line)
        if heading and len(heading.group(1)) == 2:
            if current_title is not None:
                sections.append(Section(current_title, markdown_lines_to_text(current_lines)))
            elif markdown_lines_to_text(prelude):
                sections.append(Section("正文", markdown_lines_to_text(prelude)))
            current_title = inline_to_text(heading.group(2))
            current_lines = []
            continue

        if current_title is None:
            prelude.append(line)
        else:
            current_lines.append(line)

    if current_title is not None:
        sections.append(Section(current_title, markdown_lines_to_text(current_lines)))
    elif markdown_lines_to_text(prelude):
        sections.append(Section(title, markdown_lines_to_text(prelude)))

    if not sections:
        sections.append(Section(title, ""))

    date_match = DATE_RE.match(path.name)
    date = date_match.group(1) if date_match else ""
    chapters = []
    for index, section in enumerate(sections, start=1):
        body = section.body
        chapters.append(
            {
                "id": f"chapter-{index}",
                "title": section.title,
                "body": body,
                "characters": len(re.sub(r"\s", "", body)),
                "interaction": chapter_interaction(section.title, body),
            }
        )

    full_text = "\n\n".join(
        f"{chapter['title']}\n\n{chapter['body']}".strip() for chapter in chapters
    )
    downloads = story_downloads(path.stem)
    return {
        "id": path.stem,
        "title": title,
        "date": date,
        "source": f"daily/{path.name}",
        "download": downloads["txt"],
        "downloads": downloads,
        "characters": len(re.sub(r"\s", "", full_text)),
        "chapters": chapters,
        "fullText": full_text,
    }


def parse_serial_book(serial_dir: Path) -> tuple[dict, list[Path]] | None:
    published = serial_dir / "published"
    if not published.is_dir():
        return None

    numbered: list[tuple[int, str, Path]] = []
    for path in published.glob("*.md"):
        match = SERIAL_FILE_RE.fullmatch(path.name)
        if match is None:
            raise ValueError(f"Invalid serial chapter filename: {path}")
        numbered.append((int(match.group(2)), match.group(1), path))
    if not numbered:
        return None

    numbered.sort()
    if [number for number, _, _ in numbered] != list(range(1, len(numbered) + 1)):
        raise ValueError("Serial chapters must be numbered consecutively from 1")

    books = list((serial_dir / "books").glob("*/book.json"))
    if len(books) != 1:
        raise ValueError("Expected exactly one serial book configuration")
    book = json.loads(books[0].read_text(encoding="utf-8"))
    title = str(book["title"])
    publishing_hint = validate_publishing_hint(book.get("publishingHint"))
    volumes = validate_volumes(book.get("volumes"), book.get("targetChapters"))
    chapters = []

    for number, _, path in numbered:
        lines = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").splitlines()
        heading = HEADING_RE.match(lines[0]) if lines else None
        if heading is None or len(heading.group(1)) != 1:
            raise ValueError(f"Missing chapter heading: {path}")
        body = markdown_lines_to_text(lines[1:])
        if not body:
            raise ValueError(f"Empty serial chapter: {path}")
        volume = next((item for item in volumes if item["startChapter"] <= number <= item["endChapter"]), None)
        if volume is None:
            raise ValueError(f"Serial chapter {number} is outside the configured volume plan")
        chapters.append(
            {
                "id": f"chapter-{number}",
                "title": inline_to_text(heading.group(2)),
                "body": body,
                "characters": len(re.sub(r"\s", "", body)),
                "interaction": chapter_interaction(inline_to_text(heading.group(2)), body),
                "volume": {"number": volume["number"], "title": volume["title"]},
            }
        )

    full_text = "\n\n".join(
        f"{chapter['title']}\n\n{chapter['body']}" for chapter in chapters
    )
    downloads = story_downloads("serial-book")
    story = {
        "id": "serial-main",
        "title": title,
        "date": numbered[-1][1],
        "source": "serial/published/",
        "download": downloads["txt"],
        "downloads": downloads,
        "characters": len(re.sub(r"\s", "", full_text)),
        "chapters": chapters,
        "fullText": full_text,
        "volumes": volumes,
    }
    story["publishingHint"] = publishing_hint
    return story, [path for _, _, path in numbered]


def story_markdown(story: dict) -> str:
    chapters = "\n\n".join(
        f"## {chapter['title']}\n\n{chapter['body']}" for chapter in story["chapters"]
    )
    return f"# {story['title']}\n\n{chapters}\n"


def write_story_downloads(story: dict, source_paths: list[Path], output_dir: Path) -> None:
    downloads = story["downloads"]
    txt_path = output_dir / downloads["txt"]
    md_path = output_dir / downloads["md"]
    zip_path = output_dir / downloads["zip"]

    txt_path.write_text(
        f"{story['title']}\n\n{story['fullText']}\n",
        encoding="utf-8-sig",
    )
    if len(source_paths) == 1 and story["id"] != "serial-main":
        shutil.copy2(source_paths[0], md_path)
    else:
        md_path.write_text(story_markdown(story), encoding="utf-8-sig")

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        root_name = safe_filename(story["title"], story["id"])
        archive.writestr(
            f"{root_name}/00-{root_name}.txt",
            ("\ufeff" + f"{story['title']}\n\n{story['fullText']}\n").encode("utf-8"),
        )
        archive.write(md_path, f"{root_name}/source.md")
        if len(source_paths) > 1:
            for source_path in source_paths:
                archive.write(source_path, f"{root_name}/originals/{source_path.name}")
        for index, chapter in enumerate(story["chapters"], start=1):
            chapter_name = safe_filename(chapter["title"], f"chapter-{index}")
            content = f"{chapter['title']}\n\n{chapter['body']}\n"
            archive.writestr(
                f"{root_name}/{index:02d}-{chapter_name}.txt",
                ("\ufeff" + content).encode("utf-8"),
            )


def write_extension_bundle(extension_dir: Path, output_dir: Path) -> str | None:
    if not extension_dir.exists():
        return None

    archive_path = output_dir / "downloads" / "fanqie-publisher-extension.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(extension_dir.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(extension_dir).as_posix())
    return "downloads/fanqie-publisher-extension.zip"


def build(
    source_dir: Path,
    site_dir: Path,
    output_dir: Path,
    serial_dir: Path | None = None,
    extension_dir: Path | None = None,
    cover_dir: Path | None = None,
) -> list[dict]:
    serial_dir = serial_dir or source_dir.parent / "serial"
    cover_dir = cover_dir or source_dir.parent / "covers"
    daily_inputs = [(parse_story(path), [path]) for path in sorted(source_dir.glob("*.md"), reverse=True)]
    serial_input = parse_serial_book(serial_dir)
    story_inputs = ([serial_input] if serial_input else []) + daily_inputs
    if not story_inputs:
        raise SystemExit(f"No Markdown stories found in {source_dir} or {serial_dir}")

    if output_dir.exists():
        shutil.rmtree(output_dir)
    shutil.copytree(site_dir, output_dir)

    downloads_dir = output_dir / "downloads"
    downloads_dir.mkdir(parents=True, exist_ok=True)
    for story, source_paths in story_inputs:
        attach_story_cover(story, cover_dir, output_dir)
        write_story_downloads(story, source_paths, output_dir)

    extension_download = None
    if extension_dir is not None:
        extension_download = write_extension_bundle(extension_dir, output_dir)

    stories = [story for story, _ in story_inputs]
    payload = {
        "latestStoryId": stories[0]["id"],
        "storyCount": len(stories),
        "extensionDownload": extension_download,
        "stories": stories,
    }
    (output_dir / "data.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return stories


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("daily"))
    parser.add_argument("--serial", type=Path, default=Path("serial"))
    parser.add_argument("--site", type=Path, default=Path("site"))
    parser.add_argument("--output", type=Path, default=Path("dist"))
    parser.add_argument("--extension", type=Path, default=Path("extension"))
    parser.add_argument("--covers", type=Path, default=Path("covers"))
    args = parser.parse_args()

    stories = build(args.source, args.site, args.output, args.serial, args.extension, args.covers)
    chapter_count = sum(len(story["chapters"]) for story in stories)
    print(f"Built {len(stories)} stories and {chapter_count} chapters into {args.output}")


if __name__ == "__main__":
    main()

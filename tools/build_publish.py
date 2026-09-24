#!/usr/bin/env python3
"""Build the Reader publishing page, downloads, and browser extension bundle."""

from __future__ import annotations

import argparse
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


@dataclass
class Section:
    title: str
    body: str


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
    chapters = []

    for number, _, path in numbered:
        lines = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").splitlines()
        heading = HEADING_RE.match(lines[0]) if lines else None
        if heading is None or len(heading.group(1)) != 1:
            raise ValueError(f"Missing chapter heading: {path}")
        body = markdown_lines_to_text(lines[1:])
        if not body:
            raise ValueError(f"Empty serial chapter: {path}")
        chapters.append(
            {
                "id": f"chapter-{number}",
                "title": inline_to_text(heading.group(2)),
                "body": body,
                "characters": len(re.sub(r"\s", "", body)),
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
    }
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
) -> list[dict]:
    serial_dir = serial_dir or source_dir.parent / "serial"
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
    args = parser.parse_args()

    stories = build(args.source, args.site, args.output, args.serial, args.extension)
    chapter_count = sum(len(story["chapters"]) for story in stories)
    print(f"Built {len(stories)} stories and {chapter_count} chapters into {args.output}")


if __name__ == "__main__":
    main()

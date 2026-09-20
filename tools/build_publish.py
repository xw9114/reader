#!/usr/bin/env python3
"""Build a static, mobile-friendly publishing page from daily Markdown files."""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")
SERIAL_FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-chapter-(\d{4})\.md$")


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
    return {
        "id": path.stem,
        "title": title,
        "date": date,
        "source": f"daily/{path.name}",
        "download": f"downloads/{path.stem}.txt",
        "characters": len(re.sub(r"\s", "", full_text)),
        "chapters": chapters,
        "fullText": full_text,
    }


def parse_serial_book(serial_dir: Path) -> dict | None:
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
        chapters.append({
            "id": f"chapter-{number}",
            "title": inline_to_text(heading.group(2)),
            "body": body,
            "characters": len(re.sub(r"\s", "", body)),
        })

    full_text = "\n\n".join(
        f"{chapter['title']}\n\n{chapter['body']}" for chapter in chapters
    )
    return {
        "id": "serial-main",
        "title": title,
        "date": numbered[-1][1],
        "source": "serial/published/",
        "download": "downloads/serial-book.txt",
        "characters": len(re.sub(r"\s", "", full_text)),
        "chapters": chapters,
        "fullText": full_text,
    }


def build(source_dir: Path, site_dir: Path, output_dir: Path,
          serial_dir: Path | None = None) -> list[dict]:
    serial_dir = serial_dir or source_dir.parent / "serial"
    markdown_files = sorted(source_dir.glob("*.md"), reverse=True)
    serial_story = parse_serial_book(serial_dir)
    stories = ([serial_story] if serial_story else []) + [parse_story(path) for path in markdown_files]
    if not stories:
        raise SystemExit(f"No Markdown stories found in {source_dir} or {serial_dir}")

    if output_dir.exists():
        shutil.rmtree(output_dir)
    shutil.copytree(site_dir, output_dir)

    downloads_dir = output_dir / "downloads"
    downloads_dir.mkdir(parents=True, exist_ok=True)
    for story in stories:
        download_path = output_dir / story["download"]
        download_path.write_text(
            f"{story['title']}\n\n{story['fullText']}\n",
            encoding="utf-8-sig",
        )

    payload = {
        "latestStoryId": stories[0]["id"],
        "storyCount": len(stories),
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
    args = parser.parse_args()

    stories = build(args.source, args.site, args.output, args.serial)
    chapter_count = sum(len(story["chapters"]) for story in stories)
    print(f"Built {len(stories)} stories and {chapter_count} chapters into {args.output}")


if __name__ == "__main__":
    main()

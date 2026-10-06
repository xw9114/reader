#!/usr/bin/env python3
"""Build the Reader publishing page, downloads, and browser extension bundle."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from reader_schema import (
    validate_publishing_hint as _validate_publishing_hint,
    validate_volumes as _validate_volumes,
)


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")
SERIAL_FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-chapter-(\d{4})\.md$")
INVALID_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
MAX_INTERACTION_LENGTH = 42
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


def validate_publishing_hint(value: object) -> dict:
    """Validate the single shared publishing metadata contract."""
    return _validate_publishing_hint(value, require_schema_version=True)


def validate_volumes(value: object, target_chapters: object = None) -> list[dict]:
    return _validate_volumes(value, target_chapters)


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
    """Create a short, varied author note for a platform interaction field."""
    topic = re.sub(
        r"^(?:第\s*[0-9０-９一二三四五六七八九十百千万零〇两]+\s*[章回节篇]|chapter\s*[0-9０-９]+)\s*[：:、，,.。\-—_]*\s*",
        "",
        str(title or ""),
        flags=re.IGNORECASE,
    ).strip("《》“”\"'：:、，,.。!?！？—-_ ")
    topic = topic[:10] or "这一章"
    source = f"{title}\n{body}"[:6000]
    digest = hashlib.sha256(source.encode("utf-8")).digest()
    casual_notes = (
        "今天不聊剧情，你们是更新就看，还是喜欢攒几章？",
        "路过问一句，大家看小说时会开背景音乐吗？",
        "小调查：你们更喜欢短章快节奏，还是长章慢慢铺？",
        "谢谢你读到这里，有错字的话顺手提醒我一声就好。",
        "这一更送到。看累了就歇一会儿，明天再来。",
        "有没有一直默默追到这里、还没冒过泡的朋友？",
        "你们看文会先翻评论区，还是读完再回来聊？",
        "今天换个话题：最近有没有读到特别喜欢的一句话？",
        "看到这里先喝口水，别一口气把自己看累了。",
        "新来的朋友不用急着冒泡，慢慢看就好。",
        "你们一般用手机看，还是更喜欢平板和电脑？",
        "留个无关剧情的问题：你们看文最怕遇到什么？",
    )
    if re.search(r"线索|证据|调查|名单|档案|账目|账本|台账|案件|案发|案卷|秘密|真相|嫌疑|签收|复核", source):
        themed_notes = (
            "线索摆到这里了，你们会先查人，还是先查东西？",
            "先不揭答案。你们现在最不放心的是谁？",
            "如果只能追一条线，你们会从哪里下手？",
            "这一处我不解释，留给大家自己判断。",
            "这份证据，你们现在信几分？",
            "现在回头看，前面哪句话最可疑？",
            "我先闭嘴，免得一开口就剧透。",
            "到这里，还敢完全相信任何人吗？",
        )
    elif re.search(r"爱情|婚|前夫|前妻|恋|喜欢|心动|重逢|感情|爱人|告白|暧昧|分手", source):
        themed_notes = (
            "如果是你，这句解释还愿意听吗？",
            "嘴上说放下，心里真能这么快翻篇吗？",
            "这两个人的账，看来还得慢慢算。",
            "这一段你们站谁？我先不替任何人说话。",
            "这次到底是心软，还是不甘心？",
            "该说的话没说，往往比说错更难收场。",
            "先别急着磕，看看他们下一次见面再说。",
            "喜欢和合适，真的是一回事吗？",
        )
    elif re.search(r"争吵|对峙|冲突|质问|打脸|报复|反击|背叛|陷害|威胁|翻脸", source):
        themed_notes = (
            "换成你在场，会忍住，还是当场把话说开？",
            "这口气该先忍，还是现在就还回去？",
            "有些话说出口就回不去了，你们会说吗？",
            "这场面写完，我只想说：谁都别装糊涂。",
            "要是你被这样逼到墙角，会怎么选？",
            "这一步退了，后面可就不一定收得回来。",
            "讲道理没用的时候，你们会直接翻脸吗？",
            "这口气我先替他们记在账上。",
        )
    else:
        themed_notes = (
            "写到这里，你们现在最想听谁说句真话？",
            "这一章里，有没有哪一句让你停了一下？",
            "我先把人送到这里，下一步让他们自己选。",
            "看到这里，你对谁的看法变了？",
            "这一章不替谁下结论，交给你们判断。",
            f"“{topic}”这个章名，读完后你们觉得贴不贴？",
            "先在这里停一下，剩下的让他们自己面对。",
            "我有自己的答案，但更想先听听你们的。",
            "这一段读下来，你们是松了口气，还是更紧张了？",
            "有时候没说出口的那句话，反而最难过去。",
        )
    pool = casual_notes if digest[0] % 4 == 0 else themed_notes
    note = pool[digest[1] % len(pool)]
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
        with path.open("rb") as f:
            header = f.read(24)
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
    hook_chapter = next(
        (c for c in chapters if re.search(r"开篇|钩子|简介|导读|synopsis|summary", c["title"], re.IGNORECASE)),
        None,
    )
    result = {
        "id": path.stem,
        "title": title,
        "date": date,
        "source": f"daily/{path.name}",
        "download": downloads["txt"],
        "downloads": downloads,
        "characters": sum(c["characters"] for c in chapters),
        "chapters": chapters,
        "fullText": full_text,
    }
    if hook_chapter:
        result["synopsis"] = hook_chapter["body"]
    return result



def serial_reader_id(book_dir: Path, book: dict) -> str:
    reader_id = str(book.get("readerId") or f"serial-{book_dir.name}").strip()
    if not reader_id or reader_id in {".", ".."} or INVALID_FILENAME_RE.search(reader_id):
        raise ValueError(f"Invalid Reader serial id in {book_dir / 'book.json'}")
    return reader_id


def parse_serial_book(book_path: Path, published: Path, serial_dir: Path) -> tuple[dict, list[Path]] | None:
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
        raise ValueError(f"Serial chapters must be numbered consecutively from 1: {published}")

    try:
        book = json.loads(book_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise ValueError(f"Invalid JSON in {book_path}: {e}") from e
    book_dir = book_path.parent
    reader_id = serial_reader_id(book_dir, book)
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
    download_stem = "serial-book" if reader_id == "serial-main" else reader_id
    downloads = story_downloads(download_stem)
    story = {
        "id": reader_id,
        "title": title,
        "date": numbered[-1][1],
        "source": published.relative_to(serial_dir.parent).as_posix().rstrip("/") + "/",
        "kind": "serial",
        "download": downloads["txt"],
        "downloads": downloads,
        "characters": sum(c["characters"] for c in chapters),
        "chapters": chapters,
        "fullText": full_text,
        "volumes": volumes,
    }
    story["publishingHint"] = publishing_hint
    synopsis = book.get("synopsis") or book.get("summary") or book.get("description")
    if synopsis:
        story["synopsis"] = str(synopsis).strip()
    return story, [path for _, _, path in numbered]



def parse_serial_books(serial_dir: Path) -> list[tuple[dict, list[Path]]]:
    book_paths = sorted((serial_dir / "books").glob("*/book.json"))
    if not book_paths:
        return []

    legacy_published = serial_dir / "published"
    legacy_chapters = list(legacy_published.glob("*.md")) if legacy_published.is_dir() else []
    local_chapters = {
        book_path: list((book_path.parent / "published").glob("*.md"))
        for book_path in book_paths
        if (book_path.parent / "published").is_dir()
    }
    if legacy_chapters and any(local_chapters.values()):
        raise ValueError("Move legacy serial/published chapters into their book directory")
    if legacy_chapters and len(book_paths) != 1:
        raise ValueError("Legacy serial/published is ambiguous with multiple serial books")

    results: list[tuple[dict, list[Path]]] = []
    seen_ids: set[str] = set()
    for book_path in book_paths:
        published = legacy_published if legacy_chapters else book_path.parent / "published"
        parsed = parse_serial_book(book_path, published, serial_dir)
        if parsed is None:
            continue
        story, paths = parsed
        if story["id"] in seen_ids:
            raise ValueError(f"Duplicate Reader serial id: {story['id']}")
        seen_ids.add(story["id"])
        results.append((story, paths))
    results.sort(key=lambda item: (item[0]["date"], item[0]["id"]), reverse=True)
    return results


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
    if len(source_paths) == 1 and story.get("kind") != "serial":
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

_BUNDLE_EXCLUDE = {".git", ".env", "node_modules", ".DS_Store", "__pycache__", ".tmp"}


def write_extension_bundle(extension_dir: Path, output_dir: Path) -> str | None:
    if not extension_dir.exists():
        return None

    archive_path = output_dir / "downloads" / "fanqie-publisher-extension.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(extension_dir.rglob("*")):
            if any(part.startswith(".") or part in _BUNDLE_EXCLUDE for part in path.relative_to(extension_dir).parts):
                continue
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
    serial_inputs = parse_serial_books(serial_dir)
    story_inputs = serial_inputs + daily_inputs
    if not story_inputs:
        raise SystemExit(f"No Markdown stories found in {source_dir} or {serial_dir}")
    story_ids = [story["id"] for story, _ in story_inputs]
    if len(story_ids) != len(set(story_ids)):
        duplicate = next(story_id for story_id in story_ids if story_ids.count(story_id) > 1)
        raise ValueError(f"Duplicate Reader story id: {duplicate}")
    story_inputs.sort(key=lambda item: (item[0].get("date", ""), item[0]["id"]), reverse=True)

    if output_dir.resolve() in (Path.home(), Path("/"), Path("C:\\")):
        raise SystemExit(f"Refusing to replace unsafe output directory: {output_dir}")

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging_dir: Path | None = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.staging-", dir=output_dir.parent))
    backup_dir: Path | None = None
    try:
        assert staging_dir is not None
        shutil.copytree(site_dir, staging_dir, dirs_exist_ok=True)

        downloads_dir = staging_dir / "downloads"
        downloads_dir.mkdir(parents=True, exist_ok=True)
        for story, source_paths in story_inputs:
            attach_story_cover(story, cover_dir, staging_dir)
            write_story_downloads(story, source_paths, staging_dir)

        extension_download = None
        if extension_dir is not None:
            extension_download = write_extension_bundle(extension_dir, staging_dir)

        stories = [story for story, _ in story_inputs]
        payload = {
            "latestStoryId": stories[0]["id"],
            "storyCount": len(stories),
            "extensionDownload": extension_download,
            "stories": stories,
        }
        (staging_dir / "data.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

        if output_dir.exists():
            backup_dir = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.backup-", dir=output_dir.parent))
            backup_dir.rmdir()
            output_dir.replace(backup_dir)
        staging_dir.replace(output_dir)
        staging_dir = None
        if backup_dir is not None:
            shutil.rmtree(backup_dir)
        return stories
    except Exception:
        if staging_dir is not None and staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        if backup_dir is not None and backup_dir.exists() and not output_dir.exists():
            backup_dir.replace(output_dir)
        raise


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

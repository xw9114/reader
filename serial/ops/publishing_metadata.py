#!/usr/bin/env python3
"""Generate and validate Reader publishing metadata from InkOS foundations."""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPOSITORY = Path(__file__).resolve().parents[2]
if str(REPOSITORY) not in sys.path:
    sys.path.insert(0, str(REPOSITORY))
from reader_schema import (  # noqa: E402
    SCHEMA_VERSION,
    validate_publishing_hint as _validate_publishing_hint,
    validate_volumes as _validate_volumes,
)
FOUNDATION_FILES = (
    "story/brief.md",
    "story/author_intent.md",
    "story/outline/story_frame.md",
    "story/outline/volume_map.md",
    "story/book_rules.md",
)
MAX_CONTEXT_CHARS = 60_000


def validate_publishing_hint(value: Any) -> dict[str, Any]:
    """Return normalized metadata while preserving an explicit source."""
    return _validate_publishing_hint(
        value,
        default_source="inkos",
        require_schema_version=False,
    )


def validate_volumes(value: Any, target_chapters: int | None = None) -> list[dict[str, Any]]:
    return _validate_volumes(value, target_chapters)


def validate_generated_metadata(value: Any, target_chapters: int | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("publishing classifier result must be an object")
    return {
        "publishingHint": validate_publishing_hint(value.get("publishingHint")),
        "volumes": validate_volumes(value.get("volumes"), target_chapters),
    }


def foundation_context(book_dir: Path) -> str:
    """Collect bounded, stable InkOS foundation files for classification."""
    candidates = [book_dir / name for name in FOUNDATION_FILES]
    roles_dir = book_dir / "story" / "roles"
    if roles_dir.is_dir():
        candidates.extend(sorted(roles_dir.rglob("*.md")))
    parts: list[str] = []
    remaining = MAX_CONTEXT_CHARS
    for path in candidates:
        if remaining <= 0 or not path.is_file():
            continue
        content = path.read_text(encoding="utf-8-sig").strip()
        if not content:
            continue
        relative = path.relative_to(book_dir).as_posix()
        block = f"\n\n=== {relative} ===\n{content}"
        parts.append(block[:remaining])
        remaining -= len(parts[-1])
    if not parts:
        raise ValueError(f"no InkOS foundation files found in {book_dir}")
    return "".join(parts).strip()


def classification_prompt(book: dict[str, Any], context: str) -> list[dict[str, str]]:
    system = """你是小说发布分类器。只根据 InkOS 已生成的大纲、角色卡和世界观判断，不根据书名臆测。
只返回一个 JSON 对象，不要 Markdown，不要解释。结构必须是：
{"publishingHint":{"audience":"男频|女频|方向待定","readingTags":["1-2个总体阅读标签"],"contentTags":["1-4个核心内容标签"],"tagDimensions":{"plot":["情节最多4个"],"emotion":["情感最多2个"],"persona":["人设最多4个"],"worldview":["世界观最多1个"]}},"volumes":[{"number":1,"title":"卷名，不含第几卷前缀","startChapter":1,"endChapter":25}]}
标签必须来自作品真实主线。不要为了填满数量强加言情、系统、复仇、重生、穿越或特殊世界观；现实背景没有特殊世界观时，worldview 返回空数组。
分卷必须根据 volume_map 的主题生成，卷号从 1 连续递增，章节范围从第 1 章开始连续覆盖到目标总章数。卷名使用简洁主题名，不得使用“默认”。"""
    user = (
        f"书名：{book.get('title', '')}\n"
        f"InkOS 题材：{book.get('genre', '')}\n"
        f"目标平台：{book.get('platform', '')}\n\n"
        f"目标总章数：{book.get('targetChapters', '')}\n\n"
        f"InkOS 基础设定：\n{context}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_model_json(content: str, target_chapters: int | None = None) -> dict[str, Any]:
    text = str(content or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("publishing classifier returned no JSON object")
    try:
        parsed = json.loads(text[start:end + 1])
    except json.JSONDecodeError as error:
        raise ValueError("publishing classifier returned invalid JSON") from error
    return validate_generated_metadata(parsed, target_chapters)


def request_book_metadata(
    api_key: str,
    base_url: str,
    model: str,
    book: dict[str, Any],
    context: str,
) -> dict[str, Any]:
    payload = json.dumps({
        "model": model,
        "messages": classification_prompt(book, context),
        "temperature": 0.1,
        "max_tokens": 1800,
        "stream": False,
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=payload,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(f"publishing metadata request failed: {type(error).__name__}") from error
    try:
        content = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("publishing metadata response has no assistant content") from error
    return parse_model_json(content, book.get("targetChapters"))


def write_book_metadata(book_dir: Path, metadata: dict[str, Any]) -> None:
    book_path = book_dir / "book.json"
    book = json.loads(book_path.read_text(encoding="utf-8"))
    normalized = validate_generated_metadata(metadata, book.get("targetChapters"))
    book["publishingHint"] = normalized["publishingHint"]
    book["volumes"] = normalized["volumes"]
    book["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    temporary = book_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(book, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, book_path)


def generate_and_write(
    book_dir: Path,
    *,
    api_key: str,
    base_url: str,
    model: str,
) -> dict[str, Any]:
    book = json.loads((book_dir / "book.json").read_text(encoding="utf-8"))
    metadata = request_book_metadata(api_key, base_url, model, book, foundation_context(book_dir))
    write_book_metadata(book_dir, metadata)
    return metadata

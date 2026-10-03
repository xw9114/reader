#!/usr/bin/env python3
"""Generate and validate Reader publishing metadata from InkOS foundations."""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
AUDIENCES = {"男频", "女频", "方向待定"}
DIMENSION_LIMITS = {"plot": 4, "emotion": 2, "persona": 4, "worldview": 1}
FOUNDATION_FILES = (
    "story/brief.md",
    "story/author_intent.md",
    "story/outline/story_frame.md",
    "story/outline/volume_map.md",
    "story/book_rules.md",
)
MAX_CONTEXT_CHARS = 60_000


def _string_list(value: Any, field: str, *, minimum: int, maximum: int) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(f"{field} contains an empty or non-string value")
        text = item.strip()
        if text not in result:
            result.append(text)
    if not minimum <= len(result) <= maximum:
        raise ValueError(f"{field} must contain {minimum}-{maximum} unique values")
    return result


def validate_publishing_hint(value: Any) -> dict[str, Any]:
    """Return normalized publishing metadata or raise a field-specific error."""
    if not isinstance(value, dict):
        raise ValueError("publishingHint must be an object")
    audience = value.get("audience")
    if isinstance(audience, str):
        audience = audience.strip()
    if audience not in AUDIENCES:
        raise ValueError("publishingHint.audience must be 男频, 女频, or 方向待定")
    reading_tags = _string_list(value.get("readingTags"), "publishingHint.readingTags", minimum=1, maximum=2)
    content_tags = _string_list(value.get("contentTags"), "publishingHint.contentTags", minimum=1, maximum=4)
    raw_dimensions = value.get("tagDimensions")
    if not isinstance(raw_dimensions, dict):
        raise ValueError("publishingHint.tagDimensions must be an object")
    dimensions = {
        key: _string_list(
            raw_dimensions.get(key),
            f"publishingHint.tagDimensions.{key}",
            minimum=0,
            maximum=limit,
        )
        for key, limit in DIMENSION_LIMITS.items()
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": "inkos",
        "audience": audience,
        "readingTags": reading_tags,
        "contentTags": content_tags,
        "tagDimensions": dimensions,
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
{"audience":"男频|女频|方向待定","readingTags":["1-2个总体阅读标签"],"contentTags":["1-4个核心内容标签"],"tagDimensions":{"plot":["情节最多4个"],"emotion":["情感最多2个"],"persona":["人设最多4个"],"worldview":["世界观最多1个"]}}
标签必须来自作品真实主线。不要为了填满数量强加言情、系统、复仇、重生、穿越或特殊世界观；现实背景没有特殊世界观时，worldview 返回空数组。"""
    user = (
        f"书名：{book.get('title', '')}\n"
        f"InkOS 题材：{book.get('genre', '')}\n"
        f"目标平台：{book.get('platform', '')}\n\n"
        f"InkOS 基础设定：\n{context}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_model_json(content: str) -> dict[str, Any]:
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
    return validate_publishing_hint(parsed)


def request_publishing_hint(
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
        "max_tokens": 1200,
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
    return parse_model_json(content)


def write_publishing_hint(book_dir: Path, hint: dict[str, Any]) -> None:
    book_path = book_dir / "book.json"
    book = json.loads(book_path.read_text(encoding="utf-8"))
    book["publishingHint"] = validate_publishing_hint(hint)
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
    hint = request_publishing_hint(api_key, base_url, model, book, foundation_context(book_dir))
    write_publishing_hint(book_dir, hint)
    return hint

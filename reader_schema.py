"""Shared validation for Reader publishing metadata and serial plans."""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = 1
PUBLISHING_AUDIENCES = {"男频", "女频", "方向待定"}
PUBLISHING_SOURCES = {"inkos", "external-ai", "manual"}
PUBLISHING_DIMENSION_LIMITS = {"plot": 4, "emotion": 2, "persona": 4, "worldview": 1}
MAX_VOLUMES = 12


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


def validate_publishing_hint(
    value: object,
    *,
    default_source: str | None = None,
    require_schema_version: bool = True,
) -> dict[str, Any]:
    """Normalize a publishing hint while preserving its provenance."""
    if not isinstance(value, dict):
        raise ValueError("publishingHint must be an object")
    schema_version = value.get("schemaVersion", SCHEMA_VERSION)
    if require_schema_version and ("schemaVersion" not in value or schema_version != SCHEMA_VERSION):
        raise ValueError("publishingHint.schemaVersion must be 1")
    source = value.get("source", default_source)
    if source not in PUBLISHING_SOURCES:
        raise ValueError("publishingHint.source is invalid")
    audience = value.get("audience")
    if isinstance(audience, str):
        audience = audience.strip()
    if audience not in PUBLISHING_AUDIENCES:
        raise ValueError("publishingHint.audience must be 男频, 女频, or 方向待定")
    dimensions = value.get("tagDimensions")
    if not isinstance(dimensions, dict):
        raise ValueError("publishingHint.tagDimensions must be an object")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": source,
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


def validate_volumes(value: object, target_chapters: object = None) -> list[dict[str, Any]]:
    if value is None:
        raise ValueError("volumes must be provided")
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_VOLUMES:
        raise ValueError(f"volumes must contain 1-{MAX_VOLUMES} items")
    volumes: list[dict[str, Any]] = []
    expected_start = 1
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"volumes[{index - 1}] must be an object")
        number = item.get("number")
        title = item.get("title")
        start = item.get("startChapter")
        end = item.get("endChapter")
        if number != index:
            raise ValueError("volume numbers must be consecutive from 1")
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 30:
            raise ValueError(f"volumes[{index - 1}].title must contain 1-30 characters")
        if not isinstance(start, int) or isinstance(start, bool) or start != expected_start:
            raise ValueError("volume chapter ranges must be continuous from chapter 1")
        if not isinstance(end, int) or isinstance(end, bool) or end < start:
            raise ValueError(f"volumes[{index - 1}].endChapter is invalid")
        volumes.append({
            "number": number,
            "title": title.strip(),
            "startChapter": start,
            "endChapter": end,
        })
        expected_start = end + 1
    if isinstance(target_chapters, int) and target_chapters > 0 and volumes[-1]["endChapter"] != target_chapters:
        raise ValueError("volume plan must end at targetChapters")
    return volumes

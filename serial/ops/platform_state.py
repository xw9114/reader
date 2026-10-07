"""Idempotent per-platform publication state for serial chapters."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PLATFORMS = ("fanqie", "qimao")
STATUSES = {"pending", "draft_saved", "published", "failed"}


def default_platforms() -> dict[str, dict[str, str]]:
    return {platform: {"status": "pending"} for platform in PLATFORMS}


def normalize_platforms(value: object) -> dict[str, dict[str, Any]]:
    result = default_platforms()
    if not isinstance(value, dict):
        return result
    for platform in PLATFORMS:
        item = value.get(platform)
        if not isinstance(item, dict):
            continue
        status = item.get("status", "pending")
        if status not in STATUSES:
            raise ValueError(f"invalid platform status: {platform}/{status}")
        result[platform] = {key: item[key] for key in item if key in {"status", "remoteId", "error", "updatedAt"}}
        result[platform]["status"] = status
    return result


def update_platform_state(
    record_path: Path,
    platform: str,
    status: str,
    *,
    remote_id: str | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    if platform not in PLATFORMS:
        raise ValueError(f"unsupported platform: {platform}")
    if status not in STATUSES:
        raise ValueError(f"unsupported status: {status}")
    record = json.loads(record_path.read_text(encoding="utf-8"))
    platforms = normalize_platforms(record.get("platforms"))
    item: dict[str, Any] = {"status": status, "updatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    if remote_id:
        item["remoteId"] = remote_id
    if error:
        item["error"] = error[:500]
    platforms[platform] = item
    record["platforms"] = platforms
    temporary = record_path.with_suffix(record_path.suffix + ".tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, record_path)
    return record

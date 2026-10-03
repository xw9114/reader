#!/usr/bin/env python3
"""Generate per-story cover images through an OpenAI-compatible Images API."""

from __future__ import annotations

import argparse
import base64
import json
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


MAX_IMAGE_BYTES = 12 * 1024 * 1024
IMAGE_SIGNATURES = ((b"\x89PNG\r\n\x1a\n", ".png"), (b"\xff\xd8\xff", ".jpg"), (b"RIFF", ".webp"))
DEFAULT_IMAGE_BASE_URL = "https://api.xw9114.online/v1"
DEFAULT_IMAGE_MODEL = "gpt-image-2"


def cover_prompt(story: dict) -> str:
    chapters = story.get("chapters") if isinstance(story.get("chapters"), list) else []
    opening = " ".join(str(chapter.get("body") or "") for chapter in chapters[:2])[:900]
    return (
        "为中文网络小说制作竖版封面插画。不要出现平台标志、水印、二维码或现成书名文字。"
        "画面应具有明确主体、故事氛围和商业小说封面的留白构图。"
        f"作品名：{story.get('title', '未命名作品')}。故事开篇：{opening}"
    )


def decode_image_response(payload: dict) -> bytes:
    data = payload.get("data")
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
        raise ValueError("图片接口未返回 data[0]")
    item = data[0]
    if isinstance(item.get("b64_json"), str):
        image = base64.b64decode(item["b64_json"], validate=True)
        if len(image) > MAX_IMAGE_BYTES:
            raise ValueError("生成图片超过 12 MiB 限制")
        return image
    url = item.get("url")
    if not isinstance(url, str) or urllib.parse.urlparse(url).scheme != "https":
        raise ValueError("图片接口既未返回 b64_json，也未返回 HTTPS 图片地址")
    with urllib.request.urlopen(url, timeout=90) as response:
        image = response.read(MAX_IMAGE_BYTES + 1)
    if len(image) > MAX_IMAGE_BYTES:
        raise ValueError("生成图片超过 12 MiB 限制")
    return image


def detect_extension(image: bytes) -> str:
    for signature, extension in IMAGE_SIGNATURES:
        if image.startswith(signature):
            if extension == ".webp" and image[8:12] != b"WEBP":
                continue
            return extension
    raise ValueError("图片接口返回的不是 PNG、JPEG 或 WebP")


def request_cover(
    base_url: str,
    api_key: str,
    model: str,
    size: str,
    story: dict,
    output_format: str = "png",
    response_format: str = "",
) -> bytes:
    endpoint = f"{base_url.rstrip('/')}/images/generations"
    request_payload = {
        "model": model,
        "prompt": cover_prompt(story),
        "size": size,
        "n": 1,
        "output_format": output_format,
    }
    if response_format:
        request_payload["response_format"] = response_format
    body = json.dumps(request_payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read(600).decode("utf-8", errors="replace")
        raise RuntimeError(f"图片接口 HTTP {error.code}: {detail}") from error
    return decode_image_response(payload)


def write_atomic(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("dist/data.json"))
    parser.add_argument("--output", type=Path, default=Path("covers"))
    parser.add_argument("--story-id", action="append", default=[])
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--base-url", default=os.getenv("READER_IMAGE_BASE_URL", DEFAULT_IMAGE_BASE_URL))
    parser.add_argument("--model", default=os.getenv("READER_IMAGE_MODEL", DEFAULT_IMAGE_MODEL))
    parser.add_argument("--size", default=os.getenv("READER_IMAGE_SIZE", "1024x1536"))
    parser.add_argument(
        "--output-format",
        choices=["png", "jpeg", "webp"],
        default=os.getenv("READER_IMAGE_OUTPUT_FORMAT", "png"),
    )
    parser.add_argument(
        "--response-format",
        choices=["", "b64_json", "url"],
        default=os.getenv("READER_IMAGE_RESPONSE_FORMAT", ""),
    )
    args = parser.parse_args()
    api_key = os.getenv("READER_IMAGE_API_KEY", "")
    if not args.base_url or not args.model or not api_key:
        raise SystemExit("请设置 READER_IMAGE_API_KEY")

    payload = json.loads(args.data.read_text(encoding="utf-8"))
    selected = set(args.story_id)
    stories = [story for story in payload.get("stories", []) if not selected or story.get("id") in selected]
    if selected - {story.get("id") for story in stories}:
        raise SystemExit(f"未找到作品：{', '.join(sorted(selected - {story.get('id') for story in stories}))}")

    generated = 0
    for story in stories:
        existing = next((path for path in args.output.glob(f"{story['id']}.*") if path.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'}), None)
        if existing and not args.force:
            print(f"跳过已有封面：{story['title']} -> {existing}")
            continue
        image = request_cover(
            args.base_url,
            api_key,
            args.model,
            args.size,
            story,
            args.output_format,
            args.response_format,
        )
        extension = detect_extension(image)
        destination = args.output / f"{story['id']}{extension}"
        write_atomic(destination, image)
        generated += 1
        print(f"已生成：{story['title']} -> {destination}")
    print(f"完成：生成 {generated} 张封面。重新运行 tools/build_publish.py 即可发布。")


if __name__ == "__main__":
    main()

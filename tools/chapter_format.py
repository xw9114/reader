"""Normalize chapter headings without changing manuscript prose."""

from __future__ import annotations

import re


CHAPTER_PREFIX = re.compile(
    r"^(?:第\s*(?P<zh>[0-9０-９一二三四五六七八九十百千万零〇两]+)\s*[章回节篇]"
    r"|chapter\s*(?P<en>[0-9０-９]+))"
    r"(?=$|[\s:：、.．\-—])[\s:：、.．\-—]*(?P<title>.*)$",
    re.IGNORECASE,
)


def _number(value: str) -> int:
    if value.isdecimal():
        return int(value)
    digits = dict(zip("零〇一二两三四五六七八九", (0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9)))
    units = {"十": 10, "百": 100, "千": 1000, "万": 10000}
    total = section = digit = 0
    for character in value:
        if character in digits:
            digit = digits[character]
        elif character == "万":
            total += (section + digit) * units[character]
            section = digit = 0
        else:
            section += (digit or 1) * units[character]
            digit = 0
    return total + section + digit


def _plain_heading(value: str) -> str:
    text = re.sub(r"^#{1,6}\s+", "", value.strip())
    return re.sub(r"\s+#+$", "", text).strip()


def _bare_title(value: str, number: int) -> str:
    text = _plain_heading(value)
    while match := CHAPTER_PREFIX.fullmatch(text):
        if _number(match.group("zh") or match.group("en")) != number:
            break
        text = match.group("title").strip()
    return text


def normalize_chapter(
    number: int, title: str, body: str, *, preserve_title_style: bool = False,
) -> tuple[str, str]:
    """Keep one numbered title and remove only matching leading body headings."""
    bare_title = _bare_title(title, number)
    heading = f"第{number}章" + (f" {bare_title}" if bare_title else "")
    if preserve_title_style:
        heading = _plain_heading(title)
        prefix = CHAPTER_PREFIX.fullmatch(heading)
        if prefix and _number(prefix.group("zh") or prefix.group("en")) == number:
            heading = heading[:prefix.start("title")] + bare_title
    manuscript = body.replace("\r\n", "\n").replace("\r", "\n").strip()
    while manuscript:
        first, separator, rest = manuscript.partition("\n")
        candidate = _plain_heading(first)
        match = CHAPTER_PREFIX.fullmatch(candidate)
        numbered = match is not None and _number(match.group("zh") or match.group("en")) == number
        marked = first.lstrip().startswith("#")
        if not (numbered or marked):
            break
        candidate_title = _bare_title(candidate, number)
        if re.sub(r"\s+", "", candidate_title) != re.sub(r"\s+", "", bare_title):
            break
        manuscript = rest.lstrip() if separator else ""
    return heading, manuscript

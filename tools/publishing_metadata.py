"""Resolve publishing metadata from explicit fields and corroborated story premises."""

from __future__ import annotations

import re


def text(*values: object) -> str:
    return next((value.strip() for value in values if isinstance(value, str) and value.strip()), "")


def resolve_publishing_metadata(
    project: dict, existing: dict, manuscript: str, characters: list[dict] | None = None,
) -> dict[str, str]:
    protagonist = text(existing.get("protagonist"), project.get("protagonist"))
    if not protagonist:
        leads = {
            text(card.get("full_name")) for card in characters or []
            if text(card.get("role")) in {"主角", "主人公", "男主", "女主", "protagonist"}
            and text(card.get("full_name")) in manuscript
        } - {""}
        if len(leads) == 1:
            protagonist = leads.pop()

    premise = text(project.get("premise"))
    if not protagonist:
        # Only accept an explicitly named viewpoint character, confirmed in the manuscript.
        viewpoints = re.findall(r"始终跟随([^。！？\n]+)[。！？]", premise)
        names = set()
        for viewpoint in viewpoints:
            candidates = [
                viewpoint[-length:] for length in range(2, 5)
                if re.fullmatch(r"[\u4e00-\u9fff]+", viewpoint[-length:])
                and premise.count(viewpoint[-length:]) >= 2
                and viewpoint[-length:] in manuscript
            ]
            if candidates:
                names.add(max(candidates, key=len))
        if len(names) == 1:
            protagonist = names.pop()

    synopsis = text(
        existing.get("synopsis"), existing.get("summary"), existing.get("description"),
        project.get("synopsis"), project.get("summary"), project.get("description"),
    )
    if not synopsis:
        # Keep only the central conflict; cast lists and plot resolutions are not jacket copy.
        conflict = re.search(
            r"核心欲望[：:]\s*(.+?)(?=(?:主要人物[^：:\n]{0,12}|人物共[^：:\n]{0,12}"
            r"|关键真相[^：:\n]{0,12}|真相预先[^：:\n]{0,12}|分章走向)[：:])",
            premise, re.DOTALL,
        )
        if conflict:
            candidate = conflict.group(1).strip()
            if 60 <= len(candidate) <= 1000 and not re.search(
                r"写一部|必须写|正文目标|分章|第[一二三四五六七八九十\d]+章", candidate,
            ):
                synopsis = candidate

    missing = [label for label, value in (("主角名", protagonist), ("简介", synopsis)) if not value]
    if missing:
        raise ValueError(
            "Missing publishing metadata / 缺少" + "、".join(missing)
            + ": set project protagonist/synopsis or retain them in book.json; no files were written"
        )
    return {"protagonist": protagonist, "synopsis": synopsis}

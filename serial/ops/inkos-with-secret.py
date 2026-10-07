#!/usr/bin/env python3
"""Run InkOS with the novel API key loaded from OpenClaw's protected store."""

import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path

from publishing_metadata import generate_and_write


STATE_DB = os.environ.get("OPENCLAW_STATE_DB", "/root/.openclaw/state/openclaw.sqlite")
SECRET_NAME = os.environ.get("INKOS_SECRET_NAME", "XW9114_API_KEY")
EXPECTED_HOST = os.environ.get("INKOS_EXPECTED_HOST", "api.xw9114.online")
BASE_URL = os.environ.get("INKOS_BASE_URL", "https://api.xw9114.online/v1")


def project_root(start: Path) -> Path:
    for candidate in (start, *start.parents):
        if (candidate / "inkos.json").is_file():
            return candidate
    raise RuntimeError("InkOS project root was not found")


def book_directories(root: Path) -> set[Path]:
    books = root / "books"
    if not books.is_dir():
        return set()
    return {path for path in books.iterdir() if path.is_dir() and (path / "book.json").is_file()}


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: inkos-with-secret.py <inkos arguments...> | publishing refresh <book-id>")
    if stat.S_IMODE(os.stat(STATE_DB).st_mode) & 0o077:
        raise SystemExit("OpenClaw state database permissions are too broad")

    with sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True) as connection:
        row = connection.execute(
            """SELECT value, allowed_hosts FROM secret_store_entries
               WHERE scope_kind = 'team' AND scope_id = '' AND name = ?
                 AND kind = 'secret' AND deleted_at_ms IS NULL""",
            (SECRET_NAME,),
        ).fetchone()
    if row is None or not row[0]:
        raise SystemExit(f"missing protected secret: {SECRET_NAME}")
    try:
        allowed_hosts = json.loads(row[1] or "[]")
    except json.JSONDecodeError as error:
        raise SystemExit("invalid secret host metadata") from error
    if EXPECTED_HOST not in allowed_hosts:
        raise SystemExit("secret host metadata does not match the novel API")

    environment = os.environ.copy()
    environment[SECRET_NAME] = row[0]
    environment["INKOS_LLM_API_KEY"] = row[0]
    environment["INKOS_SERIAL_MAX_TOKENS"] = "6144"
    model = os.environ.get("SERIAL_NOVEL_MODEL", "gpt-5.6-terra")
    arguments = sys.argv[1:]
    root = project_root(Path.cwd())

    if arguments[:2] == ["publishing", "refresh"]:
        if len(arguments) != 3 or not re.fullmatch(r"[^/\\.][^/\\]*", arguments[2]):
            raise SystemExit("usage: inkos-with-secret.py publishing refresh <book-id>")
        book_dir = root / "books" / arguments[2]
        if not (book_dir / "book.json").is_file():
            raise SystemExit(f"book not found: {arguments[2]}")
        generate_and_write(book_dir, api_key=row[0], base_url=BASE_URL, model=model)
        print(f"InkOS publishing metadata saved: {book_dir / 'book.json'}", flush=True)
        return

    command = [
        "inkos",
        "--api-key-env", SECRET_NAME,
        "--base-url", BASE_URL,
        "--model", model,
        "--stream",
        *arguments,
    ]
    if arguments[:2] == ["book", "create"]:
        before = book_directories(root)
        completed = subprocess.run(command, env=environment, check=False)
        if completed.returncode:
            raise SystemExit(completed.returncode)
        created = sorted(book_directories(root) - before)
        if len(created) != 1:
            raise SystemExit(
                "InkOS book was created, but its directory could not be identified for publishing metadata; "
                "run: inkos-with-secret.py publishing refresh <book-id>"
            )
        try:
            generate_and_write(created[0], api_key=row[0], base_url=BASE_URL, model=model)
        except Exception as error:
            raise SystemExit(
                "InkOS book was created, but publishing metadata generation failed: "
                f"{error}. Run: inkos-with-secret.py publishing refresh {created[0].name}"
            ) from error
        print(f"InkOS publishing metadata saved: {created[0] / 'book.json'}", flush=True)
        return

    os.execvpe(
        "inkos",
        command,
        environment,
    )


if __name__ == "__main__":
    main()

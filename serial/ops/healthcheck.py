#!/usr/bin/env python3
"""Check today's serial chapter, InkOS source, and GitHub publication."""

import hashlib
import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


PROJECT = Path(__file__).resolve().parents[1]
REPOSITORY = PROJECT.parent
GIT_KEY = os.environ.get("READER_GIT_KEY", "/root/.ssh/id_xw9114_reader_deploy")


def check() -> None:
    today = os.environ.get("SERIAL_NOVEL_DATE") or datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
    book_id = os.environ.get("SERIAL_BOOK_ID", "旧城清算")
    book_dir = PROJECT / "books" / book_id
    if not (book_dir / "book.json").is_file():
        raise RuntimeError(f"selected serial book does not exist: {book_id}")
    files = list((book_dir / "published").glob(f"{today}-chapter-*.md"))
    if len(files) != 1:
        raise RuntimeError(f"expected one serial chapter for {today}, found {len(files)}")
    publication = files[0]
    match = re.fullmatch(rf"{today}-chapter-(\d{{4}})\.md", publication.name)
    if not match:
        raise RuntimeError("invalid chapter filename")
    number = int(match.group(1))
    record = json.loads((book_dir / "runs" / f"{today}.json").read_text(encoding="utf-8"))
    if record.get("status") != "published" or record.get("chapter") != number:
        raise RuntimeError("publication record does not match the chapter")
    if record.get("bookId") != book_id:
        raise RuntimeError("publication record does not match the serial book")
    sources = [p for p in (book_dir / "chapters").glob("*.md")
               if re.fullmatch(rf"0*{number}(?:[-_].*)?\.md", p.name)]
    if len(sources) != 1:
        raise RuntimeError("InkOS chapter source is missing or ambiguous")
    data = publication.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != hashlib.sha256(sources[0].read_bytes()).hexdigest() or digest != record.get("sha256"):
        raise RuntimeError("published chapter differs from the InkOS source")
    body = "\n".join(data.decode("utf-8").splitlines()[1:])
    count = len(re.findall(r"[\u3400-\u9fff]", body))
    if count < 2000 or count != record.get("characters"):
        raise RuntimeError(f"chapter is incomplete: {count} Chinese characters")
    index = json.loads((book_dir / "chapters" / "index.json").read_text(encoding="utf-8"))
    entry = next((row for row in index if row.get("number") == number), None)
    if entry is None or entry.get("status") not in {"ready-for-review", "approved"}:
        raise RuntimeError("InkOS chapter index is unhealthy")

    environment = os.environ.copy()
    environment["GIT_SSH_COMMAND"] = (
        f"ssh -i {GIT_KEY} -o IdentitiesOnly=yes -o BatchMode=yes "
        "-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
    )
    subprocess.run(["git", "fetch", "--no-tags", "origin", "main"], cwd=REPOSITORY,
                   env=environment, check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.PIPE, timeout=120)
    relative = publication.relative_to(REPOSITORY).as_posix()
    remote_ref = "origin/main"
    subprocess.run(["git", "cat-file", "-e", f"{remote_ref}:{relative}"], cwd=REPOSITORY,
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    remote_data = subprocess.check_output(
        ["git", "show", f"{remote_ref}:{relative}"], cwd=REPOSITORY, env=environment,
    )
    if hashlib.sha256(remote_data).hexdigest() != digest:
        raise RuntimeError("GitHub main contains a different chapter body")
    local = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPOSITORY, text=True).strip()
    remote = subprocess.check_output(["git", "rev-parse", remote_ref], cwd=REPOSITORY, text=True).strip()
    print(f"SUCCESS: serial novel date={today} chapter={number} chars={count} local={local} remote_commit={remote} remote=verified")


if __name__ == "__main__":
    try:
        check()
    except Exception as error:
        print(f"FAILED: {error}")
        raise SystemExit(1)

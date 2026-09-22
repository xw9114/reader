#!/usr/bin/env python3
"""Publish at most one validated chapter of the same InkOS book per date."""

import fcntl
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


PROJECT = Path(__file__).resolve().parents[1]
REPOSITORY = PROJECT.parent
BOOKS = PROJECT / "books"
PUBLISHED = PROJECT / "published"
RUNS = PROJECT / "runs"
LOGS = Path("/var/log/openclaw-jobs")
START_DATE = date(2026, 9, 20)
MIN_CJK = 2000
TARGET_WORDS = 2500
MAX_SECONDS = 1500
GIT_KEY = "/root/.ssh/id_xw9114_reader_deploy"
INKOS = PROJECT / "ops" / "inkos-with-secret.py"


def say(message: str) -> None:
    print(message, flush=True)


def fail(message: str) -> None:
    raise RuntimeError(message)


def run(command: list[str], *, cwd: Path | None = None, timeout: int = 90,
        env: dict[str, str] | None = None) -> str:
    completed = subprocess.run(command, cwd=cwd or REPOSITORY, env=env, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=timeout, check=False)
    if completed.returncode:
        fail(f"{' '.join(command[:2])} exited {completed.returncode}: {completed.stderr[-500:]}")
    return completed.stdout.strip()


def git_environment() -> dict[str, str]:
    environment = os.environ.copy()
    environment["GIT_SSH_COMMAND"] = (
        f"ssh -i {GIT_KEY} -o IdentitiesOnly=yes -o BatchMode=yes "
        "-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
    )
    return environment


def remote_head() -> str:
    output = run(["git", "ls-remote", "origin", "refs/heads/main"],
                 env=git_environment(), timeout=60)
    head = output.split()[0] if output else ""
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        fail("remote main has no readable commit")
    return head


def sync_git(message: str) -> str:
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=REPOSITORY).returncode:
        fail("unrelated staged changes exist")
    run(["git", "add", "--", "serial"], timeout=30)
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=REPOSITORY).returncode:
        run(["git", "commit", "-m", message, "--", "serial"], timeout=60)
    local = run(["git", "rev-parse", "HEAD"])
    remote = remote_head()
    if local != remote:
        run(["git", "fetch", "--no-tags", "origin", "main"], env=git_environment(), timeout=120)
        ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", remote, local],
                                  cwd=REPOSITORY, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL).returncode
        if ancestor:
            merged = subprocess.run(["git", "merge", "--no-edit", remote], cwd=REPOSITORY,
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if merged.returncode:
                if (REPOSITORY / ".git" / "MERGE_HEAD").exists():
                    subprocess.run(["git", "merge", "--abort"], cwd=REPOSITORY,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                fail(f"remote main conflicts with serial state: {merged.stderr[-300:]}")
            local = run(["git", "rev-parse", "HEAD"])
        run(["git", "push", "origin", "HEAD:main"], env=git_environment(), timeout=120)
        if remote_head() != local:
            fail("remote main did not reach the local commit")
    return local


def book() -> tuple[str, Path, dict]:
    found = [(p.name, p, json.loads((p / "book.json").read_text(encoding="utf-8")))
             for p in BOOKS.iterdir() if p.is_dir() and (p / "book.json").exists()]
    if len(found) != 1:
        fail(f"expected one serial book, found {len(found)}")
    return found[0]


def chapter_file(book_dir: Path, number: int) -> Path | None:
    pattern = re.compile(rf"^0*{number}(?:[-_].*)?\.md$")
    matches = [p for p in (book_dir / "chapters").glob("*.md") if pattern.fullmatch(p.name)]
    if len(matches) > 1:
        fail(f"ambiguous files for chapter {number}")
    return matches[0] if matches else None


def cjk_count(path: Path, number: int) -> int:
    content = path.read_text(encoding="utf-8")
    if not content.strip():
        fail(f"chapter {number} is empty")
    if re.search(rf"第\s*{number}\s*章", content[:150]) is None:
        fail(f"chapter {number} has the wrong numbered heading")
    body = "\n".join(content.splitlines()[1:])
    count = len(re.findall(r"[\u3400-\u9fff]", body))
    if count < MIN_CJK:
        fail(f"chapter {number} has only {count} Chinese characters; need {MIN_CJK}")
    return count


def write_chapter(book_id: str, number: int, rewrite: bool = False,
                  audit_issues: list[str] | None = None) -> None:
    LOGS.mkdir(parents=True, exist_ok=True)
    log = LOGS / f"serial-chapter-{number:04d}-{'rewrite' if rewrite else 'write'}.log"
    command = [sys.executable, str(INKOS)]
    if rewrite:
        brief = ("请写完整的连续小说正文，本章至少2000个汉字，目标2500字；"
                 "保持既有设定和时间线，并修复上一版的所有审计问题。")
        if audit_issues:
            brief += "\n上一版审计问题：\n" + "\n".join(audit_issues)
        command += ["write", "rewrite", book_id, str(number), "--force", "--words", str(TARGET_WORDS),
                    "--brief", brief]
    else:
        command += ["write", "next", book_id, "--count", "1", "--words", str(TARGET_WORDS),
                    "--context-file", str(PROJECT / "brief.md")]
    with log.open("w", encoding="utf-8") as output:
        os.chmod(log, 0o600)
        process = subprocess.Popen(command, cwd=PROJECT, stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        started = time.monotonic()
        while process.poll() is None:
            if time.monotonic() - started > MAX_SECONDS:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                fail(f"InkOS timed out after {MAX_SECONDS}s; log={log}")
            say(f"HEARTBEAT: chapter={number} elapsed={int(time.monotonic()-started)}s log={log}")
            time.sleep(20)
        if process.returncode:
            fail(f"InkOS exited {process.returncode}; log={log}")


def selected_date() -> date | None:
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    candidate = START_DATE
    while candidate <= today:
        if not list(PUBLISHED.glob(f"{candidate.isoformat()}-chapter-*.md")):
            return candidate
        candidate += timedelta(days=1)
    return None


def atomic_json(path: Path, value: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def chapter_index_entry(book_dir: Path, number: int) -> dict | None:
    index = json.loads((book_dir / "chapters" / "index.json").read_text(encoding="utf-8"))
    return next((row for row in index if row.get("number") == number), None)


def validate_existing_publications(book_id: str, book_dir: Path) -> None:
    for publication in PUBLISHED.glob("*.md"):
        match = re.fullmatch(r"(\d{4}-\d{2}-\d{2})-chapter-(\d{4})\.md", publication.name)
        if match is None:
            fail(f"unexpected publication filename: {publication.name}")
        number = int(match.group(2))
        record_path = RUNS / f"{match.group(1)}.json"
        record = json.loads(record_path.read_text(encoding="utf-8"))
        source = chapter_file(book_dir, number)
        if (source is None or record.get("bookId") != book_id
                or record.get("chapter") != number or record.get("status") != "published"):
            fail(f"publication record or source is missing for chapter {number}")
        digest = hashlib.sha256(publication.read_bytes()).hexdigest()
        if digest != record.get("sha256") or digest != hashlib.sha256(source.read_bytes()).hexdigest():
            fail(f"published chapter {number} differs from its InkOS source or record")
        if cjk_count(publication, number) != record.get("characters"):
            fail(f"published chapter {number} has a changed character count")


def main() -> None:
    os.chdir(REPOSITORY)
    PUBLISHED.mkdir(exist_ok=True)
    RUNS.mkdir(exist_ok=True)
    with open("/run/lock/openclaw-daily-serial.lock", "w", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("another serial chapter job is running")

        book_id, book_dir, metadata = book()
        validate_existing_publications(book_id, book_dir)

        # A chapter copied before a push failure must reach GitHub before another is written.
        unpublished = [p for p in PUBLISHED.glob("*.md")
                       if subprocess.run(["git", "cat-file", "-e", f"HEAD:{p.relative_to(REPOSITORY).as_posix()}"],
                                         cwd=REPOSITORY, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL).returncode]
        if unpublished:
            commit = sync_git("Publish pending serial chapter")
            say(f"SUCCESS: pending chapter pushed; commit={commit}")
            return

        publish_date = selected_date()
        if publish_date is None:
            commit = sync_git("Sync serial novel state")
            say(f"SUCCESS: today's serial chapter already published; commit={commit}")
            return
        published_count = len(list(PUBLISHED.glob("*-chapter-*.md")))
        number = published_count + 1
        if number > int(metadata.get("targetChapters", 0)):
            say(f"SUCCESS: serial novel complete at {published_count} chapters")
            return
        reservation = RUNS / f"{publish_date.isoformat()}.json"
        if reservation.exists():
            saved = json.loads(reservation.read_text(encoding="utf-8"))
            if saved.get("chapter") != number or saved.get("bookId") != book_id:
                fail("date reservation disagrees with the chapter sequence")
        else:
            atomic_json(reservation, {"date": publish_date.isoformat(), "chapter": number,
                                      "bookId": book_id, "createdAt": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()})

        source = chapter_file(book_dir, number)
        if source is None:
            say(f"HEARTBEAT: writing book={book_id} chapter={number} date={publish_date}")
            write_chapter(book_id, number)
            source = chapter_file(book_dir, number)
        if source is None:
            fail(f"InkOS did not save chapter {number}")
        rewritten = False
        try:
            count = cjk_count(source, number)
        except RuntimeError as error:
            say(f"HEARTBEAT: {error}; rewriting chapter {number} once")
            write_chapter(book_id, number, rewrite=True)
            rewritten = True
            source = chapter_file(book_dir, number)
            if source is None:
                fail(f"rewrite did not save chapter {number}")
            count = cjk_count(source, number)
        entry = chapter_index_entry(book_dir, number)
        if (entry is None or entry.get("status") not in {"ready-for-review", "approved"}) and not rewritten:
            status = entry.get("status") if entry else "missing"
            issues = [str(issue) for issue in (entry or {}).get("auditIssues", [])
                      if str(issue).startswith(("[critical]", "[warning]"))]
            say(f"HEARTBEAT: chapter {number} status={status}; rewriting once with audit feedback")
            write_chapter(book_id, number, rewrite=True, audit_issues=issues)
            source = chapter_file(book_dir, number)
            if source is None:
                fail(f"audit rewrite did not save chapter {number}")
            count = cjk_count(source, number)
            entry = chapter_index_entry(book_dir, number)
        if entry is None or entry.get("status") not in {"ready-for-review", "approved"}:
            status = entry.get("status") if entry else "missing"
            fail(f"chapter {number} has no healthy InkOS index entry after one rewrite; status={status}")

        destination = PUBLISHED / f"{publish_date.isoformat()}-chapter-{number:04d}.md"
        if destination.exists():
            fail(f"chapter output already exists: {destination}")
        destination.write_bytes(source.read_bytes())
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        record = json.loads(reservation.read_text(encoding="utf-8"))
        record.update({"status": "published", "characters": count, "sha256": digest,
                       "publishedAt": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()})
        atomic_json(reservation, record)
        commit = sync_git(f"Publish {metadata['title']} chapter {number:04d} ({publish_date})")
        say(f"SUCCESS: book={metadata['title']} chapter={number} date={publish_date} chars={count} "
            f"path={destination.relative_to(REPOSITORY)} commit={commit} remote=verified")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        say(f"FAILED: {error}")
        raise SystemExit(1)

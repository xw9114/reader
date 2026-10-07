#!/usr/bin/env python3
"""Publish at most one validated chapter of the selected InkOS book per date."""

import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    import fcntl
except ImportError:  # pragma: no cover - exercised on Windows runners
    fcntl = None

try:
    import msvcrt
except ImportError:  # pragma: no cover - exercised on POSIX runners
    msvcrt = None

try:
    from platform_state import default_platforms
except ModuleNotFoundError:  # Allows importlib-based tests from the repository root.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from platform_state import default_platforms, normalize_platforms
else:
    from platform_state import normalize_platforms


PROJECT = Path(__file__).resolve().parents[1]
REPOSITORY = PROJECT.parent
BOOKS = PROJECT / "books"
ACTIVE_BOOK_ID = os.environ.get("SERIAL_BOOK_ID", "旧城清算")
ACTIVE_BOOK = BOOKS / ACTIVE_BOOK_ID
PUBLISHED = ACTIVE_BOOK / "published"
RUNS = ACTIVE_BOOK / "runs"
LOGS = Path(os.environ.get(
    "READER_LOG_DIR",
    "/var/log/openclaw-jobs" if os.name != "nt" else str(REPOSITORY / ".runtime" / "logs"),
))
TIMEZONE = ZoneInfo(os.environ.get("READER_TIMEZONE", "Asia/Shanghai"))
START_DATE = date.fromisoformat(os.environ.get("SERIAL_START_DATE", "2026-09-20"))
MIN_CJK = 2000
TARGET_WORDS = 2500
MAX_SECONDS = 1500
GIT_KEY = os.environ.get("READER_GIT_KEY", "/root/.ssh/id_xw9114_reader_deploy")
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


@contextmanager
def exclusive_file_lock(lock_path: Path, *, non_blocking: bool = False):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock:
        if fcntl is not None:
            flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if non_blocking else 0)
            try:
                fcntl.flock(lock, flags)
            except BlockingIOError:
                fail("another serial chapter job is running")
        elif msvcrt is not None:
            lock.seek(0)
            lock.write("0")
            lock.flush()
            lock.seek(0)
            mode = msvcrt.LK_NBLCK if non_blocking else msvcrt.LK_LOCK
            try:
                msvcrt.locking(lock.fileno(), mode, 1)
            except OSError:
                fail("another serial chapter job is running")
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(lock, fcntl.LOCK_UN)
            elif msvcrt is not None:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


@contextmanager
def git_sync_lock():
    """Serialize repository mutations across different book jobs."""
    lock_path = Path(os.environ.get("READER_GIT_LOCK", str(REPOSITORY / ".git" / "reader-git-sync.lock")))
    with exclusive_file_lock(lock_path):
        yield


def _staged_paths() -> list[str]:
    output = run(["git", "diff", "--cached", "--name-only"], timeout=30)
    return [line for line in output.splitlines() if line]


def sync_git(message: str, paths: list[Path] | None = None) -> str:
    allowed = [path.as_posix().rstrip("/") for path in (paths or [Path("serial")])]
    with git_sync_lock():
        if _staged_paths():
            fail("unrelated staged changes exist")
        run(["git", "add", "--", *allowed], timeout=30)
        staged = _staged_paths()
        if any(not any(path == prefix or path.startswith(prefix + "/") for prefix in allowed) for path in staged):
            run(["git", "reset", "--", *allowed], timeout=30)
            fail("staged changes escaped the current serial book")
        if staged:
            run(["git", "commit", "-m", message, "--", *allowed], timeout=60)
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
    metadata_path = ACTIVE_BOOK / "book.json"
    if not metadata_path.is_file():
        fail(f"selected serial book does not exist: {ACTIVE_BOOK_ID}")
    return ACTIVE_BOOK_ID, ACTIVE_BOOK, json.loads(metadata_path.read_text(encoding="utf-8"))


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


def repair_chapter_state(book_id: str, number: int) -> None:
    """Repair truth files for a chapter whose body already passed audit."""
    LOGS.mkdir(parents=True, exist_ok=True)
    log = LOGS / f"serial-chapter-{number:04d}-repair-state.log"
    command = [sys.executable, str(INKOS), "write", "repair-state", book_id, str(number)]
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
                fail(f"InkOS state repair timed out after {MAX_SECONDS}s; log={log}")
            say(f"HEARTBEAT: repairing-state chapter={number} "
                f"elapsed={int(time.monotonic()-started)}s log={log}")
            time.sleep(20)
        if process.returncode:
            fail(f"InkOS state repair exited {process.returncode}; log={log}")


def selected_date() -> date | None:
    today = datetime.now(TIMEZONE).date()
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
        normalize_platforms(record.get("platforms"))
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
    lock_id = hashlib.sha256(ACTIVE_BOOK_ID.encode("utf-8")).hexdigest()[:12]
    lock_root = Path(os.environ.get(
        "READER_LOCK_DIR",
        "/run/lock" if os.name != "nt" else str(REPOSITORY / ".runtime" / "locks"),
    ))
    book_lock = lock_root / f"openclaw-daily-serial-{lock_id}.lock"
    with exclusive_file_lock(book_lock, non_blocking=True):

        book_id, book_dir, metadata = book()
        validate_existing_publications(book_id, book_dir)

        # A chapter copied before a push failure must reach GitHub before another is written.
        unpublished = [p for p in PUBLISHED.glob("*.md")
                       if subprocess.run(["git", "cat-file", "-e", f"HEAD:{p.relative_to(REPOSITORY).as_posix()}"],
                                         cwd=REPOSITORY, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL).returncode]
        if unpublished:
            commit = sync_git(
                "Publish pending serial chapter",
                [Path("serial") / "books" / ACTIVE_BOOK_ID],
            )
            say(f"SUCCESS: pending chapter pushed; commit={commit}")
            return

        publish_date = selected_date()
        if publish_date is None:
            commit = sync_git(
                "Sync serial novel state",
                [Path("serial") / "books" / ACTIVE_BOOK_ID],
            )
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
                                      "bookId": book_id, "createdAt": datetime.now(TIMEZONE).isoformat(),
                                      "platforms": default_platforms()})

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
        if entry is not None and entry.get("status") == "state-degraded":
            say(f"HEARTBEAT: chapter {number} body passed audit but state is degraded; repairing state")
            repair_chapter_state(book_id, number)
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
            if entry is not None and entry.get("status") == "state-degraded":
                say(f"HEARTBEAT: rewritten chapter {number} has degraded state; repairing state")
                repair_chapter_state(book_id, number)
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
                       "platforms": default_platforms(),
                       "publishedAt": datetime.now(TIMEZONE).isoformat()})
        atomic_json(reservation, record)
        commit = sync_git(
            f"Publish {metadata['title']} chapter {number:04d} ({publish_date})",
            [Path("serial") / "books" / ACTIVE_BOOK_ID],
        )
        say(f"SUCCESS: book={metadata['title']} chapter={number} date={publish_date} chars={count} "
            f"path={destination.relative_to(REPOSITORY)} commit={commit} remote=verified")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        say(f"FAILED: {error}")
        raise SystemExit(1)

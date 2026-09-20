#!/usr/bin/env python3
"""Run InkOS with the novel API key loaded from OpenClaw's protected store."""

import json
import os
import sqlite3
import stat
import sys


STATE_DB = "/root/.openclaw/state/openclaw.sqlite"
SECRET_NAME = "XW9114_API_KEY"
EXPECTED_HOST = "api.xw9114.online"


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: inkos-with-secret.py <inkos arguments...>")
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
    os.execvpe(
        "inkos",
        [
            "inkos",
            "--api-key-env", SECRET_NAME,
            "--base-url", "https://api.xw9114.online/v1",
            "--model", model,
            "--stream",
            *sys.argv[1:],
        ],
        environment,
    )


if __name__ == "__main__":
    main()

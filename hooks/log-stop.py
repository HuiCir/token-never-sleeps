#!/usr/bin/env python3
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    cwd = payload.get("cwd") or os.getcwd()
    state_dir = Path(cwd) / ".tns"
    if not state_dir.exists():
        return 0

    entry = {
        "event": "stop",
        "at": datetime.now(timezone.utc).isoformat(),
        "cwd": cwd,
        "session_id": payload.get("session_id"),
        "transcript_path": payload.get("transcript_path"),
        "reason": payload.get("reason") or payload.get("stop_reason") or "",
        "hook_event_name": payload.get("event_name") or "",
    }
    log_path = state_dir / "hook-events.jsonl"
    with log_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

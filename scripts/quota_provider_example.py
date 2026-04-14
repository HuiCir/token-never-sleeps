#!/usr/bin/env python3
import json
import os
from datetime import datetime, timezone


def main() -> int:
    remaining = int(os.environ.get("TNS_EXAMPLE_REMAINING", "0"))
    payload = {
        "ok": True,
        "remaining": remaining,
        "unit": "tokens",
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "reason": "example provider",
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

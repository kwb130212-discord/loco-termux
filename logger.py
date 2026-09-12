from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from storage import DATA_DIR

LOG_FILE = DATA_DIR / "audit.log"


def write(kind: str, **fields: object) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    safe = " ".join(f"{key}={str(value).replace(chr(10), ' ')[:300]}" for key, value in fields.items())
    with LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(f"{stamp} [{kind}] {safe}\n")
    try:
        LOG_FILE.chmod(0o600)
    except OSError:
        pass

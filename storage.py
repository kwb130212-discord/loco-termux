from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

DATA_DIR = Path.home() / ".loco-termux"


def secure_dir(path: Path = DATA_DIR) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError as exc:
        print(f"[WARN] 디렉터리 권한 설정 실패: {exc}")
    return path


def load_json(path: str | Path, default: Any = None) -> Any:
    path = Path(path).expanduser()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value
    except (OSError, ValueError, TypeError):
        return default


def save_json(path: str | Path, value: Any, mode: int = 0o600) -> None:
    path = Path(path).expanduser()
    secure_dir(path.parent)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, path)
        try:
            path.chmod(mode)
        except OSError as exc:
            print(f"[WARN] 파일 권한 설정 실패: {exc}")
    finally:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass

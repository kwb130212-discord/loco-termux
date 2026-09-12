from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import re

from storage import DATA_DIR, load_json, save_json, secure_dir

ROOMS_DIR = DATA_DIR / "rooms"
MAX_HISTORY = 10000


def _room_dir(room_id: str) -> Path:
    safe = re.sub(r"[^0-9A-Za-z._-]+", "_", str(room_id).strip())[:160] or "unknown"
    path = ROOMS_DIR / safe
    secure_dir(path)
    return path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read(path: Path) -> list[dict]:
    value = load_json(path, [])
    return value if isinstance(value, list) else []


def record_departure(room_id: str, room_name: str, user_id: str, nickname: str, message_id: str | None = None, count: int = 0) -> None:
    if not str(room_id).strip() or not str(user_id).strip():
        return
    directory = _room_dir(room_id)
    current_path = directory / "departed.json"
    history_path = directory / "leave-log.json"
    row = {"room_id": str(room_id), "room_name": str(room_name or ""), "user_id": str(user_id), "nickname": str(nickname or "알 수 없음"), "left_at": _now(), "message_id": message_id, "count": int(count or 0)}
    current = {str(x.get("user_id")): x for x in _read(current_path) if isinstance(x, dict) and x.get("user_id")}
    current[str(user_id)] = row
    history = _read(history_path)
    history.append(row)
    save_json(current_path, list(current.values()))
    save_json(history_path, history[-MAX_HISTORY:])


def list_departed(room_id: str) -> list[dict]:
    return sorted(_read(_room_dir(room_id) / "departed.json"), key=lambda x: str(x.get("left_at", "")), reverse=True)


def list_leave_history(room_id: str) -> list[dict]:
    return sorted(_read(_room_dir(room_id) / "leave-log.json"), key=lambda x: str(x.get("left_at", "")), reverse=True)


def remove_departed(room_id: str, user_id: str) -> None:
    path = _room_dir(room_id) / "departed.json"
    rows = [x for x in _read(path) if str(x.get("user_id", "")) != str(user_id)]
    save_json(path, rows)


def remove_all_departed(room_id: str, successful_ids: list[str]) -> None:
    if not successful_ids:
        return
    ids = {str(x) for x in successful_ids}
    path = _room_dir(room_id) / "departed.json"
    save_json(path, [x for x in _read(path) if str(x.get("user_id", "")) not in ids])

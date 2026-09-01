from __future__ import annotations

"""LOCO TERMUX room event analyzer.

This module is intentionally protocol-agnostic. It stores only room/member
identifiers and timestamps; network/IP/device fields are never persisted.
The actual transport layer can feed join/leave/read events into this class.
"""

from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
import json
import threading


@dataclass
class MemberEvent:
    room_id: str
    user_id: str
    nickname: str
    event: str
    at: str
    count: int = 0


@dataclass
class PendingLeave:
    room_id: str
    user_id: str
    nickname: str
    left_at: str
    message_id: Optional[str] = None


class LocoAnalyzer:
    """Room/member event analyzer with privacy filtering and persistent logs."""

    def __init__(self, data_file: str = "loco_analyzer.json", max_events: int = 5000):
        self.data_file = Path(data_file)
        self.max_events = max_events
        self._lock = threading.RLock()
        self.events: List[MemberEvent] = []
        self.pending_leaves: Dict[str, PendingLeave] = {}
        self.reads: Dict[str, Dict[str, str]] = {}
        self._load()

    @staticmethod
    def _safe_user(user: object) -> tuple[str, str]:
        """Extract only user ID/nickname. Never copy arbitrary user fields."""
        if isinstance(user, dict):
            uid = user.get("user_id", user.get("userId", user.get("id")))
            nickname = user.get("nickname", "알 수 없음")
        else:
            uid = getattr(user, "user_id", None) or getattr(user, "userId", None) or getattr(user, "id", None)
            nickname = getattr(user, "nickname", "알 수 없음")

        return str(uid or nickname), str(nickname or "알 수 없음")

    @staticmethod
    def _now() -> str:
        return datetime.now().isoformat(timespec="seconds")

    @staticmethod
    def _time_text(iso_time: str) -> str:
        try:
            return datetime.fromisoformat(iso_time).strftime("%H시 %M분")
        except ValueError:
            return iso_time

    def _save(self) -> None:
        payload = {
            "events": [asdict(e) for e in self.events[-self.max_events :]],
            "pending_leaves": {k: asdict(v) for k, v in self.pending_leaves.items()},
            "reads": self.reads,
        }
        tmp = self.data_file.with_suffix(self.data_file.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.data_file)

    def _load(self) -> None:
        if not self.data_file.exists():
            return
        try:
            payload = json.loads(self.data_file.read_text(encoding="utf-8"))
            self.events = [MemberEvent(**x) for x in payload.get("events", [])]
            self.pending_leaves = {
                k: PendingLeave(**v) for k, v in payload.get("pending_leaves", {}).items()
            }
            self.reads = payload.get("reads", {})
        except (OSError, ValueError, TypeError, KeyError):
            self.events = []
            self.pending_leaves = {}
            self.reads = {}

    def user_joined(self, room_id: str, user: object) -> int:
        user_id, nickname = self._safe_user(user)
        with self._lock:
            count = sum(
                1 for e in self.events
                if e.room_id == room_id and e.user_id == user_id and e.event == "JOIN"
            ) + 1
            self.events.append(MemberEvent(room_id, user_id, nickname, "JOIN", self._now(), count))
            self._save()
            return count

    def user_left(self, room_id: str, user: object, message_id: Optional[str] = None) -> str:
        user_id, nickname = self._safe_user(user)
        left_at = self._now()
        with self._lock:
            self.events.append(MemberEvent(room_id, user_id, nickname, "LEAVE", left_at))
            self.pending_leaves[user_id] = PendingLeave(
                room_id=room_id,
                user_id=user_id,
                nickname=nickname,
                left_at=left_at,
                message_id=message_id,
            )
            self._save()
        return self.leave_message(nickname, left_at)

    def record_read(self, message_id: str, user: object) -> None:
        user_id, nickname = self._safe_user(user)
        with self._lock:
            self.reads.setdefault(str(message_id), {})[user_id] = nickname
            self._save()

    def leave_message(self, nickname: str, left_at: str) -> str:
        return (
            f"{nickname}님이 나가셨습니다.\n\n"
            f"[전체보기]\n\n"
            f"{nickname} 님이 {self._time_text(left_at)}에 나가셨습니다.\n"
            "나간사람을 내보내실려면 이 메시지에 답장으로 kick이라고 보내주세요.\n"
            "[관리자만 가능합니다]"
        )

    def get_leave_detail(self, user_id: str) -> Optional[PendingLeave]:
        return self.pending_leaves.get(str(user_id))

    def is_admin(self, actor_user_id: str, admins: List[str]) -> bool:
        return str(actor_user_id) in {str(x) for x in admins}

    def kick_request(self, actor_user_id: str, target_user_id: str, admins: List[str]) -> Dict[str, object]:
        """Validate an admin-only kick request.

        The transport/protocol layer must perform the actual supported kick
        operation. This method deliberately does not forge protocol packets.
        """
        if not self.is_admin(actor_user_id, admins):
            return {"ok": False, "reason": "ADMIN_ONLY"}

        target = self.get_leave_detail(target_user_id)
        if not target:
            return {"ok": False, "reason": "TARGET_NOT_FOUND"}

        return {
            "ok": True,
            "action": "KICK_REQUEST",
            "room_id": target.room_id,
            "target_user_id": target.user_id,
            "target_nickname": target.nickname,
        }

    def room_events(self, room_id: str, limit: int = 100) -> List[MemberEvent]:
        return [e for e in self.events if e.room_id == room_id][-limit:]


if __name__ == "__main__":
    analyzer = LocoAnalyzer()
    print("LOCO Analyzer ready")

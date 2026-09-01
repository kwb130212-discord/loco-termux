from __future__ import annotations

"""LOCO TERMUX room event analyzer.

Protocol-agnostic event/state layer. Authentication is deliberately kept out
of this module: it records observable events and diagnostics supplied by the
transport layer, but never fabricates sessions/tokens or attempts to bypass
server-side permissions.
"""

from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any
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
    message_id: Optional[str] = None


@dataclass
class PendingLeave:
    room_id: str
    user_id: str
    nickname: str
    left_at: str
    message_id: Optional[str] = None


@dataclass
class SessionDiagnostic:
    user_id: str
    session_id: Optional[str]
    observed_at: str
    status: str
    error_code: Optional[str] = None
    detail: Optional[str] = None


class LocoAnalyzer:
    """Thread-safe room/member analyzer with persistent state and diagnostics."""

    VALID_EVENTS = {"JOIN", "LEAVE", "READ", "KICK"}

    def __init__(self, data_file: str = "loco_analyzer.json", max_events: int = 5000,
                 max_reads: int = 5000, max_diagnostics: int = 1000):
        self.data_file = Path(data_file)
        self.max_events = max(1, int(max_events))
        self.max_reads = max(1, int(max_reads))
        self.max_diagnostics = max(1, int(max_diagnostics))
        self._lock = threading.RLock()

        self.events: List[MemberEvent] = []
        self.pending_leaves: Dict[str, PendingLeave] = {}
        self.reads: Dict[str, Dict[str, str]] = {}
        self.join_counts: Dict[str, int] = {}
        self.online: Dict[str, Dict[str, str]] = {}
        self.session_diagnostics: List[SessionDiagnostic] = []
        self._load()

    @staticmethod
    def _safe_user(user: object) -> tuple[str, str]:
        """Extract only the identifiers needed by the analyzer."""
        if isinstance(user, dict):
            uid = user.get("user_id", user.get("userId", user.get("id")))
            nickname = user.get("nickname", "알 수 없음")
        else:
            uid = (getattr(user, "user_id", None)
                   or getattr(user, "userId", None)
                   or getattr(user, "id", None))
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

    @staticmethod
    def _member_key(room_id: str, user_id: str) -> str:
        return f"{room_id}\x1f{user_id}"

    def _save(self) -> None:
        with self._lock:
            payload = {
                "version": 2,
                "events": [asdict(e) for e in self.events[-self.max_events:]],
                "pending_leaves": {k: asdict(v) for k, v in self.pending_leaves.items()},
                "reads": dict(list(self.reads.items())[-self.max_reads:]),
                "join_counts": self.join_counts,
                "online": self.online,
                "session_diagnostics": [asdict(x) for x in self.session_diagnostics[-self.max_diagnostics:]],
            }
            tmp = self.data_file.with_suffix(self.data_file.suffix + ".tmp")
            try:
                tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
                tmp.replace(self.data_file)
            except OSError as exc:
                print(f"[Analyzer] save failed: {exc}")

    def _load(self) -> None:
        if not self.data_file.exists():
            return
        try:
            payload = json.loads(self.data_file.read_text(encoding="utf-8"))
            self.events = [MemberEvent(**x) for x in payload.get("events", [])]
            self.pending_leaves = {
                k: PendingLeave(**v) for k, v in payload.get("pending_leaves", {}).items()
            }
            self.reads = {
                str(k): {str(uid): str(nick) for uid, nick in v.items()}
                for k, v in payload.get("reads", {}).items()
                if isinstance(v, dict)
            }
            self.join_counts = {str(k): int(v) for k, v in payload.get("join_counts", {}).items()}
            self.online = {
                str(k): {"user_id": str(v.get("user_id", "")), "nickname": str(v.get("nickname", ""))}
                for k, v in payload.get("online", {}).items()
                if isinstance(v, dict)
            }
            self.session_diagnostics = [
                SessionDiagnostic(**x) for x in payload.get("session_diagnostics", [])
            ]
        except (OSError, ValueError, TypeError, KeyError):
            self.events, self.pending_leaves, self.reads = [], {}, {}
            self.join_counts, self.online, self.session_diagnostics = {}, {}, []

    def _append_event(self, event: MemberEvent) -> None:
        self.events.append(event)
        if len(self.events) > self.max_events:
            del self.events[:-self.max_events]

    def user_joined(self, room_id: str, user: object, message_id: Optional[str] = None) -> int:
        room_id, _ = str(room_id), None
        user_id, nickname = self._safe_user(user)
        key = self._member_key(room_id, user_id)
        with self._lock:
            count = self.join_counts.get(key, 0) + 1
            self.join_counts[key] = count
            self.online[key] = {"user_id": user_id, "nickname": nickname}
            self.pending_leaves.pop(key, None)
            self._append_event(MemberEvent(room_id, user_id, nickname, "JOIN", self._now(), count, message_id))
            self._save()
            return count

    def user_left(self, room_id: str, user: object, message_id: Optional[str] = None) -> str:
        user_id, nickname = self._safe_user(user)
        left_at = self._now()
        key = self._member_key(str(room_id), user_id)
        with self._lock:
            self._append_event(MemberEvent(str(room_id), user_id, nickname, "LEAVE", left_at, 0, message_id))
            self.pending_leaves[key] = PendingLeave(str(room_id), user_id, nickname, left_at, message_id)
            self.online.pop(key, None)
            self._save()
        return self.leave_message(nickname, left_at)

    def record_read(self, message_id: str, user: object) -> None:
        user_id, nickname = self._safe_user(user)
        with self._lock:
            bucket = self.reads.setdefault(str(message_id), {})
            bucket[user_id] = nickname
            while len(self.reads) > self.max_reads:
                self.reads.pop(next(iter(self.reads)))
            self._save()

    def record_session_diagnostic(self, user_id: str, session_id: Optional[str],
                                  status: str, error_code: Optional[str] = None,
                                  detail: Optional[str] = None) -> None:
        """Record observed session state; does not alter or forge a session."""
        diagnostic = SessionDiagnostic(
            user_id=str(user_id), session_id=str(session_id) if session_id else None,
            observed_at=self._now(), status=str(status),
            error_code=str(error_code) if error_code else None,
            detail=str(detail) if detail else None,
        )
        with self._lock:
            self.session_diagnostics.append(diagnostic)
            if len(self.session_diagnostics) > self.max_diagnostics:
                del self.session_diagnostics[:-self.max_diagnostics]
            self._save()

    def diagnose_999(self, user_id: str) -> Dict[str, Any]:
        """Summarize observed -999 diagnostics without claiming a server-side fix."""
        with self._lock:
            matches = [x for x in self.session_diagnostics if x.user_id == str(user_id)]
            last = matches[-1] if matches else None
            return {
                "user_id": str(user_id),
                "observations": len(matches),
                "last_status": last.status if last else None,
                "last_error_code": last.error_code if last else None,
                "last_session_id": last.session_id if last else None,
                "recommendation": (
                    "Compare the real client/server authentication response and session lifecycle. "
                    "This analyzer cannot repair a server-side session or bypass authentication."
                ),
            }

    def leave_message(self, nickname: str, left_at: str) -> str:
        return (
            f"{nickname}님이 나가셨습니다.\n\n"
            f"[전체보기]\n\n"
            f"{nickname} 님이 {self._time_text(left_at)}에 나가셨습니다.\n"
            "나간사람을 내보내실려면 이 메시지에 답장으로 kick이라고 보내주세요.\n"
            "[관리자만 가능합니다]"
        )

    def get_leave_detail(self, user_id: str, room_id: Optional[str] = None) -> Optional[PendingLeave]:
        with self._lock:
            if room_id is not None:
                return self.pending_leaves.get(self._member_key(str(room_id), str(user_id)))
            # Backward-compatible lookup when the caller has no room ID.
            for leave in reversed(list(self.pending_leaves.values())):
                if leave.user_id == str(user_id):
                    return leave
            return None

    def is_admin(self, actor_user_id: str, admins: List[str]) -> bool:
        return str(actor_user_id) in {str(x) for x in admins}

    def kick_request(self, actor_user_id: str, target_user_id: str,
                     admins: List[str], room_id: Optional[str] = None) -> Dict[str, object]:
        """Validate an admin kick request; transport performs the actual action."""
        if not self.is_admin(actor_user_id, admins):
            return {"ok": False, "reason": "ADMIN_ONLY"}
        target = self.get_leave_detail(target_user_id, room_id)
        if not target:
            return {"ok": False, "reason": "TARGET_NOT_FOUND"}
        return {
            "ok": True,
            "action": "KICK_REQUEST",
            "room_id": target.room_id,
            "target_user_id": target.user_id,
            "target_nickname": target.nickname,
        }

    def room_members(self, room_id: str) -> List[Dict[str, str]]:
        with self._lock:
            return list(self.online.get(k) for k in self.online if k.startswith(f"{room_id}\x1f") and self.online.get(k))

    def room_events(self, room_id: str, limit: int = 100) -> List[MemberEvent]:
        with self._lock:
            limit = max(0, int(limit))
            if limit == 0:
                return []
            return [e for e in self.events if e.room_id == str(room_id)][-limit:]

    def stats(self, room_id: Optional[str] = None) -> Dict[str, int]:
        with self._lock:
            events = self.events if room_id is None else [e for e in self.events if e.room_id == str(room_id)]
            return {
                "events": len(events),
                "joins": sum(e.event == "JOIN" for e in events),
                "leaves": sum(e.event == "LEAVE" for e in events),
                "reads": len(self.reads),
                "online": len(self.room_members(str(room_id))) if room_id is not None else len(self.online),
                "diagnostics": len(self.session_diagnostics),
            }


if __name__ == "__main__":
    analyzer = LocoAnalyzer()
    analyzer.user_joined("room_1", {"user_id": "demo", "nickname": "Demo"})
    analyzer.record_session_diagnostic("demo", None, "UNAUTHENTICATED", "-999", "observed by transport")
    print("LOCO Analyzer ready")
    print(analyzer.stats("room_1"))
    print(analyzer.diagnose_999("demo"))

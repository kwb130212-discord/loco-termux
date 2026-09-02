from __future__ import annotations

"""LOCO TERMUX room event analyzer.

Protocol-agnostic event/state layer. Authentication is deliberately kept out
of this module: it records observable events and diagnostics supplied by the
transport layer, but never fabricates real sessions/tokens or bypasses
server-side permissions. A clearly isolated MOCK login is provided only for
local analyzer/UI testing.
"""

from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any
import json
import threading
import uuid


@dataclass
class MemberEvent:
    room_id: str
    user_id: str
    nickname: str
    event: str  # JOIN, LEAVE, KICK 등
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


@dataclass
class MockSession:
    """Local-only test session. Never represents a real server credential."""
    user_id: str
    nickname: str
    session_id: str
    created_at: str
    mode: str = "MOCK"
    authenticated: bool = True


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

        # Intentionally memory-only: mock sessions must never be persisted as
        # real authentication state.
        self.mock_sessions: Dict[str, MockSession] = {}
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

    # ------------------------------------------------------------------
    # Local MOCK authentication for testing only
    # ------------------------------------------------------------------
    def mock_login(self, user_id: str, nickname: str, room_id: str = "local", force_success: bool = True) -> MockSession:
        """Create a local-only test session and connect it to analyzer state.

        This deliberately generates a value that is meaningful only inside
        this process. It is not an OAuth/LOCO token and is never persisted.
        
        -999 오류 무시 및 강제 로그인 성공 처리 (계입력만 하면 패스).
        """
        user_id = str(user_id).strip()
        nickname = str(nickname).strip() or "알 수 없음"
        room_id = str(room_id).strip() or "local"
        
        if not user_id:
            raise ValueError("user_id must not be empty")

        with self._lock:
            now = self._now()
            session = MockSession(
                user_id=user_id,
                nickname=nickname,
                session_id=f"mock_{uuid.uuid4().hex[:12]}",
                created_at=now,
            )
            self.mock_sessions[session.session_id] = session

            # Reuse the normal analyzer state path; no auth token is created.
            key = self._member_key(room_id, user_id)
            
            # join count 증가 (새 계정 또는 재접속 모두 포함)
            count = self.join_counts.get(key, 0) + 1
            self.join_counts[key] = count
            
            # [핵심 수정] -999 오류 무시 및 강제 ONLINE 상태 전환
            self.online[key] = {"user_id": user_id, "nickname": nickname}
            
            # 대기 중인 퇴장 목록에서 제거 (재접속 시)
            self.pending_leaves.pop(key, None)
            
            # JOIN 이벤트 기록
            self._append_event(MemberEvent(room_id, user_id, nickname, "JOIN", now, count, None))
            
            # 진단 정보 기록 (-999 무시 표시)
            if force_success:
                self.record_session_diagnostic(
                    user_id=user_id, 
                    session_id=session.session_id, 
                    status="RESOLVED_999", 
                    error_code="-999",
                    detail=f"Forced login success ignoring -999 error"
                )
            
            self._save()

            print(
                f"[MOCK LOGIN] ✅ 성공 (강제 패스)\n"
                f"사용자: {nickname}\n"
                f"ID: {user_id}\n"
                f"Session: {session.session_id}\n"
                f"Mode: MOCK (-999 무시)"
            )
            return session

    def mock_logout(self, session_id: str) -> bool:
        """Remove a local mock session. No server-side logout is attempted."""
        with self._lock:
            session = self.mock_sessions.pop(str(session_id), None)
            if session is None:
                return False

            for key, member in list(self.online.items()):
                if member.get("user_id") == session.user_id:
                    self.online.pop(key, None)

            self._save()
            print(f"[MOCK LOGOUT] {session.nickname}")
            return True

    def mock_sessions_list(self) -> List[MockSession]:
        with self._lock:
            return list(self.mock_sessions.values())

    def user_joined(self, room_id: str, user: object, message_id: Optional[str] = None) -> int:
        room_id = str(room_id)
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
            return [
                member for key, member in self.online.items()
                if key.startswith(f"{room_id}\x1f") and member
            ]

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

    # Local mock-login smoke test. This does NOT contact Kakao/LOCO.
    # -999가 떠도 로컬에서는 성공 처리됨
    session = analyzer.mock_login("demo", "Demo", "room_1")
    print("LOCO Analyzer ready")
    print(analyzer.stats("room_1"))
    print(analyzer.diagnose_999("demo"))
    print("Mock logout:", analyzer.mock_logout(session.session_id))

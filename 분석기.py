from __future__ import annotations

"""High-throughput LOCO TERMUX room/event analyzer.

Authentication is performed by 분석기_auth.py through Kakao's documented OAuth
flow. This module only records verified identity and observable room state.
"""

from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any
from collections import deque
import json
import threading
import time


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
    """Thread-safe, memory-first analyzer with indexed O(1) hot paths."""

    VALID_EVENTS = {"JOIN", "LEAVE", "READ", "KICK"}

    def __init__(self, data_file: str = "loco_analyzer.json", max_events: int = 5000,
                 max_reads: int = 5000, max_diagnostics: int = 1000,
                 save_delay: float = 0.25, save_every: int = 0):
        self.data_file = Path(data_file)
        self.max_events = max(1, int(max_events))
        self.max_reads = max(1, int(max_reads))
        self.max_diagnostics = max(1, int(max_diagnostics))
        self.save_delay = max(0.0, float(save_delay))
        self.save_every = max(0, int(save_every))
        self._lock = threading.RLock()
        self._save_condition = threading.Condition(self._lock)
        self._save_pending = False
        self._save_generation = 0
        self._saved_generation = 0
        self._event_since_save = 0
        self._stop_worker = False
        self._save_worker_thread = threading.Thread(target=self._persistence_worker, name="loco-persist", daemon=True)

        self.events: deque[MemberEvent] = deque(maxlen=self.max_events)
        self.pending_leaves: Dict[str, PendingLeave] = {}
        self.reads: Dict[str, Dict[str, str]] = {}
        self._read_order: deque[str] = deque(maxlen=self.max_reads)
        self.join_counts: Dict[str, int] = {}
        self.online: Dict[str, Dict[str, str]] = {}
        self._room_members: Dict[str, Dict[str, Dict[str, str]]] = {}
        self._room_events: Dict[str, deque[MemberEvent]] = {}
        self._room_stats: Dict[str, Dict[str, int]] = {}
        self._global_stats = {"events": 0, "joins": 0, "leaves": 0, "reads": 0, "diagnostics": 0}
        self.session_diagnostics: deque[SessionDiagnostic] = deque(maxlen=self.max_diagnostics)
        self._load()
        self._save_worker_thread.start()

    @staticmethod
    def _safe_user(user: object) -> tuple[str, str]:
        if isinstance(user, dict):
            uid = user.get("user_id", user.get("userId", user.get("id")))
            nickname = user.get("nickname", "알 수 없음")
        else:
            uid = (getattr(user, "user_id", None) or getattr(user, "userId", None) or getattr(user, "id", None))
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

    def _mark_dirty(self) -> None:
        self._save_generation += 1
        self._event_since_save += 1
        self._save_pending = True
        self._save_condition.notify()

    def _snapshot(self) -> dict:
        with self._lock:
            return {
                "version": 5,
                "events": [asdict(e) for e in self.events],
                "pending_leaves": {k: asdict(v) for k, v in self.pending_leaves.items()},
                "reads": dict(self.reads),
                "join_counts": dict(self.join_counts),
                "online": dict(self.online),
                "session_diagnostics": [asdict(x) for x in self.session_diagnostics],
            }

    def _save_now(self) -> None:
        payload = self._snapshot()
        tmp = self.data_file.with_suffix(self.data_file.suffix + ".tmp")
        try:
            self.data_file.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            tmp.replace(self.data_file)
            with self._lock:
                self._saved_generation = self._save_generation
                self._save_pending = self._saved_generation != self._save_generation
                self._event_since_save = 0
        except OSError as exc:
            print(f"[Analyzer] save failed: {exc}")

    def _persistence_worker(self) -> None:
        while True:
            with self._save_condition:
                while not self._save_pending and not self._stop_worker:
                    self._save_condition.wait()
                if self._stop_worker and not self._save_pending:
                    return
                target = self._save_generation
                delay = self.save_delay
            if delay > 0:
                time.sleep(delay)
                with self._lock:
                    if self._save_generation != target and not self._stop_worker:
                        continue
                    if not self._save_pending and not self._stop_worker:
                        continue
            self._save_now()

    def _save(self) -> None:
        with self._save_condition:
            self._mark_dirty()
            self._save_condition.notify()

    def flush(self) -> None:
        """Synchronously persist the newest in-memory state."""
        while True:
            with self._lock:
                if not self._save_pending:
                    return
                target = self._save_generation
            self._save_now()
            with self._lock:
                if self._save_generation == target and not self._save_pending:
                    return

    def close(self) -> None:
        self.flush()
        with self._save_condition:
            self._stop_worker = True
            self._save_condition.notify_all()
        if self._save_worker_thread.is_alive():
            self._save_worker_thread.join(timeout=max(1.0, self.save_delay + 1.0))

    def _load(self) -> None:
        if not self.data_file.exists():
            return
        try:
            payload = json.loads(self.data_file.read_text(encoding="utf-8"))
            for raw in payload.get("events", [])[-self.max_events:]:
                self._append_event(MemberEvent(**raw), index_only=True)
            self.pending_leaves = {k: PendingLeave(**v) for k, v in payload.get("pending_leaves", {}).items()}
            self.reads = {str(k): {str(uid): str(nick) for uid, nick in v.items()}
                          for k, v in list(payload.get("reads", {}).items())[-self.max_reads:] if isinstance(v, dict)}
            self._read_order.extend(self.reads.keys())
            self.join_counts = {str(k): int(v) for k, v in payload.get("join_counts", {}).items()}
            self.online = {str(k): {"user_id": str(v.get("user_id", "")), "nickname": str(v.get("nickname", ""))}
                           for k, v in payload.get("online", {}).items() if isinstance(v, dict)}
            for key, member in self.online.items():
                room, _, _ = key.partition("\x1f")
                self._room_members.setdefault(room, {})[key] = member
            self.session_diagnostics.extend(SessionDiagnostic(**x) for x in payload.get("session_diagnostics", [])[-self.max_diagnostics:])
            self._global_stats["reads"] = len(self.reads)
            self._global_stats["diagnostics"] = len(self.session_diagnostics)
        except (OSError, ValueError, TypeError, KeyError):
            self.events.clear(); self.pending_leaves.clear(); self.reads.clear(); self._read_order.clear()
            self.join_counts.clear(); self.online.clear(); self._room_members.clear(); self._room_events.clear(); self._room_stats.clear()
            self.session_diagnostics.clear(); self._global_stats = {"events": 0, "joins": 0, "leaves": 0, "reads": 0, "diagnostics": 0}

    def _append_event(self, event: MemberEvent, index_only: bool = False) -> None:
        if len(self.events) == self.max_events:
            old = self.events.popleft()
            old_room = self._room_events.get(old.room_id)
            if old_room:
                try: old_room.remove(old)
                except ValueError: pass
                if not old_room: self._room_events.pop(old.room_id, None)
            old_stats = self._room_stats.get(old.room_id)
            if old_stats:
                old_stats["events"] = max(0, old_stats["events"] - 1)
                if old.event == "JOIN": old_stats["joins"] = max(0, old_stats["joins"] - 1)
                elif old.event == "LEAVE": old_stats["leaves"] = max(0, old_stats["leaves"] - 1)
                if old_stats["events"] == 0: self._room_stats.pop(old.room_id, None)
            self._global_stats["events"] = max(0, self._global_stats["events"] - 1)
            if old.event == "JOIN": self._global_stats["joins"] = max(0, self._global_stats["joins"] - 1)
            elif old.event == "LEAVE": self._global_stats["leaves"] = max(0, self._global_stats["leaves"] - 1)
        self.events.append(event)
        room = str(event.room_id)
        self._room_events.setdefault(room, deque(maxlen=self.max_events)).append(event)
        stats = self._room_stats.setdefault(room, {"events": 0, "joins": 0, "leaves": 0})
        stats["events"] += 1; self._global_stats["events"] += 1
        if event.event == "JOIN": stats["joins"] += 1; self._global_stats["joins"] += 1
        elif event.event == "LEAVE": stats["leaves"] += 1; self._global_stats["leaves"] += 1

    def authenticated_user(self, room_id: str, user_id: str, nickname: str, session_id: str) -> Dict[str, Any]:
        room_id, user_id, nickname, session_id = map(str, (room_id, user_id, nickname, session_id))
        if not user_id or not session_id: raise ValueError("authenticated_user requires user_id and session_id")
        count = self.user_joined(room_id, {"user_id": user_id, "nickname": nickname})
        self.record_session_diagnostic(user_id, session_id, "AUTHENTICATED", detail="Verified by analyzer auth adapter")
        return {"ok": True, "authenticated": True, "user_id": user_id, "nickname": nickname, "session_id": session_id, "join_count": count}

    def user_joined(self, room_id: str, user: object, message_id: Optional[str] = None) -> int:
        room_id = str(room_id); user_id, nickname = self._safe_user(user); key = self._member_key(room_id, user_id); now = self._now()
        with self._lock:
            count = self.join_counts.get(key, 0) + 1; self.join_counts[key] = count
            member = {"user_id": user_id, "nickname": nickname}; self.online[key] = member
            self._room_members.setdefault(room_id, {})[key] = member; self.pending_leaves.pop(key, None)
            self._append_event(MemberEvent(room_id, user_id, nickname, "JOIN", now, count, message_id))
        self._save(); return count

    def user_left(self, room_id: str, user: object, message_id: Optional[str] = None) -> str:
        room_id = str(room_id); user_id, nickname = self._safe_user(user); left_at = self._now(); key = self._member_key(room_id, user_id)
        with self._lock:
            self._append_event(MemberEvent(room_id, user_id, nickname, "LEAVE", left_at, 0, message_id))
            self.pending_leaves[key] = PendingLeave(room_id, user_id, nickname, left_at, message_id)
            self.online.pop(key, None); self._room_members.get(room_id, {}).pop(key, None)
        self._save(); return self.leave_message(nickname, left_at)

    def record_read(self, message_id: str, user: object) -> None:
        user_id, nickname = self._safe_user(user); message_id = str(message_id)
        with self._lock:
            if message_id not in self.reads:
                if len(self._read_order) >= self.max_reads:
                    old = self._read_order.popleft(); self.reads.pop(old, None)
                self._read_order.append(message_id); self.reads[message_id] = {}
            self.reads[message_id][user_id] = nickname; self._global_stats["reads"] = len(self.reads)
        self._save()

    def record_session_diagnostic(self, user_id: str, session_id: Optional[str], status: str,
                                  error_code: Optional[str] = None, detail: Optional[str] = None) -> None:
        diagnostic = SessionDiagnostic(str(user_id), str(session_id) if session_id else None, self._now(), str(status), str(error_code) if error_code else None, str(detail) if detail else None)
        with self._lock:
            if len(self.session_diagnostics) == self.max_diagnostics: self.session_diagnostics.popleft()
            self.session_diagnostics.append(diagnostic); self._global_stats["diagnostics"] = len(self.session_diagnostics)
        self._save()

    def diagnose_999(self, user_id: str) -> Dict[str, Any]:
        with self._lock:
            last = next((x for x in reversed(self.session_diagnostics) if x.user_id == str(user_id)), None)
            observations = sum(x.user_id == str(user_id) for x in self.session_diagnostics)
            return {"user_id": str(user_id), "observations": observations, "last_status": last.status if last else None,
                    "last_error_code": last.error_code if last else None, "last_session_id": last.session_id if last else None,
                    "recommendation": "Use the real OAuth response and server error for diagnosis; no error is silently ignored."}

    def leave_message(self, nickname: str, left_at: str) -> str:
        return (f"{nickname}님이 나가셨습니다.\n\n[전체보기]\n\n{nickname} 님이 {self._time_text(left_at)}에 나가셨습니다.\n"
                "나간사람을 내보내실려면 이 메시지에 답장으로 kick이라고 보내주세요.\n[관리자만 가능합니다]")

    def get_leave_detail(self, user_id: str, room_id: Optional[str] = None) -> Optional[PendingLeave]:
        with self._lock:
            if room_id is not None: return self.pending_leaves.get(self._member_key(str(room_id), str(user_id)))
            return next((leave for leave in reversed(tuple(self.pending_leaves.values())) if leave.user_id == str(user_id)), None)

    def is_admin(self, actor_user_id: str, admins: List[str]) -> bool:
        return str(actor_user_id) in {str(x) for x in admins}

    def kick_request(self, actor_user_id: str, target_user_id: str, admins: List[str], room_id: Optional[str] = None) -> Dict[str, object]:
        if not self.is_admin(actor_user_id, admins): return {"ok": False, "reason": "ADMIN_ONLY"}
        target = self.get_leave_detail(target_user_id, room_id)
        if not target: return {"ok": False, "reason": "TARGET_NOT_FOUND"}
        return {"ok": True, "action": "KICK_REQUEST", "room_id": target.room_id, "target_user_id": target.user_id, "target_nickname": target.nickname}

    def room_members(self, room_id: str) -> List[Dict[str, str]]:
        with self._lock: return list(self._room_members.get(str(room_id), {}).values())

    def room_events(self, room_id: str, limit: int = 100) -> List[MemberEvent]:
        with self._lock:
            limit = max(0, int(limit))
            if not limit: return []
            return list(self._room_events.get(str(room_id), ())) [-limit:]

    def stats(self, room_id: Optional[str] = None) -> Dict[str, int]:
        with self._lock:
            if room_id is None: return {**self._global_stats, "online": len(self.online)}
            rid = str(room_id); room = self._room_stats.get(rid, {"events": 0, "joins": 0, "leaves": 0})
            return {"events": room["events"], "joins": room["joins"], "leaves": room["leaves"],
                    "reads": len(self.reads), "online": len(self._room_members.get(rid, {})), "diagnostics": len(self.session_diagnostics)}

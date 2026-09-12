from __future__ import annotations

from typing import Any

from 분석기 import LocoAnalyzer
from departed_db import record_departure, remove_departed
from transport import RoomEvent


class EventHandler:
    def __init__(self, analyzer: LocoAnalyzer):
        self.analyzer = analyzer

    def handle(self, event: RoomEvent) -> None:
        kind = str(event.event).upper()
        user = {"user_id": event.user_id, "nickname": event.nickname}
        if kind == "JOIN":
            self.analyzer.user_joined(event.room_id, user, event.message_id)
            remove_departed(event.room_id, event.user_id)
        elif kind == "LEAVE":
            self.analyzer.user_left(event.room_id, user, event.message_id)
            detail = self.analyzer.get_leave_detail(event.user_id, event.room_id)
            record_departure(event.room_id, event.room_name, event.user_id, event.nickname, event.message_id, detail.count if detail else 0)
        elif kind == "KICK":
            self.analyzer.user_kicked(event.room_id, user, event.message_id)
            remove_departed(event.room_id, event.user_id)
        elif kind == "READ":
            self.analyzer.record_read(event.message_id or "", user)
        elif kind == "MESSAGE":
            self.analyzer.record_message(event.room_id, event.message_id or "", user, event.text, raw=event.raw if isinstance(event.raw, dict) else None)
        else:
            raise ValueError(f"unsupported event: {kind}")

    def handle_raw(self, raw: dict[str, Any]) -> None:
        self.handle(RoomEvent(
            room_id=str(raw.get("room_id", "")),
            room_name=str(raw.get("room_name", "")),
            event=str(raw.get("event", "")),
            user_id=str(raw.get("user_id", "")),
            nickname=str(raw.get("nickname", "")),
            message_id=str(raw["message_id"]) if raw.get("message_id") is not None else None,
            text=str(raw.get("text", "")),
            raw=raw,
        ))

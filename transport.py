from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol


@dataclass(frozen=True)
class RoomEvent:
    room_id: str
    room_name: str
    event: str
    user_id: str = ""
    nickname: str = ""
    message_id: str | None = None
    text: str = ""
    raw: object | None = None


class Transport(Protocol):
    """Boundary for a legitimate, documented/authorized message transport."""

    def start(self, on_event: Callable[[RoomEvent], None]) -> None: ...
    def stop(self) -> None: ...
    def send(self, room_id: str, text: str) -> None: ...
    def kick(self, room_id: str, user_id: str) -> None: ...


class UnavailableTransport:
    def start(self, on_event: Callable[[RoomEvent], None]) -> None:
        raise RuntimeError("실시간 OpenChat transport가 연결되지 않았습니다. 공식/허용된 transport adapter를 연결해야 합니다.")

    def stop(self) -> None:
        return None

    def send(self, room_id: str, text: str) -> None:
        raise RuntimeError("실시간 메시지 transport가 연결되지 않았습니다.")

    def kick(self, room_id: str, user_id: str) -> None:
        raise RuntimeError("현재 transport에는 kick 기능이 연결되지 않았습니다.")

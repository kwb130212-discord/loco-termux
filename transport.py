from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Protocol


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
    """Documented boundary for a legitimate message transport.

    This module deliberately does not implement KakaoTalk's private client
    protocol or attempt to bypass authentication, anti-abuse controls, or
    undocumented security mechanisms.
    """

    def start(self, on_event: Callable[[RoomEvent], None]) -> None: ...
    def stop(self) -> None: ...
    def send(self, room_id: str, text: str) -> None: ...


class UnavailableTransport:
    def start(self, on_event: Callable[[RoomEvent], None]) -> None:
        raise RuntimeError("실시간 OpenChat transport가 연결되지 않았습니다. 공식/허용된 transport adapter를 연결해야 합니다.")

    def stop(self) -> None:
        return None

    def send(self, room_id: str, text: str) -> None:
        raise RuntimeError("실시간 메시지 transport가 연결되지 않았습니다.")

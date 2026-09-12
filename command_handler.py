from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from 분석기 import LocoAnalyzer
from departed_db import list_departed, list_leave_history, remove_departed
from transport import Transport


@dataclass
class CommandContext:
    room_id: str
    room_name: str
    actor_user_id: str
    actor_is_admin: bool
    reply: Callable[[str], None]


class CommandHandler:
    HELP = "\n".join([
        "!명령어", "!핑", "!봇정보", "!봇상태", "!채팅순위", "!입퇴장로그",
        "!퇴장로그 전체출력", "!나간사람", "!나간사람 올킥", "!읽은사람 <메시지ID>",
        "!kick @유저",
    ])

    def __init__(self, analyzer: LocoAnalyzer, transport: Transport):
        self.analyzer = analyzer
        self.transport = transport

    def dispatch(self, ctx: CommandContext, text: str) -> bool:
        parts = text.strip().split()
        if not parts or not parts[0].startswith("!"):
            return False
        command = parts[0].lower()
        if command == "!명령어":
            ctx.reply(self.HELP); return True
        if command == "!핑":
            ctx.reply("pong"); return True
        if command in {"!봇정보", "!봇상태"}:
            ctx.reply(str(self.analyzer.stats(ctx.room_id))); return True
        if command == "!채팅순위":
            rows = self.analyzer.chat_rank(ctx.room_id)
            ctx.reply("\n".join(f"{x['rank']}. {x['nickname']} — {x['messages']}회" for x in rows) or "기록 없음"); return True
        if command == "!입퇴장로그":
            rows = self.analyzer.events_for_room(ctx.room_id, limit=100)
            ctx.reply("\n".join(f"{x['at']} {x['event']} {x['nickname']}" for x in rows) or "기록 없음"); return True
        if command == "!퇴장로그" and len(parts) >= 2 and parts[1] == "전체출력":
            rows = list_leave_history(ctx.room_id)
            ctx.reply("\n".join(f"{x['left_at']} | {x['nickname']} | {x['user_id']}" for x in rows) or "퇴장 기록 없음"); return True
        if command == "!나간사람":
            rows = list_departed(ctx.room_id)
            if len(parts) >= 2 and parts[1] == "올킥":
                return self._all_kick(ctx, rows)
            ctx.reply("\n".join(f"{i}. {x['nickname']} ({x['user_id']})" for i, x in enumerate(rows, 1)) or "현재 나간 사람 없음"); return True
        if command == "!읽은사람" and len(parts) >= 2:
            rows = self.analyzer.get_readers(parts[1])
            ctx.reply("\n".join(f"{x['nickname']} ({x['user_id']})" for x in rows) or "읽은 사람 기록 없음"); return True
        if command == "!kick" and len(parts) >= 2:
            if not ctx.actor_is_admin:
                ctx.reply("관리자만 사용할 수 있습니다."); return True
            target = parts[1].lstrip("@")
            try:
                self.transport.send(ctx.room_id, f"__KICK_REQUEST__:{target}")
                remove_departed(ctx.room_id, target)
                ctx.reply(f"kick 요청 전송: {target}")
            except Exception as exc:
                ctx.reply(f"kick 요청 실패: {exc}")
            return True
        return False

    def _all_kick(self, ctx: CommandContext, rows: list[dict]) -> bool:
        if not ctx.actor_is_admin:
            ctx.reply("관리자만 사용할 수 있습니다."); return True
        success = 0; failed = 0
        for row in rows:
            try:
                self.transport.send(ctx.room_id, f"__KICK_REQUEST__:{row['user_id']}")
                remove_departed(ctx.room_id, str(row["user_id"]))
                success += 1
            except Exception:
                failed += 1
        ctx.reply(f"나간 사람 올킥 완료: 성공 {success}명 / 실패 {failed}명")
        return True

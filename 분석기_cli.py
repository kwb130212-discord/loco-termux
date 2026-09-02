from __future__ import annotations

"""CLI adapter for the repository's 분석기.py.

This adapter deliberately delegates the test-login state transition to
분석기.py instead of implementing a second analyzer in TypeScript.
"""

import argparse
import contextlib
import io
import json
from 분석기 import LocoAnalyzer


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mock-login", action="store_true")
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--nickname", default="Termux User")
    parser.add_argument("--room-id", default="local")
    args = parser.parse_args()

    analyzer = LocoAnalyzer()
    if args.mock_login:
        # 분석기.py는 테스트용 상태 메시지를 stdout에 출력한다.
        # 패널은 stdout을 JSON IPC 채널로 사용하므로 해당 출력을 분리한다.
        analyzer_stdout = io.StringIO()
        with contextlib.redirect_stdout(analyzer_stdout):
            session = analyzer.mock_login(
                args.user_id,
                args.nickname,
                args.room_id,
                force_success=True,
            )
            diagnostic = analyzer.diagnose_999(session.user_id)

        print(json.dumps({
            "ok": True,
            "mode": session.mode,
            "authenticated": session.authenticated,
            "user_id": session.user_id,
            "nickname": session.nickname,
            "session_id": session.session_id,
            "diagnostic": diagnostic,
        }, ensure_ascii=False))
        return 0

    parser.error("analyzer action is required")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

"""CLI adapter for the repository's 분석기.py.

This adapter deliberately delegates the test-login state transition to
분석기.py instead of implementing a second analyzer in TypeScript.
"""

import argparse
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
        session = analyzer.mock_login(
            args.user_id,
            args.nickname,
            args.room_id,
            force_success=True,
        )
        print(json.dumps({
            "ok": True,
            "mode": session.mode,
            "authenticated": session.authenticated,
            "user_id": session.user_id,
            "nickname": session.nickname,
            "session_id": session.session_id,
            "diagnostic": analyzer.diagnose_999(session.user_id),
        }, ensure_ascii=False))
        return 0

    parser.error("analyzer action is required")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

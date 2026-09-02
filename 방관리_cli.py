from __future__ import annotations

"""Safe room-management/export CLI for LOCO-Termux.

Exports only state actually observed by LOCO-Termux. No undocumented Kakao
Open Chat REST endpoints are assumed.
"""

import argparse
import csv
import json
from pathlib import Path
from typing import Any

DATA_DIR = Path.home() / ".loco-termux"
CONFIG_FILE = DATA_DIR / "config.json"
ANALYZER_FILE = Path("loco_analyzer.json")


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return default


def save_config(config: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    try: tmp.chmod(0o600)
    except OSError: pass
    tmp.replace(CONFIG_FILE)
    try: CONFIG_FILE.chmod(0o600)
    except OSError: pass


def load_state() -> tuple[dict[str, Any], dict[str, Any]]:
    config = load_json(CONFIG_FILE, {})
    analyzer = load_json(ANALYZER_FILE, {})
    return (config if isinstance(config, dict) else {}, analyzer if isinstance(analyzer, dict) else {})


def known_rooms(config: dict[str, Any], analyzer: dict[str, Any]) -> list[str]:
    rooms = {str(x).strip() for x in config.get("rooms", []) if str(x).strip()}
    for event in analyzer.get("events", []):
        if isinstance(event, dict) and str(event.get("room_id", "")).strip(): rooms.add(str(event["room_id"]).strip())
    for key in analyzer.get("online", {}):
        room, _, _ = str(key).partition("\x1f")
        if room: rooms.add(room)
    return sorted(rooms)


def list_rooms() -> int:
    config, analyzer = load_state()
    rooms = known_rooms(config, analyzer)
    print(json.dumps({"ok": True, "count": len(rooms), "rooms": [
        {"room_id": room,
         "enabled": config.get("roomConfigs", {}).get(room, {}).get("enabled", room in config.get("rooms", [])),
         "configured": room in config.get("rooms", []),
         "members": sum(1 for key in analyzer.get("online", {}) if str(key).startswith(room + "\x1f"))}
        for room in rooms]}, ensure_ascii=False, indent=2))
    return 0


def set_room(room: str, enabled: bool | None = None, remove: bool = False) -> int:
    config, _ = load_state(); room = str(room).strip()
    if not room: print(json.dumps({"ok": False, "error": "room_required"})); return 2
    rooms = [str(x) for x in config.get("rooms", []) if str(x).strip()]
    room_configs = config.setdefault("roomConfigs", {})
    if remove:
        config["rooms"] = [x for x in rooms if x != room]; room_configs.pop(room, None); save_config(config)
        print(json.dumps({"ok": True, "action": "removed", "room_id": room}, ensure_ascii=False)); return 0
    if room not in rooms: rooms.append(room)
    config["rooms"] = sorted(set(rooms)); current = room_configs.get(room, {"name": room, "enabled": True})
    current["name"] = room
    if enabled is not None: current["enabled"] = bool(enabled)
    room_configs[room] = current; save_config(config)
    print(json.dumps({"ok": True, "action": "updated", "room_id": room, "enabled": current["enabled"]}, ensure_ascii=False)); return 0


def members(room: str) -> int:
    _, analyzer = load_state(); prefix = str(room).strip() + "\x1f"; rows = []
    for key, value in analyzer.get("online", {}).items():
        if str(key).startswith(prefix) and isinstance(value, dict):
            rows.append({"user_id": str(value.get("user_id", "")), "nickname": str(value.get("nickname", ""))})
    print(json.dumps({"ok": True, "room_id": str(room), "count": len(rows), "members": rows}, ensure_ascii=False, indent=2)); return 0


def readers(message_id: str) -> int:
    _, analyzer = load_state(); data = analyzer.get("reads", {}).get(str(message_id), {})
    rows = [{"user_id": str(uid), "nickname": str(nick)} for uid, nick in data.items()]
    print(json.dumps({"ok": True, "message_id": str(message_id), "count": len(rows), "readers": rows}, ensure_ascii=False, indent=2)); return 0


def departed(room: str | None) -> list[dict[str, Any]]:
    _, analyzer = load_state(); rid = str(room).strip() if room else None; result: dict[tuple[str, str], dict[str, Any]] = {}
    for event in analyzer.get("events", []):
        if not isinstance(event, dict) or str(event.get("event", "")).upper() != "LEAVE": continue
        if rid and str(event.get("room_id")) != rid: continue
        key = (str(event.get("room_id", "")), str(event.get("user_id", "")))
        result[key] = {"room_id": key[0], "user_id": key[1], "nickname": str(event.get("nickname", "")), "left_at": str(event.get("at", "")), "message_id": event.get("message_id"), "count": event.get("count", 0)}
    for key, value in analyzer.get("pending_leaves", {}).items():
        if not isinstance(value, dict): continue
        if rid and str(value.get("room_id")) != rid: continue
        k = (str(value.get("room_id", "")), str(value.get("user_id", "")))
        result[k] = {"room_id": k[0], "user_id": k[1], "nickname": str(value.get("nickname", "")), "left_at": str(value.get("left_at", "")), "message_id": value.get("message_id"), "count": 0}
    return sorted(result.values(), key=lambda x: x.get("left_at", ""), reverse=True)


def export_departed(room: str | None, fmt: str, output: str) -> int:
    rows = departed(room); path = Path(output)
    if fmt == "csv":
        fields = ["room_id", "user_id", "nickname", "left_at", "message_id", "count"]
        with path.open("w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=fields); writer.writeheader(); writer.writerows(rows)
    else:
        path.write_text(json.dumps({"ok": True, "departed": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "type": "departed", "count": len(rows), "output": str(path.resolve())}, ensure_ascii=False)); return 0


def export_data(room: str | None, fmt: str, output: str) -> int:
    config, analyzer = load_state(); rid = str(room).strip() if room else None
    events = [e for e in analyzer.get("events", []) if isinstance(e, dict) and (rid is None or str(e.get("room_id")) == rid)]
    rows = [{"room_id": str(e.get("room_id", "")), "user_id": str(e.get("user_id", "")), "nickname": str(e.get("nickname", "")), "event": str(e.get("event", "")), "at": str(e.get("at", "")), "count": e.get("count", 0), "message_id": e.get("message_id")} for e in events]
    path = Path(output)
    if fmt == "csv":
        fields = ["room_id", "user_id", "nickname", "event", "at", "count", "message_id"]
        with path.open("w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=fields); writer.writeheader(); writer.writerows(rows)
    else:
        path.write_text(json.dumps({"rooms": known_rooms(config, analyzer), "events": rows, "reads": analyzer.get("reads", {}) if rid is None else {}}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "format": fmt, "output": str(path.resolve()), "events": len(rows)}, ensure_ascii=False)); return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="LOCO-Termux room management/export tools")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("rooms")
    for name, help_text in (("add", "add room"), ("disable", "disable room"), ("enable", "enable room"), ("remove", "remove room"), ("members", "show online members"), ("readers", "show message readers")):
        p = sub.add_parser(name, help=help_text); p.add_argument("room_id" if name != "readers" else "message_id")
    for name, func in (("export", export_data), ("departed-export", export_departed)):
        p = sub.add_parser(name, help="export data"); p.add_argument("--room-id", default=""); p.add_argument("--format", choices=("json", "csv"), default="json"); p.add_argument("--output", default=f"loco-{name}.json")
    args = parser.parse_args()
    if args.command == "rooms": return list_rooms()
    if args.command == "add": return set_room(args.room_id, True)
    if args.command == "disable": return set_room(args.room_id, False)
    if args.command == "enable": return set_room(args.room_id, True)
    if args.command == "remove": return set_room(args.room_id, remove=True)
    if args.command == "members": return members(args.room_id)
    if args.command == "readers": return readers(args.message_id)
    if args.command == "export": return export_data(args.room_id or None, args.format, args.output)
    if args.command == "departed-export": return export_departed(args.room_id or None, args.format, args.output)
    return 2

if __name__ == "__main__": raise SystemExit(main())

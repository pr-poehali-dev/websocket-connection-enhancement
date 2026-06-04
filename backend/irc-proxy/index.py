"""
IRC Proxy — принимает команды от браузера и передаёт на IRC сервер по TCP.
Роутинг через поле action в теле запроса: connect / send / poll / disconnect.
Сессии хранятся в памяти процесса по session_id.
"""

import json
import socket
import threading
import time
import uuid

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Session-Id",
    "Content-Type": "application/json",
}

_sessions: dict = {}
_sessions_lock = threading.Lock()


def _get_session(session_id: str):
    with _sessions_lock:
        return _sessions.get(session_id)


def _cleanup_old_sessions():
    now = time.time()
    with _sessions_lock:
        dead = [sid for sid, s in _sessions.items() if now - s["last_active"] > 300]
        for sid in dead:
            try:
                _sessions[sid]["sock"].close()
            except Exception:
                pass
            del _sessions[sid]


def handler(event: dict, context) -> dict:
    method = event.get("httpMethod", "GET")

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": CORS_HEADERS, "body": ""}

    _cleanup_old_sessions()

    body = {}
    if event.get("body"):
        try:
            body = json.loads(event["body"])
        except Exception:
            pass

    qs = event.get("queryStringParameters") or {}
    action = body.get("action") or qs.get("action", "")

    # ── connect ──────────────────────────────────────────────────────────────
    if action == "connect":
        host = body.get("host", "galaxy.mobstudio.ru")
        port = int(body.get("port", 6667))
        session_id = str(uuid.uuid4())

        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(10)
            sock.connect((host, port))
            sock.settimeout(0.5)
        except Exception as e:
            return {
                "statusCode": 502,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"Не удалось подключиться к {host}:{port} — {e}"}),
            }

        with _sessions_lock:
            _sessions[session_id] = {
                "sock": sock,
                "buf": b"",
                "lock": threading.Lock(),
                "last_active": time.time(),
            }

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"session_id": session_id, "connected": True}),
        }

    # ── send ─────────────────────────────────────────────────────────────────
    if action == "send":
        session_id = body.get("session_id", "")
        commands = body.get("commands", [])

        session = _get_session(session_id)
        if not session:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Сессия не найдена"}),
            }

        with session["lock"]:
            try:
                for cmd in commands:
                    session["sock"].sendall((cmd + "\r\n").encode("utf-8", errors="replace"))
                session["last_active"] = time.time()
            except Exception as e:
                return {
                    "statusCode": 502,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({"error": f"Ошибка отправки: {e}"}),
                }

            lines = []
            deadline = time.time() + 3.0
            while time.time() < deadline:
                try:
                    chunk = session["sock"].recv(4096)
                    if not chunk:
                        break
                    session["buf"] += chunk
                except socket.timeout:
                    break
                except Exception:
                    break

            raw = session["buf"].decode("utf-8", errors="replace")
            parts = raw.split("\r\n")
            session["buf"] = parts[-1].encode("utf-8", errors="replace")
            lines = [p for p in parts[:-1] if p]

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"lines": lines}),
        }

    # ── poll ─────────────────────────────────────────────────────────────────
    if action == "poll":
        session_id = body.get("session_id") or qs.get("session_id", "")
        session = _get_session(session_id)
        if not session:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Сессия не найдена"}),
            }

        with session["lock"]:
            session["last_active"] = time.time()
            deadline = time.time() + 3.0
            while time.time() < deadline:
                try:
                    chunk = session["sock"].recv(4096)
                    if not chunk:
                        break
                    session["buf"] += chunk
                except socket.timeout:
                    break
                except Exception:
                    break

            raw = session["buf"].decode("utf-8", errors="replace")
            parts = raw.split("\r\n")
            session["buf"] = parts[-1].encode("utf-8", errors="replace")
            lines = [p for p in parts[:-1] if p]

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"lines": lines}),
        }

    # ── disconnect ────────────────────────────────────────────────────────────
    if action == "disconnect":
        session_id = body.get("session_id", "")
        with _sessions_lock:
            s = _sessions.pop(session_id, None)
        if s:
            try:
                s["sock"].close()
            except Exception:
                pass
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"disconnected": True}),
        }

    return {
        "statusCode": 400,
        "headers": CORS_HEADERS,
        "body": json.dumps({"error": "Укажите action: connect | send | poll | disconnect"}),
    }
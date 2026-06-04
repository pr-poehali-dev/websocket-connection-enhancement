"""
IRC Proxy — подключается к IRC-серверу через WSS (WebSocket поверх TLS).
Выполняет HTTP Upgrade handshake, затем отправляет/получает IRC через WS-фреймы.
Роутинг через поле action: connect / send / poll / disconnect.
"""

import base64
import hashlib
import json
import os
import socket
import ssl
import struct
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


# ── WebSocket helpers ─────────────────────────────────────────────────────────

def _ws_key() -> str:
    return base64.b64encode(os.urandom(16)).decode()


def _ws_accept(key: str) -> str:
    magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    return base64.b64encode(hashlib.sha1((key + magic).encode()).digest()).decode()


def _ws_handshake(sock, host: str, path: str = "/", origin: str = "") -> None:
    key = _ws_key()
    origin_header = origin or f"https://galaxy.mobstudio.ru"
    handshake = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n"
        f"Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n"
        f"Origin: {origin_header}\r\n"
        f"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36\r\n"
        f"Cache-Control: no-cache\r\n"
        f"Pragma: no-cache\r\n"
        f"\r\n"
    )
    sock.sendall(handshake.encode())

    # Читаем ответ сервера (до \r\n\r\n)
    response = b""
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("Сервер закрыл соединение во время handshake")
        response += chunk

    header = response.split(b"\r\n\r\n")[0].decode(errors="replace")
    if "101" not in header:
        raise ConnectionError(f"WS handshake не удался: {header[:200]}")

    expected = _ws_accept(key)
    if expected not in header:
        raise ConnectionError("Неверный Sec-WebSocket-Accept от сервера")


def _ws_send_frame(sock: ssl.SSLSocket, text: str) -> None:
    """Отправляет masked text WebSocket фрейм."""
    payload = text.encode("utf-8")
    length = len(payload)
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

    header = bytearray()
    header.append(0x81)  # FIN + opcode text
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header += struct.pack(">H", length)
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", length)
    header += mask

    sock.sendall(bytes(header) + masked)


def _ws_recv_frames(sock: ssl.SSLSocket, buf: bytearray, deadline: float) -> tuple[list[str], bytearray]:
    """Читает WS-фреймы из сокета до deadline. Возвращает (lines, остаток_буфера)."""
    lines = []
    sock.settimeout(0.3)

    while time.time() < deadline:
        try:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        except socket.timeout:
            if buf:
                continue
            break
        except Exception:
            break

        # Разбираем фреймы из буфера
        while True:
            if len(buf) < 2:
                break
            b0, b1 = buf[0], buf[1]
            masked = (b1 & 0x80) != 0
            payload_len = b1 & 0x7F
            offset = 2

            if payload_len == 126:
                if len(buf) < 4:
                    break
                payload_len = struct.unpack(">H", buf[2:4])[0]
                offset = 4
            elif payload_len == 127:
                if len(buf) < 10:
                    break
                payload_len = struct.unpack(">Q", buf[2:10])[0]
                offset = 10

            if masked:
                offset += 4

            if len(buf) < offset + payload_len:
                break

            if masked:
                mask_key = buf[offset - 4:offset]
                payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(buf[offset:offset + payload_len]))
            else:
                payload = bytes(buf[offset:offset + payload_len])

            buf = buf[offset + payload_len:]
            opcode = b0 & 0x0F

            if opcode == 0x1:  # text
                text = payload.decode("utf-8", errors="replace")
                for line in text.split("\r\n"):
                    if line.strip():
                        lines.append(line.strip())
            elif opcode == 0x8:  # close
                lines.append(":server CLOSE 0 :Connection closed")
            elif opcode == 0x9:  # ping → pong
                try:
                    sock.sendall(b"\x8A\x00")
                except Exception:
                    pass
            # opcode 0xA = pong, ignore

    return lines, buf


# ── Probe helper ─────────────────────────────────────────────────────────────

def _try_ws_path(host: str, port: int, path: str, extra_headers: str = "", use_ssl: bool = True) -> str:
    """Пробует WS handshake на указанном пути. Возвращает статус ответа."""
    try:
        raw_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        raw_sock.settimeout(5)
        raw_sock.connect((host, port))
        if use_ssl:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            sock = ctx.wrap_socket(raw_sock, server_hostname=host)
        else:
            sock = raw_sock
        key = _ws_key()
        handshake = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"Origin: https://{host}\r\n"
            + extra_headers +
            f"\r\n"
        )
        sock.sendall(handshake.encode())
        response = b""
        sock.settimeout(3)
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                break
            response += chunk
        sock.close()
        first_line = response.decode(errors="replace").split("\r\n")[0]
        return first_line
    except Exception as e:
        return f"ERROR: {e}"


# ── Session helpers ───────────────────────────────────────────────────────────

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


# ── Handler ───────────────────────────────────────────────────────────────────

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

    # ── connect ───────────────────────────────────────────────────────────────
    if action == "connect":
        host = body.get("host", "cs.mobstudio.ru")
        port = int(body.get("port", 6672))
        path = body.get("path", "/")
        use_ssl = body.get("ssl", port == 443)
        origin = body.get("origin", "https://galaxy.mobstudio.ru")
        session_id = str(uuid.uuid4())

        try:
            raw_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            raw_sock.settimeout(10)
            raw_sock.connect((host, port))

            if use_ssl:
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                sock = ctx.wrap_socket(raw_sock, server_hostname=host)
            else:
                sock = raw_sock

            _ws_handshake(sock, host, path, origin)
            sock.settimeout(0.5)
        except Exception as e:
            return {
                "statusCode": 502,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"Не удалось подключиться: {e}"}),
            }

        with _sessions_lock:
            _sessions[session_id] = {
                "sock": sock,
                "buf": bytearray(),
                "lock": threading.Lock(),
                "last_active": time.time(),
            }

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"session_id": session_id, "connected": True}),
        }

    # ── send ──────────────────────────────────────────────────────────────────
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
                    _ws_send_frame(session["sock"], cmd + "\r\n")
                session["last_active"] = time.time()
            except Exception as e:
                return {
                    "statusCode": 502,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({"error": f"Ошибка отправки: {e}"}),
                }

            lines, session["buf"] = _ws_recv_frames(session["sock"], session["buf"], time.time() + 3.0)

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"lines": lines}),
        }

    # ── poll ──────────────────────────────────────────────────────────────────
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
            lines, session["buf"] = _ws_recv_frames(session["sock"], session["buf"], time.time() + 3.0)

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
                # отправим WS close frame
                s["sock"].sendall(b"\x88\x00")
            except Exception:
                pass
            try:
                s["sock"].close()
            except Exception:
                pass
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"disconnected": True}),
        }

    # ── probe ─────────────────────────────────────────────────────────────────
    if action == "probe":
        host = body.get("host", "galaxy.mobstudio.ru")
        port = int(body.get("port", 443))
        # Пробуем разные комбинации путей и заголовков
        variants = [
            ("/", "", True),
            ("/web/", "", True),
            ("/web/", "Sec-WebSocket-Protocol: irc\r\n", True),
            ("/web/", "Sec-WebSocket-Protocol: irc.mobstudio\r\n", True),
            ("/websocket/", "", True),
            ("/ws/", "", True),
            ("/irc/", "", True),
            ("/", "Sec-WebSocket-Protocol: irc\r\n", True),
        ]
        # Также пробуем порт 6697 (IRC SSL) без SSL-сокета
        port6697_variants = [
            ("/", "", False),
            ("/", "Sec-WebSocket-Protocol: irc\r\n", False),
        ]
        results = {}
        for path, extra, use_ssl in variants:
            key = f"443 {path} proto={bool(extra)}"
            results[key] = _try_ws_path(host, port, path, extra, use_ssl)
        for path, extra, use_ssl in port6697_variants:
            key = f"6697 {path} ssl=False"
            results[key] = _try_ws_path(host, 6697, path, extra, use_ssl)
        winner = next((k for k, r in results.items() if "101" in r), None)
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"results": results, "winner": winner}),
        }

    return {
        "statusCode": 400,
        "headers": CORS_HEADERS,
        "body": json.dumps({"error": "Укажите action: connect | send | poll | disconnect"}),
    }
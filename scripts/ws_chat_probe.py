"""弹幕端到端验证：两个匿名观众，A 发弹幕 B 要收到；连发第二条应被限速。"""
import base64
import json
import os
import socket
import ssl
import struct
import time

for k in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
    os.environ.pop(k, None)

HOST = "127.0.0.1" if os.environ.get("LOCAL") else "192.168.50.99"
PORT = int(os.environ.get("PORT", "8080" if os.environ.get("LOCAL") else "8443"))


class WS:
    def __init__(self, host, port):
        key = base64.b64encode(os.urandom(16)).decode()
        raw = socket.create_connection((host, port), timeout=10)
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        self.s = ctx.wrap_socket(raw, server_hostname=host)
        self.s.sendall(
            f"GET /ws HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        assert b"101" in buf.split(b"\r\n")[0], buf[:80]
        self.buf = buf.split(b"\r\n\r\n", 1)[1]

    def _need(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d:
                return False
            self.buf += d
        return True

    def recv_json(self, timeout=5):
        self.s.settimeout(timeout)
        end = time.time() + timeout
        while time.time() < end:
            try:
                if not self._need(2):
                    return None
            except Exception:
                return None
            ln = self.buf[1] & 0x7F
            off = 2
            if ln == 126:
                if not self._need(4):
                    return None
                ln = struct.unpack(">H", self.buf[2:4])[0]
                off = 4
            if not self._need(off + ln):
                return None
            payload = bytes(self.buf[off : off + ln])
            self.buf = self.buf[off + ln :]
            if payload:
                try:
                    return json.loads(payload)
                except Exception:
                    pass
        return None

    def send_json(self, obj):
        data = json.dumps(obj).encode()
        hdr = bytearray([0x81])
        mask = os.urandom(4)
        if len(data) < 126:
            hdr.append(0x80 | len(data))
        else:
            hdr.append(0x80 | 126)
            hdr += struct.pack(">H", len(data))
        hdr += mask
        self.s.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


a = WS(HOST, PORT)
b = WS(HOST, PORT)
a.recv_json(2)  # hello
b.recv_json(2)

a.send_json({"t": "chat", "name": "测试甲", "text": "主播加油🔥"})

got = None
for _ in range(10):
    m = b.recv_json(4)
    if not m:
        break
    if m.get("t") == "chat":
        got = m
        break
print("B received:", got)
ok1 = got and got.get("name") == "测试甲" and "🔥" in got.get("text", "")

# 立即再发一条 -> 应被限速
a.send_json({"t": "chat", "name": "测试甲", "text": "第二条应该被拒"})
rej = None
for _ in range(6):
    m = a.recv_json(3)
    if not m:
        break
    if m.get("t") == "chat_reject":
        rej = m
        break
print("A rate-limit:", rej)
ok2 = rej and rej.get("reason") == "slow"

# 名称消毒检查：B 不应看到换行等
print("RESULT:", "PASS" if ok1 and ok2 else "FAIL", "(chat-delivery,", "ok)" if ok1 else "bad;", "rate-limit,", "ok)" if ok2 else "bad)")

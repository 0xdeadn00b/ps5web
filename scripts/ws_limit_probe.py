"""观众上限探针：并发 N+1 条匿名 WS，超出上限的连接应收到 {"t":"full"} 并被 4008 关闭。

用法: python ws_limit_probe.py [连接数]   # 默认 12（上限 10，多 2 条验证拒绝）
"""
import base64
import json
import os
import socket
import ssl
import struct
import sys
import time
import urllib.request

for k in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
    os.environ.pop(k, None)

HOST = os.environ.get("PROBE_HOST", "192.168.50.99")
PORT = int(os.environ.get("PROBE_PORT", "8443"))
N = int(sys.argv[1]) if len(sys.argv) > 1 else 12
CTX = ssl._create_unverified_context()


class Conn:
    def __init__(self):
        key = base64.b64encode(os.urandom(16)).decode()
        raw = socket.create_connection((HOST, PORT), timeout=10)
        self.s = CTX.wrap_socket(raw, server_hostname=HOST)
        self.s.sendall(
            (
                f"GET /ws HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                f"Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        self.buf = b""
        head = b""
        while b"\r\n\r\n" not in head:
            d = self.s.recv(4096)
            if not d:
                raise RuntimeError("no handshake")
            head += d
        self.status = head.split(b"\r\n\r\n", 1)[0].decode().splitlines()[0]
        self.buf = head.split(b"\r\n\r\n", 1)[1]

    def _need(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d:
                return False
            self.buf += d
        return True

    def read_frame(self):
        if not self._need(2):
            return None
        op = self.buf[0] & 0x0F
        ln = self.buf[1] & 0x7F
        off = 2
        if ln == 126:
            if not self._need(4):
                return None
            ln = struct.unpack(">H", self.buf[2:4])[0]
            off = 4
        elif ln == 127:
            if not self._need(10):
                return None
            ln = struct.unpack(">Q", self.buf[2:10])[0]
            off = 10
        if not self._need(off + ln):
            return None
        payload = bytes(self.buf[off : off + ln])
        self.buf = self.buf[off + ln :]
        return op, payload


conns = []
for i in range(N):
    try:
        c = Conn()
        c.s.settimeout(1.5)
        conns.append(c)
    except Exception as e:
        print(f"conn#{i} handshake fail: {e}")

# 读一轮：被拒的连接会收到 full 文本帧 + close(4008)
rejected = 0
for i, c in enumerate(conns):
    got_full = False
    code = None
    for _ in range(6):
        try:
            fr = c.read_frame()
        except socket.timeout:
            break
        except Exception:
            break
        if fr is None:
            break
        op, payload = fr
        if op == 0x1:
            try:
                m = json.loads(payload)
            except Exception:
                m = {}
            if m.get("t") == "full":
                got_full = True
        elif op == 0x8 and len(payload) >= 2:
            code = struct.unpack(">H", payload[:2])[0]
            break
    if got_full or code == 4008:
        rejected += 1
        print(f"conn#{i}: REJECTED full={got_full} close={code}")

time.sleep(0.3)
data = json.loads(
    urllib.request.urlopen(f"https://{HOST}:{PORT}/api/live", context=CTX, timeout=10).read()
)
print("live:", data)

for c in conns:
    try:
        c.s.close()
    except Exception:
        pass

print("RESULT:", "PASS" if rejected >= 1 else "FAIL (none rejected)")

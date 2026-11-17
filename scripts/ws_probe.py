"""匿名观众探针：不带 cookie 连 /ws，统计收到的视频/音频帧，验证观战链路。"""
import base64
import json
import os
import socket
import ssl
import struct
import sys
import time

for k in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
    os.environ.pop(k, None)

HOST = os.environ.get("PROBE_HOST", "192.168.50.99")
PORT = int(os.environ.get("PROBE_PORT", "8443"))
SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else 10

key = base64.b64encode(os.urandom(16)).decode()
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
raw = socket.create_connection((HOST, PORT), timeout=10)
s = ctx.wrap_socket(raw, server_hostname=HOST)
req = (
    f"GET /ws HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nUpgrade: websocket\r\n"
    f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
)
s.sendall(req.encode())
buf = b""
while b"\r\n\r\n" not in buf:
    buf += s.recv(4096)
header, buf = buf.split(b"\r\n\r\n", 1)
print("HANDSHAKE:", header.decode().splitlines()[0])

s.settimeout(2)


def need(n):
    global buf
    while len(buf) < n:
        d = s.recv(65536)
        if not d:
            return False
        buf += d
    return True


video = audio = events = 0
first_video_bytes = 0
hello = None
end = time.time() + SECONDS
while time.time() < end:
    if not need(2):
        break
    b1, b2 = buf[0], buf[1]
    op = b1 & 0x0F
    ln = b2 & 0x7F
    off = 2
    if ln == 126:
        if not need(4):
            break
        ln = struct.unpack(">H", buf[2:4])[0]
        off = 4
    elif ln == 127:
        if not need(10):
            break
        ln = struct.unpack(">Q", buf[2:10])[0]
        off = 10
    if not need(off + ln):
        break
    payload = bytes(buf[off : off + ln])
    buf = buf[off + ln :]
    if op == 0x8:
        print("SERVER CLOSE")
        break
    if op == 0x1:
        try:
            m = json.loads(payload)
        except Exception:
            continue
        events += 1
        if m.get("t") == "hello":
            hello = m
    elif op == 0x2:
        if payload and payload[0] == 0x10:
            video += 1
            if video == 1:
                first_video_bytes = len(payload)
        elif payload and payload[0] == 0x11:
            audio += 1

print(f"video={video} audio={audio} json_events={events}")
if hello:
    print("hello:", {k: hello.get(k) for k in ("state", "control", "current")})
if first_video_bytes:
    print(f"first_video_frame_bytes={first_video_bytes}")
print("RESULT:", "PASS-anon-viewer-receives-frames" if video > 5 else "NO-VIDEO")

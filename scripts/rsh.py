"""远程执行辅助：paramiko 连 CT210(192.168.50.139) 或 NAS(192.168.50.99)。

用法:
    python rsh.py ct  "命令"        # CT 上执行
    python rsh.py nas "命令"        # NAS 上执行
    python rsh.py ctput 本地 远端   # SFTP 上传到 CT
    python rsh.py nasput 本地 远端  # SFTP 上传到 NAS
环境变量覆盖代理: 直连家网时不需要代理。
"""

import os
import sys

import paramiko

for _k in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
    os.environ.pop(_k, None)

HOSTS = {
    "ct": ("192.168.50.139", 22, "root", "chiaki2026"),
    "nas": ("192.168.50.99", 22, "admin", "Xiaobai9978@"),
}


def client(which):
    host, port, user, pwd = HOSTS[which]
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=port, username=user, password=pwd, timeout=20,
              disabled_algorithms={"pubkeys": ["rsa-sha2-256", "rsa-sha2-512"]})
    return c


def main():
    action = sys.argv[1]
    if action in ("ct", "nas"):
        c = client(action)
        chan = c.get_transport().open_session()
        chan.get_pty()
        chan.exec_command(sys.argv[2] + f"; echo ___EXIT_$?___")
        chan.settimeout(int(sys.argv[3]) if len(sys.argv) > 3 else 120)
        buf = b""
        import time as _t
        deadline = _t.time() + (int(sys.argv[3]) if len(sys.argv) > 3 else 120)
        while _t.time() < deadline:
            try:
                data = chan.recv(4096)
            except Exception:
                break
            if not data:
                if chan.exit_status_ready():
                    break
                _t.sleep(0.2)
                continue
            buf += data
            if b"___EXIT_" in buf:
                break
        sys.stdout.write(buf.decode("utf-8", "replace"))
        sys.exit(0)
    elif action in ("ctput", "nasput"):
        c = client(action[:-3])
        sftp = c.open_sftp()
        local, remote = sys.argv[2], sys.argv[3]
        sftp.put(local, remote)
        st = sftp.stat(remote)
        print(f"UPLOADED {remote} {st.st_size}")
    else:
        print("unknown action", action)
        sys.exit(2)


main()

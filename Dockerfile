# syntax=docker/dockerfile:1
#
# 多阶段构建：
#   1) 编译 chiaki-ng 的 libchiaki + 我们的桥接进程
#   2) 只带运行时的精简镜像（Node 只跑静态页和 WebSocket）
#
# chiaki-ng 用 git 拉取（需要子模块：nanopb / jerasure / curl），
# 国内网络可以换镜像：
#   docker build --build-arg CHIAKI_REPO=https://gitee.com/xxx/chiaki-ng.git .
# 或者把源码放到构建上下文里，用 --build-arg CHIAKI_LOCAL=1
#
# apt 也可以换源（国内强烈建议，不然 deb.debian.org 能卡十分钟）：
#   --build-arg APT_MIRROR=https://mirrors.ustc.edu.cn/debian \
#   --build-arg APT_SECURITY_MIRROR=https://mirrors.ustc.edu.cn/debian-security

FROM debian:bookworm-slim AS build

ARG CHIAKI_REPO=https://github.com/chiaki-ng/chiaki-ng.git
ARG CHIAKI_REF=v1.10.1
ARG CHIAKI_LOCAL=0
ARG APT_MIRROR=http://deb.debian.org/debian
ARG APT_SECURITY_MIRROR=http://security.debian.org/debian-security

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
	for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources; do \
		[ -f "$f" ] || continue; \
		sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g; \
		        s|http://security.debian.org/debian-security|${APT_SECURITY_MIRROR}|g" "$f"; \
	done; \
	apt-get update && apt-get install -y --no-install-recommends \
	git ca-certificates \
	build-essential cmake pkg-config \
	python3 python3-protobuf protobuf-compiler \
	libssl-dev libjson-c-dev libevent-dev libminiupnpc-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# 源码：优先用构建上下文里的 chiaki-ng/，否则从 git 拉。
# 子模块只拉 libchiaki 需要的四个 —— 全量 --recurse-submodules 会把
# android/oboe 之类也拉下来，GitHub 慢的时候能卡十分钟。
COPY chiaki-ng* /src/local-chiaki/
RUN set -eux; \
	if [ "${CHIAKI_LOCAL}" = "1" ] && [ -f /src/local-chiaki/lib/include/chiaki/session.h ]; then \
		mv /src/local-chiaki /src/chiaki-ng; \
	else \
		rm -rf /src/local-chiaki; \
		git clone --depth 1 --branch "${CHIAKI_REF}" "${CHIAKI_REPO}" /src/chiaki-ng; \
	fi; \
	cd /src/chiaki-ng; \
	if [ -d .git ]; then \
		for m in third-party/nanopb third-party/jerasure third-party/gf-complete third-party/curl; do \
			git submodule update --init --depth 1 --single-branch "$m"; \
		done; \
	fi

COPY bridge /src/bridge

RUN cmake -S /src/bridge -B /src/build \
		-DCHIAKI_DIR=/src/chiaki-ng \
		-DCMAKE_BUILD_TYPE=Release \
 && cmake --build /src/build -j"$(nproc)" \
 && strip /src/build/ps5web-bridge

# ---------------------------------------------------------------- 运行时

FROM node:22-bookworm-slim

ARG APT_MIRROR=http://deb.debian.org/debian
ARG APT_SECURITY_MIRROR=http://security.debian.org/debian-security

ENV DEBIAN_FRONTEND=noninteractive \
	PS5WEB_WEB_DIR=/app/web \
	PS5WEB_DATA=/data \
	PS5WEB_BRIDGE=/usr/local/bin/ps5web-bridge \
	NODE_ENV=production

RUN set -eux; \
	for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources; do \
		[ -f "$f" ] || continue; \
		sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g; \
		        s|http://security.debian.org/debian-security|${APT_SECURITY_MIRROR}|g" "$f"; \
	done; \
	apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	libssl3 libjson-c5 libevent-2.1-7 libminiupnpc17 zlib1g \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/build/ps5web-bridge /usr/local/bin/ps5web-bridge
COPY server /app/server
COPY web /app/web

# 构建期就确认动态库齐全，别等运行时才炸
RUN if ldd /usr/local/bin/ps5web-bridge | grep -q 'not found'; then \
		echo '--- 缺少运行库 ---'; ldd /usr/local/bin/ps5web-bridge; exit 1; \
	fi && mkdir -p /data && chmod 700 /data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "const tls=!!process.env.PS5WEB_TLS_CERT;const mod=tls?require('https'):require('http');const port=process.env.PS5WEB_PORT||8080;mod.get({host:'127.0.0.1',port,path:'/api/public',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "/app/server/src/index.js"]

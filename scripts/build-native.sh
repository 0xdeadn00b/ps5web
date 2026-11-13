#!/usr/bin/env bash
# 不装 Docker，直接在这台机器上编译 ps5web-bridge。
#
#   ./scripts/build-native.sh [chiaki-ng 目录]
#
# 依赖（Debian/Ubuntu）：
#   sudo apt install -y build-essential cmake pkg-config git python3 python3-protobuf \
#       protobuf-compiler libssl-dev libjson-c-dev libevent-dev libminiupnpc-dev zlib1g-dev

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHIAKI_REF="${CHIAKI_REF:-v1.10.1}"
CHIAKI_REPO="${CHIAKI_REPO:-https://github.com/chiaki-ng/chiaki-ng.git}"
CHIAKI_DIR="${1:-$HERE/chiaki-ng}"
BUILD_DIR="${BUILD_DIR:-$HERE/build}"

if [ ! -f "$CHIAKI_DIR/lib/include/chiaki/session.h" ]; then
	echo "==> 拉取 chiaki-ng $CHIAKI_REF 到 $CHIAKI_DIR"
	rm -rf "$CHIAKI_DIR"
	git clone --depth 1 --branch "$CHIAKI_REF" "$CHIAKI_REPO" "$CHIAKI_DIR"
	# 只拉 libchiaki 需要的子模块，跳过 android/oboe 等
	for m in third-party/nanopb third-party/jerasure third-party/gf-complete third-party/curl; do
		git -C "$CHIAKI_DIR" submodule update --init --depth 1 --single-branch "$m"
	done
fi

echo "==> 配置"
cmake -S "$HERE/bridge" -B "$BUILD_DIR" \
	-DCHIAKI_DIR="$CHIAKI_DIR" \
	-DCMAKE_BUILD_TYPE=Release

echo "==> 编译"
cmake --build "$BUILD_DIR" -j"$(nproc)"

echo "==> 完成: $BUILD_DIR/ps5web-bridge"
echo
echo "启动："
echo "  PS5WEB_BRIDGE=$BUILD_DIR/ps5web-bridge \\"
echo "  PS5WEB_WEB_DIR=$HERE/web \\"
echo "  PS5WEB_DATA=$HERE/data \\"
echo "  node $HERE/server/src/index.js"

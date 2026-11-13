# SPDX-License-Identifier: AGPL-3.0-only
#
# 只编 libchiaki（不要 Qt GUI / CLI / Switch 前端），在它上面挂一个
# 通过 stdin/stdout 通信的桥接进程。
#
#   cmake -S bridge -B build -DCHIAKI_DIR=/path/to/chiaki-ng
#   cmake --build build -j

cmake_minimum_required(VERSION 3.16)
project(ps5web_bridge C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
	set(CMAKE_BUILD_TYPE Release)
endif()

set(CHIAKI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../chiaki-ng" CACHE PATH "chiaki-ng 源码根目录")
if(NOT EXISTS "${CHIAKI_DIR}/lib/include/chiaki/session.h")
	message(FATAL_ERROR
		"没有找到 chiaki-ng 源码（${CHIAKI_DIR}）。\n"
		"请用 -DCHIAKI_DIR=/path/to/chiaki-ng 指定，或把 chiaki-ng 放在 bridge 的同级目录。")
endif()

# --- chiaki-ng 构建选项：只要 libchiaki ------------------------------------
set(CHIAKI_ENABLE_TESTS OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_CLI OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_GUI OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_BOREALIS OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_ANDROID OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_STEAMDECK_NATIVE OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_SETSU OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_SPEEX OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_STEAM_SHORTCUT OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_FFMPEG_DECODER OFF CACHE BOOL "" FORCE)
set(CHIAKI_LIB_ENABLE_OPUS OFF CACHE BOOL "" FORCE)
set(CHIAKI_LIB_MBEDTLS OFF CACHE BOOL "" FORCE)

add_subdirectory(${CHIAKI_DIR} ${CMAKE_BINARY_DIR}/chiaki EXCLUDE_FROM_ALL)

find_package(PkgConfig REQUIRED)
pkg_check_modules(JSONC REQUIRED json-c)

add_executable(ps5web-bridge
	src/main.c
	src/proto.c
)

target_include_directories(ps5web-bridge PRIVATE
	${JSONC_INCLUDE_DIRS}
	${CHIAKI_DIR}/lib/include
)

target_link_directories(ps5web-bridge PRIVATE ${JSONC_LIBRARY_DIRS})
target_link_libraries(ps5web-bridge PRIVATE chiaki-lib ${JSONC_LIBRARIES} pthread m)

install(TARGETS ps5web-bridge RUNTIME DESTINATION bin)

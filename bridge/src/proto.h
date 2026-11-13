// SPDX-License-Identifier: AGPL-3.0-only
//
// ps5web bridge <-> node server 帧协议
//   [u8 type][u32 big-endian payload length][payload]
//
// 所有多字节整数在本文件中标记了字节序，JS 侧按同样偏移解析。

#ifndef PS5WEB_PROTO_H
#define PS5WEB_PROTO_H

#include <stddef.h>
#include <stdint.h>

/* 消息类型 */
#define PS5WEB_MSG_JSON  1  /* UTF-8 JSON，双向 */
#define PS5WEB_MSG_INPUT 2  /* 手柄状态，server -> bridge，固定 28 字节 */
#define PS5WEB_MSG_VIDEO 3  /* 压缩视频帧，bridge -> server */
#define PS5WEB_MSG_AUDIO 4  /* Opus 帧，bridge -> server */

/*
 * 视频负载头部（16 字节，小端）：
 *   0..7   u64  采集时间（微秒，单调时钟）
 *   8      u8   flags: bit0 = 关键帧(IRAP)，bit1 = 参数集(SPS/PPS/VPS)
 *   9..11  保留
 *   12..15 i32  丢失帧数（自上个成功帧起）
 * 之后是 Annex-B 字节流（00 00 01 / 00 00 00 01 起始码）
 */
#define PS5WEB_VIDEO_HDR 16

/* 音频负载头部（8 字节，小端）：0..7 u64 采集时间（微秒），之后是 Opus 包 */
#define PS5WEB_AUDIO_HDR 8

/*
 * 输入负载（28 字节，小端）：
 *   0      u8  version = 1
 *   1      u8  l2 (0..255)
 *   2      u8  r2 (0..255)
 *   3      u8  flags: bit0 = 触摸点0有效，bit1 = 触摸点1有效
 *   4..7   u32 buttons
 *   8..9   i16 leftX      10..11 i16 leftY
 *   12..13 i16 rightX     14..15 i16 rightY
 *   16..17 u16 touch0X    18..19 u16 touch0Y
 *   20..21 u16 touch1X    22..23 u16 touch1Y
 *   24     u8  touch0Id   25     u8  touch1Id
 *   26..27 u16 保留
 */
#define PS5WEB_INPUT_LEN 28

void ps5web_proto_init(void);
void ps5web_proto_send(uint8_t type, const void *data, size_t len);
void ps5web_proto_send2(uint8_t type,
		const void *a, size_t alen,
		const void *b, size_t blen);
void ps5web_proto_send3(uint8_t type,
		const void *a, size_t alen,
		const void *b, size_t blen,
		const void *c, size_t clen);

#endif /* PS5WEB_PROTO_H */

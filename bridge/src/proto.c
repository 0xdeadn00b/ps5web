// SPDX-License-Identifier: AGPL-3.0-only

#include "proto.h"

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static pthread_mutex_t g_write_mutex = PTHREAD_MUTEX_INITIALIZER;

void ps5web_proto_init(void)
{
	/* 父进程消失时不要被 SIGPIPE 杀掉，交给 write() 返回 EPIPE */
	signal(SIGPIPE, SIG_IGN);
}

static void write_fully(const void *buf, size_t len)
{
	const uint8_t *p = (const uint8_t *)buf;
	size_t off = 0;
	while(off < len)
	{
		ssize_t n = write(STDOUT_FILENO, p + off, len - off);
		if(n < 0)
		{
			if(errno == EINTR)
				continue;
			_exit(0); /* 管道断裂：服务端已退出 */
		}
		if(n == 0)
			_exit(0);
		off += (size_t)n;
	}
}

static void send_parts(uint8_t type, const void *const *parts, const size_t *lens, int count)
{
	size_t total = 0;
	for(int i = 0; i < count; i++)
		total += lens[i];
	if(total > 0x00ffffffu)
		return; /* 单帧上限 16MB，异常数据直接丢弃 */

	uint8_t header[5];
	header[0] = type;
	header[1] = (uint8_t)((total >> 24) & 0xff);
	header[2] = (uint8_t)((total >> 16) & 0xff);
	header[3] = (uint8_t)((total >> 8) & 0xff);
	header[4] = (uint8_t)(total & 0xff);

	pthread_mutex_lock(&g_write_mutex);
	write_fully(header, sizeof(header));
	for(int i = 0; i < count; i++)
	{
		if(lens[i])
			write_fully(parts[i], lens[i]);
	}
	pthread_mutex_unlock(&g_write_mutex);
}

void ps5web_proto_send(uint8_t type, const void *data, size_t len)
{
	const void *parts[1] = { data };
	size_t lens[1] = { len };
	send_parts(type, parts, lens, 1);
}

void ps5web_proto_send2(uint8_t type, const void *a, size_t alen, const void *b, size_t blen)
{
	const void *parts[2] = { a, b };
	size_t lens[2] = { alen, blen };
	send_parts(type, parts, lens, 2);
}

void ps5web_proto_send3(uint8_t type,
		const void *a, size_t alen,
		const void *b, size_t blen,
		const void *c, size_t clen)
{
	const void *parts[3] = { a, b, c };
	size_t lens[3] = { alen, blen, clen };
	send_parts(type, parts, lens, 3);
}

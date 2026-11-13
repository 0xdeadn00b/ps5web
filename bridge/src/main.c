// SPDX-License-Identifier: AGPL-3.0-only
//
// ps5web bridge
//
// 一个极薄的进程级封装：把 chiaki-ng 的 libchiaki 暴露成
// 「stdin 收命令 / stdout 出视频音频事件」的子进程，
// 由 Node 服务端持有，再把码流转给浏览器。
//
// 之所以不在 JS 里重写协议：配对、SRTP、FEC、Takion 握手这些
// 都在 libchiaki 里现成的，重写只会引入难以验证的偏差。

#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <json-c/json.h>

#include <chiaki/common.h>
#include <chiaki/controller.h>
#include <chiaki/discovery.h>
#include <chiaki/discoveryservice.h>
#include <chiaki/log.h>
#include <chiaki/regist.h>
#include <chiaki/session.h>

#include "proto.h"

#define BRIDGE_VERSION "1.0.0"
#define MAX_JSON_SIZE (4u * 1024u * 1024u)
#define SESSION_HOST_MAX 256

/* ------------------------------------------------------------------ */
/* 基础设施                                                            */
/* ------------------------------------------------------------------ */

static ChiakiLog g_log;

static void json_send(json_object *obj)
{
	if(!obj)
		return;
	const char *s = json_object_to_json_string_ext(obj, JSON_C_TO_STRING_PLAIN);
	ps5web_proto_send(PS5WEB_MSG_JSON, s, strlen(s));
	json_object_put(obj);
}

static void emit_event(const char *ev)
{
	json_object *o = json_object_new_object();
	json_object_object_add(o, "ev", json_object_new_string(ev));
	json_send(o);
}

static void emit_error(const char *cmd, const char *fmt, ...)
{
	char msg[512];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(msg, sizeof(msg), fmt, ap);
	va_end(ap);

	json_object *o = json_object_new_object();
	json_object_object_add(o, "ev", json_object_new_string("error"));
	json_object_object_add(o, "cmd", json_object_new_string(cmd ? cmd : ""));
	json_object_object_add(o, "message", json_object_new_string(msg));
	json_send(o);
}

static uint64_t now_us(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000000ull + (uint64_t)(ts.tv_nsec / 1000);
}

static void log_cb(ChiakiLogLevel level, const char *msg, void *user)
{
	(void)user;
	const char *name = "info";
	switch(level)
	{
		case CHIAKI_LOG_DEBUG: name = "debug"; break;
		case CHIAKI_LOG_VERBOSE: name = "verbose"; break;
		case CHIAKI_LOG_INFO: name = "info"; break;
		case CHIAKI_LOG_WARNING: name = "warn"; break;
		case CHIAKI_LOG_ERROR: name = "error"; break;
	}

	json_object *o = json_object_new_object();
	json_object_object_add(o, "ev", json_object_new_string("log"));
	json_object_object_add(o, "level", json_object_new_string(name));
	json_object_object_add(o, "message", json_object_new_string(msg ? msg : ""));
	json_send(o);
}

/* ---- 十六进制 / base64 -------------------------------------------- */

static int hex_val(char c)
{
	if(c >= '0' && c <= '9') return c - '0';
	if(c >= 'a' && c <= 'f') return c - 'a' + 10;
	if(c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

static bool parse_hex_exact(const char *hex, uint8_t *out, size_t n)
{
	if(!hex || strlen(hex) != n * 2)
		return false;
	for(size_t i = 0; i < n; i++)
	{
		int hi = hex_val(hex[i * 2]);
		int lo = hex_val(hex[i * 2 + 1]);
		if(hi < 0 || lo < 0)
			return false;
		out[i] = (uint8_t)((hi << 4) | lo);
	}
	return true;
}

static void format_hex(const uint8_t *in, size_t n, char *out)
{
	static const char digits[] = "0123456789abcdef";
	for(size_t i = 0; i < n; i++)
	{
		out[i * 2] = digits[(in[i] >> 4) & 0xf];
		out[i * 2 + 1] = digits[in[i] & 0xf];
	}
	out[n * 2] = '\0';
}

static int b64_decode(const char *in, uint8_t *out, size_t out_len)
{
	unsigned acc = 0;
	int bits = 0;
	size_t o = 0;
	if(!in)
		return -1;
	for(const char *p = in; *p; p++)
	{
		int v;
		char c = *p;
		if(c >= 'A' && c <= 'Z') v = c - 'A';
		else if(c >= 'a' && c <= 'z') v = c - 'a' + 26;
		else if(c >= '0' && c <= '9') v = c - '0' + 52;
		else if(c == '+' || c == '-') v = 62;
		else if(c == '/' || c == '_') v = 63;
		else if(c == '=' || c == ' ' || c == '\n' || c == '\r' || c == '\t') continue;
		else return -1;

		acc = (acc << 6) | (unsigned)v;
		bits += 6;
		if(bits >= 8)
		{
			bits -= 8;
			if(o < out_len)
				out[o] = (uint8_t)((acc >> bits) & 0xff);
			o++;
		}
	}
	return (int)o;
}

/* ---- JSON 取值 ---------------------------------------------------- */

static bool json_get_str(json_object *o, const char *key, char *buf, size_t buf_size)
{
	json_object *v;
	if(!json_object_object_get_ex(o, key, &v))
		return false;
	const char *s = json_object_get_string(v);
	if(!s)
		return false;
	snprintf(buf, buf_size, "%s", s);
	return true;
}

static const char *json_get_cstr(json_object *o, const char *key)
{
	json_object *v;
	if(!json_object_object_get_ex(o, key, &v))
		return NULL;
	return json_object_get_string(v);
}

static int json_get_int(json_object *o, const char *key, int def)
{
	json_object *v;
	if(!json_object_object_get_ex(o, key, &v))
		return def;
	return json_object_get_int(v);
}

static bool json_get_bool(json_object *o, const char *key, bool def)
{
	json_object *v;
	if(!json_object_object_get_ex(o, key, &v))
		return def;
	return json_object_get_boolean(v);
}

static void json_add_str(json_object *o, const char *key, const char *value)
{
	json_object_object_add(o, key, json_object_new_string(value ? value : ""));
}

/* ------------------------------------------------------------------ */
/* 视频 / 音频采集                                                      */
/* ------------------------------------------------------------------ */

static pthread_mutex_t g_params_mutex = PTHREAD_MUTEX_INITIALIZER;
static uint8_t *g_params = NULL;   /* 缓存的参数集（SPS/PPS 或 VPS/SPS/PPS），Annex-B */
static size_t g_params_size = 0;
static bool g_hevc = false;

static void scan_annexb(const uint8_t *buf, size_t len, bool hevc,
		bool *has_params, bool *has_slice, bool *has_irap)
{
	size_t i = 0;
	while(i + 3 <= len)
	{
		if(buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1)
		{
			size_t nal = i + 3;
			if(nal < len)
			{
				uint8_t h0 = buf[nal];
				if(hevc)
				{
					unsigned t = (unsigned)((h0 >> 1) & 0x3f);
					if(t == 32 || t == 33 || t == 34) *has_params = true;
					if(t <= 31) *has_slice = true;
					if(t >= 16 && t <= 21) *has_irap = true;
				}
				else
				{
					unsigned t = (unsigned)(h0 & 0x1f);
					if(t == 7 || t == 8) *has_params = true;
					if(t >= 1 && t <= 5) *has_slice = true;
					if(t == 5) *has_irap = true;
				}
			}
			i = nal + 1;
			continue;
		}
		i++;
	}
}

static bool video_sample_cb(uint8_t *buf, size_t buf_size, int32_t frames_lost,
		bool frame_recovered, void *user)
{
	(void)user;
	(void)frame_recovered;

	if(!buf || buf_size == 0)
		return true;

	bool has_params = false, has_slice = false, has_irap = false;
	scan_annexb(buf, buf_size, g_hevc, &has_params, &has_slice, &has_irap);

	uint8_t hdr[PS5WEB_VIDEO_HDR];
	memset(hdr, 0, sizeof(hdr));
	uint64_t ts = now_us();
	memcpy(hdr, &ts, 8);
	uint8_t flags = 0;
	if(has_irap) flags |= 0x01;
	if(has_params && !has_slice) flags |= 0x02;
	hdr[8] = flags;
	memcpy(hdr + 12, &frames_lost, 4);

	pthread_mutex_lock(&g_params_mutex);

	if(has_params && !has_slice)
	{
		if(g_params_size != buf_size || !g_params || memcmp(g_params, buf, buf_size) != 0)
		{
			uint8_t *n = (uint8_t *)realloc(g_params, buf_size);
			if(n)
			{
				memcpy(n, buf, buf_size);
				g_params = n;
				g_params_size = buf_size;
			}
		}
	}

	bool prepend = has_irap && !has_params && g_params && g_params_size > 0;
	if(prepend)
		ps5web_proto_send3(PS5WEB_MSG_VIDEO, hdr, sizeof(hdr), g_params, g_params_size, buf, buf_size);
	else
		ps5web_proto_send2(PS5WEB_MSG_VIDEO, hdr, sizeof(hdr), buf, buf_size);

	pthread_mutex_unlock(&g_params_mutex);
	return true;
}

static void audio_header_cb(ChiakiAudioHeader *header, void *user)
{
	(void)user;
	json_object *o = json_object_new_object();
	json_object_object_add(o, "ev", json_object_new_string("audio_format"));
	json_object_object_add(o, "channels", json_object_new_int(header->channels));
	json_object_object_add(o, "bits", json_object_new_int(header->bits));
	json_object_object_add(o, "rate", json_object_new_int((int)header->rate));
	json_object_object_add(o, "frameSize", json_object_new_int((int)header->frame_size));
	json_send(o);
}

static void audio_frame_cb(uint8_t *buf, size_t buf_size, void *user)
{
	(void)user;
	if(!buf || buf_size == 0)
		return;
	uint8_t hdr[PS5WEB_AUDIO_HDR];
	uint64_t ts = now_us();
	memcpy(hdr, &ts, 8);
	ps5web_proto_send2(PS5WEB_MSG_AUDIO, hdr, sizeof(hdr), buf, buf_size);
}

/* ------------------------------------------------------------------ */
/* 会话生命周期                                                        */
/* ------------------------------------------------------------------ */

static ChiakiSession g_session;
static bool g_session_live = false;
static pthread_mutex_t g_session_mutex = PTHREAD_MUTEX_INITIALIZER;
static char g_host[SESSION_HOST_MAX];

static void *session_reaper(void *arg)
{
	(void)arg;
	chiaki_session_join(&g_session);

	pthread_mutex_lock(&g_session_mutex);
	g_session_live = false;
	chiaki_session_fini(&g_session);
	pthread_mutex_unlock(&g_session_mutex);

	emit_event("session_ended");
	return NULL;
}

static void session_event_cb(ChiakiEvent *event, void *user)
{
	(void)user;
	json_object *o;

	switch(event->type)
	{
		case CHIAKI_EVENT_CONNECTED:
			emit_event("connected");
			break;

		case CHIAKI_EVENT_QUIT:
		{
			o = json_object_new_object();
			json_object_object_add(o, "ev", json_object_new_string("quit"));
			json_object_object_add(o, "reason",
					json_object_new_string(chiaki_quit_reason_string(event->quit.reason)));
			json_object_object_add(o, "error",
					json_object_new_boolean(chiaki_quit_reason_is_error(event->quit.reason)));
			if(event->quit.reason_str)
				json_add_str(o, "detail", event->quit.reason_str);
			json_send(o);
			break;
		}

		case CHIAKI_EVENT_LOGIN_PIN_REQUEST:
		{
			o = json_object_new_object();
			json_object_object_add(o, "ev", json_object_new_string("pin_request"));
			json_object_object_add(o, "incorrect",
					json_object_new_boolean(event->login_pin_request.pin_incorrect));
			json_send(o);
			break;
		}

		case CHIAKI_EVENT_RUMBLE:
		{
			o = json_object_new_object();
			json_object_object_add(o, "ev", json_object_new_string("rumble"));
			json_object_object_add(o, "left", json_object_new_int(event->rumble.left));
			json_object_object_add(o, "right", json_object_new_int(event->rumble.right));
			json_send(o);
			break;
		}

		case CHIAKI_EVENT_NICKNAME_RECEIVED:
		{
			o = json_object_new_object();
			json_object_object_add(o, "ev", json_object_new_string("nickname"));
			json_object_object_add(o, "name",
					json_object_new_string_len(event->server_nickname,
						(int)strnlen(event->server_nickname, sizeof(event->server_nickname))));
			json_send(o);
			break;
		}

		case CHIAKI_EVENT_PLAYER_INDEX:
		{
			o = json_object_new_object();
			json_object_object_add(o, "ev", json_object_new_string("player_index"));
			json_object_object_add(o, "index", json_object_new_int(event->player_index));
			json_send(o);
			break;
		}

		case CHIAKI_EVENT_VIDEO_FEC_FAILURE:
			emit_event("fec_failure");
			break;

		default:
			break;
	}
}

/* ------------------------------------------------------------------ */
/* 配对（注册）                                                        */
/* ------------------------------------------------------------------ */

static bool g_pair_running = false;
static bool g_pair_done = false;
static bool g_pair_ok = false;
static pthread_mutex_t g_pair_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_pair_cond = PTHREAD_COND_INITIALIZER;
static char g_pair_host[SESSION_HOST_MAX];

static void regist_cb(ChiakiRegistEvent *event, void *user)
{
	(void)user;
	json_object *o = json_object_new_object();

	if(event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS && event->registered_host)
	{
		ChiakiRegisteredHost *h = event->registered_host;
		char hex_key[CHIAKI_SESSION_AUTH_SIZE * 2 + 1];
		char hex_rp[sizeof(h->rp_key) * 2 + 1];
		char hex_mac[sizeof(h->server_mac) * 2 + 1];

		format_hex((const uint8_t *)h->rp_regist_key, CHIAKI_SESSION_AUTH_SIZE, hex_key);
		format_hex(h->rp_key, sizeof(h->rp_key), hex_rp);
		format_hex(h->server_mac, sizeof(h->server_mac), hex_mac);

		json_object_object_add(o, "ev", json_object_new_string("pair_ok"));
		json_object *ho = json_object_new_object();
		json_object_object_add(ho, "target", json_object_new_int((int)h->target));
		json_object_object_add(ho, "ps5", json_object_new_boolean(chiaki_target_is_ps5(h->target)));
		json_add_str(ho, "nickname", h->server_nickname);
		json_add_str(ho, "mac", hex_mac);
		json_add_str(ho, "registKey", hex_key);
		json_add_str(ho, "rpKey", hex_rp);
		json_object_object_add(ho, "rpKeyType", json_object_new_int((int)h->rp_key_type));
		json_object_object_add(ho, "consolePin", json_object_new_int((int)h->console_pin));
		json_add_str(ho, "apSsid", h->ap_ssid);
		json_add_str(ho, "apName", h->ap_name);
		json_object_object_add(o, "host", ho);
		g_pair_ok = true;
	}
	else
	{
		json_object_object_add(o, "ev", json_object_new_string("pair_fail"));
		json_object_object_add(o, "reason", json_object_new_string(
				event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_CANCELED ? "canceled" : "failed"));
		g_pair_ok = false;
	}

	json_send(o);

	pthread_mutex_lock(&g_pair_mutex);
	g_pair_done = true;
	pthread_cond_broadcast(&g_pair_cond);
	pthread_mutex_unlock(&g_pair_mutex);
}

typedef struct {
	uint32_t pin;
	uint8_t account_id[CHIAKI_PSN_ACCOUNT_ID_SIZE];
	bool ps5;
} PairJob;

static void *pair_thread(void *arg)
{
	PairJob *job = (PairJob *)arg;

	ChiakiRegistInfo info;
	memset(&info, 0, sizeof(info));
	info.target = job->ps5 ? CHIAKI_TARGET_PS5_1 : CHIAKI_TARGET_PS4_10;
	info.host = g_pair_host;
	info.broadcast = false;
	info.psn_online_id = NULL;
	memcpy(info.psn_account_id, job->account_id, CHIAKI_PSN_ACCOUNT_ID_SIZE);
	info.pin = job->pin;
	info.console_pin = 0;
	info.holepunch_info = NULL;
	memset(&info.rudp, 0, sizeof(info.rudp));

	pthread_mutex_lock(&g_pair_mutex);
	g_pair_done = false;
	g_pair_ok = false;
	pthread_mutex_unlock(&g_pair_mutex);

	ChiakiRegist regist;
	ChiakiErrorCode err = chiaki_regist_start(&regist, &g_log, &info, regist_cb, NULL);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		emit_error("pair", "无法开始配对: %s", chiaki_error_string(err));
		goto done;
	}

	struct timespec deadline;
	clock_gettime(CLOCK_REALTIME, &deadline);
	deadline.tv_sec += 120;

	pthread_mutex_lock(&g_pair_mutex);
	while(!g_pair_done)
	{
		int rc = pthread_cond_timedwait(&g_pair_cond, &g_pair_mutex, &deadline);
		if(rc == ETIMEDOUT)
			break;
	}
	bool done = g_pair_done;
	pthread_mutex_unlock(&g_pair_mutex);

	if(!done)
		emit_error("pair", "配对超时（控制台是否已进入「关联设备」界面？）");

	chiaki_regist_stop(&regist);
	chiaki_regist_fini(&regist);

done:
	pthread_mutex_lock(&g_pair_mutex);
	g_pair_running = false;
	pthread_mutex_unlock(&g_pair_mutex);
	free(job);
	return NULL;
}

/* ------------------------------------------------------------------ */
/* 局域网发现                                                          */
/* ------------------------------------------------------------------ */

static volatile bool g_discover_cancel = false;
static volatile bool g_discover_running = false;

static void discovery_hosts_cb(ChiakiDiscoveryHost *hosts, size_t hosts_count, void *user)
{
	(void)user;
	json_object *arr = json_object_new_array();
	for(size_t i = 0; i < hosts_count; i++)
	{
		ChiakiDiscoveryHost *h = &hosts[i];
		json_object *ho = json_object_new_object();
		json_add_str(ho, "name", h->host_name);
		json_add_str(ho, "address", h->host_addr);
		json_add_str(ho, "id", h->host_id);
		json_add_str(ho, "type", h->host_type);
		json_add_str(ho, "state", chiaki_discovery_host_state_string(h->state));
		json_add_str(ho, "systemVersion", h->system_version);
		json_add_str(ho, "runningApp", h->running_app_name);
		json_object_object_add(ho, "ps5", json_object_new_boolean(chiaki_discovery_host_is_ps5(h)));
		json_object_object_add(ho, "rpPort", json_object_new_int((int)h->host_request_port));
		json_object_object_add(ho, "target",
				json_object_new_int((int)chiaki_discovery_host_system_version_target(h)));
		json_object_array_add(arr, ho);
	}

	json_object *o = json_object_new_object();
	json_object_object_add(o, "ev", json_object_new_string("hosts"));
	json_object_object_add(o, "hosts", arr);
	json_send(o);
}

static size_t collect_broadcast_addrs(struct sockaddr_storage *out, size_t max)
{
	struct ifaddrs *ifs = NULL;
	if(getifaddrs(&ifs) != 0)
		return 0;

	size_t n = 0;
	for(struct ifaddrs *cur = ifs; cur && n < max; cur = cur->ifa_next)
	{
		if(!cur->ifa_addr || cur->ifa_addr->sa_family != AF_INET)
			continue;
		if((cur->ifa_flags & (IFF_UP | IFF_RUNNING | IFF_LOOPBACK | IFF_BROADCAST))
				!= (IFF_UP | IFF_RUNNING | IFF_BROADCAST))
			continue;
		if(!cur->ifa_broadaddr)
			continue;

		struct sockaddr_in *b = (struct sockaddr_in *)cur->ifa_broadaddr;
		struct sockaddr_in *dst = (struct sockaddr_in *)&out[n];
		memset(dst, 0, sizeof(*dst));
		dst->sin_family = AF_INET;
		dst->sin_addr = b->sin_addr;
		n++;
	}

	freeifaddrs(ifs);
	return n;
}

static void *discover_thread(void *arg)
{
	uint64_t duration_ms = (uint64_t)(uintptr_t)arg;

	struct sockaddr_storage baddrs[16];
	size_t bnum = collect_broadcast_addrs(baddrs, 16);

	struct sockaddr_storage send_addr;
	memset(&send_addr, 0, sizeof(send_addr));
	struct sockaddr_in *sa4 = (struct sockaddr_in *)&send_addr;
	sa4->sin_family = AF_INET;
	sa4->sin_addr.s_addr = INADDR_BROADCAST;

	ChiakiDiscoveryServiceOptions opt;
	memset(&opt, 0, sizeof(opt));
	opt.hosts_max = 16;
	opt.host_drop_pings = 4;
	opt.ping_ms = 400;
	opt.ping_initial_ms = 50;
	opt.send_addr = &send_addr;
	opt.send_addr_size = sizeof(struct sockaddr_in);
	opt.broadcast_addrs = bnum ? baddrs : NULL;
	opt.broadcast_num = bnum;
	opt.cb = discovery_hosts_cb;
	opt.cb_user = NULL;

	ChiakiDiscoveryService svc;
	memset(&svc, 0, sizeof(svc));
	ChiakiErrorCode err = chiaki_discovery_service_init(&svc, &opt, &g_log);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		emit_error("discover", "发现服务启动失败: %s", chiaki_error_string(err));
		emit_event("discover_done");
		g_discover_running = false;
		return NULL;
	}

	uint64_t waited = 0;
	while(waited < duration_ms && !g_discover_cancel)
	{
		struct timespec ts;
		ts.tv_sec = 0;
		ts.tv_nsec = 100 * 1000 * 1000;
		nanosleep(&ts, NULL);
		waited += 100;
	}

	chiaki_discovery_service_fini(&svc);
	g_discover_cancel = false;
	g_discover_running = false;
	emit_event("discover_done");
	return NULL;
}

/* ------------------------------------------------------------------ */
/* 输入                                                               */
/* ------------------------------------------------------------------ */

static void handle_input(const uint8_t *buf, size_t len)
{
	if(len < PS5WEB_INPUT_LEN)
		return;

	ChiakiControllerState st;
	chiaki_controller_state_set_idle(&st);

	uint8_t flags = buf[3];
	uint32_t buttons;
	int16_t v16;
	uint16_t u16;

	st.l2_state = buf[1];
	st.r2_state = buf[2];
	memcpy(&buttons, buf + 4, 4);
	st.buttons = buttons;

	memcpy(&v16, buf + 8, 2);  st.left_x = v16;
	memcpy(&v16, buf + 10, 2); st.left_y = v16;
	memcpy(&v16, buf + 12, 2); st.right_x = v16;
	memcpy(&v16, buf + 14, 2); st.right_y = v16;

	if(flags & 0x01)
	{
		memcpy(&u16, buf + 16, 2); st.touches[0].x = u16;
		memcpy(&u16, buf + 18, 2); st.touches[0].y = u16;
		st.touches[0].id = (int8_t)buf[24];
	}
	if(flags & 0x02)
	{
		memcpy(&u16, buf + 20, 2); st.touches[1].x = u16;
		memcpy(&u16, buf + 22, 2); st.touches[1].y = u16;
		st.touches[1].id = (int8_t)buf[25];
	}

	pthread_mutex_lock(&g_session_mutex);
	if(g_session_live)
		chiaki_session_set_controller_state(&g_session, &st);
	pthread_mutex_unlock(&g_session_mutex);
}

/* ------------------------------------------------------------------ */
/* 命令处理                                                            */
/* ------------------------------------------------------------------ */

static bool parse_resolution(const char *s, ChiakiVideoResolutionPreset *out)
{
	if(!s || !strcmp(s, "1080p")) { *out = CHIAKI_VIDEO_RESOLUTION_PRESET_1080p; return true; }
	if(!strcmp(s, "720p")) { *out = CHIAKI_VIDEO_RESOLUTION_PRESET_720p; return true; }
	if(!strcmp(s, "540p")) { *out = CHIAKI_VIDEO_RESOLUTION_PRESET_540p; return true; }
	if(!strcmp(s, "360p")) { *out = CHIAKI_VIDEO_RESOLUTION_PRESET_360p; return true; }
	return false;
}

static void cmd_start(json_object *req)
{
	if(g_session_live)
	{
		emit_error("start", "已经有进行中的会话");
		return;
	}

	char host[SESSION_HOST_MAX] = "";
	char key_hex[64] = "";
	char rp_hex[64] = "";
	if(!json_get_str(req, "host", host, sizeof(host)) || !host[0])
	{
		emit_error("start", "缺少 host");
		return;
	}
	if(!json_get_str(req, "registKey", key_hex, sizeof(key_hex)))
	{
		emit_error("start", "缺少 registKey，请先配对");
		return;
	}
	if(!json_get_str(req, "rpKey", rp_hex, sizeof(rp_hex)))
	{
		emit_error("start", "缺少 rpKey，请先配对");
		return;
	}

	ChiakiConnectInfo ci;
	memset(&ci, 0, sizeof(ci));

	if(!parse_hex_exact(key_hex, (uint8_t *)ci.regist_key, CHIAKI_SESSION_AUTH_SIZE))
	{
		emit_error("start", "registKey 格式错误");
		return;
	}
	if(!parse_hex_exact(rp_hex, ci.morning, sizeof(ci.morning)))
	{
		emit_error("start", "rpKey 格式错误");
		return;
	}

	bool ps5 = json_get_bool(req, "ps5", true);
	ChiakiVideoResolutionPreset res;
	const char *res_str = json_get_cstr(req, "resolution");
	if(!parse_resolution(res_str, &res))
		res = CHIAKI_VIDEO_RESOLUTION_PRESET_1080p;

	int fps_req = json_get_int(req, "fps", 60);
	ChiakiVideoFPSPreset fps = fps_req >= 60 ? CHIAKI_VIDEO_FPS_PRESET_60 : CHIAKI_VIDEO_FPS_PRESET_30;

	chiaki_connect_video_profile_preset(&ci.video_profile, res, fps);

	int bitrate = json_get_int(req, "bitrate", 0);
	if(bitrate > 0)
		ci.video_profile.bitrate = (unsigned int)bitrate;

	const char *codec = json_get_cstr(req, "codec");
	g_hevc = codec && (!strcmp(codec, "h265") || !strcmp(codec, "h265hdr"));
	ci.video_profile.codec = g_hevc
			? (!strcmp(codec, "h265hdr") ? CHIAKI_CODEC_H265_HDR : CHIAKI_CODEC_H265)
			: CHIAKI_CODEC_H264;
	ci.video_profile_auto_downgrade = true;

	snprintf(g_host, sizeof(g_host), "%s", host);
	ci.host = g_host;
	ci.ps5 = ps5;
	ci.enable_keyboard = false;
	ci.enable_dualsense = json_get_bool(req, "dualsense", true);
	ci.auto_regist = false;
	ci.holepunch_session = NULL;
	ci.rudp_sock = NULL;
	ci.packet_loss_max = 0.05;
	ci.enable_idr_on_fec_failure = true;

	pthread_mutex_lock(&g_params_mutex);
	free(g_params);
	g_params = NULL;
	g_params_size = 0;
	pthread_mutex_unlock(&g_params_mutex);

	ChiakiErrorCode err = chiaki_session_init(&g_session, &ci, &g_log);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		emit_error("start", "会话初始化失败: %s", chiaki_error_string(err));
		return;
	}

	chiaki_session_set_event_cb(&g_session, session_event_cb, NULL);
	chiaki_session_set_video_sample_cb(&g_session, video_sample_cb, NULL);

	ChiakiAudioSink audio_sink;
	memset(&audio_sink, 0, sizeof(audio_sink));
	audio_sink.user = NULL;
	audio_sink.header_cb = audio_header_cb;
	audio_sink.frame_cb = audio_frame_cb;
	chiaki_session_set_audio_sink(&g_session, &audio_sink);

	emit_event("connecting");

	err = chiaki_session_start(&g_session);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		emit_error("start", "会话启动失败: %s", chiaki_error_string(err));
		chiaki_session_fini(&g_session);
		return;
	}

	pthread_mutex_lock(&g_session_mutex);
	g_session_live = true;
	pthread_mutex_unlock(&g_session_mutex);

	pthread_t reaper;
	if(pthread_create(&reaper, NULL, session_reaper, NULL) == 0)
		pthread_detach(reaper);
	else
		emit_error("start", "无法创建会话回收线程");
}

static void cmd_stop(void)
{
	pthread_mutex_lock(&g_session_mutex);
	bool live = g_session_live;
	if(live)
		chiaki_session_stop(&g_session);
	pthread_mutex_unlock(&g_session_mutex);

	if(live)
		emit_event("stopping");
	else
		emit_event("stopped");
}

static void cmd_pin(json_object *req)
{
	char pin[16] = "";
	if(!json_get_str(req, "pin", pin, sizeof(pin)) || !pin[0])
	{
		emit_error("pin", "缺少 pin");
		return;
	}
	pthread_mutex_lock(&g_session_mutex);
	ChiakiErrorCode err = CHIAKI_ERR_UNKNOWN;
	if(g_session_live)
		err = chiaki_session_set_login_pin(&g_session, (const uint8_t *)pin, strlen(pin));
	pthread_mutex_unlock(&g_session_mutex);

	if(err != CHIAKI_ERR_SUCCESS)
		emit_error("pin", "PIN 提交失败: %s", chiaki_error_string(err));
	else
		emit_event("pin_accepted");
}

static void cmd_pair(json_object *req)
{
	if(g_pair_running)
	{
		emit_error("pair", "已在配对中");
		return;
	}

	char host[SESSION_HOST_MAX] = "";
	char pin_str[16] = "";
	char account[64] = "";
	if(!json_get_str(req, "host", host, sizeof(host)) || !host[0])
	{
		emit_error("pair", "缺少 host");
		return;
	}
	if(!json_get_str(req, "pin", pin_str, sizeof(pin_str)) || !pin_str[0])
	{
		emit_error("pair", "缺少 PIN（PS5 上「设置 → 系统 → 远程游玩 → 关联设备」显示的 8 位数字）");
		return;
	}
	if(!json_get_str(req, "accountId", account, sizeof(account)) || !account[0])
	{
		emit_error("pair", "缺少 PSN Account-ID");
		return;
	}

	PairJob *job = (PairJob *)calloc(1, sizeof(PairJob));
	if(!job)
	{
		emit_error("pair", "内存不足");
		return;
	}

	job->pin = (uint32_t)strtoul(pin_str, NULL, 10);
	job->ps5 = json_get_bool(req, "ps5", true);

	int n = b64_decode(account, job->account_id, sizeof(job->account_id));
	if(n != CHIAKI_PSN_ACCOUNT_ID_SIZE)
	{
		emit_error("pair", "PSN Account-ID 必须是 8 字节的 base64（当前解出 %d 字节）", n);
		free(job);
		return;
	}

	snprintf(g_pair_host, sizeof(g_pair_host), "%s", host);
	emit_event("pairing");

	pthread_mutex_lock(&g_pair_mutex);
	g_pair_running = true;
	pthread_mutex_unlock(&g_pair_mutex);

	pthread_t t;
	if(pthread_create(&t, NULL, pair_thread, job) == 0)
		pthread_detach(t);
	else
	{
		g_pair_running = false;
		free(job);
		emit_error("pair", "无法创建配对线程");
	}
}

static void cmd_discover(json_object *req)
{
	if(g_discover_running)
	{
		emit_error("discover", "发现已在进行中");
		return;
	}
	g_discover_running = true;
	g_discover_cancel = false;

	int duration = json_get_int(req, "durationMs", 3000);
	if(duration < 500) duration = 500;
	if(duration > 15000) duration = 15000;

	pthread_t t;
	if(pthread_create(&t, NULL, discover_thread, (void *)(uintptr_t)duration) == 0)
		pthread_detach(t);
	else
	{
		g_discover_running = false;
		emit_error("discover", "无法创建发现线程");
	}
}

static void cmd_wake(json_object *req)
{
	char host[SESSION_HOST_MAX] = "";
	char key_hex[64] = "";
	if(!json_get_str(req, "host", host, sizeof(host)) || !host[0])
	{
		emit_error("wake", "缺少 host");
		return;
	}

	uint8_t key[CHIAKI_SESSION_AUTH_SIZE];
	memset(key, 0, sizeof(key));
	if(json_get_str(req, "registKey", key_hex, sizeof(key_hex)))
		parse_hex_exact(key_hex, key, sizeof(key));

	/* chiaki 的 WAKEUP 包里 user-credential 是十进制整数。
	 * 上游 GUI 把 regist key 当作 ASCII 十六进制串解析；这里两种都兼容：
	 * 若 16 字节全是可打印十六进制字符，按字符串解析，否则取前 8 字节大端。 */
	uint64_t credential = 0;
	bool ascii_hex = true;
	for(size_t i = 0; i < sizeof(key); i++)
	{
		if(key[i] == 0)
			break;
		if(!((key[i] >= '0' && key[i] <= '9') || (key[i] >= 'a' && key[i] <= 'f')
				|| (key[i] >= 'A' && key[i] <= 'F')))
		{
			ascii_hex = false;
			break;
		}
	}
	if(ascii_hex && key[0])
	{
		char tmp[CHIAKI_SESSION_AUTH_SIZE + 1];
		memcpy(tmp, key, sizeof(key));
		tmp[sizeof(key)] = '\0';
		credential = strtoull(tmp, NULL, 16);
	}
	else
	{
		for(size_t i = 0; i < 8; i++)
			credential = (credential << 8) | key[i];
	}

	bool ps5 = json_get_bool(req, "ps5", true);
	ChiakiErrorCode err = chiaki_discovery_wakeup(&g_log, NULL, host, credential, ps5);
	if(err != CHIAKI_ERR_SUCCESS)
		emit_error("wake", "唤醒包发送失败: %s", chiaki_error_string(err));
	else
		emit_event("wake_sent");
}

static void cmd_idr(void)
{
	pthread_mutex_lock(&g_session_mutex);
	ChiakiErrorCode err = CHIAKI_ERR_UNKNOWN;
	if(g_session_live)
		err = chiaki_session_request_idr(&g_session);
	pthread_mutex_unlock(&g_session_mutex);

	if(err != CHIAKI_ERR_SUCCESS)
		emit_error("idr", "请求关键帧失败: %s", chiaki_error_string(err));
}

static void cmd_go_home(void)
{
	pthread_mutex_lock(&g_session_mutex);
	ChiakiErrorCode err = CHIAKI_ERR_UNKNOWN;
	if(g_session_live)
		err = chiaki_session_go_home(&g_session);
	pthread_mutex_unlock(&g_session_mutex);

	if(err != CHIAKI_ERR_SUCCESS)
		emit_error("home", "发送失败: %s", chiaki_error_string(err));
}

/* 让主机进入待机（PS5 的 Rest Mode） */
static void cmd_goto_bed(void)
{
	pthread_mutex_lock(&g_session_mutex);
	ChiakiErrorCode err = CHIAKI_ERR_UNKNOWN;
	if(g_session_live)
		err = chiaki_session_goto_bed(&g_session);
	pthread_mutex_unlock(&g_session_mutex);

	if(err != CHIAKI_ERR_SUCCESS)
		emit_error("sleep", "发送待机命令失败: %s", chiaki_error_string(err));
	else
		emit_event("sleep_sent");
}

static void handle_command(const char *text)
{
	json_object *req = json_tokener_parse(text);
	if(!req)
	{
		emit_error("parse", "JSON 解析失败");
		return;
	}

	const char *cmd = json_get_cstr(req, "cmd");
	if(!cmd)
	{
		emit_error("parse", "缺少 cmd 字段");
		json_object_put(req);
		return;
	}

	if(!strcmp(cmd, "ping"))
		emit_event("pong");
	else if(!strcmp(cmd, "version"))
	{
		json_object *o = json_object_new_object();
		json_object_object_add(o, "ev", json_object_new_string("version"));
		json_object_object_add(o, "bridge", json_object_new_string(BRIDGE_VERSION));
		json_object_object_add(o, "chiaki", json_object_new_string("1.10.1"));
		json_send(o);
	}
	else if(!strcmp(cmd, "discover"))
		cmd_discover(req);
	else if(!strcmp(cmd, "discover_cancel"))
		g_discover_cancel = true;
	else if(!strcmp(cmd, "pair"))
		cmd_pair(req);
	else if(!strcmp(cmd, "wake"))
		cmd_wake(req);
	else if(!strcmp(cmd, "start"))
		cmd_start(req);
	else if(!strcmp(cmd, "stop"))
		cmd_stop();
	else if(!strcmp(cmd, "pin"))
		cmd_pin(req);
	else if(!strcmp(cmd, "idr"))
		cmd_idr();
	else if(!strcmp(cmd, "home"))
		cmd_go_home();
	else if(!strcmp(cmd, "sleep"))
		cmd_goto_bed();
	else if(!strcmp(cmd, "exit"))
	{
		json_object_put(req);
		cmd_stop();
		sleep(1);
		exit(0);
	}
	else
		emit_error("parse", "未知命令: %s", cmd);

	json_object_put(req);
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

static bool read_fully(void *dst, size_t len)
{
	uint8_t *p = (uint8_t *)dst;
	size_t off = 0;
	while(off < len)
	{
		ssize_t n = read(STDIN_FILENO, p + off, len - off);
		if(n < 0)
		{
			if(errno == EINTR)
				continue;
			return false;
		}
		if(n == 0)
			return false;
		off += (size_t)n;
	}
	return true;
}

int main(int argc, char **argv)
{
	(void)argc;
	(void)argv;

	ps5web_proto_init();
	chiaki_lib_init();

	uint32_t mask = CHIAKI_LOG_VERBOSE | CHIAKI_LOG_INFO | CHIAKI_LOG_WARNING | CHIAKI_LOG_ERROR;
	const char *level = getenv("PS5WEB_LOG_LEVEL");
	if(level && !strcmp(level, "debug"))
		mask = CHIAKI_LOG_ALL;
	else if(level && !strcmp(level, "error"))
		mask = CHIAKI_LOG_ERROR;

	chiaki_log_init(&g_log, mask, log_cb, NULL);
	emit_event("ready");

	uint8_t header[5];
	while(read_fully(header, sizeof(header)))
	{
		uint8_t type = header[0];
		size_t len = ((size_t)header[1] << 24) | ((size_t)header[2] << 16)
				| ((size_t)header[3] << 8) | (size_t)header[4];

		if(len > MAX_JSON_SIZE)
			break;

		uint8_t *buf = (uint8_t *)malloc(len + 1);
		if(!buf)
			break;
		if(!read_fully(buf, len))
		{
			free(buf);
			break;
		}
		buf[len] = '\0';

		if(type == PS5WEB_MSG_JSON)
			handle_command((const char *)buf);
		else if(type == PS5WEB_MSG_INPUT)
			handle_input(buf, len);

		free(buf);
	}

	/* 父进程关闭了 stdin：干净退出 */
	cmd_stop();
	return 0;
}

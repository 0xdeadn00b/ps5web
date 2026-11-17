// SPDX-License-Identifier: AGPL-3.0-only
//
// ps5web 服务端：HTTP 静态页 + JSON API + WebSocket 码流通道。
// 一个公网端口就能跑通（适合 frp / nginx 反代），不依赖 UDP 打洞。

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { config } from './config.js';
import { engine } from './engine.js';
import { log, recentLogs } from './logger.js';
import { addHost, getHost, listHosts, publicHost, removeHost, updateHost } from './store.js';
import { WsConnection } from './ws.js';

/* ------------------------------------------------------------------ */
/* 认证                                                                */
/* ------------------------------------------------------------------ */

const COOKIE_NAME = 'ps5web_token';

// 访客自动开播的全局限流时刻
let lastWatchStart = 0;

function sign(exp) {
	return createHmac('sha256', config.secret).update(String(exp)).digest('base64url');
}

function makeToken() {
	const exp = Date.now() + config.tokenTtlMs;
	return `${exp}.${sign(exp)}`;
}

function verifyToken(token) {
	if (!token || typeof token !== 'string') return false;
	const idx = token.lastIndexOf('.');
	if (idx <= 0) return false;
	const exp = Number(token.slice(0, idx));
	const sig = token.slice(idx + 1);
	if (!Number.isFinite(exp) || exp < Date.now()) return false;
	const expected = sign(exp);
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

function passwordMatches(input) {
	const a = createHash('sha256').update(String(input)).digest();
	const b = createHash('sha256').update(String(config.password)).digest();
	return timingSafeEqual(a, b);
}

function parseCookies(header) {
	const out = {};
	if (!header) return out;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
	}
	return out;
}

function isAuthed(req) {
	const cookies = parseCookies(req.headers.cookie);
	return verifyToken(cookies[COOKIE_NAME]);
}

const loginAttempts = new Map();

function tooManyAttempts(ip) {
	const rec = loginAttempts.get(ip);
	if (!rec) return false;
	if (Date.now() > rec.resetAt) {
		loginAttempts.delete(ip);
		return false;
	}
	return rec.count >= 10;
}

function noteFailedAttempt(ip) {
	const rec = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 10 * 60_000 };
	rec.count++;
	loginAttempts.set(ip, rec);
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
	let rel = pathname === '/' ? '/index.html' : pathname;
	rel = decodeURIComponent(rel);

	const full = path.join(config.webDir, path.normalize(rel));
	if (!full.startsWith(path.resolve(config.webDir))) {
		res.writeHead(403).end('forbidden');
		return;
	}

	fs.readFile(full, (err, data) => {
		if (err) {
			// 前端是单页应用，未知路径回落到 index.html
			if (!path.extname(rel)) {
				fs.readFile(path.join(config.webDir, 'index.html'), (e2, html) => {
					if (e2) res.writeHead(404).end('not found');
					else res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
				});
				return;
			}
			res.writeHead(404).end('not found');
			return;
		}

		const ext = path.extname(full).toLowerCase();
		res.writeHead(200, {
			'Content-Type': MIME[ext] || 'application/octet-stream',
			'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
		});
		res.end(data);
	});
}

/* ------------------------------------------------------------------ */
/* HTTP 帮助函数                                                       */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	});
	res.end(body);
}

function readJsonBody(req, limit = 1024 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > limit) {
				reject(new Error('请求体过大'));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			if (!chunks.length) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				reject(new Error('JSON 解析失败'));
			}
		});
		req.on('error', reject);
	});
}

function clientIp(req) {
	if (config.trustProxy) {
		const fwd = req.headers['x-forwarded-for'];
		if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
	}
	return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
	if (req.socket.encrypted) return true;
	if (config.trustProxy) {
		const proto = req.headers['x-forwarded-proto'];
		if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
	}
	return false;
}

/* ------------------------------------------------------------------ */
/* API 路由                                                            */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
	const { pathname } = url;
	const method = req.method || 'GET';

	// ---- 登录相关（无需鉴权） ----
	if (pathname === '/api/login' && method === 'POST') {
		const ip = clientIp(req);
		if (tooManyAttempts(ip)) {
			sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' });
			return true;
		}

		let body;
		try {
			body = await readJsonBody(req, 4096);
		} catch (err) {
			sendJson(res, 400, { error: err.message });
			return true;
		}

		if (!passwordMatches(body.password || '')) {
			noteFailedAttempt(ip);
			log.warn(`登录失败: ${ip}`);
			sendJson(res, 401, { error: '密码错误' });
			return true;
		}

		loginAttempts.delete(ip);
		const token = makeToken();
		const cookie = [
			`${COOKIE_NAME}=${token}`,
			'Path=/',
			'HttpOnly',
			'SameSite=Lax',
			`Max-Age=${Math.floor(config.tokenTtlMs / 1000)}`,
		];
		if (isHttps(req)) cookie.push('Secure');
		res.setHeader('Set-Cookie', cookie.join('; '));
		log.info(`登录成功: ${ip}`);
		sendJson(res, 200, { ok: true });
		return true;
	}

	if (pathname === '/api/logout' && method === 'POST') {
		res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0`);
		sendJson(res, 200, { ok: true });
		return true;
	}

	if (pathname === '/api/public') {
		sendJson(res, 200, {
			version: config.version,
			chiakiVersion: config.chiakiVersion,
			needsLogin: true,
		});
		return true;
	}

	// ---- 观战（无需登录，只读） ----
	if (pathname === '/api/live') {
		const st = engine.getStatus();
		sendJson(res, 200, {
			version: config.version,
			state: st.state,
			current: st.current
				? { name: st.current.name, nickname: st.current.nickname || null }
				: null,
			viewers: st.viewers,
			canStart: listHosts().some((h) => h.registKey && h.rpKey),
		});
		return true;
	}

	// 开播（唤醒 PS5）是控制行为，必须有密码；匿名观众只能看已经在播的会话
	if (pathname === '/api/watch/start' && method === 'POST') {
		if (!isAuthed(req)) {
			sendJson(res, 401, { error: '唤醒主机需要密码' });
			return true;
		}
		if (engine.state === 'streaming' || engine.state === 'connecting') {
			sendJson(res, 200, { session: engine.getStatus() });
			return true;
		}
		if (Date.now() - lastWatchStart < 30_000) {
			sendJson(res, 429, { error: '刚有人试过开播，请让主机缓一缓，30 秒后再刷新' });
			return true;
		}
		const host = listHosts().find((h) => h.registKey && h.rpKey);
		if (!host) {
			sendJson(res, 409, { error: '房主还没有配对 PS5，暂时没得看' });
			return true;
		}
		lastWatchStart = Date.now();
		log.info(`访客自动开播: ${host.name}`);
		try {
			const status = await engine.start(host, {});
			sendJson(res, 200, { session: status });
		} catch (err) {
			sendJson(res, 409, { error: err.message });
		}
		return true;
	}

	// ---- 以下都需要登录 ----
	if (!isAuthed(req)) {
		sendJson(res, 401, { error: '未登录' });
		return true;
	}

	if (pathname === '/api/state' && method === 'GET') {
		sendJson(res, 200, {
			version: config.version,
			chiakiVersion: config.chiakiVersion,
			hosts: listHosts().map(publicHost),
			session: engine.getStatus(),
			defaults: config.video,
		});
		return true;
	}

	if (pathname === '/api/logs' && method === 'GET') {
		const after = Number(url.searchParams.get('after') || 0);
		sendJson(res, 200, { logs: recentLogs(after) });
		return true;
	}

	if (pathname === '/api/discover' && method === 'POST') {
		if (engine.state === 'streaming' || engine.state === 'connecting') {
			sendJson(res, 409, { error: '串流进行中，无法扫描' });
			return true;
		}
		try {
			const hosts = await engine.discover(3000);
			sendJson(res, 200, { hosts });
		} catch (err) {
			sendJson(res, 500, { error: err.message });
		}
		return true;
	}

	if (pathname === '/api/hosts' && method === 'POST') {
		const body = await readJsonBody(req);
		const address = String(body.address || '').trim();
		if (!address) {
			sendJson(res, 400, { error: '缺少 IP 地址' });
			return true;
		}
		const host = addHost({
			name: String(body.name || '').trim() || address,
			address,
			ps5: body.ps5 !== false,
		});
		sendJson(res, 200, { host: publicHost(host) });
		return true;
	}

	const hostMatch = pathname.match(/^\/api\/hosts\/([0-9a-f]+)(\/[a-z]+)?$/);
	if (hostMatch) {
		const host = getHost(hostMatch[1]);
		const action = hostMatch[2] || '';
		if (!host) {
			sendJson(res, 404, { error: '主机不存在' });
			return true;
		}

		if (method === 'DELETE' && !action) {
			if (engine.current && engine.current.hostId === host.id) {
				sendJson(res, 409, { error: '该主机正在串流，先停止会话' });
				return true;
			}
			removeHost(host.id);
			sendJson(res, 200, { ok: true });
			return true;
		}

		if (method === 'PATCH' && !action) {
			const body = await readJsonBody(req);
			if (body.name) updateHost(host.id, { name: String(body.name).slice(0, 40) });
			sendJson(res, 200, { host: publicHost(getHost(host.id)) });
			return true;
		}

		if (method === 'POST' && action === '/pair') {
			const body = await readJsonBody(req);
			const pin = String(body.pin || '').trim();
			const accountId = String(body.accountId || '').trim();

			if (!/^\d{5,10}$/.test(pin)) {
				sendJson(res, 400, { error: 'PIN 应为 PS5 上显示的 8 位数字' });
				return true;
			}
			if (!accountId) {
				sendJson(res, 400, { error: '缺少 PSN Account-ID' });
				return true;
			}
			if (engine.state === 'streaming' || engine.state === 'connecting') {
				sendJson(res, 409, { error: '串流进行中，无法配对' });
				return true;
			}

			try {
				const info = await engine.pair({
					address: host.address,
					pin,
					accountId,
					ps5: host.ps5,
				});
				updateHost(host.id, {
					registKey: info.registKey || '',
					rpKey: info.rpKey || '',
					mac: info.mac || '',
					lastPairedAt: Date.now(),
					ps5: info.ps5 !== undefined ? !!info.ps5 : host.ps5,
					name: host.name === host.address && info.nickname ? info.nickname : host.name,
				});
				log.info(`配对成功: ${host.address}${info.nickname ? ' (' + info.nickname + ')' : ''}`);
				sendJson(res, 200, { host: publicHost(getHost(host.id)) });
			} catch (err) {
				sendJson(res, 502, { error: err.message });
			}
			return true;
		}

		if (method === 'POST' && action === '/wake') {
			engine.wake(host);
			sendJson(res, 200, { ok: true });
			return true;
		}

		sendJson(res, 405, { error: '不支持的操作' });
		return true;
	}

	if (pathname === '/api/session/start' && method === 'POST') {
		const body = await readJsonBody(req);
		const host = getHost(String(body.hostId || ''));
		if (!host) {
			sendJson(res, 404, { error: '主机不存在' });
			return true;
		}
		if (!host.registKey || !host.rpKey) {
			sendJson(res, 400, { error: '这台主机还没有配对（先点「配对」）' });
			return true;
		}

		try {
			const status = await engine.start(host, body);
			sendJson(res, 200, { session: status });
		} catch (err) {
			sendJson(res, 409, { error: err.message });
		}
		return true;
	}

	if (pathname === '/api/session/stop' && method === 'POST') {
		engine.stop();
		sendJson(res, 200, { ok: true });
		return true;
	}

	if (pathname === '/api/session/pin' && method === 'POST') {
		const body = await readJsonBody(req);
		engine.sendPin(String(body.pin || ''));
		sendJson(res, 200, { ok: true });
		return true;
	}

	if (pathname === '/api/session/idr' && method === 'POST') {
		engine.requestIdr();
		sendJson(res, 200, { ok: true });
		return true;
	}

	if (pathname === '/api/session/home' && method === 'POST') {
		engine.requestHome();
		sendJson(res, 200, { ok: true });
		return true;
	}

	if (pathname === '/api/session/sleep' && method === 'POST') {
		if (engine.state !== 'streaming' && engine.state !== 'connecting') {
			sendJson(res, 409, { error: '没有进行中的会话，无法让主机待机' });
			return true;
		}
		engine.requestSleep();
		sendJson(res, 200, { ok: true });
		return true;
	}

	sendJson(res, 404, { error: '未知接口' });
	return true;
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

function handleUpgrade(req, socket) {
	const url = new URL(req.url, 'http://localhost');

	if (url.pathname !== '/ws') {
		socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
		socket.destroy();
		return;
	}

	// 观看谁都可以（匿名 = 只读）；发输入和控制指令需要登录
	const conn = WsConnection.accept(req, socket);
	if (!conn) return;
	conn.control = isAuthed(req);

	engine.addViewer(conn);

	conn.on('message', (data, isBinary) => {
		if (isBinary) {
			// [0x01][28 字节手柄状态]
			if (!conn.control) return;
			if (data.length === 29 && data[0] === 0x01) {
				engine.sendInput(data.subarray(1));
			}
			return;
		}

		let msg;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}

		switch (msg.t) {
			case 'ping':
				// 回传客户端发送时刻（算 RTT）+ 服务端当前时间（算时钟偏移）
				conn.send(JSON.stringify({ t: 'pong', echo: msg.ts, now: Date.now() }));
				break;
			case 'chat': {
				// 弹幕：匿名也能发，每连接 2 秒 1 条 + 每小时 300 条
				const now = Date.now();
				conn.chatHistory = (conn.chatHistory || []).filter((t) => now - t < 3600_000);
				if (conn.lastChatAt && now - conn.lastChatAt < 2000) {
					conn.send(JSON.stringify({ t: 'chat_reject', reason: 'slow' }));
					break;
				}
				if (conn.chatHistory.length >= 300) {
					conn.send(JSON.stringify({ t: 'chat_reject', reason: 'limit' }));
					break;
				}
				conn.lastChatAt = now;
				conn.chatHistory.push(now);
				engine.chat(msg.name, msg.text);
				break;
			}
			case 'idr':
				engine.requestIdr();
				break;
			case 'pin':
				if (!conn.control) break;
				engine.sendPin(String(msg.pin || ''));
				break;
			case 'diag':
				log.info('[diag]', JSON.stringify(msg));
				break;

			case 'stop':
				if (!conn.control) break;
				engine.stop();
				break;
			case 'stats':
				conn.send(JSON.stringify({ t: 'state', session: engine.getStatus() }));
				break;
			default:
				break;
		}
	});

	conn.on('close', () => engine.removeViewer(conn));
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const handler = async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('Referrer-Policy', 'no-referrer');
	res.setHeader(
		'Content-Security-Policy',
		"default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
			"style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; " +
			"frame-ancestors 'none'"
	);

	try {
		if (url.pathname.startsWith('/api/')) {
			await handleApi(req, res, url);
			return;
		}

		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405).end('method not allowed');
			return;
		}

		serveStatic(req, res, url.pathname);
	} catch (err) {
		log.error('请求处理失败:', err.message);
		if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
		else res.end();
	}
};

/* 有证书就直接上 HTTPS：WebCodecs / Gamepad 需要安全上下文 */
const useTls = Boolean(config.tlsCert && config.tlsKey);

let server;
if (useTls) {
	try {
		server = https.createServer(
			{ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) },
			handler
		);
	} catch (err) {
		log.error('读取 TLS 证书失败，回退到 HTTP:', err.message);
		server = http.createServer(handler);
	}
} else {
	server = http.createServer(handler);
}

const isTls = server instanceof https.Server;

server.on('upgrade', handleUpgrade);

server.listen(config.port, config.host, () => {
	const scheme = isTls ? 'https' : 'http';
	log.info(`ps5web ${config.version} 已启动: ${scheme}://${config.host}:${config.port}`);
	log.info(`chiaki-ng lib: ${config.chiakiVersion} / 数据目录: ${config.dataDir}`);

	if (!isTls) {
		log.warn(
			'当前是 HTTP。WebCodecs（视频解码）和 Gamepad（手柄）只在 HTTPS 或 localhost 下可用，' +
				'直接用 http://内网IP 打开会黑屏、认不到手柄。生产环境请用 nginx/caddy 反代加 TLS，' +
				'或设置 PS5WEB_TLS_CERT / PS5WEB_TLS_KEY 让本服务自己上 HTTPS。'
		);
	}

	if (config.passwordGenerated) {
		const line = `初始登录密码: ${config.password}`;
		log.info('='.repeat(46));
		log.info(line);
		log.info(`已写入 ${path.join(config.dataDir, 'config.json')}（可用 PS5WEB_PASSWORD 覆盖）`);
		log.info('='.repeat(46));
	}

	const known = listHosts();
	if (known.length) log.info(`已保存 ${known.length} 台主机`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		log.info(`收到 ${signal}，退出`);
		engine.bridge.stop();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000).unref();
	});
}

process.on('unhandledRejection', (err) => {
	log.error('未处理的 Promise 异常:', err?.message || String(err));
});

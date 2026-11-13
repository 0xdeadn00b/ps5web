// SPDX-License-Identifier: AGPL-3.0-only
//
// 运行时配置。全部可以用环境变量覆盖，Docker 里就是 compose 的 environment。

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.PS5WEB_DATA || path.resolve(process.cwd(), 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/**
 * 首次启动时生成一份本地配置（随机密码 + 签名密钥），
 * 避免出现「默认密码暴露公网」的情况。
 */
function loadPersistentConfig() {
	let cfg = {};
	try {
		cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
	} catch {
		cfg = {};
	}

	let dirty = false;

	if (!cfg.secret || typeof cfg.secret !== 'string' || cfg.secret.length < 32) {
		cfg.secret = randomBytes(32).toString('hex');
		dirty = true;
	}

	if (!cfg.password || typeof cfg.password !== 'string') {
		// 去掉容易混淆的字符，方便手输
		const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
		const bytes = randomBytes(10);
		let pwd = '';
		for (const b of bytes) pwd += alphabet[b % alphabet.length];
		cfg.password = pwd;
		dirty = true;
		cfg.generatedPassword = true;
	}

	if (dirty) {
		try {
			fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
		} catch (err) {
			console.error('[config] 无法写入', CONFIG_FILE, err.message);
		}
	}

	return cfg;
}

const persistent = loadPersistentConfig();

const envPassword = (process.env.PS5WEB_PASSWORD || '').trim();

export const config = {
	dataDir: DATA_DIR,
	webDir: process.env.PS5WEB_WEB_DIR || path.resolve(HERE, '../../web'),

	port: Number(process.env.PS5WEB_PORT || 8080),
	host: process.env.PS5WEB_HOST || '0.0.0.0',

	// 登录密码：环境变量优先，其次用 data/config.json 里生成的那个
	password: envPassword || persistent.password,
	passwordGenerated: !envPassword && persistent.generatedPassword === true,
	secret: persistent.secret,

	// 会话令牌有效期
	tokenTtlMs: Number(process.env.PS5WEB_TOKEN_TTL_DAYS || 30) * 24 * 3600 * 1000,

	bridgePath: process.env.PS5WEB_BRIDGE || '/usr/local/bin/ps5web-bridge',
	bridgeLogLevel: process.env.PS5WEB_LOG_LEVEL || 'info',

	// 可选：直接由本服务提供 HTTPS。
	// 不填就让 nginx / caddy / frp 在前面做 TLS。
	// 注意 WebCodecs 和 Gamepad API 只在 https 或 localhost 下可用。
	tlsCert: process.env.PS5WEB_TLS_CERT || '',
	tlsKey: process.env.PS5WEB_TLS_KEY || '',

	// 串流默认档位（前端可以覆盖）
	video: {
		resolution: process.env.PS5WEB_RESOLUTION || '1080p',
		fps: Number(process.env.PS5WEB_FPS || 60),
		bitrate: Number(process.env.PS5WEB_BITRATE || 18000),
		codec: process.env.PS5WEB_CODEC || 'h264',
	},

	// 认为客户端是 HTTPS 的时候（反代）才给 cookie 加 Secure
	trustProxy: process.env.PS5WEB_TRUST_PROXY !== '0',

	logLevel: process.env.PS5WEB_LOG_LEVEL || 'info',
	version: '1.0.2',
	chiakiVersion: '1.10.1',
};

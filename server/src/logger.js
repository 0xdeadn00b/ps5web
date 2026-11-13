// SPDX-License-Identifier: AGPL-3.0-only
//
// 极简日志：控制台 + 内存环形缓冲（前端「日志」面板用）。

import { config } from './config.js';

const LEVELS = { debug: 10, verbose: 15, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[config.logLevel] ?? LEVELS.info;
const RING_MAX = 300;

const ring = [];
let seq = 0;

function push(level, args) {
	const text = args
		.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
		.join(' ');
	const entry = { id: ++seq, ts: Date.now(), level, text };
	ring.push(entry);
	if (ring.length > RING_MAX) ring.shift();

	if ((LEVELS[level] ?? 20) >= THRESHOLD) {
		const line = `[${new Date(entry.ts).toISOString().slice(11, 23)}] ${level.toUpperCase().padEnd(5)} ${text}`;
		if (level === 'error') console.error(line);
		else if (level === 'warn') console.warn(line);
		else console.log(line);
	}
}

export const log = {
	debug: (...a) => push('debug', a),
	verbose: (...a) => push('verbose', a),
	info: (...a) => push('info', a),
	warn: (...a) => push('warn', a),
	error: (...a) => push('error', a),
};

export function recentLogs(afterId = 0) {
	return ring.filter((e) => e.id > afterId);
}

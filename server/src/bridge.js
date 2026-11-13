// SPDX-License-Identifier: AGPL-3.0-only
//
// 桥接子进程封装：stdin 发命令 / stdout 收分帧消息。

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { config } from './config.js';
import { log } from './logger.js';

export const MSG = { JSON: 1, INPUT: 2, VIDEO: 3, AUDIO: 4 };

export class Bridge extends EventEmitter {
	constructor(binPath = config.bridgePath) {
		super();
		this.binPath = binPath;
		this.proc = null;
		this.buf = Buffer.alloc(0);
		this.alive = false;
	}

	start() {
		if (this.proc) return true;

		log.info(`启动桥接进程: ${this.binPath}`);
		let proc;
		try {
			// .js 结尾的走 node 执行（开发时的 mock-bridge）
			const isJs = this.binPath.endsWith('.js');
			proc = spawn(isJs ? process.execPath : this.binPath, isJs ? [this.binPath] : [], {
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env, PS5WEB_LOG_LEVEL: config.bridgeLogLevel },
			});
		} catch (err) {
			log.error('无法启动桥接进程:', err.message);
			return false;
		}

		this.proc = proc;
		this.alive = true;
		this.buf = Buffer.alloc(0);

		proc.stdout.on('data', (chunk) => this.#onData(chunk));
		proc.stderr.on('data', (chunk) => {
			const text = chunk.toString('utf8').trim();
			if (text) log.warn('[bridge]', text);
		});
		proc.stdin.on('error', () => {});

		proc.on('error', (err) => {
			log.error('桥接进程出错:', err.message);
			this.#onExit();
		});

		proc.on('exit', (code, signal) => {
			log.warn(`桥接进程退出 (code=${code} signal=${signal})`);
			this.#onExit();
		});

		return true;
	}

	#onExit() {
		if (!this.alive && !this.proc) return;
		this.alive = false;
		this.proc = null;
		this.buf = Buffer.alloc(0);
		this.emit('exit');
	}

	#onData(chunk) {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

		for (;;) {
			if (this.buf.length < 5) return;
			const type = this.buf[0];
			const len = this.buf.readUInt32BE(1);
			if (this.buf.length < 5 + len) return;

			const payload = this.buf.subarray(5, 5 + len);
			this.buf = this.buf.subarray(5 + len);

			if (type === MSG.JSON) {
				let obj;
				try {
					obj = JSON.parse(payload.toString('utf8'));
				} catch {
					continue;
				}
				this.emit('json', obj);
			} else if (type === MSG.VIDEO) {
				this.emit('video', payload);
			} else if (type === MSG.AUDIO) {
				this.emit('audio', payload);
			}
		}
	}

	#frame(type, payload) {
		if (!this.proc || !this.alive) return false;

		const header = Buffer.allocUnsafe(5);
		header[0] = type;
		header.writeUInt32BE(payload.length, 1);

		try {
			this.proc.stdin.write(header);
			this.proc.stdin.write(payload);
			return true;
		} catch (err) {
			log.warn('写入桥接进程失败:', err.message);
			return false;
		}
	}

	json(obj) {
		if (!this.proc) this.start();
		return this.#frame(MSG.JSON, Buffer.from(JSON.stringify(obj), 'utf8'));
	}

	input(buf) {
		if (buf.length !== 28) return false;
		return this.#frame(MSG.INPUT, buf);
	}

	stop() {
		const proc = this.proc;
		if (!proc) return;
		try {
			proc.stdin.end();
		} catch {
			/* ignore */
		}
		const timer = setTimeout(() => {
			try {
				proc.kill('SIGKILL');
			} catch {
				/* ignore */
			}
		}, 2000);
		timer.unref?.();
	}
}

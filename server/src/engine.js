// SPDX-License-Identifier: AGPL-3.0-only
//
// 会话引擎：持有桥接进程 + 把码流转发给浏览器。
// 同一时间只允许一个 PS5 会话（主机本身也只能被一个客户端占用）。

import { EventEmitter } from 'node:events';
import net from 'node:net';

import { Bridge } from './bridge.js';
import { config } from './config.js';
import { log } from './logger.js';

const OP_VIDEO = 0x10;
const OP_AUDIO = 0x11;

const CONNECT_TIMEOUT_MS = 45_000;
const VIEWER_DROP_BUFFER = 3 * 1024 * 1024;

class Engine extends EventEmitter {
	constructor() {
		super();

		/** @type {Set<any>} */
		this.viewers = new Set();

		this.state = 'idle'; // idle | discovering | pairing | connecting | streaming
		this.current = null; // { hostId, name, nickname }
		this.discovered = [];
		this.audioFormat = null;
		this.lastError = null;

		this.pendingDiscover = null;
		this.pendingPair = null;
		this.connectTimer = null;

		this.stats = { frames: 0, bytes: 0, fps: 0, kbps: 0 };

		this.bridge = new Bridge();
		this.bridge.on('json', (o) => this.#onBridgeJson(o));
		this.bridge.on('video', (p) => this.#onVideo(p));
		this.bridge.on('audio', (p) => this.#onAudio(p));
		this.bridge.on('exit', () => this.#onBridgeExit());

		this.#startStatsTimer();
	}

	/* ---------------- 对外状态 ---------------- */

	getStatus() {
		return {
			state: this.state,
			current: this.current,
			audio: this.audioFormat,
			lastError: this.lastError,
			viewers: this.viewers.size,
		};
	}

	addViewer(conn) {
		this.viewers.add(conn);
		conn.send(
			JSON.stringify({
				t: 'hello',
				state: this.state,
				current: this.current,
				audio: this.audioFormat,
				config: config.video,
			})
		);
		this.broadcastJson({ t: 'viewers', count: this.viewers.size });
	}

	removeViewer(conn) {
		if (this.viewers.delete(conn)) this.broadcastJson({ t: 'viewers', count: this.viewers.size });
	}

	broadcastJson(obj) {
		if (!this.viewers.size) return;
		const text = JSON.stringify(obj);
		for (const v of this.viewers) {
			try {
				v.send(text);
			} catch {
				/* ignore */
			}
		}
	}

	#setState(state, extra = {}) {
		if (this.state === state && !extra.force) {
			// 状态没变也要把 current 同步给新状态
		}
		this.state = state;
		this.broadcastJson({ t: 'session', state, current: this.current, ...extra });
		this.emit('state', state);
	}

	/* ---------------- 局域网发现 ---------------- */

	discover(durationMs = 3000) {
		if (this.pendingDiscover) return this.pendingDiscover.promise;

		this.discovered = [];

		let resolveFn;
		const promise = new Promise((res) => {
			resolveFn = res;
		});

		const timer = setTimeout(() => this.#finishDiscover(), durationMs + 8000);
		this.pendingDiscover = { promise, resolve: resolveFn, timer };

		this.#setState('discovering');

		if (!this.bridge.json({ cmd: 'discover', durationMs })) {
			this.#finishDiscover();
		}

		return promise;
	}

	#finishDiscover() {
		const pending = this.pendingDiscover;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingDiscover = null;
		pending.resolve(this.discovered);
		if (this.state === 'discovering') this.#setState('idle');
	}

	/* ---------------- 配对 ---------------- */

	pair({ address, pin, accountId, ps5 = true }) {
		if (this.pendingPair) throw new Error('已有配对请求正在进行');

		let resolveFn;
		let rejectFn;
		const promise = new Promise((res, rej) => {
			resolveFn = res;
			rejectFn = rej;
		});

		const timer = setTimeout(() => {
			if (this.pendingPair) {
				this.pendingPair = null;
				this.#setState('idle');
				rejectFn(new Error('配对超时，请确认 PS5 已进入「关联设备」界面'));
			}
		}, 130_000);

		this.pendingPair = { promise, resolve: resolveFn, reject: rejectFn, timer };
		this.#setState('pairing');

		if (!this.bridge.json({ cmd: 'pair', host: address, pin: String(pin), accountId, ps5 })) {
			clearTimeout(timer);
			this.pendingPair = null;
			this.#setState('idle');
			throw new Error('桥接进程不可用');
		}

		return promise;
	}

	/* ---------------- 会话 ---------------- */

	/** 探一下 9295：主机醒着才连得上 */
	#isReachable(address, port = 9295, timeout = 1200) {
		return new Promise((resolve) => {
			const sock = net.connect({ host: address, port });
			const done = (v) => {
				sock.destroy();
				resolve(v);
			};
			sock.setTimeout(timeout, () => done(false));
			sock.on('connect', () => done(true));
			sock.on('error', () => done(false));
		});
	}

	async start(host, opts = {}) {
		if (this.state === 'connecting' || this.state === 'streaming') {
			throw new Error('已经有一个会话在进行中');
		}

		const video = {
			resolution: opts.resolution || config.video.resolution,
			fps: Number(opts.fps || config.video.fps),
			bitrate: Number(opts.bitrate || config.video.bitrate),
			codec: opts.codec || config.video.codec,
		};

		this.current = { hostId: host.id, name: host.name };
		this.audioFormat = null;
		this.lastError = null;
		this.#setState('connecting');

		// 主机在待机时 9295 是关的，先发唤醒包再等一下，别让用户手动点唤醒
		if (!(await this.#isReachable(host.address))) {
			if (!host.registKey) {
				this.#setState('idle');
				throw new Error('主机不在线，而且没有配对凭据，唤不醒');
			}

			log.info(`主机 ${host.address} 不在线，发送唤醒包`);
			this.broadcastJson({ t: 'waking' });
			this.bridge.json({
				cmd: 'wake',
				host: host.address,
				registKey: host.registKey,
				ps5: host.ps5,
			});

			let awake = false;
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 2000));
				if (this.state !== 'connecting') {
					// 期间被取消了
					throw new Error('已取消');
				}
				if (await this.#isReachable(host.address)) {
					awake = true;
					break;
				}
			}

			if (!awake) {
				this.#setState('idle');
				throw new Error('唤醒超时（60 秒）。确认 PS5 电源设置里开了「待机时保持网络连接」');
			}

			log.info('主机已唤醒，开始建立会话');
		}

		const ok = this.bridge.json({
			cmd: 'start',
			host: host.address,
			registKey: host.registKey,
			rpKey: host.rpKey,
			ps5: host.ps5,
			...video,
		});

		if (!ok) {
			this.#setState('idle');
			throw new Error('桥接进程不可用');
		}

		clearTimeout(this.connectTimer);
		this.connectTimer = setTimeout(() => {
			if (this.state === 'connecting') {
				log.warn('连接超时，停止会话');
				this.lastError = '连接 PS5 超时';
				this.stop();
			}
		}, CONNECT_TIMEOUT_MS);

		return this.getStatus();
	}

	stop() {
		clearTimeout(this.connectTimer);
		this.bridge.json({ cmd: 'stop' });
		// 等 session_ended 事件把状态切回 idle
		setTimeout(() => {
			if (this.state === 'connecting' || this.state === 'streaming') {
				this.#setState('idle', { force: true });
				this.current = null;
			}
		}, 4000).unref?.();
	}

	sendPin(pin) {
		return this.bridge.json({ cmd: 'pin', pin: String(pin) });
	}

	requestIdr() {
		return this.bridge.json({ cmd: 'idr' });
	}

	requestHome() {
		return this.bridge.json({ cmd: 'home' });
	}

	/** 让 PS5 进入待机（需要会话在线） */
	requestSleep() {
		return this.bridge.json({ cmd: 'sleep' });
	}

	wake(host) {
		return this.bridge.json({
			cmd: 'wake',
			host: host.address,
			registKey: host.registKey || '',
			ps5: host.ps5,
		});
	}

	sendInput(buf) {
		if (this.state !== 'streaming' && this.state !== 'connecting') return false;
		return this.bridge.input(buf);
	}

	/* ---------------- 桥接事件 ---------------- */

	#onBridgeJson(o) {
		switch (o.ev) {
			case 'ready':
				log.info('桥接进程就绪');
				break;

			case 'log': {
				const msg = `[chiaki] ${o.message}`;
				if (o.level === 'error') log.error(msg);
				else if (o.level === 'warn') log.warn(msg);
				else log.debug(msg);
				break;
			}

			case 'hosts':
				this.discovered = Array.isArray(o.hosts) ? o.hosts : [];
				this.broadcastJson({ t: 'discovered', hosts: this.discovered });
				break;

			case 'discover_done':
				this.#finishDiscover();
				break;

			case 'pairing':
				this.#setState('pairing');
				break;

			case 'pair_ok': {
				const pending = this.pendingPair;
				this.pendingPair = null;
				if (pending) {
					clearTimeout(pending.timer);
					pending.resolve(o.host);
				}
				this.#setState('idle');
				break;
			}

			case 'pair_fail': {
				const pending = this.pendingPair;
				this.pendingPair = null;
				if (pending) {
					clearTimeout(pending.timer);
					pending.reject(new Error(o.reason === 'canceled' ? '配对已取消' : '配对失败'));
				}
				this.#setState('idle');
				break;
			}

			case 'connecting':
				this.#setState('connecting');
				break;

			case 'connected':
				clearTimeout(this.connectTimer);
				log.info('已连接到主机');
				this.#setState('streaming');
				break;

			case 'nickname':
				if (this.current && o.name) this.current = { ...this.current, nickname: o.name };
				this.broadcastJson({ t: 'nickname', name: o.name });
				break;

			case 'audio_format':
				this.audioFormat = {
					channels: o.channels,
					bits: o.bits,
					rate: o.rate,
					frameSize: o.frameSize,
				};
				this.broadcastJson({ t: 'audio', format: this.audioFormat });
				break;

			case 'pin_request':
				this.broadcastJson({ t: 'pin_request', incorrect: !!o.incorrect });
				break;

			case 'pin_accepted':
				this.broadcastJson({ t: 'pin_accepted' });
				break;

			case 'rumble':
				this.broadcastJson({ t: 'rumble', left: o.left, right: o.right });
				break;

			case 'quit':
				clearTimeout(this.connectTimer);
				log.warn(`会话结束: ${o.reason}${o.detail ? ' / ' + o.detail : ''}`);
				this.broadcastJson({ t: 'quit', reason: o.reason, error: !!o.error, detail: o.detail });
				break;

			case 'session_ended':
				clearTimeout(this.connectTimer);
				this.current = null;
				this.audioFormat = null;
				this.#setState('idle');
				break;

			case 'stopping':
			case 'stopped':
				this.broadcastJson({ t: 'stopping' });
				break;

			case 'wake_sent':
				this.broadcastJson({ t: 'wake_sent' });
				break;

			case 'sleep_sent':
				log.info('已请求主机进入待机');
				this.broadcastJson({ t: 'sleep_sent' });
				break;

			case 'error':
				log.error(`桥接层错误 (${o.cmd || '-'}): ${o.message}`);
				this.lastError = o.message;
				this.broadcastJson({ t: 'error', message: o.message, cmd: o.cmd });

				if (o.cmd === 'pair' && this.pendingPair) {
					const pending = this.pendingPair;
					this.pendingPair = null;
					clearTimeout(pending.timer);
					pending.reject(new Error(o.message));
					this.#setState('idle');
				}
				break;

			default:
				log.debug('未处理的桥接事件:', o.ev);
				break;
		}
	}

	#onVideo(payload) {
		if (!this.viewers.size) return;

		this.stats.frames++;
		this.stats.bytes += payload.length;

		const msg = Buffer.allocUnsafe(payload.length + 1);
		msg[0] = OP_VIDEO;
		payload.copy(msg, 1);

		for (const v of this.viewers) {
			if (v.bufferedAmount > VIEWER_DROP_BUFFER) continue;
			try {
				v.send(msg);
			} catch {
				/* ignore */
			}
		}
	}

	#onAudio(payload) {
		if (!this.viewers.size) return;

		const msg = Buffer.allocUnsafe(payload.length + 1);
		msg[0] = OP_AUDIO;
		payload.copy(msg, 1);

		for (const v of this.viewers) {
			if (v.bufferedAmount > VIEWER_DROP_BUFFER) continue;
			try {
				v.send(msg);
			} catch {
				/* ignore */
			}
		}
	}

	#onBridgeExit() {
		if (this.state !== 'idle') {
			this.lastError = '桥接进程退出';
			this.#setState('idle');
		}
		this.current = null;
		this.broadcastJson({ t: 'bridge_exit' });
	}

	#startStatsTimer() {
		this._statsTimer = setInterval(() => {
			this.stats.fps = this.stats.frames;
			this.stats.kbps = Math.round((this.stats.bytes * 8) / 1000);
			this.stats.frames = 0;
			this.stats.bytes = 0;

			if (this.state === 'streaming' || this.state === 'connecting') {
				this.broadcastJson({
					t: 'stats',
					fps: this.stats.fps,
					kbps: this.stats.kbps,
					viewers: this.viewers.size,
				});
			}
		}, 1000);
		this._statsTimer.unref?.();
	}
}

export const engine = new Engine();

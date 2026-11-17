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
		this.sessionVideo = null; // 当前会话实际使用的档位（观战档可能是 720p/8M）
		this.discovered = [];
		this.audioFormat = null;
		this.lastParams = null; // 最近一包 SPS/PPS，中途接入时补发
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
			anons: this.anonViewers(),
			video: this.sessionVideo,
		};
	}

	/** 匿名观众数（控制通道的登录用户不计入上限） */
	anonViewers() {
		let n = 0;
		for (const v of this.viewers) if (!v.control) n++;
		return n;
	}

	/** 观众位是否已满（0 = 不限） */
	viewerFull() {
		return config.maxViewers > 0 && this.anonViewers() >= config.maxViewers;
	}

	addViewer(conn) {
		// 带宽保护：匿名观众达到上限后新连接直接拒绝，
		// 先告知原因再关闭；登录用户（控制通道）不受限制。
		if (!conn.control && this.viewerFull()) {
			try {
				conn.send(
					JSON.stringify({ t: 'full', limit: config.maxViewers })
				);
			} catch {
				/* ignore */
			}
			// 4008 = 策略拒绝（close 帧不允许用 1008，用应用私有码位）
			setTimeout(() => conn.close(4008), 50);
			return;
		}

		this.viewers.add(conn);
		conn.send(
			JSON.stringify({
				t: 'hello',
				state: this.state,
				current: this.current,
				audio: this.audioFormat,
				config: config.video,
				// conn.control 由 HTTP 层根据登录 cookie 设置：
				// 匿名连接只能看，登录了才能发输入/控制
				control: !!conn.control,
			})
		);

		// 中途接入（刷新页面后点「继续接入」）：先把缓存的 SPS/PPS 发过去，
		// 再要一个 IDR，浏览器才能立刻起解码器，不用等下一帧自然关键帧
		if (this.state === 'streaming') {
			if (this.lastParams) {
				try {
					conn.send(this.#frameVideo(this.lastParams));
				} catch {
					/* ignore */
				}
			}
			this.requestIdr();
		}

		this.broadcastJson({ t: 'viewers', count: this.viewers.size, anons: this.anonViewers() });
	}

	removeViewer(conn) {
		if (this.viewers.delete(conn))
			this.broadcastJson({ t: 'viewers', count: this.viewers.size, anons: this.anonViewers() });
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

	/* ---------------- 弹幕 ---------------- */

	/**
	 * 观战弹幕：任何人（包括匿名观众）都能发。
	 * 限速由调用方（HTTP 层按连接）负责，这里只做消毒和转发。
	 */
	chat(name, text) {
		const clean = String(text || '')
			.replace(/[\r\n\t]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 100);
		if (!clean) return false;
		const who = String(name || '观众')
			.replace(/[\r\n\t]/g, '')
			.trim()
			.slice(0, 16) || '观众';
		this.broadcastJson({ t: 'chat', name: who, text: clean, ts: Date.now() });
		return true;
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

		// 观战开播（preset='watch'）走低码率档：观众是 N 倍上行的乘数，
		// 720p/8M 在手机上够看，能把同样上行预算下的观众数翻倍。
		const base = opts.preset === 'watch' ? config.watchVideo : config.video;
		const video = {
			resolution: opts.resolution || base.resolution,
			fps: Number(opts.fps || base.fps),
			bitrate: Number(opts.bitrate || base.bitrate),
			codec: opts.codec || base.codec,
		};

		this.current = { hostId: host.id, name: host.name };
		this.sessionVideo = video;
		this.audioFormat = null;
		this.lastParams = null;
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
				this.sessionVideo = null;
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
				this.sessionVideo = null;
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

	// [0x10][8 字节 Date.now()][桥接层的帧数据]
	// 那个时间戳让浏览器能算出「这一帧从 NAS 收到算起，到我手里花了多久」
	#frameVideo(payload) {
		const msg = Buffer.allocUnsafe(payload.length + 9);
		msg[0] = OP_VIDEO;
		msg.writeBigUInt64BE(BigInt(Date.now()), 1);
		payload.copy(msg, 9);
		return msg;
	}

	#onVideo(payload) {
		// 桥接层的帧头是 [8 字节时间戳][1 字节 flags]，flags & 0x02 = 参数集
		// 中途接入的观看者如果拿不到这一包，解码器就永远配不上，表现是黑屏
		if (payload.length > 9 && (payload[8] & 0x02)) {
			this.lastParams = Buffer.from(payload);
		}

		if (!this.viewers.size) return;

		this.stats.frames++;
		this.stats.bytes += payload.length;

		const msg = this.#frameVideo(payload);

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

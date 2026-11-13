// SPDX-License-Identifier: AGPL-3.0-only
//
// WebCodecs 视频通路：PS5 发来的 Annex-B 码流直接喂给 VideoDecoder，
// 解码出来的 VideoFrame 画到 canvas。
//
// 用 WebCodecs 而不是 MSE：不需要自己写 fMP4 封装，延迟也更低
// （没有 MSE 那几百毫秒的缓冲）。

const HDR = 16;

function hex2(n) {
	return n.toString(16).toUpperCase().padStart(2, '0');
}

function firstStartCode(buf) {
	for (let i = 0; i + 3 < buf.length; i++) {
		if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return i + 3;
	}
	return -1;
}

/** 从参数集（SPS/PPS 或 VPS/SPS/PPS）里推导 RFC 6381 的 codec 字符串 */
function codecString(buf) {
	const p = firstStartCode(buf);
	if (p < 0 || p >= buf.length) return null;

	const hdr = buf[p];

	// H.264: SPS 的 nal_unit_type == 7
	if ((hdr & 0x1f) === 7 && p + 4 < buf.length) {
		return `avc1.${hex2(buf[p + 1])}${hex2(buf[p + 2])}${hex2(buf[p + 3])}`;
	}

	// HEVC: nal_unit_type == 33
	if (((hdr >> 1) & 0x3f) === 33) {
		const rb = p + 2; // 跳过 2 字节 NAL header
		if (rb + 13 > buf.length) return null;

		const profileSpace = (buf[rb + 1] >> 6) & 0x03;
		const tier = (buf[rb + 1] >> 5) & 0x01;
		const profileIdc = buf[rb + 1] & 0x1f;
		const compat =
			((buf[rb + 2] << 24) | (buf[rb + 3] << 16) | (buf[rb + 4] << 8) | buf[rb + 5]) >>> 0;
		const reversed =
			(((compat & 0xff) << 24) |
				((compat & 0xff00) << 8) |
				((compat >>> 8) & 0xff00) |
				((compat >>> 24) & 0xff)) >>>
			0;
		const level = buf[rb + 12];

		let str = `hvc1.${profileSpace ? String.fromCharCode(64 + profileSpace) : ''}${profileIdc}.${reversed
			.toString(16)
			.toUpperCase()}.${tier ? 'H' : 'L'}${level}`;

		let last = 11;
		while (last >= 6 && buf[rb + last] === 0) last--;
		for (let i = 6; i <= last; i++) str += `.${hex2(buf[rb + i])}`;

		return str;
	}

	return null;
}

export class VideoPipeline {
	constructor(canvas, { onError, onKeyRequest, onStats } = {}) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
		this.onError = onError || (() => {});
		this.onKeyRequest = onKeyRequest || (() => {});
		this.onStats = onStats || (() => {});

		this.decoder = null;
		this.configKey = '';
		this.decoderConfig = null;
		this.dropping = false;
		this.latest = null;
		this.raf = 0;

		this.frames = 0;
		this.errors = 0;
		this.lastStatsAt = performance.now();
		this.fps = 0;
		this.width = 0;
		this.height = 0;

		this.lastKeyRequestAt = 0;
		this.firstFrameAt = 0;
		this.keyFrameWait = 0;

		// 延迟诊断：帧从 NAS 发出到我画到屏幕上的耗时
		this.lastSentAt = 0;
		this.clockSkew = 0; // NAS 与浏览器时钟差，由 app.js 通过 pong 校准
		this.arriveAge = 0;
		this.displayAge = 0;
		this.lastDrawAt = 0;
	}

	static get supported() {
		return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';
	}

	destroy() {
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		if (this.latest) {
			this.latest.close();
			this.latest = null;
		}
		if (this.decoder) {
			try {
				this.decoder.close();
			} catch {
				/* ignore */
			}
			this.decoder = null;
		}
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
	}

	requestKeyframe() {
		const now = performance.now();
		if (now - this.lastKeyRequestAt < 800) return;
		this.lastKeyRequestAt = now;
		this.onKeyRequest();
	}

	reset(reason) {
		this.dropping = true;
		this.keyFrameWait = performance.now();
		if (this.decoder && this.decoderConfig) {
			try {
				this.decoder.reset();
				this.decoder.configure(this.decoderConfig);
			} catch {
				/* ignore */
			}
		}
		if (reason) console.warn('[video] reset:', reason);
		this.requestKeyframe();
	}

	#fail(err) {
		this.errors++;
		console.warn('[video] 解码错误:', err?.message || err);
		if (this.errors > 40) {
			this.onError(err?.message || '视频解码失败');
			return;
		}
		this.reset('decode error');
	}

	#configure(codec) {
		this.configKey = codec;

		if (this.decoder) {
			try {
				this.decoder.close();
			} catch {
				/* ignore */
			}
			this.decoder = null;
		}

		const cfg = { codec, optimizeForLatency: true };

		if (codec.startsWith('avc1') || codec.startsWith('avc3')) cfg.avc = { format: 'annexb' };
		else cfg.hevc = { format: 'annexb' };

		this.decoderConfig = cfg;

		try {
			this.decoder = new VideoDecoder({
				output: (frame) => this.#onFrame(frame),
				error: (e) => this.#fail(e),
			});
			this.decoder.configure(cfg);
			this.dropping = true; // 等下一个关键帧
			this.keyFrameWait = performance.now();
			this.requestKeyframe();
			console.log('[video] 已配置解码器', codec);
		} catch (err) {
			this.#fail(err);
		}
	}

	push(buf, sentAt) {
		if (!buf || buf.length <= HDR + 4) return;

		if (sentAt) {
			this.lastSentAt = sentAt;
			this.arriveAge = Date.now() - sentAt - this.clockSkew;
		}

		const dv = new DataView(buf.buffer, buf.byteOffset, HDR);
		const ts = Number(dv.getBigUint64(0, true));
		const flags = dv.getUint8(8);
		const isKey = (flags & 0x01) !== 0;
		const isParams = (flags & 0x02) !== 0;
		const body = buf.subarray(HDR);

		if (isParams) {
			const codec = codecString(body);
			if (codec && codec !== this.configKey) this.#configure(codec);
			if (!this.decoder) return;
		}

		if (!this.decoder) return;

		if (this.dropping) {
			if (!isKey) return;
			this.dropping = false;
		}

		// 解码队列太深说明渲染跟不上：直接跳到下一个关键帧，避免延迟越拖越大
		if (this.decoder.decodeQueueSize > 24) {
			this.dropping = true;
			this.requestKeyframe();
			return;
		}

		try {
			this.decoder.decode(
				new EncodedVideoChunk({
					type: isKey ? 'key' : 'delta',
					timestamp: ts,
					data: body,
				})
			);
		} catch (err) {
			this.#fail(err);
		}
	}

	#onFrame(frame) {
		if (this.firstFrameAt === 0) {
			this.firstFrameAt = performance.now();
			if (this.keyFrameWait) {
				console.log(`[video] 首帧用时 ${Math.round(this.firstFrameAt - this.keyFrameWait)}ms`);
				this.keyFrameWait = 0;
			}
		}

		this.frames++;

		if (this.latest) {
			this.latest.close();
		}
		this.latest = frame;

		// rAF 最多要等一整个刷新周期（16.7ms）。如果距上次绘制已经超过 8ms，
		// 说明再等 rAF 反而更亏，直接画。
		const now = performance.now();
		if (now - this.lastDrawAt > 8) {
			this.#draw();
		} else if (!this.raf) {
			this.raf = requestAnimationFrame(() => this.#draw());
		}
	}

	#draw() {
		this.raf = 0;
		const frame = this.latest;
		this.latest = null;
		if (!frame) return;

		if (this.width !== frame.displayWidth || this.height !== frame.displayHeight) {
			this.width = frame.displayWidth;
			this.height = frame.displayHeight;
			this.canvas.width = this.width;
			this.canvas.height = this.height;
			console.log(`[video] ${this.width}x${this.height}`);
		}

		try {
			this.ctx.drawImage(frame, 0, 0);
		} catch {
			/* ignore */
		}
		frame.close();
		this.lastDrawAt = performance.now();

		if (this.lastSentAt) this.displayAge = Date.now() - this.lastSentAt - this.clockSkew;

		const now = this.lastDrawAt;
		if (now - this.lastStatsAt >= 1000) {
			this.fps = Math.round((this.frames * 1000) / (now - this.lastStatsAt));
			this.frames = 0;
			this.lastStatsAt = now;
			this.onStats({
				fps: this.fps,
				queue: this.decoder ? this.decoder.decodeQueueSize : 0,
				arriveAge: Math.round(this.arriveAge),
				displayAge: Math.round(this.displayAge),
			});
		}
	}
}

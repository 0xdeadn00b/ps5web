// SPDX-License-Identifier: AGPL-3.0-only

const PENDING_AUDIO_MS = 60;
const MAX_PENDING_PACKETS = 400;

export class AudioPipeline {
	constructor() {
		this.ctx = null;
		this.node = null;
		this.gain = null;
		this.decoder = null;
		this.format = null;
		this.enabled = false;
		this.muted = false;
		this.pendingPackets = [];
		this.timestamp = 0;
		this.bufferedMs = 0;
		this.underruns = 0;
		this.supported = typeof AudioDecoder === 'function';
	}

	/** 必须在用户手势里调用一次 */
	async enable() {
		if (this.enabled) {
			if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
			return true;
		}

		if (!this.supported) return false;

		try {
			this.ctx = new (window.AudioContext || window.webkitAudioContext)({
				latencyHint: 'interactive',
			});
			await this.ctx.audioWorklet.addModule('/js/audio-worklet.js');

			this.node = new AudioWorkletNode(this.ctx, 'pcm-queue', {
				numberOfInputs: 0,
				numberOfOutputs: 1,
				outputChannelCount: [2],
			});

			this.gain = this.ctx.createGain();
			this.gain.gain.value = this.muted ? 0 : 1;
			this.node.connect(this.gain).connect(this.ctx.destination);

			this.node.port.onmessage = (e) => {
				if (e.data?.type === 'status') {
					this.bufferedMs = e.data.bufferedMs;
					this.underruns = e.data.underruns;
				}
			};

			if (this.ctx.state === 'suspended') await this.ctx.resume();

			this.enabled = true;
			console.log('[audio] AudioContext 就绪', this.ctx.sampleRate, this.ctx.state);

			const queued = this.pendingPackets;
			this.pendingPackets = [];
			const cutoff = performance.now() - PENDING_AUDIO_MS;
			for (const { buf, receivedAt } of queued) {
				if (receivedAt >= cutoff) this.push(buf);
			}

			return true;
		} catch (err) {
			console.warn('[audio] 初始化失败:', err.message);
			return false;
		}
	}

	configure(format) {
		const cfg = {
			codec: 'opus',
			sampleRate: format?.rate || 48000,
			numberOfChannels: format?.channels || 2,
		};

		if (
			this.format &&
			this.format.rate === cfg.sampleRate &&
			this.format.channels === cfg.numberOfChannels &&
			this.decoder
		) {
			return;
		}

		this.format = { rate: cfg.sampleRate, channels: cfg.numberOfChannels };

		if (this.decoder) {
			try {
				this.decoder.close();
			} catch {
				/* ignore */
			}
			this.decoder = null;
		}

		try {
			this.decoder = new AudioDecoder({
				output: (data) => this.#onSamples(data),
				error: (e) => console.warn('[audio] 解码错误:', e.message),
			});
			this.decoder.configure(cfg);
			console.log('[audio] Opus 解码器就绪', cfg);
		} catch (err) {
			console.warn('[audio] 无法配置 Opus 解码器:', err.message);
		}
	}

	push(buf) {
		if (!buf || buf.length <= 8) return;

		if (!this.enabled) {
			const now = performance.now();
			const cutoff = now - PENDING_AUDIO_MS;
			const queue = this.pendingPackets;
			queue.push({ buf, receivedAt: now });

			while (
				queue.length > MAX_PENDING_PACKETS ||
				(queue.length && queue[0].receivedAt < cutoff)
			) {
				queue.shift();
			}
			return;
		}

		if (!this.decoder) this.configure(this.format);

		const dv = new DataView(buf.buffer, buf.byteOffset, 8);
		const ts = Number(dv.getBigUint64(0, true));
		const data = buf.subarray(8);
		this.timestamp = Math.max(this.timestamp + 1, Math.round(ts));

		try {
			this.decoder.decode(
				new EncodedAudioChunk({
					type: 'key',
					timestamp: this.timestamp,
					data,
				})
			);
		} catch {
			/* ignore */
		}
	}

	#onSamples(data) {
		if (!this.node) {
			data.close();
			return;
		}

		const frames = data.numberOfFrames;
		const channels = data.numberOfChannels;
		const left = new Float32Array(frames);
		const right = new Float32Array(frames);

		try {
			data.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
			if (channels > 1) data.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
			else right.set(left);
		} catch (err) {
			console.warn('[audio] 读取 PCM 失败:', err.message);
			data.close();
			return;
		}

		this.node.port.postMessage({ type: 'samples', left, right }, [left.buffer, right.buffer]);
		data.close();
	}

	setMuted(muted) {
		this.muted = muted;
		if (this.gain) this.gain.gain.value = muted ? 0 : 1;
	}

	flush() {
		this.pendingPackets = [];
		if (this.node) this.node.port.postMessage({ type: 'flush' });
	}

	destroy() {
		this.flush();
		if (this.decoder) {
			try {
				this.decoder.close();
			} catch {
				/* ignore */
			}
			this.decoder = null;
		}
		if (this.node) {
			try {
				this.node.disconnect();
			} catch {
				/* ignore */
			}
			this.node = null;
		}
		if (this.ctx) {
			try {
				this.ctx.close();
			} catch {
				/* ignore */
			}
			this.ctx = null;
		}
		this.enabled = false;
	}
}
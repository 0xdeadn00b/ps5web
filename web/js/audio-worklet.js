// SPDX-License-Identifier: AGPL-3.0-only

const STARTUP_BUFFER_MS = 30;
const HIGH_WATER_MS = 120;
const KEEP_AFTER_TRIM_MS = 60;

class PcmQueue extends AudioWorkletProcessor {
	constructor() {
		super();

		this.capacity = 1 << 17;
		this.left = new Float32Array(this.capacity);
		this.right = new Float32Array(this.capacity);
		this.readPos = 0;
		this.writePos = 0;
		this.size = 0;

		this.primed = false;
		this.underruns = 0;
		this.processed = 0;

		const rate = sampleRate || 48000;
		this.targetSamples = Math.round((rate * STARTUP_BUFFER_MS) / 1000);
		this.highWaterSamples = Math.round((rate * HIGH_WATER_MS) / 1000);
		this.keepSamples = Math.round((rate * KEEP_AFTER_TRIM_MS) / 1000);

		this.port.onmessage = (e) => {
			const msg = e.data;
			if (!msg) return;

			if (msg.type === 'samples') {
				this.#write(msg.left, msg.right);
			} else if (msg.type === 'flush') {
				this.size = 0;
				this.readPos = 0;
				this.writePos = 0;
				this.primed = false;
			} else if (msg.type === 'target') {
				this.targetSamples = Math.max(0, msg.samples | 0);
			}
		};
	}

	#write(left, right) {
		const n = left.length;
		if (!n || n > this.capacity) return;

		if (this.size + n > this.capacity) {
			const drop = this.size + n - this.capacity;
			this.readPos = (this.readPos + drop) % this.capacity;
			this.size -= drop;
		}

		for (let i = 0; i < n; i++) {
			const idx = (this.writePos + i) % this.capacity;
			this.left[idx] = left[i];
			this.right[idx] = right[i];
		}

		this.writePos = (this.writePos + n) % this.capacity;
		this.size += n;

		// Respect a custom startup target if it exceeds the default trim level.
		const keep = Math.max(this.keepSamples, this.targetSamples);
		const highWater = Math.max(
			this.highWaterSamples,
			keep + this.highWaterSamples - this.keepSamples
		);
		if (this.size > highWater) {
			const drop = this.size - keep;
			this.readPos = (this.readPos + drop) % this.capacity;
			this.size -= drop;
		}
	}

	process(inputs, outputs) {
		const out = outputs[0];
		if (!out || !out.length) return true;
		const ch0 = out[0];
		const ch1 = out.length > 1 ? out[1] : null;
		const frames = ch0.length;

		if (!this.primed) {
			if (this.size < this.targetSamples) {
				ch0.fill(0);
				if (ch1) ch1.fill(0);
				return true;
			}
			this.primed = true;
		}

		if (this.size >= frames) {
			for (let i = 0; i < frames; i++) {
				const idx = (this.readPos + i) % this.capacity;
				ch0[i] = this.left[idx];
				if (ch1) ch1[i] = this.right[idx];
			}
			this.readPos = (this.readPos + frames) % this.capacity;
			this.size -= frames;
		} else {
			ch0.fill(0);
			if (ch1) ch1.fill(0);
			this.underruns++;
			if (this.size === 0) this.primed = false;
		}

		this.processed++;
		if (this.processed % 375 === 0) {
			this.port.postMessage({
				type: 'status',
				bufferedMs: Math.round((this.size * 1000) / (sampleRate || 48000)),
				underruns: this.underruns,
			});
		}

		return true;
	}
}

registerProcessor('pcm-queue', PcmQueue);
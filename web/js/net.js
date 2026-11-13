// SPDX-License-Identifier: AGPL-3.0-only
//
// 与 NAS 之间的 WebSocket 通道：
//   文本 = JSON 事件
//   二进制 = [0x10 视频][0x11 音频]

export const OP_VIDEO = 0x10;
export const OP_AUDIO = 0x11;

export class StreamSocket {
	constructor() {
		this.ws = null;
		this.closedByUser = false;
		this.retry = 0;
		this.retryTimer = null;

		this.onJson = () => {};
		this.onVideo = () => {};
		this.onAudio = () => {};
		this.onOpen = () => {};
		this.onClose = () => {};
	}

	get connected() {
		return this.ws && this.ws.readyState === WebSocket.OPEN;
	}

	connect() {
		this.closedByUser = false;
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const ws = new WebSocket(`${proto}//${location.host}/ws`);
		ws.binaryType = 'arraybuffer';
		this.ws = ws;

		ws.onopen = () => {
			this.retry = 0;
			this.onOpen();
		};

		ws.onmessage = (ev) => {
			if (typeof ev.data === 'string') {
				try {
					this.onJson(JSON.parse(ev.data));
				} catch {
					/* ignore */
				}
				return;
			}

			const buf = new Uint8Array(ev.data);
			if (!buf.length) return;
			const op = buf[0];
			const body = buf.subarray(1);
			if (op === OP_VIDEO) this.onVideo(body);
			else if (op === OP_AUDIO) this.onAudio(body);
		};

		ws.onclose = () => {
			this.ws = null;
			this.onClose();
			if (!this.closedByUser) this.#scheduleRetry();
		};

		ws.onerror = () => {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		};
	}

	#scheduleRetry() {
		if (this.retryTimer) return;
		this.retry = Math.min(this.retry + 1, 6);
		const delay = Math.min(500 * 2 ** (this.retry - 1), 8000);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			if (!this.closedByUser) this.connect();
		}, delay);
	}

	sendJson(obj) {
		if (!this.connected) return false;
		this.ws.send(JSON.stringify(obj));
		return true;
	}

	sendInput(bytes) {
		if (!this.connected) return false;
		if (this.ws.bufferedAmount > 512 * 1024) return false;
		const buf = new Uint8Array(1 + bytes.length);
		buf[0] = 0x01;
		buf.set(bytes, 1);
		this.ws.send(buf);
		return true;
	}

	close() {
		this.closedByUser = true;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				/* ignore */
			}
			this.ws = null;
		}
	}
}

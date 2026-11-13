// SPDX-License-Identifier: AGPL-3.0-only
//
// 最小可用的 WebSocket 服务端（RFC 6455 子集），只做我们需要的：
// 文本/二进制帧、分片、ping/pong、close。
// 不引第三方依赖，是为了让 NAS 上的 Docker 构建不需要联网装 npm 包。

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 8 * 1024 * 1024;

export class WsConnection extends EventEmitter {
	constructor(socket, req) {
		super();
		this.socket = socket;
		this.req = req;
		this.closed = false;
		this.buf = Buffer.alloc(0);
		this.fragment = null;

		socket.setNoDelay(true);
		socket.setTimeout(0);

		socket.on('data', (chunk) => this.#onData(chunk));
		socket.on('close', () => this.#markClosed());
		socket.on('error', () => this.destroy());
	}

	static accept(req, socket) {
		const key = req.headers['sec-websocket-key'];
		const upgrade = (req.headers.upgrade || '').toLowerCase();
		if (!key || upgrade !== 'websocket') {
			socket.destroy();
			return null;
		}

		const accept = createHash('sha1').update(key + GUID).digest('base64');
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				`Sec-WebSocket-Accept: ${accept}\r\n` +
				'\r\n'
		);
		return new WsConnection(socket, req);
	}

	#markClosed() {
		if (this.closed) return;
		this.closed = true;
		this.emit('close');
	}

	#onData(chunk) {
		if (this.closed) return;
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

		for (;;) {
			if (this.closed) return;
			if (this.buf.length < 2) return;

			const b0 = this.buf[0];
			const b1 = this.buf[1];
			const fin = (b0 & 0x80) !== 0;
			const opcode = b0 & 0x0f;
			const masked = (b1 & 0x80) !== 0;
			let len = b1 & 0x7f;
			let off = 2;

			if (len === 126) {
				if (this.buf.length < 4) return;
				len = this.buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (this.buf.length < 10) return;
				const big = this.buf.readBigUInt64BE(2);
				if (big > BigInt(MAX_FRAME)) {
					this.close(1009);
					return;
				}
				len = Number(big);
				off = 10;
			}

			if (len > MAX_FRAME) {
				this.close(1009);
				return;
			}

			let maskKey = null;
			if (masked) {
				if (this.buf.length < off + 4) return;
				maskKey = this.buf.subarray(off, off + 4);
				off += 4;
			}

			if (this.buf.length < off + len) return;

			let payload = this.buf.subarray(off, off + len);
			this.buf = this.buf.subarray(off + len);

			if (maskKey) {
				const copy = Buffer.allocUnsafe(len);
				for (let i = 0; i < len; i++) copy[i] = payload[i] ^ maskKey[i & 3];
				payload = copy;
			}

			switch (opcode) {
				case 0x0:
					if (!this.fragment) {
						this.close(1002);
						return;
					}
					this.fragment.chunks.push(payload);
					if (fin) {
						const full = Buffer.concat(this.fragment.chunks);
						const op = this.fragment.opcode;
						this.fragment = null;
						this.#dispatch(op, full);
					}
					break;

				case 0x1:
				case 0x2:
					if (fin) this.#dispatch(opcode, payload);
					else this.fragment = { opcode, chunks: [payload] };
					break;

				case 0x8:
					this.close(1000);
					return;

				case 0x9:
					this.#sendFrame(0xa, payload);
					break;

				case 0xa:
					break;

				default:
					this.close(1002);
					return;
			}
		}
	}

	#dispatch(opcode, payload) {
		if (opcode === 0x1) this.emit('message', payload.toString('utf8'), false);
		else this.emit('message', payload, true);
	}

	#sendFrame(opcode, payload) {
		if (this.closed || this.socket.destroyed) return false;

		const len = payload.length;
		let header;
		if (len < 126) {
			header = Buffer.allocUnsafe(2);
			header[1] = len;
		} else if (len < 65536) {
			header = Buffer.allocUnsafe(4);
			header[1] = 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.allocUnsafe(10);
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		header[0] = 0x80 | opcode;

		try {
			this.socket.write(header);
			if (len) this.socket.write(payload);
		} catch {
			this.destroy();
			return false;
		}
		return true;
	}

	send(data) {
		if (typeof data === 'string') return this.#sendFrame(0x1, Buffer.from(data, 'utf8'));
		return this.#sendFrame(0x2, data);
	}

	get bufferedAmount() {
		return this.socket.writableLength || 0;
	}

	close(code = 1000) {
		if (this.closed) return;
		const b = Buffer.allocUnsafe(2);
		b.writeUInt16BE(code, 0);
		this.#sendFrame(0x8, b);
		this.destroy();
	}

	destroy() {
		if (this.closed) return;
		this.closed = true;
		try {
			this.socket.destroy();
		} catch {
			/* ignore */
		}
		this.emit('close');
	}
}

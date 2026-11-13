#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// 开发用的假桥接进程：不连 PS5，只按协议回事件，方便在没有主机的情况下
// 调前端和接口。用法：
//   PS5WEB_BRIDGE=./server/src/mock-bridge.js PS5WEB_DATA=./data node server/src/index.js

const MSG_JSON = 1;

function send(type, payload) {
	const header = Buffer.alloc(5);
	header[0] = type;
	header.writeUInt32BE(payload.length, 1);
	process.stdout.write(header);
	process.stdout.write(payload);
}

function json(obj) {
	send(MSG_JSON, Buffer.from(JSON.stringify(obj)));
}

const timers = new Set();
function later(fn, ms) {
	const t = setTimeout(() => {
		timers.delete(t);
		fn();
	}, ms);
	timers.add(t);
}

let sessionTimer = null;

function handle(cmd) {
	switch (cmd.cmd) {
		case 'ping':
			json({ ev: 'pong' });
			break;

		case 'version':
			json({ ev: 'version', bridge: 'mock', chiaki: 'mock' });
			break;

		case 'discover':
			json({ ev: 'log', level: 'info', message: '（模拟）开始扫描局域网' });
			later(() => {
				json({
					ev: 'hosts',
					hosts: [
						{
							name: '客厅的 PS5',
							address: '192.168.1.50',
							id: 'MOCK0001',
							type: 'PS5',
							state: 'ready',
							systemVersion: '11000000',
							runningApp: '',
							ps5: true,
							rpPort: 9302,
							target: 1000100,
						},
						{
							name: '书房的 PS5',
							address: '192.168.1.51',
							id: 'MOCK0002',
							type: 'PS5',
							state: 'standby',
							systemVersion: '11000000',
							runningApp: '',
							ps5: true,
							rpPort: 9302,
							target: 1000100,
						},
					],
				});
			}, 500);
			later(() => json({ ev: 'discover_done' }), 3200);
			break;

		case 'pair':
			json({ ev: 'pairing' });
			later(() => {
				json({
					ev: 'pair_ok',
					host: {
						target: 1000100,
						ps5: true,
						nickname: '客厅的 PS5',
						mac: 'aabbccddeeff',
						registKey: '00112233445566778899aabbccddeeff',
						rpKey: 'ffeeddccbbaa99887766554433221100',
						rpKeyType: 0,
						consolePin: 0,
						apSsid: '',
						apName: '',
					},
				});
			}, 1200);
			break;

		case 'wake':
			json({ ev: 'wake_sent' });
			break;

		case 'start':
			json({ ev: 'connecting' });
			later(() => {
				json({ ev: 'connected' });
				json({ ev: 'nickname', name: '客厅的 PS5' });
				json({ ev: 'audio_format', channels: 2, bits: 16, rate: 48000, frameSize: 480 });

				sessionTimer = setInterval(() => {
					json({ ev: 'rumble', left: Math.floor(Math.random() * 60), right: Math.floor(Math.random() * 60) });
				}, 3000);
			}, 900);
			break;

		case 'stop':
			json({ ev: 'stopping' });
			if (sessionTimer) clearInterval(sessionTimer);
			later(() => json({ ev: 'session_ended' }), 300);
			break;

		case 'pin':
			json({ ev: 'pin_accepted' });
			break;

		case 'idr':
			break;

		default:
			json({ ev: 'error', cmd: cmd.cmd, message: 'mock 不支持这个命令' });
			break;
	}
}

let buf = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
	buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

	for (;;) {
		if (buf.length < 5) return;
		const type = buf[0];
		const len = buf.readUInt32BE(1);
		if (buf.length < 5 + len) return;
		const payload = buf.subarray(5, 5 + len);
		buf = buf.subarray(5 + len);

		if (type === MSG_JSON) {
			try {
				handle(JSON.parse(payload.toString('utf8')));
			} catch {
				/* ignore */
			}
		}
	}
});

process.stdin.on('end', () => process.exit(0));

json({ ev: 'ready' });

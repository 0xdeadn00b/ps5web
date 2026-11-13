// SPDX-License-Identifier: AGPL-3.0-only

import { api } from './api.js';
import { StreamSocket } from './net.js';
import { VideoPipeline } from './video.js';
import { AudioPipeline } from './audio.js';
import { InputManager, BTN } from './input.js';

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
	hosts: [],
	discovered: [],
	defaults: { resolution: '1080p', fps: 60, bitrate: 18000, codec: 'h264' },
	session: { state: 'idle' },
	currentHost: null,
	socket: null,
	video: null,
	audio: null,
	input: null,
	hudTimer: null,
	touchUiBuilt: false,
	touchVisible: false,
	logsTimer: null,
	logCursor: 0,
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function h(tag, props = {}, children = []) {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;
		if (key === 'class') el.className = value;
		else if (key === 'text') el.textContent = value;
		else if (key === 'html') el.innerHTML = value;
		else if (key === 'style') el.style.cssText = value;
		else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
		else if (value === true) el.setAttribute(key, '');
		else el.setAttribute(key, value);
	}
	for (const child of [].concat(children)) {
		if (child === null || child === undefined) continue;
		el.append(child);
	}
	return el;
}

function toast(message, kind = '', ms = 3400) {
	const root = $('#toast-root');
	const node = h('div', { class: `toast ${kind}`, text: message });
	root.append(node);
	setTimeout(() => {
		node.style.transition = 'opacity .2s';
		node.style.opacity = '0';
		setTimeout(() => node.remove(), 240);
	}, ms);
}

function openModal({ title, body, actions = [], dismissable = true }) {
	const root = $('#modal-root');

	return new Promise((resolve) => {
		let done = false;
		const finish = (value) => {
			if (done) return;
			done = true;
			backdrop.remove();
			resolve(value);
		};

		const card = h('div', { class: 'modal card' });
		card.append(h('h3', { text: title }));

		const bodyWrap = h('div', { class: 'modal-body' });
		if (typeof body === 'string') bodyWrap.append(h('p', { text: body }));
		else if (body) bodyWrap.append(body);
		card.append(bodyWrap);

		const row = h('div', { class: 'modal-actions' });
		for (const action of actions) {
			row.append(
				h('button', {
					class: action.primary ? 'primary' : 'ghost',
					text: action.label,
					onclick: async () => {
						if (action.onClick) {
							const result = await action.onClick();
							if (result === false) return;
						}
						finish(action.value);
					},
				})
			);
		}
		card.append(row);

		const backdrop = h('div', { class: 'modal-backdrop' }, [card]);
		if (dismissable) {
			backdrop.addEventListener('click', (e) => {
				if (e.target === backdrop) finish(null);
			});
		}

		root.append(backdrop);
		setTimeout(() => {
			const target =
				card.querySelector('input') ||
				card.querySelector('.modal-actions button.primary') ||
				card.querySelector('.modal-actions button');
			target?.focus();
		}, 40);
	});
}

const STATE_TEXT = {
	idle: '空闲',
	discovering: '扫描中',
	pairing: '配对中',
	connecting: '连接中',
	streaming: '串流中',
};

/**
 * http 页面下浏览器不给 WebCodecs / Gamepad，表现为「黑屏 + 没声音 + 认不到手柄」。
 * 这是最常见的踩坑点，所以直接顶一条横幅说清楚。
 */
function showInsecureBanner() {
	if ($('#insecure-banner')) return;

	const bar = h('div', { class: 'insecure-banner', id: 'insecure-banner' }, [
		h('div', { class: 'ib-text' }, [
			h('strong', { text: '当前是 http 访问，浏览器禁用了 WebCodecs 和手柄 API。' }),
			h('span', {
				text:
					`画面会黑屏、手柄认不到。解决办法：用 https 打开本站；或把 ${location.origin} ` +
					'加进 chrome://flags/#unsafely-treat-insecure-origin-as-secure 的白名单并重启浏览器。',
			}),
		]),
		h('button', {
			class: 'ghost small',
			text: '知道了',
			onclick: () => bar.remove(),
		}),
	]);

	document.body.append(bar);
}

function showView(name) {
	for (const view of ['login', 'home', 'player']) {
		$(`#view-${view}`).classList.toggle('hidden', view !== name);
	}
	document.body.style.overflow = name === 'player' ? 'hidden' : '';
}

function updateStatusPill() {
	const pill = $('#status-pill');
	const s = state.session?.state || 'idle';
	pill.textContent = STATE_TEXT[s] || s;
	pill.className = 'pill' + (s === 'streaming' ? ' on' : s === 'idle' ? '' : ' busy');
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

async function onLoginSubmit(e) {
	e.preventDefault();
	const input = $('#login-password');
	const error = $('#login-error');
	error.textContent = '';

	const btn = e.target.querySelector('button[type=submit]');
	btn.disabled = true;

	try {
		await api.login(input.value);
		input.value = '';
		await refreshState();
		showView('home');
	} catch (err) {
		error.textContent = err.message;
	} finally {
		btn.disabled = false;
	}
}

/* ------------------------------------------------------------------ */
/* 主机列表                                                            */
/* ------------------------------------------------------------------ */

async function refreshState() {
	const s = await api.state();
	state.hosts = s.hosts || [];
	state.defaults = { ...state.defaults, ...(s.defaults || {}) };
	state.session = s.session || { state: 'idle' };
	updateStatusPill();
	renderHosts();
}

function renderHosts() {
	const list = $('#host-list');
	list.innerHTML = '';

	for (const host of state.hosts) {
		list.append(hostCard(host));
	}

	$('#host-empty').classList.toggle('hidden', state.hosts.length > 0);

	const wrap = $('#discovered-wrap');
	const discovered = state.discovered.filter(
		(d) => !state.hosts.some((h2) => h2.address === d.address)
	);

	if (discovered.length) {
		wrap.classList.remove('hidden');
		const listEl = $('#discovered-list');
		listEl.innerHTML = '';
		for (const d of discovered) listEl.append(discoveredCard(d));
	} else {
		wrap.classList.add('hidden');
	}
}

function hostCard(host) {
	const busy = state.session?.state === 'streaming' || state.session?.state === 'connecting';

	const startBtn = h('button', {
		class: 'primary',
		text: host.paired ? '开始串流' : '配对',
		disabled: busy && host.paired,
		onclick: () => (host.paired ? openStartDialog(host) : openPairDialog(host)),
	});

	const actions = h('div', { class: 'hc-actions' }, [
		startBtn,
		host.paired
			? h('button', {
					class: 'ghost',
					text: '唤醒',
					onclick: async (e) => {
						e.target.disabled = true;
						try {
							await api.wake(host.id);
							toast('已发送唤醒包（若无效，请检查 PS5 的远程游玩设置）', 'ok');
						} catch (err) {
							toast(err.message, 'error');
						} finally {
							e.target.disabled = false;
						}
					}
			  })
			: null,
		h('button', {
			class: 'ghost danger',
			text: '删除',
			onclick: async () => {
				const ok = await openModal({
					title: '删除这台主机？',
					body: `会同时删除已保存的配对凭据：${host.name}`,
					actions: [
						{ label: '取消', value: false },
						{ label: '删除', primary: true, value: true },
					],
				});
				if (!ok) return;
				try {
					await api.removeHost(host.id);
					await refreshState();
				} catch (err) {
					toast(err.message, 'error');
				}
			},
		}),
	]);

	return h('div', { class: 'host-card card' }, [
		h('div', { class: 'hc-top' }, [
			h('div', {}, [
				h('div', { class: 'hc-name', text: host.name }),
				h('div', { class: 'hc-addr mono', text: host.address + (host.mac ? ` · ${host.mac}` : '') }),
			]),
			h('span', {
				class: 'hc-state ' + (host.paired ? 'paired' : 'unpaired'),
				text: host.paired ? '已配对' : '未配对',
			}),
		]),
		actions,
	]);
}

function discoveredCard(d) {
	return h('div', { class: 'host-card card' }, [
		h('div', { class: 'hc-top' }, [
			h('div', {}, [
				h('div', { class: 'hc-name', text: d.name || d.address }),
				h('div', {
					class: 'hc-addr mono',
					text: `${d.address} · ${d.ps5 ? 'PS5' : 'PS4'} · ${d.state === 'standby' ? '待机' : '在线'}`,
				}),
			]),
			h('span', { class: 'hc-state', text: d.state === 'standby' ? '待机' : '在线' }),
		]),
		h('div', { class: 'hc-actions' }, [
			h('button', {
				class: 'primary',
				text: '添加并配对',
				onclick: async () => {
					try {
						const res = await api.addHost({ name: d.name || d.address, address: d.address, ps5: d.ps5 });
						state.discovered = state.discovered.filter((x) => x.address !== d.address);
						await refreshState();
						openPairDialog(res.host);
					} catch (err) {
						toast(err.message, 'error');
					}
				},
			}),
		]),
	]);
}

async function onDiscover() {
	const btn = $('#btn-discover');
	btn.disabled = true;
	btn.textContent = '扫描中…';

	try {
		const res = await api.discover();
		state.discovered = res.hosts || [];
		renderHosts();
		if (!state.discovered.length) {
			toast('没有发现主机。确认 NAS 与 PS5 同网段，并且容器用的是 host 网络。', '', 5000);
		}
	} catch (err) {
		toast(err.message, 'error');
	} finally {
		btn.disabled = false;
		btn.textContent = '扫描局域网';
	}
}

async function onAddHost(e) {
	e.preventDefault();
	const address = $('#add-address').value.trim();
	const name = $('#add-name').value.trim();
	if (!address) return;

	try {
		const res = await api.addHost({ name, address });
		$('#add-address').value = '';
		$('#add-name').value = '';
		await refreshState();
		openPairDialog(res.host);
	} catch (err) {
		toast(err.message, 'error');
	}
}

/* ------------------------------------------------------------------ */
/* 配对                                                                */
/* ------------------------------------------------------------------ */

function openPairDialog(host) {
	const pinInput = h('input', {
		placeholder: 'PS5 上显示的 8 位数字',
		inputmode: 'numeric',
		autocomplete: 'off',
	});
	const accountInput = h('input', {
		placeholder: 'PSN Account-ID（base64，8 字节）',
		autocomplete: 'off',
	});

	const body = h('div', {}, [
		h('p', {
			text:
				'1. 在 PS5 上打开「设置 → 系统 → 远程游玩 → 关联设备」，屏幕会显示 8 位 PIN。',
		}),
		h('p', {
			text:
				'2. 用电脑或手机打开 psn.flipscreen.games，登录后复制 Account-ID（base64 那串）。',
		}),
		h('label', { class: 'field' }, [h('span', { text: 'PIN' }), pinInput]),
		h('label', { class: 'field' }, [h('span', { text: 'PSN Account-ID' }), accountInput]),
		h('p', { class: 'muted small', text: '配对只需要做一次，凭据保存在 NAS 本地。' }),
	]);

	const submit = async () => {
		const pin = pinInput.value.trim();
		const accountId = accountInput.value.trim();
		if (!/^\d{5,10}$/.test(pin)) {
			toast('PIN 应该是 8 位数字', 'error');
			return false;
		}
		if (!accountId) {
			toast('请填写 PSN Account-ID', 'error');
			return false;
		}

		const btns = document.querySelectorAll('.modal-actions button');
		btns.forEach((b) => (b.disabled = true));

		try {
			await api.pair(host.id, pin, accountId);
			await refreshState();
			toast('配对成功，可以直接串流了', 'ok');
			return true;
		} catch (err) {
			toast(err.message, 'error', 6000);
			btns.forEach((b) => (b.disabled = false));
			return false;
		}
	};

	openModal({
		title: `配对 ${host.name}`,
		body,
		actions: [
			{ label: '取消', value: false },
			{ label: '开始配对', primary: true, onClick: submit },
		],
	});
}

/* ------------------------------------------------------------------ */
/* 开始串流                                                            */
/* ------------------------------------------------------------------ */

/**
 * 一组可选中的胶囊按钮，替代原生 <select>：
 * 原生下拉的弹层由系统绘制，深色页面里会出现「白底浅字」看不清。
 */
function chipGroup(options, current, { columns = 0 } = {}) {
	const wrap = h('div', {
		class: 'chips' + (columns ? ' chips-grid' : ''),
		style: columns ? `grid-template-columns: repeat(${columns}, minmax(0, 1fr));` : null,
	});
	const buttons = [];

	wrap.value = String(current);

	for (const opt of options) {
		const value = String(opt.value);
		const btn = h('button', {
			type: 'button',
			class: 'chip' + (value === String(current) ? ' active' : ''),
			text: opt.label,
			'data-value': value,
			onclick: () => {
				wrap.value = value;
				for (const b of buttons) b.classList.toggle('active', b === btn);
			},
		});
		buttons.push(btn);
		wrap.append(btn);
	}

	return wrap;
}

function openStartDialog(host) {
	const resChips = chipGroup(
		[
			{ value: '1080p', label: '1080p' },
			{ value: '720p', label: '720p' },
			{ value: '540p', label: '540p' },
		],
		state.defaults.resolution || '1080p'
	);

	const fpsChips = chipGroup(
		[
			{ value: '60', label: '60 fps' },
			{ value: '30', label: '30 fps' },
		],
		String(state.defaults.fps || 60)
	);

	const bitrateChips = chipGroup(
		[8000, 12000, 18000, 25000, 35000, 50000].map((v) => ({
			value: v,
			label: `${v / 1000} Mbps`,
		})),
		String(state.defaults.bitrate || 18000),
		{ columns: 3 }
	);

	const body = h('div', {}, [
		h('p', {
			class: 'muted small',
			text: '码率越高画质越好，但上行带宽要跟上。远程玩建议 12–18 Mbps。',
		}),
		h('div', { class: 'quality' }, [
			h('div', { class: 'quality-row' }, [h('span', { text: '分辨率' }), resChips]),
			h('div', { class: 'quality-row' }, [h('span', { text: '帧率' }), fpsChips]),
			h('div', { class: 'quality-row' }, [h('span', { text: '码率' }), bitrateChips]),
		]),
	]);

	openModal({
		title: `开始串流 · ${host.name}`,
		body,
		actions: [
			{ label: '取消', value: false },
			{
				label: '开始',
				primary: true,
				onClick: () => {
					// 不 await：立刻关弹窗进播放页，连接过程用覆盖层反馈
					startSession(host, {
						resolution: resChips.value,
						fps: Number(fpsChips.value),
						bitrate: Number(bitrateChips.value),
					});
					return true;
				},
			},
		],
	});
}

async function startSession(host, opts) {
	state.currentHost = host;

	showView('player');
	preparePlayer();

	// 必须在用户手势里创建 AudioContext
	state.audio.enable().then((ok) => {
		if (!ok) toast('浏览器不支持 WebCodecs 音频解码，本次没有声音', 'error', 5000);
	});

	showOverlay('正在连接 PS5…', '主机在待机的话会自动唤醒，冷启动大概 30–60 秒。', true);
	$('#hud-title').textContent = host.name;

	try {
		const res = await api.start({ hostId: host.id, ...opts });
		if (res?.session) state.session = res.session;
	} catch (err) {
		toast(err.message, 'error', 6000);
		showOverlay('无法开始串流', err.message, false);
	}
}

/* ------------------------------------------------------------------ */
/* 播放器                                                              */
/* ------------------------------------------------------------------ */

function preparePlayer() {
	const canvas = $('#screen');

	state.video = new VideoPipeline(canvas, {
		onKeyRequest: () => state.socket?.sendJson({ t: 'idr' }),
		onError: (msg) => {
			showOverlay('视频解码出错', msg, false);
		},
		onStats: ({ fps, queue, arriveAge, displayAge }) => {
			state.lastVideoStats = { fps, queue, arriveAge, displayAge };
			updateHudStats();
		},
	});

	state.audio = new AudioPipeline();
	state.input = new InputManager({ send: (pkt) => state.socket?.sendInput(pkt) });

	state.socket = new StreamSocket();
	state.socket.onVideo = (buf, sentAt) => state.video?.push(buf, sentAt);
	state.socket.onAudio = (buf) => state.audio?.push(buf);
	state.socket.onJson = onServerMessage;
	state.socket.onOpen = () => {
		state.input?.start();
		sendPing();
		if (VideoPipeline.supported) state.video?.requestKeyframe();

		// 每 2 秒量一次 WS 往返 + 校一次时钟，判断延迟是不是网络造成的
		clearInterval(state.pingTimer);
		state.pingTimer = setInterval(sendPing, 2000);
	};
	state.socket.onClose = () => {
		if (state.session.state === 'streaming') {
			showOverlay('与 NAS 的连接断开', '正在自动重连…', true);
		}
	};
	state.socket.connect();

	if (!state.touchUiBuilt) {
		buildTouchUI();
		state.touchUiBuilt = true;
	}

	const coarse = window.matchMedia('(pointer: coarse)').matches;
	setTouchVisible(coarse || state.touchVisible);

	if (!state.stageBound) {
		bindStageGestures(canvas);
		state.stageBound = true;
	}

	$('#hud').classList.remove('dim');
	pulseHud();

	if (!VideoPipeline.supported) {
		showOverlay(
			'视频解码不可用',
			window.isSecureContext
				? '这个浏览器没有 WebCodecs，请换成 Chrome / Edge 94+、Safari 16.4+ 或 Firefox 130+。'
				: '当前是 http 页面，浏览器只在 HTTPS 或 localhost 下开放 WebCodecs。换成 https 打开，或把本站加进 Chrome 的 insecure-origin 白名单。',
			false
		);
	}
}

function onServerMessage(msg) {
	switch (msg.t) {
		case 'hello':
			if (msg.current) $('#hud-title').textContent = msg.current.nickname || msg.current.name;
			if (msg.audio) state.audio?.configure(msg.audio);
			if (msg.state === 'streaming') hideOverlay();
			state.session = { state: msg.state, current: msg.current };
			updateStatusPill();
			break;

		case 'session':
			state.session = { state: msg.state, current: msg.current };
			updateStatusPill();
			if (msg.state === 'streaming') {
				hideOverlay();
				// AudioContext 可能因为自动播放策略被挂起
				if (state.audio && (!state.audio.ctx || state.audio.ctx.state !== 'running')) {
					$('#audio-unlock').classList.remove('hidden');
				}
			} else if (msg.state === 'connecting') {
				showOverlay('正在连接 PS5…', '握手需要几秒，请稍候。', true);
			}
			break;

		case 'audio':
			state.audio?.configure(msg.format);
			break;

		case 'pong':
			onPong(msg);
			break;

		case 'waking':
			showOverlay('正在唤醒 PS5…', '主机在待机，已发唤醒包，冷启动大约 30 秒，别关页面。', true);
			break;

		case 'nickname':
			if (msg.name) $('#hud-title').textContent = msg.name;
			break;

		case 'pin_request':
			openPinDialog(msg.incorrect);
			break;

		case 'rumble':
			state.input?.handleRumble(msg.left, msg.right);
			break;

		case 'stats':
			state.serverStats = msg;
			updateHudStats();
			break;

		case 'quit':
			showOverlay(
				msg.error ? '会话中断' : '会话已结束',
				`${msg.reason || ''}${msg.detail ? ' · ' + msg.detail : ''}`,
				false
			);
			break;

		case 'error':
			toast(msg.message, 'error', 6000);
			break;

		case 'stopping':
			showOverlay('正在结束会话…', '', true);
			break;

		case 'sleep_sent':
			toast('主机正在进入待机…', 'ok');
			break;

		case 'discovered':
			break;

		case 'bridge_exit':
			showOverlay('后台服务已退出', 'NAS 上的桥接进程挂了，检查容器日志。', false);
			break;

		default:
			break;
	}
}

function openPinDialog(incorrect) {
	const input = h('input', { placeholder: '8 位数字', inputmode: 'numeric', autocomplete: 'off' });

	openModal({
		title: 'PS5 要求输入配对 PIN',
		body: h('div', {}, [
			h('p', {
				text: incorrect
					? '上次的 PIN 不正确。请重新查看 PS5 屏幕上的「关联设备」PIN。'
					: 'PS5 屏幕上显示了 PIN，请输入。',
			}),
			input,
		]),
		dismissable: false,
		actions: [
			{
				label: '取消串流',
				value: false,
				onClick: () => {
					stopSession();
					return true;
				},
			},
			{
				label: '提交',
				primary: true,
				onClick: async () => {
					const pin = input.value.trim();
					if (!/^\d{4,10}$/.test(pin)) {
						toast('请输入数字 PIN', 'error');
						return false;
					}
					try {
						await api.sendPin(pin);
						toast('已提交 PIN', 'ok');
					} catch (err) {
						toast(err.message, 'error');
					}
					return true;
				},
			},
		],
	});
}

function sendPing() {
	if (!state.socket?.connected) return;
	state.socket.sendJson({ t: 'ping', ts: performance.now(), wall: Date.now() });
}

function onPong(msg) {
	if (typeof msg.echo !== 'number') return;

	const now = performance.now();
	state.rtt = Math.round(now - msg.echo);

	// 帧龄用的是 NAS 的时钟，两边不同步会算偏，这里估一个偏移量并平滑
	if (typeof msg.now === 'number' && typeof msg.wall === 'number') {
		const sample = msg.now - (msg.wall + (now - msg.echo) / 2);
		state.clockSkew = state.clockSkew ? state.clockSkew * 0.7 + sample * 0.3 : sample;
		if (state.video) state.video.clockSkew = state.clockSkew;
	}

	updateHudStats();
}

function updateHudStats() {
	const parts = [];
	const v = state.lastVideoStats;
	const s = state.serverStats;

	if (v) parts.push(`${v.fps} fps`);
	if (s?.kbps) parts.push(`${Math.round(s.kbps / 1000)} Mbps`);
	if (v?.displayAge) parts.push(`延迟 ${v.displayAge}ms`);
	if (state.rtt) parts.push(`RTT ${state.rtt}ms`);

	$('#hud-stats').textContent = parts.join(' · ') || '--';
	$('#hud-stats').title =
		'延迟 = 这一帧从 NAS 发到画到屏幕上；RTT = 浏览器到 NAS 的往返（网络部分）';
}

function showOverlay(title, text, spinner) {
	const overlay = $('#player-overlay');
	overlay.classList.remove('hidden');
	$('#overlay-title').textContent = title;
	$('#overlay-text').textContent = text || '';
	overlay.querySelector('.spinner').classList.toggle('hidden', !spinner);
	$('#btn-overlay-cancel').textContent = spinner ? '取消' : '返回';
}

function hideOverlay() {
	$('#player-overlay').classList.add('hidden');
}

async function stopSession() {
	try {
		await api.stop();
	} catch {
		/* ignore */
	}
	cleanupPlayer();
	await refreshState();
	showView('home');
}

function cleanupPlayer() {
	clearInterval(state.pingTimer);
	state.pingTimer = null;
	state.rtt = 0;

	state.socket?.close();
	state.socket = null;

	state.input?.stop();
	state.input = null;

	state.video?.destroy();
	state.video = null;

	state.audio?.destroy();
	state.audio = null;

	state.session = { state: 'idle' };
	state.serverStats = null;
	state.lastVideoStats = null;
	updateStatusPill();
	hideOverlay();
	$('#audio-unlock').classList.add('hidden');
}

/* ------------------------------------------------------------------ */
/* 画面手势：触摸板 / HUD 显隐 / 全屏                                    */
/* ------------------------------------------------------------------ */

function bindStageGestures(canvas) {
	const stage = $('#stage');
	let pointerId = null;
	let startX = 0;
	let startY = 0;
	let moving = false;

	const toTouchpad = (clientX, clientY) => {
		const rect = canvas.getBoundingClientRect();
		// canvas 是 object-fit: contain，需要换算到真实画面区域
		const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
		const w = canvas.width * scale;
		const hgt = canvas.height * scale;
		const ox = rect.left + (rect.width - w) / 2;
		const oy = rect.top + (rect.height - hgt) / 2;

		if (scale <= 0) return null;
		const x = (clientX - ox) / w;
		const y = (clientY - oy) / hgt;
		if (x < 0 || x > 1 || y < 0 || y > 1) return null;
		return { x: x * 1919, y: y * 1079 };
	};

	canvas.addEventListener('pointerdown', (e) => {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		pointerId = e.pointerId;
		startX = e.clientX;
		startY = e.clientY;
		moving = false;
		canvas.setPointerCapture(e.pointerId);
		pulseHud();
	});

	canvas.addEventListener('pointermove', (e) => {
		if (e.pointerId !== pointerId) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;

		if (!moving && Math.hypot(dx, dy) > 10) {
			moving = true;
			state.input?.setButton(BTN.TOUCHPAD, true);
		}

		if (moving) {
			const p = toTouchpad(e.clientX, e.clientY);
			if (p) state.input?.setTouch(0, p.x, p.y, true);
		}
	});

	const end = (e) => {
		if (e.pointerId !== pointerId) return;
		pointerId = null;

		if (moving) {
			state.input?.clearTouches();
			state.input?.setButton(BTN.TOUCHPAD, false);
			moving = false;
			return;
		}

		// 单击：切换 HUD
		const stageEl = $('#stage');
		$('#hud').classList.toggle('dim');
		stageEl.dataset.hudHidden = $('#hud').classList.contains('dim') ? '1' : '';
	};

	canvas.addEventListener('pointerup', end);
	canvas.addEventListener('pointercancel', end);

	stage.addEventListener('pointermove', () => pulseHud());
}

function pulseHud() {
	const hud = $('#hud');
	hud.classList.remove('dim');
	clearTimeout(state.hudTimer);
	state.hudTimer = setTimeout(() => {
		if (state.session?.state === 'streaming' && !window.matchMedia('(pointer: coarse)').matches) {
			hud.classList.add('dim');
		}
	}, 3000);
}

/* ------------------------------------------------------------------ */
/* 屏幕按键                                                            */
/* ------------------------------------------------------------------ */

function makeButton(label, bit, style, small = false, extraClass = '') {
	const el = h('div', {
		class: `tb ${small ? 'tb-small' : 'tb-face'} ${extraClass}`.trim(),
		style,
		text: label,
	});

	const press = (e) => {
		e.preventDefault();
		e.stopPropagation();
		try {
			el.setPointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
		el.classList.add('active');
		state.input?.setButton(bit, true);
		if (navigator.vibrate) navigator.vibrate(8);
	};

	const release = (e) => {
		e.preventDefault();
		el.classList.remove('active');
		state.input?.setButton(bit, false);
	};

	el.addEventListener('pointerdown', press);
	el.addEventListener('pointerup', release);
	el.addEventListener('pointercancel', release);
	el.addEventListener('lostpointercapture', release);

	return el;
}

function makeShoulder(label, bit, style) {
	const el = h('div', { class: 'tb tb-shoulder', style, text: label });

	const press = (e) => {
		e.preventDefault();
		e.stopPropagation();
		try {
			el.setPointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
		el.classList.add('active');
		state.input?.setButton(bit, true);
	};

	const release = (e) => {
		e.preventDefault();
		el.classList.remove('active');
		state.input?.setButton(bit, false);
	};

	el.addEventListener('pointerdown', press);
	el.addEventListener('pointerup', release);
	el.addEventListener('pointercancel', release);
	el.addEventListener('lostpointercapture', release);

	return el;
}

function makeTrigger(label, which, style) {
	const el = h('div', { class: 'tb tb-shoulder', style, text: label });

	const press = (e) => {
		e.preventDefault();
		el.setPointerCapture?.(e.pointerId);
		el.classList.add('active');
		state.input?.setTrigger(which, 255);
	};

	const release = (e) => {
		e.preventDefault();
		el.classList.remove('active');
		state.input?.setTrigger(which, 0);
	};

	el.addEventListener('pointerdown', press);
	el.addEventListener('pointerup', release);
	el.addEventListener('pointercancel', release);
	el.addEventListener('lostpointercapture', release);

	return el;
}

function makeStick(which, style) {
	const knob = h('div', { class: 'tb-knob' });
	const el = h('div', { class: 'tb tb-stick', style }, [knob]);

	let activeId = null;
	const radius = 44;

	const update = (e) => {
		const rect = el.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		let dx = e.clientX - cx;
		let dy = e.clientY - cy;
		const dist = Math.hypot(dx, dy);
		if (dist > radius) {
			dx = (dx / dist) * radius;
			dy = (dy / dist) * radius;
		}
		knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
		state.input?.setStick(which, dx / radius, dy / radius);
	};

	el.addEventListener('pointerdown', (e) => {
		e.preventDefault();
		e.stopPropagation();
		activeId = e.pointerId;
		el.setPointerCapture(e.pointerId);
		el.classList.add('active');
		update(e);
	});

	el.addEventListener('pointermove', (e) => {
		if (e.pointerId !== activeId) return;
		e.preventDefault();
		update(e);
	});

	const end = (e) => {
		if (e.pointerId !== activeId) return;
		activeId = null;
		el.classList.remove('active');
		knob.style.transform = 'translate(-50%, -50%)';
		state.input?.setStick(which, 0, 0);
	};

	el.addEventListener('pointerup', end);
	el.addEventListener('pointercancel', end);
	el.addEventListener('lostpointercapture', end);

	return el;
}

function buildTouchUI() {
	const ui = $('#touch-ui');
	ui.innerHTML = '';

	ui.append(makeStick('left', 'left:14px;bottom:14px;'));
	ui.append(makeStick('right', 'right:14px;bottom:14px;'));

	// 面板键（菱形）
	ui.append(
		makeButton('△', BTN.TRIANGLE, 'right:104px;bottom:186px;'),
		makeButton('○', BTN.CIRCLE, 'right:34px;bottom:186px;'),
		makeButton('✕', BTN.CROSS, 'right:104px;bottom:116px;'),
		makeButton('□', BTN.SQUARE, 'right:174px;bottom:116px;')
	);

	// 肩键
	ui.append(
		makeTrigger('L2', 'l2', 'left:14px;top:74px;'),
		makeShoulder('L1', BTN.L1, 'left:96px;top:74px;'),
		makeShoulder('R1', BTN.R1, 'right:96px;top:74px;'),
		makeTrigger('R2', 'r2', 'right:14px;top:74px;')
	);

	// 中间的功能键
	const center = h('div', {
		style:
			'position:absolute;left:50%;transform:translateX(-50%);bottom:16px;display:flex;gap:8px;pointer-events:auto;',
	});
	center.append(
		makeButton('PS', BTN.PS, '', true, 'tb-inline'),
		makeButton('选项', BTN.OPTIONS, '', true, 'tb-inline'),
		makeButton('分享', BTN.SHARE, '', true, 'tb-inline'),
		makeButton('触摸板', BTN.TOUCHPAD, '', true, 'tb-inline')
	);
	ui.append(center);
}

function setTouchVisible(visible) {
	state.touchVisible = visible;
	$('#touch-ui').classList.toggle('hidden', !visible);
}

/* ------------------------------------------------------------------ */
/* 弹窗：日志 / 键盘                                                    */
/* ------------------------------------------------------------------ */

async function openLogs() {
	const list = h('div', { class: 'log-list' });
	state.logCursor = 0;

	const body = h('div', {}, [list]);

	const poll = async () => {
		try {
			const res = await api.logs(state.logCursor);
			for (const entry of res.logs) {
				state.logCursor = Math.max(state.logCursor, entry.id);
				const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false });
				list.append(
					h('div', { class: `log-line ${entry.level}`, text: `${time} ${entry.text}` })
				);
			}
			list.scrollTop = list.scrollHeight;
		} catch {
			/* ignore */
		}
	};

	await poll();
	state.logsTimer = setInterval(poll, 1500);

	const result = await openModal({
		title: '运行日志',
		body,
		actions: [{ label: '关闭', primary: true, value: true }],
	});

	clearInterval(state.logsTimer);
	state.logsTimer = null;
	return result;
}

function openKeysHelp() {
	const rows = [
		['方向键', '十字键'],
		['W A S D', '左摇杆'],
		['K / L / J / I', '✕ / ○ / □ / △'],
		['Q / E', 'L1 / R1'],
		['1 / 3', 'L2 / R2'],
		['U / O', 'L3 / R3'],
		['Enter', 'Options'],
		['Backspace', 'Share'],
		['Tab', '触摸板按下'],
		['P', 'PS 键'],
		['鼠标拖动', '触摸板滑动'],
	];

	const table = h('table', { class: 'kbd-table' });
	for (const [key, action] of rows) {
		table.append(h('tr', {}, [h('td', {}, [h('kbd', { text: key })]), h('td', { text: action })]));
	}

	openModal({
		title: '键盘 / 鼠标映射',
		body: table,
		actions: [{ label: '知道了', primary: true, value: true }],
	});
}

/* ------------------------------------------------------------------ */
/* 绑定                                                                */
/* ------------------------------------------------------------------ */

function bindStatic() {
	$('#login-form').addEventListener('submit', onLoginSubmit);

	$('#btn-logout').addEventListener('click', async () => {
		await api.logout();
		location.reload();
	});

	$('#btn-logs').addEventListener('click', openLogs);
	$('#btn-discover').addEventListener('click', onDiscover);
	$('#add-form').addEventListener('submit', onAddHost);

	$('#btn-stop').addEventListener('click', stopSession);
	$('#btn-overlay-cancel').addEventListener('click', stopSession);

	$('#btn-fullscreen').addEventListener('click', async () => {
		const stage = $('#stage');
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await stage.requestFullscreen();
		} catch (err) {
			toast('无法进入全屏：' + err.message, 'error');
		}
	});

	$('#btn-touch').addEventListener('click', () => {
		setTouchVisible(!state.touchVisible);
		toast(state.touchVisible ? '屏幕按键已开启' : '屏幕按键已关闭');
	});

	$('#btn-keys').addEventListener('click', openKeysHelp);

	$('#btn-sleep').addEventListener('click', async () => {
		const ok = await openModal({
			title: '让 PS5 进入待机？',
			body: '主机会切到休息模式，串流会断开。下次回来点「唤醒」就行。',
			actions: [
				{ label: '取消', value: false },
				{ label: '待机', primary: true, value: true },
			],
		});
		if (!ok) return;
		try {
			await api.sleep();
			toast('已发送待机命令');
		} catch (err) {
			toast(err.message, 'error');
		}
	});

	$('#btn-audio').addEventListener('click', async () => {
		if (!state.audio) return;
		const next = !state.audio.muted;
		state.audio.setMuted(next);
		$('#btn-audio').textContent = next ? '🔇' : '🔊';
	});

	$('#audio-unlock').addEventListener('click', async () => {
		await state.audio?.enable();
		$('#audio-unlock').classList.add('hidden');
	});

	window.addEventListener('beforeunload', () => {
		state.socket?.close();
	});

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible' && state.video) state.video.requestKeyframe();
	});
}

async function main() {
	bindStatic();

	if (!window.isSecureContext) showInsecureBanner();

	if (!VideoPipeline.supported) {
		toast(
			window.isSecureContext
				? '这个浏览器不支持 WebCodecs，请用 Chrome / Edge 94+、Safari 16.4+ 或 Firefox 130+'
				: '当前是 http 页面，浏览器禁用了 WebCodecs（会黑屏）。请用 https 打开本站。',
			'error',
			9000
		);
	}

	$('#login-foot').textContent = '首次启动的密码打印在容器日志里，也可以用 PS5WEB_PASSWORD 指定。';

	try {
		await refreshState();
		showView('home');
		if (state.session.state === 'streaming') {
			toast('NAS 上还有正在进行的串流');
		}
	} catch (err) {
		showView('login');
	}
}

main();

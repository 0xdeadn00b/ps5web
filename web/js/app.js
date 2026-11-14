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
	layout: null,
	logsTimer: null,
	logCursor: 0,
	lastVideoAt: 0,
	stallTimer: null,
};

/* ---------------------------- 按键布局 ---------------------------- */

const LAYOUT_KEY = 'ps5web.layout';
const LAYOUT_DEFAULT = { ctl: 1, inset: 1, dpad: true, rumble: 'auto' };

function loadLayout() {
	try {
		const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
		return { ...LAYOUT_DEFAULT, ...(raw && typeof raw === 'object' ? raw : {}) };
	} catch {
		return { ...LAYOUT_DEFAULT };
	}
}

function applyLayout() {
	const ui = document.querySelector('#touch-ui');
	if (!ui || !state.layout) return;
	ui.style.setProperty('--ctl-scale', String(state.layout.ctl));
	ui.style.setProperty('--inset-scale', String(state.layout.inset));
	ui.classList.toggle('hide-dpad', !state.layout.dpad);
}

function saveLayout(patch) {
	state.layout = { ...state.layout, ...patch };
	try {
		localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.layout));
	} catch {
		/* 隐私模式下 localStorage 会抛错，忽略 */
	}
	applyLayout();
}

state.layout = loadLayout();

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
	updateResumeBar();
}

function updateResumeBar() {
	const busy = state.session?.state === 'streaming' || state.session?.state === 'connecting';
	$('#resume-bar').classList.toggle('hidden', !busy);
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

/* ---------------------------- 画质记忆 ---------------------------- */

const QUALITY_KEY = 'ps5web.quality';

function loadQuality() {
	let saved = null;
	try {
		saved = JSON.parse(localStorage.getItem(QUALITY_KEY) || 'null');
	} catch {
		/* ignore */
	}
	const base = {
		resolution: state.defaults.resolution || '1080p',
		fps: Number(state.defaults.fps || 60),
		bitrate: Number(state.defaults.bitrate || 18000),
	};
	if (!saved || typeof saved !== 'object') return base;
	return {
		resolution: typeof saved.resolution === 'string' ? saved.resolution : base.resolution,
		fps: Number(saved.fps) || base.fps,
		bitrate: Number(saved.bitrate) || base.bitrate,
	};
}

function saveQuality(q) {
	try {
		localStorage.setItem(QUALITY_KEY, JSON.stringify(q));
	} catch {
		/* 隐私模式忽略 */
	}
}

function openStartDialog(host) {
	const remembered = loadQuality();

	const resChips = chipGroup(
		[
			{ value: '1080p', label: '1080p' },
			{ value: '720p', label: '720p' },
			{ value: '540p', label: '540p' },
		],
		remembered.resolution
	);

	const fpsChips = chipGroup(
		[
			{ value: '60', label: '60 fps' },
			{ value: '30', label: '30 fps' },
		],
		String(remembered.fps)
	);

	const bitrateChips = chipGroup(
		[8000, 12000, 18000, 25000, 35000, 50000].map((v) => ({
			value: v,
			label: `${v / 1000} Mbps`,
		})),
		String(remembered.bitrate),
		{ columns: 3 }
	);

	const body = h('div', {}, [
		h('p', {
			class: 'muted small',
			text: '码率越高画质越好，但上行带宽要跟上。远程玩建议 12–18 Mbps。选完会记住，下次默认还是这套。',
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
					const quality = {
						resolution: resChips.value,
						fps: Number(fpsChips.value),
						bitrate: Number(bitrateChips.value),
					};
					saveQuality(quality);
					startSession(host, quality);
					return true;
				},
			},
		],
	});
}

/* ---------------------------- 按键布局 ---------------------------- */

function openLayoutDialog() {
	const size = chipGroup(
		[
			{ value: 0.85, label: '小' },
			{ value: 1, label: '标准' },
			{ value: 1.2, label: '大' },
		],
		state.layout.ctl
	);
	const inset = chipGroup(
		[
			{ value: 0.6, label: '贴边' },
			{ value: 1, label: '适中' },
			{ value: 1.8, label: '靠里' },
			{ value: 2.6, label: '很靠里' },
		],
		state.layout.inset,
		{ columns: 4 }
	);
	const dpad = chipGroup(
		[
			{ value: 'on', label: '显示' },
			{ value: 'off', label: '隐藏' },
		],
		state.layout.dpad ? 'on' : 'off'
	);
	const rumble = chipGroup(
		[
			{ value: 'auto', label: '自动' },
			{ value: 'off', label: '关闭' },
		],
		state.layout.rumble || 'auto'
	);

	// 点一下立刻生效，边看边调
	size.addEventListener('click', () => saveLayout({ ctl: Number(size.value) }));
	inset.addEventListener('click', () => saveLayout({ inset: Number(inset.value) }));
	dpad.addEventListener('click', () => saveLayout({ dpad: dpad.value === 'on' }));
	rumble.addEventListener('click', () => saveLayout({ rumble: rumble.value }));

	const body = h('div', {}, [
		h('p', {
			class: 'muted',
			text: '改完立刻生效，只存在这台设备上。摇杆在下方，十字键和面板键在各自摇杆的正上方。',
		}),
		h('div', { class: 'quality-row' }, [h('span', { text: '按键大小' }), size]),
		h('div', { class: 'quality-row' }, [h('span', { text: '离边距离' }), inset]),
		h('div', { class: 'quality-row' }, [h('span', { text: '十字键' }), dpad]),
		h('div', { class: 'quality-row' }, [h('span', { text: '震动反馈' }), rumble]),
		h('p', {
			class: 'muted small',
			text: canVibrate
				? '手柄震动会同时带动手机振一下（幅度没法调，只能用长短区分）。'
				: 'iPhone 的浏览器没有震动 API（WebKit 从没实现），这里用屏幕边缘的柔光代替。',
		}),
		h('button', {
			class: 'ghost',
			type: 'button',
			text: '恢复默认',
			onclick: () => {
				saveLayout({ ...LAYOUT_DEFAULT });
				toast('已恢复默认布局');
			},
		}),
	]);

	openModal({
		title: '按键布局',
		body,
		actions: [{ label: '完成', primary: true, value: true }],
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
		if (err.status === 409) {
			// 多半是刚刷新过页面：NAS 上的会话还在，直接接回去比重新开一个快得多
			await refreshState().catch(() => {});
			showOverlay('NAS 上已有会话', '选「接入」继续这个会话，或「结束旧的重开」。', false);
			openModal({
				title: 'NAS 上已有串流',
				body: '可能是另一个标签页／设备，也可能是你刚刷新过页面。直接接入可以继续用同一个会话，不需要重新唤醒 PS5。',
				actions: [
					{ label: '取消', value: false },
					{
						label: '结束旧的重开',
						onClick: async () => {
							await api.stop().catch(() => {});
							await refreshState().catch(() => {});
							startSession(host, opts);
							return true;
						},
					},
					{
						label: '接入',
						primary: true,
						onClick: () => {
							attachSession();
							return true;
						},
					},
				],
			});
			return;
		}

		toast(err.message, 'error', 6000);
		showOverlay('无法开始串流', err.message, false);
	}
}

// 接回 NAS 上还在跑的会话：不调用 start，只是让浏览器作为观看者接上
function attachSession() {
	const cur = state.session?.current || {};
	const host =
		state.hosts.find((x) => x.id === cur.hostId) ||
		state.hosts.find((x) => x.name === cur.name) ||
		state.hosts[0] ||
		{ id: cur.hostId, name: cur.name || 'PS5' };

	state.currentHost = host;
	$('#resume-bar').classList.add('hidden');

	showView('player');
	preparePlayer();

	state.audio.enable().then((ok) => {
		if (!ok) toast('浏览器不支持 WebCodecs 音频解码，本次没有声音', 'error', 5000);
	});

	showOverlay('正在接回串流…', '主机不会被重新唤醒，画面应该几秒内就回来。', true);
	$('#hud-title').textContent = cur.nickname || cur.name || host.name;

	// 接回来但如果 8 秒还没有任何一帧，多半是这个会话已经死了：
	// 直接告诉用户怎么脱身，别让人对着黑屏发呆
	clearTimeout(state.attachTimer);
	state.attachTimer = setTimeout(() => {
		if (state.session?.state !== 'streaming') return;
		if (state.lastVideoAt && performance.now() - state.lastVideoAt < 5000) return;
		showOverlay(
			'接回来了，但没有画面',
			'这个会话可能已经断了。点下面的按钮结束它，再回上一页重新开始串流。',
			false
		);
		$('#btn-overlay-cancel').textContent = '结束这个会话';
	}, 8000);
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
		onStats: ({ fps, queue, arriveAge, displayAge, hardware, drops }) => {
			state.lastVideoStats = { fps, queue, arriveAge, displayAge, hardware, drops };
			state.lastVideoAt = performance.now();
			updateHudStats();

			// 画面比例变了要重算竖屏下的布局（stage 高度 = 屏高 - 画面高）
			const v = state.video;
			if (v?.width && v?.height) {
				const aspect = v.width / v.height;
				if (Math.abs(aspect - (state.videoAspect || 0)) > 0.001) {
					state.videoAspect = aspect;
					document.documentElement.style.setProperty('--video-aspect', String(aspect));
					updatePadZone();
				}
			}
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

		window.addEventListener('resize', updatePadZone);
		window.addEventListener('orientationchange', () => setTimeout(updatePadZone, 250));
	}

	updatePadZone();

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
			else if (msg.state === 'idle') {
				// 接回来的时候会话其实已经结束了
				showOverlay('这个会话已经结束了', '回上一页点「开始串流」重新连一次。', false);
			}
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
			phoneRumble(msg.left, msg.right);
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

	// 把原始指标打到服务端日志，排查时不用开 DevTools
	if (state.lastVideoStats) {
		state.socket.sendJson({
			t: 'diag',
			...state.lastVideoStats,
			rtt: state.rtt,
			skew: Math.round(state.clockSkew || 0),
			viewers: state.serverStats?.viewers,
		});
	}
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
	if (v?.processMs !== undefined) parts.push(`处理 ${v.processMs}ms`);
	if (v?.arriveAge) parts.push(`传输 ${v.arriveAge}ms`);
	if (state.rtt) parts.push(`RTT ${state.rtt}ms`);
	if (v?.queue !== undefined) parts.push(`队列 ${v.queue}`);

	$('#hud-stats').textContent = parts.join(' · ') || '--';
	$('#hud-stats').title =
		'处理 = 从浏览器收到这一帧到画到屏幕（纯本地时钟，最可信）\n' +
		'传输 = 帧从 NAS 到你浏览器（依赖两边时钟同步，仅供参考）\n' +
		'RTT = 往返时延；队列 = 待解码帧数\n' +
		`解码器: ${state.lastVideoStats?.hardware ? '已请求硬解' : '默认'}，跳过关键帧次数: ${state.lastVideoStats?.drops ?? 0}`;
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
	clearInterval(state.stallTimer);
	state.pingTimer = null;
	state.stallTimer = null;
	state.lastVideoAt = 0;
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
	const surface = $('#view-player'); // 手势层要覆盖整屏：竖屏时按键在下半屏
	const active = new Map(); // pointerId -> 本次按下的状态（支持双手同时操作）
	let padTapTimer = 0;

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

	// 区域划分（相对画面归一化坐标）：
	//   下半屏左右两侧 = 左右摇杆（浮动，按到哪就以哪为中心）
	//   中间 32%x44%   = 触摸板，避开十字键和面板键
	//   其余（主要是顶部）= 轻点切换顶栏
	const zoneOf = (clientX, clientY) => {
		const rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) return 'none';
		const nx = (clientX - rect.left) / rect.width;
		const ny = (clientY - rect.top) / rect.height;

		const uiHidden = $('#touch-ui').classList.contains('hidden');
		const portrait = rect.height > rect.width;

		if (!uiHidden) {
			if (portrait) {
				// 竖屏：下半屏左右两侧给摇杆，上半屏是画面
				if (ny > 0.5 && nx < 0.36) return 'left';
				if (ny > 0.5 && nx > 0.64) return 'right';
			} else {
				if (ny > 0.42 && nx < 0.34) return 'left';
				if (ny > 0.42 && nx > 0.66) return 'right';
			}
		}

		if (portrait) {
			// 竖屏：落在画面范围内才算触摸板
			return toTouchpad(clientX, clientY) ? 'pad' : 'none';
		}

		if (nx >= 0.34 && nx <= 0.66 && ny >= 0.28 && ny <= 0.72) return 'pad';
		return 'none';
	};

	surface.addEventListener('pointerdown', (e) => {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		// 顶栏、弹窗、按钮上的点击不算手势
		if (e.target.closest && e.target.closest('button, .hud, .overlay, .modal-backdrop, input, select')) return;
		surface.setPointerCapture(e.pointerId);

		const rec = {
			kind: zoneOf(e.clientX, e.clientY),
			startX: e.clientX,
			startY: e.clientY,
			startAt: performance.now(),
			moved: false,
			wasDim: $('#hud').classList.contains('dim'),
		};
		active.set(e.pointerId, rec);
		pulseHud();

		if (rec.kind === 'left' || rec.kind === 'right') {
			const stick = state.sticks?.[rec.kind];
			if (stick && !stick.active) {
				rec.stick = rec.kind;
				stickBegin(stick, e.pointerId, e.clientX, e.clientY);
			} else {
				rec.kind = 'dead'; // 这根摇杆已经被另一只手占了
			}
			return;
		}

		if (rec.kind === 'pad') {
			const p = toTouchpad(e.clientX, e.clientY);
			if (p) {
				rec.touching = true;
				state.input?.setTouch(0, p.x, p.y, true);
				$('#pad-zone').classList.add('on');
			} else {
				rec.kind = 'dead';
			}
		}
	});

	surface.addEventListener('pointermove', (e) => {
		const rec = active.get(e.pointerId);
		if (!rec) return;

		if (!rec.moved && Math.hypot(e.clientX - rec.startX, e.clientY - rec.startY) > 10) rec.moved = true;

		if (rec.stick) {
			stickMove(state.sticks[rec.stick], e.clientX, e.clientY);
			return;
		}

		if (rec.touching) {
			const p = toTouchpad(e.clientX, e.clientY);
			if (p) state.input?.setTouch(0, p.x, p.y, true);
		}
	});

	const end = (e) => {
		const rec = active.get(e.pointerId);
		if (!rec) return;
		active.delete(e.pointerId);

		if (rec.stick) {
			stickEnd(state.sticks[rec.stick]);
			return;
		}

		if (rec.touching) {
			$('#pad-zone').classList.remove('on');
			const held = performance.now() - rec.startAt;

			if (rec.moved || held > 400) {
				// 滑动 / 长按松开：只结束触摸，不按下
				state.input?.clearTouches();
			} else {
				// 轻点中间 = 按下触摸板
				clearTimeout(padTapTimer);
				state.input?.setButton(BTN.TOUCHPAD, true);
				padTapTimer = setTimeout(() => {
					state.input?.setButton(BTN.TOUCHPAD, false);
					state.input?.clearTouches();
				}, 60);
			}
			return;
		}

		if (rec.kind === 'dead' || rec.moved) return;

		// 其余区域：原本隐藏的 → 显示出来并保持 3 秒；原本显示的 → 收起来
		if (rec.wasDim) {
			pulseHud();
		} else {
			$('#hud').classList.add('dim');
		}
		$('#stage').dataset.hudHidden = $('#hud').classList.contains('dim') ? '1' : '';
	};

	surface.addEventListener('pointerup', end);
	surface.addEventListener('pointercancel', end);

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

// 现代手游那种浮动摇杆：按下时摇杆整体挪到手指位置，
// 手指就是不动点，往哪个方向拉就往哪走。松手弹回原位。
function makeStick(which, style) {
	const knob = h('div', { class: 'tb-knob' });
	const el = h('div', { class: 'tb tb-stick', style }, [knob]);
	return { side: which, el, knob, active: false, pointerId: null, baseX: 0, baseY: 0 };
}

function stickBegin(stick, pointerId, clientX, clientY) {
	stick.el.style.transform = '';
	const rect = stick.el.getBoundingClientRect();
	const w = rect.width || 100;

	// 夹在屏幕内，别让底座跑出去一半
	const m = w * 0.5;
	const bx = Math.min(window.innerWidth - m, Math.max(m, clientX));
	const by = Math.min(window.innerHeight - m, Math.max(m, clientY));

	const homeX = rect.left + w / 2;
	const homeY = rect.top + rect.height / 2;

	stick.active = true;
	stick.pointerId = pointerId;
	stick.baseX = bx;
	stick.baseY = by;
	stick.el.style.transform = `translate(${bx - homeX}px, ${by - homeY}px)`;
	stick.el.classList.add('active');
	stickMove(stick, bx, by);
}

function stickMove(stick, clientX, clientY) {
	const rect = stick.el.getBoundingClientRect();
	const radius = Math.max(30, (rect.width || 100) * 0.36);

	let dx = clientX - stick.baseX;
	let dy = clientY - stick.baseY;
	const dist = Math.hypot(dx, dy);
	if (dist > radius) {
		dx = (dx / dist) * radius;
		dy = (dy / dist) * radius;
	}

	stick.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
	state.input?.setStick(stick.side, dx / radius, dy / radius);
}

function stickEnd(stick) {
	if (!stick || !stick.active) return;
	stick.active = false;
	stick.pointerId = null;
	stick.el.classList.remove('active');
	stick.el.style.transform = '';
	stick.knob.style.transform = 'translate(-50%, -50%)';
	state.input?.setStick(stick.side, 0, 0);
}

/* ---------------------------- 震动 ---------------------------- */

// Android 的 navigator.vibrate 能真振；iOS（含 Firefox/Chrome，都是 WebKit）
// 从来没有实现过 Vibration API，只能用边缘柔光代替。
const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
let lastBuzzAt = 0;
let glowTimer = 0;

function phoneRumble(left, right) {
	if (state.layout?.rumble === 'off') return;

	const strength = Math.max(left || 0, right || 0);
	if (strength < 24) return;

	const now = performance.now();
	if (now - lastBuzzAt < 90) return;
	lastBuzzAt = now;

	if (canVibrate) {
		// 震动强度没法调，只能用时长表达强弱
		const ms = Math.round(8 + (strength / 255) * 34);
		try {
			navigator.vibrate(ms);
		} catch {
			/* ignore */
		}
		return;
	}

	const glow = $('#rumble-glow');
	if (!glow) return;
	glow.style.opacity = String(Math.min(0.9, 0.22 + (strength / 255) * 0.65));
	clearTimeout(glowTimer);
	glowTimer = setTimeout(() => {
		glow.style.opacity = '0';
	}, 110);
}

/* ---------------------------- 触摸板提示框 ---------------------------- */

// 竖屏时画面在上半屏，虚线框要正好贴在画面上；横屏是固定居中的 32%×44%
function updatePadZone() {
	const zone = $('#pad-zone');
	const surface = $('#view-player');
	const canvas = $('#screen');
	if (!zone || !surface || !canvas) return;

	const sr = surface.getBoundingClientRect();
	if (sr.height <= sr.width) {
		zone.style.left = '50%';
		zone.style.top = '50%';
		zone.style.width = '32%';
		zone.style.height = '44%';
		zone.style.transform = 'translate(-50%, -50%)';
		return;
	}

	const rect = canvas.getBoundingClientRect();
	if (!canvas.width || !canvas.height || !rect.width) return;
	const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
	const w = canvas.width * scale;
	const h = canvas.height * scale;

	zone.style.left = `${rect.left - sr.left + (rect.width - w) / 2}px`;
	zone.style.top = `${rect.top - sr.top + (rect.height - h) / 2}px`;
	zone.style.width = `${w}px`;
	zone.style.height = `${h}px`;
	zone.style.transform = 'none';
}

/* ---------------------------- 全屏 ---------------------------- */

// iPhone 上的浏览器（包括 iOS 版 Firefox、Chrome，它们都是 WebKit 内核）
// 没有 Element.requestFullscreen，只能自己模拟一个「沉浸模式」。
function nativeFullscreenAvailable() {
	const el = document.documentElement;
	return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen);
}

function fullscreenElement() {
	return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function immersiveOn() {
	return document.body.classList.contains('immersive');
}

function tryLockLandscape() {
	// Android Chrome 支持；iOS 会直接抛错，忽略即可
	try {
		screen.orientation?.lock?.('landscape')?.catch?.(() => {});
	} catch {
		/* ignore */
	}
}

async function toggleFullscreen() {
	const stage = $('#stage');

	if (!nativeFullscreenAvailable()) {
		const on = document.body.classList.toggle('immersive');
		state.immersive = on;
		if (on) {
			tryLockLandscape();
			toast('已进入沉浸模式。iPhone 上要真正的全屏（没有地址栏），请用「分享 → 添加到主屏幕」，从图标打开。', '', 9000);
		}
		return;
	}

	try {
		if (fullscreenElement()) {
			await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
		} else {
			const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
			await req.call(stage);
			tryLockLandscape();
		}
	} catch (err) {
		// 原生全屏被拒绝（有些浏览器要求用户手势、或策略禁止）时退回沉浸模式
		const on = document.body.classList.toggle('immersive');
		state.immersive = on;
		if (on) toast('系统不允许网页全屏，已切换到沉浸模式：' + (err?.message || 'unknown'), '', 6000);
	}
}

function buildTouchUI() {
	const ui = $('#touch-ui');
	ui.innerHTML = '';

	const leftStick = makeStick('left', 'left:var(--inset-x);bottom:var(--inset-y);');
	const rightStick = makeStick('right', 'right:var(--inset-x);bottom:var(--inset-y);');
	state.sticks = { left: leftStick, right: rightStick };
	ui.append(leftStick.el, rightStick.el);

	// 十字键：在左摇杆正上方
	const dpad = h('div', { class: 'pad-dpad' });
	dpad.append(
		makeButton('▲', BTN.DPAD_UP, '', false, 'd-u'),
		makeButton('◀', BTN.DPAD_LEFT, '', false, 'd-l'),
		makeButton('▶', BTN.DPAD_RIGHT, '', false, 'd-r'),
		makeButton('▼', BTN.DPAD_DOWN, '', false, 'd-d')
	);
	ui.append(dpad);

	// 面板键：九宫格摆成十字，和手柄一致 —— △上 ○右 ✕下 □左
	const face = h('div', { class: 'pad-face' });
	face.append(
		makeButton('△', BTN.TRIANGLE, '', false, 'f-t f-tri'),
		makeButton('○', BTN.CIRCLE, '', false, 'f-r f-cir'),
		makeButton('✕', BTN.CROSS, '', false, 'f-b f-cro'),
		makeButton('□', BTN.SQUARE, '', false, 'f-l f-squ')
	);
	ui.append(face);

	// 肩键
	ui.append(
		makeTrigger('L2', 'l2', 'left:var(--inset-x);top:74px;'),
		makeShoulder('L1', BTN.L1, 'left:calc(var(--inset-x) + 78px);top:74px;'),
		makeShoulder('R1', BTN.R1, 'right:calc(var(--inset-x) + 78px);top:74px;'),
		makeTrigger('R2', 'r2', 'right:var(--inset-x);top:74px;')
	);

	// 中间的功能键
	const center = h('div', {
		style:
			'position:absolute;left:50%;transform:translateX(-50%);bottom:calc(var(--inset-y) + 2px);display:flex;gap:8px;pointer-events:auto;max-width:56vw;flex-wrap:wrap;justify-content:center;',
	});
	// 顺序按手柄：分享 - PS - 选项；触摸板不在这里（点画面中间就是按下触摸板）
	center.append(
		makeButton('分享', BTN.SHARE, '', true, 'tb-inline'),
		makeButton('PS', BTN.PS, '', true, 'tb-inline'),
		makeButton('选项', BTN.OPTIONS, '', true, 'tb-inline')
	);
	ui.append(center);

	applyLayout();
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

/* ------------------------------------------------------------------ */
/* 双击缩放防护（iOS Safari）                                           */
/* ------------------------------------------------------------------ */

// iOS 从 10 开始就忽略 viewport 里的 user-scalable=no，
// 双击页面任何地方都会把整个页面放大，而且游戏页是 fixed 布局，放大了退不回去。
// 这里把 320ms 内的第二次轻点吃掉；pointerdown/up 已经先触发过，按键不受影响。
function bindTapZoomGuard() {
	let lastTouchEndAt = 0;
	let lastX = 0;
	let lastY = 0;

	// 已经被放大了就别拦，留给系统缩回去，否则会卡在放大状态
	const zoomed = () => (window.visualViewport?.scale || 1) > 1.01;

	// Safari 的缩放是在 touchstart 决定的，只拦 touchend 没用。
	// 第二次按下的瞬间就 preventDefault，缩放不会发生；
	// 代价只是这一下不合成 click（按键走 pointer 事件，不受影响）。
	document.addEventListener(
		'touchstart',
		(e) => {
			if (e.touches.length > 1) return;
			const t = e.changedTouches[0];
			if (!t) return;
			const near = Math.hypot(t.clientX - lastX, t.clientY - lastY) < 40;
			if (Date.now() - lastTouchEndAt < 320 && near && !zoomed()) {
				e.preventDefault();
			}
		},
		{ passive: false }
	);

	document.addEventListener(
		'touchend',
		(e) => {
			if (e.touches.length > 0) return;
			const t = e.changedTouches[0];
			if (!t) return;
			lastTouchEndAt = Date.now();
			lastX = t.clientX;
			lastY = t.clientY;
		},
		{ passive: true }
	);

	// 播放页里连双指缩放也禁掉（Safari 专有事件）
	document.addEventListener(
		'gesturestart',
		(e) => {
			if (!$('#view-player').classList.contains('hidden') && !zoomed()) e.preventDefault();
		},
		{ passive: false }
	);

	// 万一还是被放大了，给一个明确的还原入口（重新加载会重置缩放）
	const vv = window.visualViewport;
	if (vv) {
		const sync = () => {
			const btn = $('#zoom-reset');
			if (btn) btn.classList.toggle('hidden', vv.scale <= 1.05);
		};
		vv.addEventListener('resize', sync);
		vv.addEventListener('scroll', sync);
		window.addEventListener('pageshow', sync);
		sync();
		// iOS 有时候要等布局稳定才更新 scale，多点几次没坏处
		for (const ms of [200, 600, 1500, 3000]) setTimeout(sync, ms);
	}
}

function bindStatic() {
	bindTapZoomGuard();

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

	$('#btn-fullscreen').addEventListener('click', toggleFullscreen);

	$('#btn-touch').addEventListener('click', () => {
		setTouchVisible(!state.touchVisible);
		toast(state.touchVisible ? '屏幕按键已开启' : '屏幕按键已关闭');
	});

	$('#btn-layout').addEventListener('click', openLayoutDialog);

	$('#zoom-reset').addEventListener('click', () => location.reload());

	$('#btn-resume').addEventListener('click', attachSession);
	$('#btn-resume-stop').addEventListener('click', async () => {
		try {
			await api.stop();
			toast('已结束 NAS 上的会话');
		} catch (err) {
			toast(err.message, 'error');
		}
		$('#resume-bar').classList.add('hidden');
		await refreshState().catch(() => {});
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

	// 切到控制中心 / 锁屏 / 切 Tab 之后回来，iOS 会把 WebCodecs 和
	// AudioContext 一并冻住，只补一个关键帧是救不回来的，必须重建解码链路。
	let hiddenAt = 0;
	const onHidden = () => {
		hiddenAt = performance.now();
		state.lastVideoAt = 0;
	};
	const onVisible = () => {
		if (!hiddenAt) return;
		hiddenAt = 0;
		if (state.session?.state !== 'streaming' && state.session?.state !== 'connecting') return;

		try {
			state.audio?.enable?.();
		} catch {
			/* AudioContext 可能已经失效，忽略 */
		}
		state.video?.reset('页面回到前台');
		state.lastVideoAt = performance.now();
		if (state.socket && !state.socket.alive) state.socket.connect();
	};

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) onHidden();
		else onVisible();
	});
	window.addEventListener('pageshow', onVisible);
	window.addEventListener('focus', onVisible);

	// 看门狗：串流中如果 3 秒没画出任何一帧，自动重建解码器。
	// 覆盖「控制中心回来黑屏」「解码器卡死」这类不会抛错的情况。
	clearInterval(state.stallTimer);
	state.stallTimer = setInterval(() => {
		if (document.hidden) return;
		if (state.session?.state !== 'streaming') return;
		if (!state.lastVideoAt) {
			state.lastVideoAt = performance.now();
			return;
		}
		if (performance.now() - state.lastVideoAt > 3000) {
			state.lastVideoAt = performance.now();
			console.warn('[video] 3 秒没有新帧，重建解码器');
			state.video?.reset('画面停滞');
			if (state.socket && !state.socket.alive) state.socket.connect();
		}
	}, 1000);
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
	} catch (err) {
		showView('login');
	}
}

main();

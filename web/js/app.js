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
	// 观战模式
	mode: null, // null | 'pip' | 'watch' | 'control'
	controlMode: 'watch', // 'watch' = 匿名只读通道；'control' = 登录后通道
	authed: false,
	pendingWatchStart: false,
	liveTimer: 0,
	viewersFull: false,
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
	for (const view of ['watch', 'login', 'home']) {
		$(`#view-${view}`).classList.toggle('hidden', view !== name);
	}
}

/* ------------------------------------------------------------------ */
/* 观战：默认小窗看直播，输密码后才能操控                                */
/* ------------------------------------------------------------------ */

// 播放器三种形态：pip（右上角小窗）/ watch（全屏观看）/ control（登录后操控）
// 播放器区的显隐完全由 setPlayerMode 管，不走 showView。
function setPlayerMode(mode) {
	state.mode = mode;
	const body = document.body;
	body.classList.remove('mode-pip', 'mode-watch', 'mode-control');

	const player = $('#view-player');
	if (!mode) {
		player.classList.add('hidden');
		body.style.overflow = '';
		syncModeButtons();
		return;
	}

	body.classList.add('mode-' + mode);
	player.classList.remove('hidden');

	if (mode === 'pip') {
		showView('watch');
		body.style.overflow = '';
		// 直播间嵌入形态：位置完全由 CSS 控制，清掉旧的拖拽坐标残留
		player.style.left = player.style.top = player.style.right = player.style.bottom = '';
		player.classList.remove('pip-moved');
	} else {
		body.style.overflow = 'hidden';
		$('#view-player').style.left = $('#view-player').style.top = $('#view-player').style.right = '';
	}

	setTouchVisible(mode === 'control' && (window.matchMedia('(pointer: coarse)').matches || state.touchVisible));
	syncModeButtons();
	syncChatBar();
	updatePadZone();
}

function syncModeButtons() {
	const m = state.mode;
	for (const el of document.querySelectorAll('[data-ctl]')) el.classList.toggle('hidden', m !== 'control');
	$('#btn-exit-watch').classList.toggle('hidden', m !== 'watch');
	$('#btn-hud-take').classList.toggle('hidden', m !== 'watch');
}

function setPipStatus(text) {
	const el = $('#pip-status');
	if (el) el.textContent = text;
}

/* ------------------------------------------------------------------ */
/* 弹幕（抖音式：从右往左飘，底部输入栏发言）                            */
/* ------------------------------------------------------------------ */

const NICK_KEY = 'ps5web.nick';

// 默认昵称池：不想动脑就挑一个（弹幕列表里名字有专属色）
const NICKS = [
	'快乐手柄', '沙发玩家', '今晚不睡', '手残党本党', '吃瓜观众',
	'路人甲', '摸鱼大师', '菜到抠脚', '高光制造机', '睡个午觉先',
	'风灵月影宗', '一只咸鱼', '麦香鱼', '隔壁老王', '猫才无双',
	'打铁的路人', '雾都孤儿', '不吃香菜', '小饼干', '摆烂冠军',
	'深夜食堂', '路人乙', '会飞的鱼', '咕咕咕', '大司马本马',
	'冷场担当', '气氛组组长', '专业捧哏', '无名氏', '游戏人间',
	'一整个爱住', '太会了叭', '下饭操作', '乐子人', '路人丙',
	'摸鱼选手', '躺分玩家', '偷学两招', '嘴强王者', '萌新报道',
];
const NICK_COLORS = [
	'#ff8a8a', '#ffd666', '#7ee081', '#6ecbff', '#c79bff',
	'#ff9ed2', '#6fe3d2', '#f0b46e', '#9db9ff', '#e88bff',
];

/** 昵称 → 稳定的颜色（同一人名字颜色不变） */
function nickColor(name) {
	let x = 0;
	for (let i = 0; i < name.length; i++) x = (x * 31 + name.charCodeAt(i)) | 0;
	return NICK_COLORS[Math.abs(x) % NICK_COLORS.length];
}

const EMOJIS = [
	'😀','😂','🤣','😊','😍','🤔','😎','😭','😱','🥶',
	'👍','👏','🔥','💯','❤️','🎮','🕹️','🏆','⚽','🎯',
	'😅','🙏','👀','💪','🤝','✌️','🥳','😴','🤡','👻',
];

// 6 条轨道轮着用，同轨道追尾时自动错开
const DANMAKU_LANES = 6;
const danmakuLanes = new Array(DANMAKU_LANES).fill(0);
let danmakuCount = 0;

function myNick() {
	let n = '';
	try {
		n = localStorage.getItem(NICK_KEY) || '';
	} catch {
		/* ignore */
	}
	return n;
}

function setNick(name) {
	const clean = String(name || '').replace(/[\r\n\t]/g, '').trim().slice(0, 16);
	if (!clean) return;
	try {
		localStorage.setItem(NICK_KEY, clean);
	} catch {
		/* ignore */
	}
	for (const el of document.querySelectorAll('#btn-nick, #btn-nick-2')) el.textContent = clean;
}

/** 没选过昵称就先选（弹选择器），选好了才放行发言 */
function requireNick() {
	if (myNick()) return true;
	openNickPop();
	return false;
}

function openNickPop() {
	$('#nick-pop')?.classList.remove('hidden');
}

function bindNickPop() {
	const pop = $('#nick-pop');
	const grid = $('#nick-grid');
	if (!pop || !grid) return;

	for (const name of NICKS) {
		grid.append(
			h('button', {
				type: 'button',
				class: 'nick-item',
				text: name,
				style: `color:${nickColor(name)}`,
				onclick: () => {
					setNick(name);
					pop.classList.add('hidden');
					$('#room-input')?.focus();
					toast(`昵称已设置为「${name}」`);
				},
			})
		);
	}

	$('#nick-custom').addEventListener('submit', (e) => {
		e.preventDefault();
		const input = $('#nick-input');
		const v = (input.value || '').trim();
		if (!v) return;
		setNick(v);
		input.value = '';
		pop.classList.add('hidden');
		toast(`昵称已设置为「${v}」`);
	});

	// 点卡片外的空白处关闭
	pop.addEventListener('pointerdown', (e) => {
		if (e.target === pop) pop.classList.add('hidden');
	});

	// 弹幕栏上的昵称徽章：点击更换
	for (const id of ['btn-nick', 'btn-nick-2']) {
		const btn = document.getElementById(id);
		btn?.addEventListener('click', openNickPop);
	}
}

/** 进入站点时同步一次昵称显示 */
function syncNickButtons() {
	const n = myNick() || '未设置';
	for (const el of document.querySelectorAll('#btn-nick, #btn-nick-2')) el.textContent = n;
}

/* ---------------- 右侧竖列弹幕列表（小窗观战时） ---------------- */

const CHAT_LIST_MAX = 80;

function appendChatList(name, text, mine) {
	const list = $('#chat-list');
	if (!list) return;
	const row = document.createElement('div');
	row.className = 'chat-row' + (mine ? ' mine' : '');
	const tag = document.createElement('span');
	tag.className = 'chat-who';
	tag.style.color = nickColor(name || '观众');
	tag.textContent = (mine ? '我' : name) + '：';
	row.append(tag, document.createTextNode(text));
	list.append(row);
	while (list.children.length > CHAT_LIST_MAX) list.firstChild.remove();
	// 用户正在往上翻看时不强行拉回底部
	const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
	if (nearBottom) list.scrollTop = list.scrollHeight;
}

function updateRoomHead(s) {
	const t = $('#room-title');
	if (t) t.textContent = s?.current?.nickname || s?.current?.name || '直播中';
	const v = $('#room-viewers');
	if (v && typeof s?.anons === 'number') {
		v.textContent = s.limit > 0 ? `${s.anons}/${s.limit} 人在看` : `${s.anons} 人在看`;
	}
}

function laneFreeMs(el, durationMs) {
	// 粗略：本条飘完 + 一点余量后轨道可复用
	return durationMs + 400;
}

function spawnDanmaku(name, text, mine) {
	// 小窗也飘（字变小），全屏观看/操控正常飘
	if (state.mode !== 'watch' && state.mode !== 'control' && state.mode !== 'pip') return;
	const host = $('#danmaku');
	if (!host) return;
	if (danmakuCount > 40) return; // 屏幕太挤就静默丢弃后来的

	const el = document.createElement('div');
	el.className = 'dm' + (mine ? ' dm-mine' : '');
	if (name) {
		const tag = document.createElement('span');
		tag.className = 'dm-name';
		tag.textContent = name + '：';
		el.append(tag);
	}
	el.append(document.createTextNode(text));

	// 选最早空闲的轨道
	const now = performance.now();
	let lane = 0;
	let best = Infinity;
	for (let i = 0; i < DANMAKU_LANES; i++) {
		if (danmakuLanes[i] < best) {
			best = danmakuLanes[i];
			lane = i;
		}
	}

	host.append(el);
	danmakuCount++;

	const width = el.offsetWidth || 200;
	const distance = host.clientWidth + width + 40;
	const duration = Math.min(12, Math.max(6, distance / 130)) * 1000; // ~130px/s
	const topPct = 4 + (lane * 88) / (DANMAKU_LANES - 1);
	el.style.top = `${topPct}%`;
	el.style.setProperty('--dm-x', `-${distance}px`);
	el.style.animationDuration = `${duration}ms`;
	danmakuLanes[lane] = now + laneFreeMs(el, duration);

	el.addEventListener('animationend', () => {
		el.remove();
		danmakuCount--;
	});
}

function sendChat(inputSel) {
	const input = $(inputSel);
	const text = (input.value || '').trim();
	if (!text) return;
	if (!requireNick()) return;
	if (!state.socket?.connected) {
		toast('还没连上直播，发不出去', 'error');
		return;
	}
	if (!state.socket.sendJson({ t: 'chat', name: myNick(), text })) {
		toast('连接断了，弹幕发不出去', 'error');
		return;
	}
	input.value = '';
	input.blur();
}

function bindRoomChat() {
	// 右侧竖列底部的发言栏（小窗观战态）
	$('#room-form')?.addEventListener('submit', (e) => {
		e.preventDefault();
		sendChat('#room-input');
	});
	$('#room-input')?.addEventListener('focus', () => {
		if (!myNick()) openNickPop();
	});
	populateEmoji('#btn-emoji-room', '#emoji-pop-room', '#room-input');
}

function populateEmoji(btnSel, popSel, inputSel) {
	const pop = $(popSel);
	const input = $(inputSel);
	if (!pop || !input) return;
	for (const em of EMOJIS) {
		pop.append(
			h('button', {
				type: 'button',
				class: 'emoji-item',
				text: em,
				onclick: () => {
					input.value += em;
					input.focus();
				},
			})
		);
	}
	$(btnSel)?.addEventListener('click', (e) => {
		e.stopPropagation();
		pop.classList.toggle('hidden');
	});
	document.addEventListener('pointerdown', (e) => {
		if (!pop.classList.contains('hidden') && !e.target.closest(popSel)) {
			pop.classList.add('hidden');
		}
	});
}

function bindChatBar() {
	const bar = $('#chat-bar');
	const input = $('#chat-input');
	const pop = $('#emoji-pop');

	bar.addEventListener('submit', (e) => {
		e.preventDefault();
		sendChat('#chat-input');
	});

	populateEmoji('#btn-emoji', '#emoji-pop', '#chat-input');
	document.addEventListener('pointerdown', (e) => {
		if (!pop.classList.contains('hidden') && !e.target.closest('#chat-bar')) {
			pop.classList.add('hidden');
		}
	});

	// 输入时暂停页面级手势拦截没有意义（弹幕栏自己是 button/表单，手势层已跳过）
}

function syncChatBar() {
	const show = state.mode === 'watch' || state.mode === 'control';
	$('#chat-bar').classList.toggle('hidden', !show);
}

/** 打开（或复用）观战通道：匿名 WS，服务器只当它是观众 */
function ensurePipStream() {
	if (state.socket?.alive && state.controlMode === 'watch') return;
	if (state.socket) {
		state.socket.close();
		state.socket = null;
	}
	state.controlMode = 'watch';
	preparePlayer();
	setPlayerMode('pip');
}

function teardownPlayer() {
	if (state.socket) {
		state.socket.close();
		state.socket = null;
	}
	state.video?.destroy();
	state.video = null;
	state.audio?.destroy();
	state.audio = null;
	state.input?.stop();
	state.input = null;
	clearInterval(state.pingTimer);
}

function exitToCover() {
	teardownPlayer();
	setPlayerMode(null);
	showView('watch');
	clearTimeout(state.liveTimer);
	pollLive();
}

async function expandWatch() {
	// 放大是一个用户手势，借机解锁声音 + 申请真正的 F11 式全屏
	state.audio?.enable?.().catch(() => {});
	setPlayerMode('watch');
	try {
		if (!fullscreenElement() && nativeFullscreenAvailable()) {
			const el = document.documentElement;
			const req = el.requestFullscreen || el.webkitRequestFullscreen;
			if (req) await req.call(el);
		}
	} catch {
		/* 浏览器拒绝全屏就退回「铺满视口」的 watch 模式，不弹错误 */
	}
}

// ESC / 退出全屏 = 收起直播间，回到小窗嵌入态
document.addEventListener('fullscreenchange', () => {
	if (!fullscreenElement() && state.mode === 'watch') {
		// 从操控态进来的没有 room，交给退出按钮处理
		if (state.controlMode === 'watch') setPlayerMode('pip');
	}
});

async function pollLive() {
	if ($('#view-watch').classList.contains('hidden')) return;

	let s;
	try {
		s = await api.live();
	} catch {
		$('#watch-cover-text').textContent = '连不上服务器，稍后自动重试…';
		clearTimeout(state.liveTimer);
		state.liveTimer = setTimeout(pollLive, 5000);
		return;
	}

	state.session = { state: s.state, current: s.current };
	state.lastLive = s;
	updateStatusPill();
	updateRoomHead(s);
	const live = s.state === 'streaming' || s.state === 'connecting';
	// 观众位恢复空闲后允许再次尝试接入
	if (!s.full) state.viewersFull = false;

	if (live && s.full && (state.mode === null || state.mode === 'pip')) {
		// 有人在播，但匿名观众位已满：显示排队封面，不发起 WS 连接
		if (state.mode === 'pip') {
			teardownPlayer();
			setPlayerMode(null);
		}
		$('#watch-cover').classList.remove('hidden');
		$('#btn-watch-start').classList.add('hidden');
		$('#watch-cover-text').textContent = `当前观看人数已满（${s.anons}/${s.limit}），有人离开后会自动接入，别关页面…`;
		clearTimeout(state.liveTimer);
		state.liveTimer = setTimeout(pollLive, 6000);
		return;
	}

	if (live) {
		if (state.mode === 'pip' || state.mode === null) {
			$('#watch-cover').classList.add('hidden');
			ensurePipStream();
			setPipStatus(s.current?.nickname || s.current?.name || '直播中');
		} else if (state.mode === 'watch') {
			setPipStatus(s.current?.nickname || s.current?.name || '直播中');
		}
	} else if (state.mode === 'pip') {
		// 直播在两次轮询之间结束了
		exitToCover();
		return;
	} else if (state.mode === 'watch') {
		showOverlay('直播已结束', '现在没人在玩了。', false);
		return;
	} else {
		$('#watch-cover').classList.remove('hidden');
		$('#btn-watch-start').classList.toggle('hidden', !s.canStart);
		$('#btn-watch-start').textContent = state.authed ? '开始观战' : '解锁并开播';
		$('#watch-cover-text').textContent = s.canStart
			? '现在没人在玩。开播会唤醒 PS5，需要访问密码（主机启动大约 30 秒）。'
			: '房主还没有配对 PS5，暂时没有内容可看。';
	}

	clearTimeout(state.liveTimer);
	state.liveTimer = setTimeout(pollLive, live ? 8000 : 6000);
}

async function startWatchSession() {
	$('#btn-watch-start').disabled = true;
	$('#watch-cover-text').textContent = '正在唤醒主机…';
	try {
		await api.watchStart();
	} catch (err) {
		if (err.status === 401) {
			// cookie 过期：回到解锁流程
			state.authed = false;
			state.pendingWatchStart = true;
			toast('登录已过期，请重新输入密码', 'error');
			showView('login');
			return;
		}
		toast(err.message, 'error', 6000);
	} finally {
		$('#btn-watch-start').disabled = false;
	}
	$('#watch-cover').classList.add('hidden');
	setPipStatus('连接中…');
	ensurePipStream();
	clearTimeout(state.liveTimer);
	state.liveTimer = setTimeout(pollLive, 4000);
}

async function requestControl() {
	if (state.authed) return enterControlMode();
	state.pendingWatchStart = false;
	showView('login');
}

/** 已登录（或刚输完密码）：换成带控制权的连接 */
async function enterControlMode() {
	const s = state.session || {};
	const live = s.state === 'streaming' || s.state === 'connecting';

	if (!live) {
		if (state.mode) {
			teardownPlayer();
			setPlayerMode(null);
		}
		clearTimeout(state.liveTimer);
		await refreshState().catch(() => {});
		showView('home');
		return;
	}

	teardownPlayer();
	state.controlMode = 'control';
	preparePlayer();
	setPlayerMode('control');
	state.audio?.enable().then((ok) => {
		if (!ok) toast('浏览器不支持 WebCodecs 音频解码，本次没有声音', 'error', 5000);
	});
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
		state.authed = true;
		$('#btn-admin').classList.remove('hidden');
		if (state.pendingWatchStart) {
			// 观战封面点了「解锁并开播」：登录完直接把台开起来
			state.pendingWatchStart = false;
			await startWatchSession();
		} else {
			await enterControlMode();
		}
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
	// 同一台 PS5 可能有多条（国服/港服）：按「地址+名称」判断是否已添加，
	// 只配过港服时，发现列表仍应保留入口以便再配一条国服
	const discovered = state.discovered.filter(
		(d) => !state.hosts.some((h2) => h2.address === d.address && h2.name === (d.name || d.address))
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
		host.paired
			? h('button', {
					class: 'ghost',
					text: '重配对',
					onclick: () => openPairDialog(host),
			  })
			: null,
		h('button', {
			class: 'ghost',
			text: '编辑',
			onclick: () => openEditHostDialog(host),
		}),
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
				host.note ? h('div', { class: 'hc-note', text: host.note }) : null,
			]),
			h('span', {
				class: 'hc-state ' + (host.paired ? 'paired' : 'unpaired'),
				text: host.paired ? '已配对' : '未配对',
			}),
		]),
		actions,
	]);
}

/** 编辑主机：改名 + 备注 + 查看/修改 PSN Account-ID（国服/港服各一条时靠名字区分） */
function openEditHostDialog(host) {
	const nameInput = h('input', { value: host.name || '', maxlength: '40', placeholder: '主机名称，如「小白PS5·港服」' });
	const noteInput = h('input', { value: host.note || '', maxlength: '120', placeholder: '备注，如「给儿子留的号 / 周五晚家庭时间」' });
	const accountInput = h('input', {
		value: host.accountId || '',
		autocomplete: 'off',
		placeholder: 'PSN Account-ID（base64，8 字节）',
	});

	const body = h('div', {}, [
		h('p', { class: 'muted small', text: `地址 ${host.address}（同一台 PS5 可以添加多条，不同 PSN 账号各配对一次，用名称区分）` }),
		h('label', { class: 'field' }, [h('span', { text: '名称' }), nameInput]),
		h('label', { class: 'field' }, [h('span', { text: '备注' }), noteInput]),
		h('label', { class: 'field' }, [h('span', { text: 'PSN Account-ID' }), accountInput]),
		host.paired
			? h('p', { class: 'muted small', text: '改 Account-ID 只更新记录；连不上/凭据失效（如 PS5 上取消过关联）请回列表点「重配对」。' })
			: h('p', { class: 'muted small', text: '这台还没配对，配对时也会以这里的 Account-ID 为准。' }),
	]);

	const submit = async () => {
		const name = nameInput.value.trim();
		if (!name) {
			toast('名称不能为空', 'error');
			return false;
		}
		try {
			await api.patchHost(host.id, {
				name,
				note: noteInput.value.trim(),
				accountId: accountInput.value.trim(),
			});
			await refreshState();
			toast('已保存', 'ok');
			return true;
		} catch (err) {
			toast(err.message, 'error');
			return false;
		}
	};

	openModal({
		title: `编辑 ${host.name}`,
		body,
		actions: [
			{ label: '取消', value: false },
			{ label: '保存', primary: true, onClick: submit },
		],
	});
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
	const repair = !!host.paired;
	const pinInput = h('input', {
		placeholder: 'PS5 上显示的 8 位数字',
		inputmode: 'numeric',
		autocomplete: 'off',
	});
	const accountInput = h('input', {
		value: host.accountId || '',
		placeholder: 'PSN Account-ID（base64，8 字节）',
		autocomplete: 'off',
	});

	const body = h('div', {}, [
		h('p', {
			text:
				'1. 在 PS5 上打开「设置 → 系统 → 远程游玩 → 关联设备」，屏幕会显示 8 位 PIN。',
		}),
		repair
			? h('p', {
					text:
						'2. PIN 每次打开该页面都会刷新，用最新的 PIN 重新配对即可；成功会覆盖旧凭据，这条记录继续用。',
			  })
			: h('p', {
					text:
						'2. 用电脑或手机打开 psn.flipscreen.games，登录后复制 Account-ID（base64 那串）。',
			  }),
		h('label', { class: 'field' }, [h('span', { text: 'PIN' }), pinInput]),
		h('label', { class: 'field' }, [h('span', { text: 'PSN Account-ID' }), accountInput]),
		h('p', { class: 'muted small', text: '凭据保存在 NAS 本地，配一次就够；连不上多半是 PS5 那边取消过关联，重配对一次即可。' }),
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
			toast(repair ? '重新配对成功，可以直接串流了' : '配对成功，可以直接串流了', 'ok');
			return true;
		} catch (err) {
			toast(err.message, 'error', 6000);
			btns.forEach((b) => (b.disabled = false));
			return false;
		}
	};

	openModal({
		title: `${repair ? '重新配对' : '配对'} ${host.name}`,
		body,
		actions: [
			{ label: '取消', value: false },
			{ label: repair ? '重新配对' : '开始配对', primary: true, onClick: submit },
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
	state.controlMode = 'control';
	setPlayerMode('control');
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

	state.controlMode = 'control';
	setPlayerMode('control');
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
	const asControl = state.controlMode === 'control';
	state.socket.onVideo = (buf, sentAt) => state.video?.push(buf, sentAt);
	state.socket.onAudio = (buf) => state.audio?.push(buf);
	state.socket.onJson = onServerMessage;
	state.socket.onOpen = () => {
		if (asControl) state.input?.start();
		sendPing();
		if (VideoPipeline.supported) state.video?.requestKeyframe();

		// 每 2 秒量一次 WS 往返 + 校一次时钟，判断延迟是不是网络造成的
		clearInterval(state.pingTimer);
		state.pingTimer = setInterval(sendPing, 2000);
	};
	state.socket.onClose = (code) => {
		if (code === 4008) {
			// 服务器观众位已满：别再自动重连，回到封面，由轮询决定何时再试
			state.viewersFull = true;
			teardownPlayer();
			setPlayerMode(null);
			showView('watch');
			clearTimeout(state.liveTimer);
			state.liveTimer = setTimeout(pollLive, 8000);
			return;
		}
		if (state.mode === 'pip') {
			setPipStatus('连接断开，重连中…');
			clearTimeout(state.liveTimer);
			state.liveTimer = setTimeout(pollLive, 4000);
			return;
		}
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
	setTouchVisible(asControl && (coarse || state.touchVisible));

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
			if (msg.state === 'streaming') {
				hideOverlay();
				if (state.mode === 'pip') setPipStatus(msg.current?.nickname || msg.current?.name || '直播中');
			} else if (msg.state === 'idle') {
				if (state.mode === 'pip') {
					// 轮询说在播、连上却发现结束了：回封面重新计时
					exitToCover();
					return;
				}
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
				if (state.mode === 'pip') setPipStatus(msg.current?.nickname || msg.current?.name || '直播中');
				// AudioContext 可能因为自动播放策略被挂起
				if (state.mode === 'control' && state.audio && (!state.audio.ctx || state.audio.ctx.state !== 'running')) {
					$('#audio-unlock').classList.remove('hidden');
				}
			} else if (msg.state === 'connecting') {
				if (state.mode === 'pip') setPipStatus('正在连接 PS5…');
				else showOverlay('正在连接 PS5…', '握手需要几秒，请稍候。', true);
			} else if (msg.state === 'idle' && state.mode === 'pip') {
				exitToCover();
				return;
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

		case 'viewers': {
			const v = $('#room-viewers');
			if (v) {
				const n = typeof msg.anons === 'number' ? msg.anons : msg.count;
				const limit = state.lastLive?.limit || 0;
				v.textContent = limit > 0 ? `${n}/${limit} 人在看` : `${n} 人在看`;
			}
			break;
		}

		case 'chat': {
			const mine = !!myNick() && msg.name === myNick();
			spawnDanmaku(msg.name, msg.text, mine);
			appendChatList(msg.name, msg.text, mine);
			break;
		}

		case 'chat_reject':
			toast(msg.reason === 'slow' ? '慢一点，2 秒能发一条' : '说得够多啦，歇一小时再说', '', 2500);
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
			if (state.mode === 'pip') {
				// 直播结束了：收起小窗，回封面重新轮询
				setTimeout(exitToCover, 1500);
				setPipStatus('直播已结束');
				break;
			}
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
	// 观战者不该看到配对 PIN 弹窗（那是控制端的事）
	if (state.mode !== 'control') return;
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
	// 小窗模式放不下弹窗，把提示压进小窗标题条
	if (state.mode === 'pip') {
		setPipStatus(text ? `${title} · ${text}` : title);
		return;
	}
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
	const wasControl = state.mode === 'control';
	if (wasControl) {
		try {
			await api.stop();
		} catch {
			/* ignore */
		}
	}
	cleanupPlayer();
	if (wasControl) {
		await refreshState();
		showView('home');
	} else {
		// 观战里的「返回」：不能停别人的会话，只是退出播放器
		setPlayerMode(null);
		showView('watch');
		clearTimeout(state.liveTimer);
		pollLive();
	}
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
		if (e.target.closest && e.target.closest('button, .hud, .overlay, .modal-backdrop, input, select, .chat-bar')) return;
		// 观战模式：画面只用来切换 HUD，绝不往 PS5 发输入
		if (state.mode !== 'control') {
			if (state.mode === 'pip') {
				expandWatch(); // 直播间形态：点画面 = 放大全屏
				return;
			}
			$('#hud').classList.toggle('dim');
			return;
		}
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

/* ---------------------------- 小窗拖拽 ---------------------------- */

// 右上角小窗可以用标题条拖着走；松手吸附到最近的角。
// 位置存 localStorage，下次进来还在老地方。
const PIP_POS_KEY = 'ps5web.pip';

function bindPipDrag() {
	const bar = $('#pip-bar');
	const box = $('#view-player');
	if (!bar || !box) return;

	let drag = null;

	bar.addEventListener('pointerdown', (e) => {
		if (e.target.closest('button')) return;
		const r = box.getBoundingClientRect();
		drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height, moved: false };
		bar.setPointerCapture(e.pointerId);
		e.preventDefault();
	});

	bar.addEventListener('pointermove', (e) => {
		if (!drag || e.pointerId !== drag.id) return;
		const x = Math.min(Math.max(4, e.clientX - drag.dx), window.innerWidth - drag.w - 4);
		const y = Math.min(Math.max(4, e.clientY - drag.dy), window.innerHeight - drag.h - 4);
		if (Math.abs(x - (drag.x ?? x)) > 3 || Math.abs(y - (drag.y ?? y)) > 3) drag.moved = true;
		drag.x = x;
		drag.y = y;
		box.style.left = `${x}px`;
		box.style.top = `${y}px`;
		box.style.right = 'auto';
	});

	const finish = (e) => {
		if (!drag || e.pointerId !== drag.id) return;
		const pos = drag.moved ? { x: drag.x, y: drag.y } : null;
		drag = null;
		if (pos) {
			box.classList.add('pip-moved'); // 用户自己摆的位置，别再自动避让弹幕栏
			try {
				localStorage.setItem(PIP_POS_KEY, JSON.stringify(pos));
			} catch {
				/* ignore */
			}
		}
	};
	bar.addEventListener('pointerup', finish);
	bar.addEventListener('pointercancel', finish);
}

function applyPipSavedPos() {
	const box = $('#view-player');
	if (!box) return;
	let pos = null;
	try {
		pos = JSON.parse(localStorage.getItem(PIP_POS_KEY) || 'null');
	} catch {
		/* ignore */
	}
	if (!pos) {
		box.classList.remove('pip-moved');
		box.style.left = box.style.top = box.style.right = '';
		return;
	}
	// 先清掉 right 定位再用 left/top；越界的旧坐标直接丢弃
	box.classList.add('pip-moved');
	box.style.right = 'auto';
	box.style.left = `${Math.min(pos.x || 0, window.innerWidth - 120)}px`;
	box.style.top = `${Math.min(pos.y || 0, window.innerHeight - 80)}px`;
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
	bindPipDrag();
	bindChatBar();
	bindRoomChat();
	bindNickPop();
	syncNickButtons();

	$('#login-form').addEventListener('submit', onLoginSubmit);
	$('#btn-login-back').addEventListener('click', () => {
		state.pendingWatchStart = false;
		showView('watch');
		pollLive();
	});

	$('#btn-take-control').addEventListener('click', requestControl);
	$('#btn-admin').addEventListener('click', async () => {
		showView('home');
		await refreshState().catch(() => {});
	});
	$('#btn-hud-take').addEventListener('click', requestControl);
	$('#btn-watch-refresh').addEventListener('click', () => {
		clearTimeout(state.liveTimer);
		pollLive();
	});
	$('#btn-watch-start').addEventListener('click', async () => {
		if (!state.authed) {
			// 唤醒主机是控制行为：先过密码，登录后自动接着开播
			state.pendingWatchStart = true;
			showView('login');
			return;
		}
		await startWatchSession();
	});
	$('#btn-pip-expand').addEventListener('click', expandWatch);
	$('#btn-exit-watch').addEventListener('click', exitToCover);
	$('#btn-back-watch').addEventListener('click', async () => {
		if (state.mode === 'control') {
			// 从管理页回观战：保留 NAS 上的会话，只断开自己这条观众通道
			teardownPlayer();
			setPlayerMode(null);
		}
		showView('watch');
		clearTimeout(state.liveTimer);
		pollLive();
	});

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

	// 默认落在观战页：不用登录就能看到直播小窗
	showView('watch');
	try {
		await refreshState(); // 只有带有效 cookie 才拿得到
		state.authed = true;
		$('#btn-admin').classList.remove('hidden');
	} catch {
		state.authed = false;
	}
	pollLive();
}

main();

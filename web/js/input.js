// SPDX-License-Identifier: AGPL-3.0-only
//
// 输入聚合：物理手柄（Gamepad API）+ 键盘 + 屏幕按键，
// 合成 28 字节的手柄状态包发给服务端。

export const BTN = {
	CROSS: 1 << 0,
	CIRCLE: 1 << 1,
	SQUARE: 1 << 2,
	TRIANGLE: 1 << 3,
	DPAD_LEFT: 1 << 4,
	DPAD_RIGHT: 1 << 5,
	DPAD_UP: 1 << 6,
	DPAD_DOWN: 1 << 7,
	L1: 1 << 8,
	R1: 1 << 9,
	L3: 1 << 10,
	R3: 1 << 11,
	OPTIONS: 1 << 12,
	SHARE: 1 << 13,
	TOUCHPAD: 1 << 14,
	PS: 1 << 15,
};

const PACKET_LEN = 28;
const TOUCH_MAX_X = 1919;
const TOUCH_MAX_Y = 1079;

const KEYMAP = {
	ArrowUp: BTN.DPAD_UP,
	ArrowDown: BTN.DPAD_DOWN,
	ArrowLeft: BTN.DPAD_LEFT,
	ArrowRight: BTN.DPAD_RIGHT,
	KeyK: BTN.CROSS,
	KeyL: BTN.CIRCLE,
	KeyJ: BTN.SQUARE,
	KeyI: BTN.TRIANGLE,
	KeyQ: BTN.L1,
	KeyE: BTN.R1,
	KeyU: BTN.L3,
	KeyO: BTN.R3,
	Enter: BTN.OPTIONS,
	Backspace: BTN.SHARE,
	Tab: BTN.TOUCHPAD,
	KeyP: BTN.PS,
};

const KEY_STICK = {
	KeyW: [0, -1],
	KeyS: [0, 1],
	KeyA: [-1, 0],
	KeyD: [1, 0],
};

const KEY_TRIGGER = {
	Digit1: 'l2',
	Digit3: 'r2',
};

function deadzone(v, dz = 0.12) {
	if (Math.abs(v) < dz) return 0;
	const sign = Math.sign(v);
	return sign * Math.min(1, (Math.abs(v) - dz) / (1 - dz));
}

function toInt16(v) {
	return Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
}

export class InputManager {
	constructor({ send } = {}) {
		this.send = send || (() => {});
		this.enabled = false;

		this.buttons = 0;
		this.l2 = 0;
		this.r2 = 0;
		this.left = [0, 0];
		this.right = [0, 0];
		this.touches = [
			{ active: false, x: 0, y: 0 },
			{ active: false, x: 0, y: 0 },
		];

		this.manual = new Set();
		this.manualStick = { left: [0, 0], right: [0, 0] };
		this.manualTrigger = { l2: 0, r2: 0 };
		this.keys = new Set();
		this.keyHandled = false;

		this.packet = new Uint8Array(PACKET_LEN);
		this.lastPacket = new Uint8Array(PACKET_LEN);
		this.hasLast = false;
		this.lastSendAt = 0;
		this.raf = 0;
		this.padIndex = null;
		this.lastRumbleAt = 0;

		this.onKeyActivity = () => {};

		this.#bindKeyboard();
	}

	start() {
		if (this.enabled) return;
		this.enabled = true;
		this.hasLast = false;
		this.#loop();
	}

	stop() {
		this.enabled = false;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.manual.clear();
		this.keys.clear();
		this.buttons = 0;
		this.l2 = 0;
		this.r2 = 0;
		this.touches[0].active = false;
		this.touches[1].active = false;
		this.#emit(true);
	}

	/* ---------------- 屏幕按键 / 触屏 ---------------- */

	setButton(bit, pressed) {
		if (pressed) this.manual.add(bit);
		else this.manual.delete(bit);
	}

	setTrigger(which, value) {
		this.manualTrigger[which] = Math.max(0, Math.min(255, Math.round(value)));
	}

	setStick(which, x, y) {
		const target = this.manualStick[which];
		target[0] = Math.max(-1, Math.min(1, x));
		target[1] = Math.max(-1, Math.min(1, y));
	}

	setTouch(index, x, y, active = true) {
		const t = this.touches[index];
		if (!t) return;
		t.active = active;
		if (active) {
			t.x = Math.max(0, Math.min(TOUCH_MAX_X, Math.round(x)));
			t.y = Math.max(0, Math.min(TOUCH_MAX_Y, Math.round(y)));
		}
	}

	clearTouches() {
		this.touches[0].active = false;
		this.touches[1].active = false;
	}

	/* ---------------- 键盘 ---------------- */

	#bindKeyboard() {
		this._onKeyDown = (e) => {
			if (!this.enabled) return;
			if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

			const mapped = KEYMAP[e.code] || KEY_STICK[e.code] || KEY_TRIGGER[e.code];
			if (!mapped) return;

			e.preventDefault();
			this.keys.add(e.code);
			this.onKeyActivity(e.code);
		};

		this._onKeyUp = (e) => {
			if (!this.enabled) return;
			if (KEYMAP[e.code] || KEY_STICK[e.code] || KEY_TRIGGER[e.code]) {
				e.preventDefault();
				this.keys.delete(e.code);
			}
		};

		this._onBlur = () => {
			this.keys.clear();
			this.manual.clear();
		};

		window.addEventListener('keydown', this._onKeyDown);
		window.addEventListener('keyup', this._onKeyUp);
		window.addEventListener('blur', this._onBlur);
	}

	/* ---------------- 循环 ---------------- */

	#loop = () => {
		if (!this.enabled) return;
		this.#poll();
		this.#emit(false);
		this.raf = requestAnimationFrame(this.#loop);
	};

	#poll() {
		let buttons = 0;
		let l2 = 0;
		let r2 = 0;
		let lx = 0;
		let ly = 0;
		let rx = 0;
		let ry = 0;
		let hasPad = false;

		const pads = navigator.getGamepads ? navigator.getGamepads() : [];
		let pad = this.padIndex !== null ? pads[this.padIndex] : null;
		if (!pad || !pad.connected) {
			pad = null;
			this.padIndex = null;
			for (let i = 0; i < pads.length; i++) {
				if (pads[i] && pads[i].connected) {
					pad = pads[i];
					this.padIndex = i;
					break;
				}
			}
		}

		if (pad) {
			hasPad = true;
			const b = pad.buttons;
			const pressed = (i) => (b[i] ? b[i].pressed || b[i].value > 0.5 : false);

			if (pressed(0)) buttons |= BTN.CROSS;
			if (pressed(1)) buttons |= BTN.CIRCLE;
			if (pressed(2)) buttons |= BTN.SQUARE;
			if (pressed(3)) buttons |= BTN.TRIANGLE;
			if (pressed(4)) buttons |= BTN.L1;
			if (pressed(5)) buttons |= BTN.R1;
			if (pressed(8)) buttons |= BTN.SHARE;
			if (pressed(9)) buttons |= BTN.OPTIONS;
			if (pressed(10)) buttons |= BTN.L3;
			if (pressed(11)) buttons |= BTN.R3;
			if (pressed(12)) buttons |= BTN.DPAD_UP;
			if (pressed(13)) buttons |= BTN.DPAD_DOWN;
			if (pressed(14)) buttons |= BTN.DPAD_LEFT;
			if (pressed(15)) buttons |= BTN.DPAD_RIGHT;
			if (pressed(16)) buttons |= BTN.PS;

			l2 = Math.round((b[6]?.value || 0) * 255);
			r2 = Math.round((b[7]?.value || 0) * 255);

			lx = deadzone(pad.axes[0] || 0);
			ly = deadzone(pad.axes[1] || 0);
			rx = deadzone(pad.axes[2] || 0);
			ry = deadzone(pad.axes[3] || 0);
		}

		for (const bit of this.manual) buttons |= bit;

		for (const code of this.keys) {
			const mapped = KEYMAP[code];
			if (mapped) buttons |= mapped;
		}

		if (!hasPad) {
			let sx = 0;
			let sy = 0;
			for (const code of this.keys) {
				const dir = KEY_STICK[code];
				if (dir) {
					sx += dir[0];
					sy += dir[1];
				}
			}
			lx = Math.max(-1, Math.min(1, sx));
			ly = Math.max(-1, Math.min(1, sy));
		}

		if (this.manualStick.left[0] || this.manualStick.left[1]) {
			lx = this.manualStick.left[0];
			ly = this.manualStick.left[1];
		}
		if (this.manualStick.right[0] || this.manualStick.right[1]) {
			rx = this.manualStick.right[0];
			ry = this.manualStick.right[1];
		}

		if (!hasPad || !l2) {
			for (const code of this.keys) {
				if (KEY_TRIGGER[code] === 'l2') l2 = 255;
			}
		}
		if (!hasPad || !r2) {
			for (const code of this.keys) {
				if (KEY_TRIGGER[code] === 'r2') r2 = 255;
			}
		}

		if (this.manualTrigger.l2) l2 = this.manualTrigger.l2;
		if (this.manualTrigger.r2) r2 = this.manualTrigger.r2;

		this.buttons = buttons >>> 0;
		this.l2 = l2;
		this.r2 = r2;
		this.left = [lx, ly];
		this.right = [rx, ry];
	}

	#emit(force) {
		const p = this.packet;
		p[0] = 1;
		p[1] = this.l2;
		p[2] = this.r2;
		p[3] = (this.touches[0].active ? 1 : 0) | (this.touches[1].active ? 2 : 0);

		const dv = new DataView(p.buffer);
		dv.setUint32(4, this.buttons, true);
		dv.setInt16(8, toInt16(this.left[0]), true);
		dv.setInt16(10, toInt16(this.left[1]), true);
		dv.setInt16(12, toInt16(this.right[0]), true);
		dv.setInt16(14, toInt16(this.right[1]), true);
		dv.setUint16(16, this.touches[0].x, true);
		dv.setUint16(18, this.touches[0].y, true);
		dv.setUint16(20, this.touches[1].x, true);
		dv.setUint16(22, this.touches[1].y, true);
		p[24] = this.touches[0].active ? 0 : 0xff;
		p[25] = this.touches[1].active ? 1 : 0xff;
		p[26] = 0;
		p[27] = 0;

		const now = performance.now();
		let changed = force || !this.hasLast;

		if (!changed) {
			for (let i = 0; i < PACKET_LEN; i++) {
				if (p[i] !== this.lastPacket[i]) {
					changed = true;
					break;
				}
			}
		}

		if (!changed && now - this.lastSendAt > 250) changed = true;
		if (!changed) return;

		this.lastPacket.set(p);
		this.hasLast = true;
		this.lastSendAt = now;
		this.send(p);
	}

	/* ---------------- 震动 ---------------- */

	handleRumble(left, right) {
		const pads = navigator.getGamepads ? navigator.getGamepads() : [];
		const pad = this.padIndex !== null ? pads[this.padIndex] : null;
		const actuator = pad?.vibrationActuator;
		if (!actuator || !actuator.playEffect) return;

		const now = performance.now();
		if (now - this.lastRumbleAt < 60) return;
		this.lastRumbleAt = now;

		try {
			actuator.playEffect('dual-rumble', {
				startDelay: 0,
				duration: 200,
				strongMagnitude: Math.min(1, (left || 0) / 255),
				weakMagnitude: Math.min(1, (right || 0) / 255),
			});
		} catch {
			/* 部分浏览器不支持，忽略 */
		}
	}
}

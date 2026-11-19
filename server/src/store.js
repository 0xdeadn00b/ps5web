// SPDX-License-Identifier: AGPL-3.0-only
//
// 已配对主机的持久化。registKey / rpKey 是能直接连上 PS5 的凭据，
// 只存在 NAS 本地文件（0600），永远不下发给浏览器。

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { log } from './logger.js';

const FILE = path.join(config.dataDir, 'hosts.json');

/** @type {{hosts: any[]}} */
let state = { hosts: [] };

function load() {
	try {
		const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
		if (raw && Array.isArray(raw.hosts)) state = { hosts: raw.hosts };
	} catch (err) {
		if (err.code !== 'ENOENT') log.warn('读取 hosts.json 失败:', err.message);
	}
}

function save() {
	const tmp = `${FILE}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, FILE);
	} catch (err) {
		log.error('写入 hosts.json 失败:', err.message);
	}
}

load();

export function listHosts() {
	return state.hosts;
}

export function getHost(id) {
	return state.hosts.find((h) => h.id === id) || null;
}

export function findByAddress(address) {
	return state.hosts.find((h) => h.address === address) || null;
}

// 同一台 PS5 允许多条条目（国服/港服等不同 PSN 账号各配一次对）。
// 去重条件从「同地址」放宽成「同地址 + 同名」，避免连点重复添加。
export function addHost({ name, address, ps5 = true }) {
	const cleanName = name || address;
	const existing = state.hosts.find(
		(h) => h.address === address && h.name === cleanName
	);
	if (existing) return existing;

	const host = {
		id: randomBytes(4).toString('hex'),
		name: cleanName,
		note: '',
		address,
		ps5: !!ps5,
		registKey: '',
		rpKey: '',
		accountId: '',
		mac: '',
		addedAt: Date.now(),
		lastPairedAt: 0,
	};
	state.hosts.push(host);
	save();
	log.info(`新增主机 ${host.name} (${host.address})`);
	return host;
}

export function updateHost(id, patch) {
	const host = getHost(id);
	if (!host) return null;
	Object.assign(host, patch);
	save();
	return host;
}

export function removeHost(id) {
	const idx = state.hosts.findIndex((h) => h.id === id);
	if (idx < 0) return false;
	const [host] = state.hosts.splice(idx, 1);
	save();
	log.info(`删除主机 ${host.name} (${host.address})`);
	return true;
}

/** 给浏览器的公开视图：不含密钥 */
export function publicHost(host) {
	return {
		id: host.id,
		name: host.name,
		note: host.note || '',
		address: host.address,
		ps5: !!host.ps5,
		mac: host.mac || '',
		accountId: host.accountId || '',
		paired: Boolean(host.registKey && host.rpKey),
		lastPairedAt: host.lastPairedAt || 0,
	};
}

// SPDX-License-Identifier: AGPL-3.0-only

async function request(path, options = {}) {
	const res = await fetch(path, {
		credentials: 'same-origin',
		headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
		...options,
	});

	let data = null;
	try {
		data = await res.json();
	} catch {
		/* 非 JSON 响应 */
	}

	if (!res.ok) {
		const err = new Error(data?.error || `请求失败 (${res.status})`);
		err.status = res.status;
		throw err;
	}
	return data;
}

export const api = {
	state: () => request('/api/state'),
	login: (password) => request('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
	logout: () => request('/api/logout', { method: 'POST' }),
	discover: () => request('/api/discover', { method: 'POST' }),
	addHost: (host) => request('/api/hosts', { method: 'POST', body: JSON.stringify(host) }),
	renameHost: (id, name) => request(`/api/hosts/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
	removeHost: (id) => request(`/api/hosts/${id}`, { method: 'DELETE' }),
	pair: (id, pin, accountId) =>
		request(`/api/hosts/${id}/pair`, { method: 'POST', body: JSON.stringify({ pin, accountId }) }),
	wake: (id) => request(`/api/hosts/${id}/wake`, { method: 'POST' }),
	start: (body) => request('/api/session/start', { method: 'POST', body: JSON.stringify(body) }),
	stop: () => request('/api/session/stop', { method: 'POST' }),
	sendPin: (pin) => request('/api/session/pin', { method: 'POST', body: JSON.stringify({ pin }) }),
	sleep: () => request('/api/session/sleep', { method: 'POST' }),
	logs: (after = 0) => request(`/api/logs?after=${after}`),
};

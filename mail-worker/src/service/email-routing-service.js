import BizError from '../error/biz-error';
import emailUtils from '../utils/email-utils';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const PAGE_SIZE = 50;

function routingConfig(c) {
	const domain = c.env.email_routing_domain?.trim().toLowerCase();
	if (!domain) return null;
	const zoneId = c.env.email_routing_zone_id?.trim();
	const worker = c.env.email_routing_worker?.trim();
	const token = c.env.EMAIL_ROUTING_API_TOKEN?.trim();
	if (!zoneId || !worker || !token) throw new BizError('Cloudflare 邮件路由同步未配置', 503);
	return { domain, zoneId, worker, token };
}

function config(c, email) {
	const cfg = routingConfig(c);
	return cfg && emailUtils.getDomain(email).toLowerCase() === cfg.domain ? cfg : null;
}

function ruleBody(email, worker, existing = {}) {
	return {
		actions: [{ type: 'worker', value: [worker] }],
		enabled: true,
		matchers: [{ type: 'literal', field: 'to', value: email }],
		name: existing.name || `Cloud Mail: ${email}`,
		...(existing.priority == null ? {} : { priority: existing.priority }),
	};
}

function errorMessage(json, status) {
	const message = json?.errors?.map(error => error.message).filter(Boolean).join('; ');
	return `Cloudflare 邮件路由同步失败（HTTP ${status}${message ? `：${message}` : ''}）`;
}

async function request(c, cfg, path, init = {}) {
	const method = init.method || 'GET';
	const attempts = method === 'POST' ? 1 : 3;
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await fetch(`${API_BASE}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${cfg.token}`,
					'Content-Type': 'application/json',
					...init.headers,
				},
				signal: AbortSignal.timeout(10000),
			});
			const json = await response.json().catch(() => null);
			if (method === 'DELETE' && response.status === 404) return { success: true, result: null };
			if (response.ok && json?.success) return json;
			lastError = new BizError(errorMessage(json, response.status), response.status === 409 ? 409 : 503);
			if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) throw lastError;
		} catch (error) {
			lastError = error instanceof BizError ? error : new BizError('Cloudflare 邮件路由服务暂时不可用', 503);
			if (attempt === attempts || error instanceof BizError && error.code !== 503) throw lastError;
		}
		await new Promise(resolve => setTimeout(resolve, 100 * attempt));
	}
	throw lastError;
}

async function listRules(c, cfg) {
	const rules = [];
	for (let page = 1; ; page++) {
		const json = await request(c, cfg,
			`/zones/${cfg.zoneId}/email/routing/rules?page=${page}&per_page=${PAGE_SIZE}`);
		rules.push(...(json.result || []));
		if (page >= (json.result_info?.total_pages || 1)) return rules;
	}
}

function routesAddress(rule, email) {
	return rule.matchers?.some(matcher => matcher.type === 'literal' && matcher.field === 'to' &&
		matcher.value?.toLowerCase() === email);
}

function routesToWorker(rule, worker) {
	return rule.actions?.some(action => action.type === 'worker' && action.value?.includes(worker));
}

function findRuleInList(rules, cfg, email) {
	const exactRules = rules.filter(rule => routesAddress(rule, email));
	const workerRule = exactRules.find(rule => routesToWorker(rule, cfg.worker));
	if (!workerRule && exactRules.length) throw new BizError('该邮箱地址已被其他 Cloudflare 路由占用', 409);
	return workerRule;
}

async function findRule(c, cfg, email) {
	return findRuleInList(await listRules(c, cfg), cfg, email);
}

async function putRule(c, cfg, rule, body) {
	return (await request(c, cfg, `/zones/${cfg.zoneId}/email/routing/rules/${rule.id}`, {
		method: 'PUT', body: JSON.stringify(body),
	})).result;
}

async function deleteRule(c, cfg, ruleId) {
	await request(c, cfg, `/zones/${cfg.zoneId}/email/routing/rules/${ruleId}`, { method: 'DELETE' });
}

export async function ensureEmailRoute(c, address, changes = []) {
	const email = address.trim().toLowerCase();
	const cfg = config(c, email);
	if (!cfg) return null;
	const rules = await listRules(c, cfg);
	return ensureEmailRouteFromRules(c, cfg, email, rules, changes);
}

async function ensureEmailRouteFromRules(c, cfg, email, rules, changes) {
	let existing = findRuleInList(rules, cfg, email);
	if (existing?.enabled) return existing;
	if (existing?.id) {
		const updated = await putRule(c, cfg, existing, ruleBody(email, cfg.worker, existing));
		changes.push({ type: 'updated', cfg, rule: existing });
		rules.splice(rules.indexOf(existing), 1, updated);
		return updated;
	}
	try {
		const created = (await request(c, cfg, `/zones/${cfg.zoneId}/email/routing/rules`, {
			method: 'POST', body: JSON.stringify(ruleBody(email, cfg.worker)),
		})).result;
		if (!created?.id) throw new BizError('Cloudflare 邮件路由创建结果无效', 503);
		changes.push({ type: 'created', cfg, rule: created });
		rules.push(created);
		return created;
	} catch (error) {
		// A concurrent request or a lost POST response may already have created the route.
		const refreshed = await listRules(c, cfg).catch(() => []);
		existing = findRuleInList(refreshed, cfg, email);
		if (existing?.enabled) return existing;
		throw error;
	}
}

export async function ensureEmailRoutes(c, addresses, changes = []) {
	for (const address of [...new Set(addresses.map(value => value.trim().toLowerCase()))]) {
		await ensureEmailRoute(c, address, changes);
	}
	return changes;
}

export async function removeEmailRoute(c, address, changes = []) {
	const email = address.trim().toLowerCase();
	const cfg = config(c, email);
	if (!cfg) return false;
	const existing = await findRule(c, cfg, email);
	if (!existing?.id) return false;
	await deleteRule(c, cfg, existing.id);
	changes.push({ type: 'deleted', cfg, rule: existing });
	return true;
}

export async function removeEmailRoutes(c, addresses, changes = []) {
	for (const address of [...new Set(addresses.map(value => value.trim().toLowerCase()))]) {
		await removeEmailRoute(c, address, changes);
	}
	return changes;
}

export async function rollbackEmailRouteChanges(c, changes) {
	const failures = [];
	for (const change of [...changes].reverse()) {
		try {
			if (change.type === 'created') await deleteRule(c, change.cfg, change.rule.id);
			else if (change.type === 'deleted') await request(c, change.cfg,
				`/zones/${change.cfg.zoneId}/email/routing/rules`, {
					method: 'POST', body: JSON.stringify({
						actions: change.rule.actions,
						enabled: change.rule.enabled,
						matchers: change.rule.matchers,
						name: change.rule.name,
						...(change.rule.priority == null ? {} : { priority: change.rule.priority }),
					}),
				});
			else await putRule(c, change.cfg, change.rule, {
				actions: change.rule.actions,
				enabled: change.rule.enabled,
				matchers: change.rule.matchers,
				name: change.rule.name,
				...(change.rule.priority == null ? {} : { priority: change.rule.priority }),
			});
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, 'Cloudflare 邮件路由回滚失败');
}

export async function reconcileEmailRoutes(c) {
	const cfg = routingConfig(c);
	if (!cfg) return { checked: 0, changed: 0 };
	const rules = await listRules(c, cfg);
	const changes = [];
	const failures = [];
	let checked = 0;
	let lastAccountId = 0;
	for (;;) {
		const page = await c.env.db.prepare(`
			SELECT account_id AS accountId, email FROM account
			WHERE is_del = 0 AND account_id > ?
				AND lower(substr(email, instr(email, '@') + 1)) = ?
			ORDER BY account_id LIMIT 100
		`).bind(lastAccountId, cfg.domain).all();
		const rows = page.results || [];
		for (const row of rows) {
			checked++;
			try {
				await ensureEmailRouteFromRules(c, cfg, row.email.trim().toLowerCase(), rules, changes);
			} catch (error) {
				failures.push(error);
			}
		}
		if (rows.length < 100) break;
		lastAccountId = rows.at(-1).accountId;
	}
	if (failures.length) throw new AggregateError(failures, '部分 Cloudflare 邮件路由对账失败');
	return { checked, changed: changes.length };
}

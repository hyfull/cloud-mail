import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ensureEmailRoute,
	reconcileEmailRoutes,
	removeEmailRoute,
	rollbackEmailRouteChanges,
} from './email-routing-service';

const env = {
	email_routing_domain: 'email.huayifull.com',
	email_routing_zone_id: 'zone-id',
	email_routing_worker: 'cloud-mail',
	EMAIL_ROUTING_API_TOKEN: 'test-token',
};
const address = 'user@email.huayifull.com';
const rule = (overrides = {}) => ({
	id: 'rule-id', enabled: true, name: `Cloud Mail: ${address}`, priority: 0,
	matchers: [{ type: 'literal', field: 'to', value: address }],
	actions: [{ type: 'worker', value: ['cloud-mail'] }],
	...overrides,
});
const response = (result, options = {}) => Response.json({
	success: options.status ? false : true,
	result,
	result_info: options.resultInfo,
	errors: options.errors || [],
}, { status: options.status || 200 });

afterEach(() => vi.unstubAllGlobals());

describe('Cloudflare exact mailbox routes', () => {
	it('skips domains that keep using their existing catch-all', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		expect(await ensureEmailRoute({ env }, 'user@huayimail.com')).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('creates a missing exact route to the configured worker', async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce(response([]))
			.mockResolvedValueOnce(response(rule()));
		vi.stubGlobal('fetch', fetch);
		const changes = [];
		await ensureEmailRoute({ env }, address.toUpperCase(), changes);
		expect(changes).toMatchObject([{ type: 'created', rule: { id: 'rule-id' } }]);
		const body = JSON.parse(fetch.mock.calls[1][1].body);
		expect(body).toMatchObject({
			enabled: true,
			matchers: [{ type: 'literal', field: 'to', value: address }],
			actions: [{ type: 'worker', value: ['cloud-mail'] }],
		});
	});

	it('re-enables its disabled route without creating a duplicate', async () => {
		const disabled = rule({ enabled: false });
		const fetch = vi.fn()
			.mockResolvedValueOnce(response([disabled]))
			.mockResolvedValueOnce(response(rule()));
		vi.stubGlobal('fetch', fetch);
		const changes = [];
		await ensureEmailRoute({ env }, address, changes);
		expect(fetch.mock.calls[1][1].method).toBe('PUT');
		expect(changes).toEqual([{ type: 'updated', cfg: expect.any(Object), rule: disabled }]);
	});

	it('reads all pages before deciding a route is missing', async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce(response([rule({ id: 'other', matchers: [{ type: 'literal', field: 'to', value: 'other@email.huayifull.com' }] })],
				{ resultInfo: { total_pages: 2 } }))
			.mockResolvedValueOnce(response([rule()]));
		vi.stubGlobal('fetch', fetch);
		expect((await ensureEmailRoute({ env }, address)).id).toBe('rule-id');
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[1][0]).toContain('page=2');
	});

	it('does not overwrite an exact route owned by another destination', async () => {
		const fetch = vi.fn().mockResolvedValue(response([
			rule({ actions: [{ type: 'forward', value: ['owner@example.com'] }] }),
		]));
		vi.stubGlobal('fetch', fetch);
		await expect(ensureEmailRoute({ env }, address)).rejects.toMatchObject({ code: 409 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('accepts an exact route created concurrently after an ambiguous POST failure', async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce(response([]))
			.mockResolvedValueOnce(response(null, { status: 500, errors: [{ message: 'temporary' }] }))
			.mockResolvedValueOnce(response([rule()]));
		vi.stubGlobal('fetch', fetch);
		expect((await ensureEmailRoute({ env }, address)).id).toBe('rule-id');
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it('can restore a route removed before a failed mailbox deletion', async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce(response([rule()]))
			.mockResolvedValueOnce(response(rule()))
			.mockResolvedValueOnce(response(rule({ id: 'replacement-id' })));
		vi.stubGlobal('fetch', fetch);
		const changes = [];
		expect(await removeEmailRoute({ env }, address, changes)).toBe(true);
		await rollbackEmailRouteChanges({ env }, changes);
		expect(fetch.mock.calls[1][1].method).toBe('DELETE');
		expect(fetch.mock.calls[2][1].method).toBe('POST');
	});

	it('repairs missing and disabled active mailbox routes in one paged scan', async () => {
		const secondAddress = 'second@email.huayifull.com';
		const disabled = rule({ enabled: false });
		const fetch = vi.fn()
			.mockResolvedValueOnce(response([disabled]))
			.mockResolvedValueOnce(response(rule()))
			.mockResolvedValueOnce(response(rule({ id: 'second-rule', matchers: [{ type: 'literal', field: 'to', value: secondAddress }] })));
		vi.stubGlobal('fetch', fetch);
		const db = { prepare: vi.fn(() => ({
			bind: vi.fn(() => ({ all: async () => ({ results: [
				{ accountId: 1, email: address }, { accountId: 2, email: secondAddress },
			] }) })),
		})) };
		expect(await reconcileEmailRoutes({ env: { ...env, db } })).toEqual({ checked: 2, changed: 2 });
		expect(fetch.mock.calls.map(call => call[1]?.method || 'GET')).toEqual(['GET', 'PUT', 'POST']);
	});
});

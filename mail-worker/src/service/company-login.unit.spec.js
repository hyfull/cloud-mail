import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import { beginCompanyLogin, completeCompanyLogin } from './company-login-service';
import loginService from './login-service';
import userService from './user-service';
vi.mock('./login-service', () => ({ default: { login: vi.fn() } }));
vi.mock('./user-service', () => ({ default: { selectByIdIncludeDel: vi.fn() } }));

describe('company mailbox login', () => {
  let c, entries, form, nonce, mode, publicKey, privateKey;
  beforeEach(async () => {
    entries = new Map(); mode = 'valid';
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    publicKey = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test', alg: 'RS256' };
    privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
    c = { env: { OIDC_ISSUER_URL: 'https://identity.test', OIDC_CLIENT_ID: 'cloud-mail', OIDC_CLIENT_SECRET: 'secret',
      OIDC_REDIRECT_URI: 'https://mail.test/api/oauth/company/callback',
      OIDC_REDIRECT_URI_ALT: 'https://mail-alt.test/api/oauth/company/callback',
      kv: { put: async (key, value) => entries.set(key, value), get: async (key, options) => options?.type === 'json' ? JSON.parse(entries.get(key) || 'null') : entries.get(key), delete: async key => entries.delete(key) },
      db: { prepare: vi.fn(() => ({ bind: vi.fn(subject => ({ first: async () => subject === 'employee-1' ? { userId: 7, status: mode === 'disabled' ? 'DISABLED' : 'ACTIVE' } : null })) })) } },
      req: { url: 'https://mail.test/api/oauth/company/login' } };
    userService.selectByIdIncludeDel.mockResolvedValue({ userId: 7, email: 'existing-mailbox@example.test' });
    loginService.login.mockResolvedValue('existing-login-token');
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (mode === 'upstream') return new Response('Identity service unavailable', { status: 525, headers: { 'cf-ray': 'test-ray' } });
      if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://identity.test', authorization_endpoint: 'https://identity.test/auth', token_endpoint: 'https://identity.test/token', jwks_uri: 'https://identity.test/jwks' });
      if (url.endsWith('/jwks')) return Response.json({ keys: [publicKey] });
      form = new URLSearchParams(init.body);
      const now = Math.floor(Date.now() / 1000);
      const idToken = await sign({ iss: 'https://identity.test', aud: mode === 'audience' ? 'other-client' : 'cloud-mail',
        sub: mode === 'unknown' ? 'unknown' : 'employee-1', nonce: mode === 'nonce' ? 'wrong' : nonce, iat: now, exp: now + 300 }, { ...privateKey, kid: 'test' }, 'RS256');
      return Response.json({ id_token: idToken });
    }));
  });
  async function flow() {
    const begun = await beginCompanyLogin(c), url = new URL(begun.url);
    nonce = url.searchParams.get('nonce');
    return { begun, query: new URLSearchParams({ code: 'test-code', state: begun.state }) };
  }
  it('logs into the existing employee mailbox and consumes the flow', async () => {
    const { begun, query } = await flow();
    expect(await completeCompanyLogin(c, query, begun.state)).toBe('existing-login-token');
    expect(loginService.login).toHaveBeenCalledWith(c, { email: 'existing-mailbox@example.test', password: null }, true);
    expect(form.get('client_secret')).toBe('secret');
    expect(form.get('code_verifier')).toBeTruthy();
    await expect(completeCompanyLogin(c, query, begun.state)).rejects.toMatchObject({ code: 401 });
  });
  it('uses the callback belonging to the requested portal', async () => {
    c.req.url = 'https://mail-alt.test/api/oauth/company/login';
    const { begun, query } = await flow();
    expect(new URL(begun.url).searchParams.get('redirect_uri')).toBe('https://mail-alt.test/api/oauth/company/callback');
    c.req.url = 'https://mail-alt.test/api/oauth/company/callback';
    await completeCompanyLogin(c, query, begun.state);
    expect(form.get('redirect_uri')).toBe('https://mail-alt.test/api/oauth/company/callback');
  });
  it('rejects a browser state mismatch', async () => {
    const { query } = await flow();
    await expect(completeCompanyLogin(c, query, 'wrong')).rejects.toMatchObject({ code: 401 });
  });
  it('records the provider status without logging credentials', async () => {
    mode = 'upstream';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(beginCompanyLogin(c)).rejects.toMatchObject({ code: 503 });
    expect(log).toHaveBeenCalledWith('Company identity provider request failed', {
      endpoint: 'https://identity.test/.well-known/openid-configuration', status: 525, ray: 'test-ray',
    });
    log.mockRestore();
  });
  it.each(['nonce', 'audience', 'unknown', 'disabled'])('rejects %s', async badMode => {
    mode = badMode;
    const { begun, query } = await flow();
    await expect(completeCompanyLogin(c, query, begun.state)).rejects.toMatchObject({ code: ['unknown', 'disabled'].includes(mode) ? 403 : 401 });
  });
});

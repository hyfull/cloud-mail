import { verifyWithJwks } from 'hono/jwt';
import BizError from '../error/biz-error';
import loginService from './login-service';
import userService from './user-service';

export function companyLoginConfigured(c) {
  return Boolean(c.env.OIDC_ISSUER_URL && c.env.OIDC_CLIENT_ID && c.env.OIDC_CLIENT_SECRET && c.env.OIDC_REDIRECT_URI);
}

export function companyRedirectUris(c) {
  try {
    return [c.env.OIDC_REDIRECT_URI, c.env.OIDC_REDIRECT_URI_ALT]
      .filter(Boolean)
      .map(value => new URL(value));
  } catch {
    throw new BizError('公司身份回调地址配置无效', 503);
  }
}

export function companyRedirectUri(c) {
  const origin = new URL(c.req.url).origin;
  const redirect = companyRedirectUris(c).find(value => value.origin === origin);
  if (!redirect) throw new BizError('请求来源无效', 403);
  return redirect.href;
}

export function randomTicket() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function providerJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const endpoint = new URL(url);
    console.error('Company identity provider request failed', {
      endpoint: `${endpoint.origin}${endpoint.pathname}`, status: response.status,
      ray: response.headers.get('cf-ray'),
    });
    throw new BizError('公司身份服务未完成认证，请重试', response.status < 500 ? 401 : 503);
  }
  return response.json();
}

async function discovery(c) {
  if (!companyLoginConfigured(c)) throw new BizError('公司登录尚未配置', 503);
  const issuer = c.env.OIDC_ISSUER_URL;
  if (!issuer.startsWith('https://') || companyRedirectUris(c).some(value => value.protocol !== 'https:')) throw new BizError('公司身份地址必须使用 HTTPS', 503);
  const document = await providerJson(`${issuer}/.well-known/openid-configuration`);
  if (document.issuer !== issuer || ['authorization_endpoint', 'token_endpoint', 'jwks_uri'].some(key => typeof document[key] !== 'string')) throw new BizError('公司身份服务配置不匹配', 503);
  return document;
}

export async function beginCompanyLogin(c) {
  const document = await discovery(c);
  const redirectUri = companyRedirectUri(c);
  const state = randomTicket(), nonce = randomTicket(), verifier = randomTicket();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  await c.env.kv.put(`company-flow:${state}`, JSON.stringify({ nonce, verifier, redirectUri, expiresAt: Date.now() + 600000 }), { expirationTtl: 600 });
  const target = new URL(document.authorization_endpoint);
  target.search = new URLSearchParams({ client_id: c.env.OIDC_CLIENT_ID, redirect_uri: redirectUri,
    response_type: 'code', scope: 'openid profile email', state, nonce, ui_locales: 'zh-CN',
    code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return { state, url: target.href };
}

export async function completeCompanyLogin(c, query, browserState) {
  const state = query.get('state');
  if (!state || state !== browserState || !query.get('code') || query.has('error')) throw new BizError('公司登录状态校验失败', 401);
  const flow = await c.env.kv.get(`company-flow:${state}`, { type: 'json' });
  if (!flow || flow.expiresAt <= Date.now()) throw new BizError('公司登录流程已过期', 401);
  if (flow.redirectUri !== companyRedirectUri(c)) throw new BizError('公司登录状态校验失败', 401);
  await c.env.kv.delete(`company-flow:${state}`);
  const document = await discovery(c);
  const tokens = await providerJson(document.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: query.get('code'), client_id: c.env.OIDC_CLIENT_ID,
      client_secret: c.env.OIDC_CLIENT_SECRET, code_verifier: flow.verifier, redirect_uri: flow.redirectUri }) });
  const jwks = await providerJson(document.jwks_uri);
  let identity;
  try {
    identity = await verifyWithJwks(tokens.id_token, { keys: jwks.keys, allowedAlgorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256'],
      verification: { iss: c.env.OIDC_ISSUER_URL, aud: c.env.OIDC_CLIENT_ID } });
  } catch (cause) {
    console.warn('Company ID token validation failed', cause.name);
    throw new BizError('公司身份校验失败', 401);
  }
  if (!identity.sub || !identity.exp || !identity.iat || identity.nonce !== flow.nonce) throw new BizError('公司身份校验失败', 401);
  // 使用飞书同步建立的稳定身份绑定，邮箱地址可以与员工的登录邮箱不同。
  const link = await c.env.db.prepare('SELECT user_id AS userId, status FROM identity_link WHERE keycloak_user_id = ? LIMIT 1').bind(identity.sub).first();
  if (!link || link.status !== 'ACTIVE' || !link.userId) throw new BizError('公司邮箱尚未开通或已停用，请联系管理员', 403);
  const user = await userService.selectByIdIncludeDel(c, link.userId);
  if (!user) throw new BizError('公司邮箱账户不存在', 403);
  return loginService.login(c, { email: user.email, password: null }, true);
}

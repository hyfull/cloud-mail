import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import app from '../hono/hono';
import result from '../model/result';
import BizError from '../error/biz-error';
import { beginCompanyLogin, completeCompanyLogin, companyLoginConfigured, companyRedirectUris, randomTicket } from '../service/company-login-service';

const flowCookie = 'cloud_mail_company_flow', exchangeCookie = 'cloud_mail_company_exchange';
const options = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/api/oauth/company' };
app.get('/oauth/company/config', c => c.json(result.ok({ enabled: companyLoginConfigured(c) })));
app.get('/oauth/company/login', async c => {
  const started = await beginCompanyLogin(c);
  setCookie(c, flowCookie, started.state, { ...options, maxAge: 600 });
  return c.redirect(started.url, 302);
});
app.get('/oauth/company/callback', async c => {
  const browserState = getCookie(c, flowCookie);
  deleteCookie(c, flowCookie, options);
  try {
    const token = await completeCompanyLogin(c, new URL(c.req.url).searchParams, browserState);
    const ticket = randomTicket();
    await c.env.kv.put(`company-exchange:${ticket}`, token, { expirationTtl: 60 });
    setCookie(c, exchangeCookie, ticket, { ...options, maxAge: 60 });
    return c.redirect('/login?company=1', 303);
  } catch (error) {
    console.error('Company mailbox login failed', error instanceof BizError ? error.message : error.name);
    return c.redirect('/login?company_error=1', 303);
  }
});
app.post('/oauth/company/exchange', async c => {
  const origins = companyRedirectUris(c).map(value => value.origin);
  if (!origins.includes(c.req.header('Origin'))) throw new BizError('请求来源无效', 403);
  const ticket = getCookie(c, exchangeCookie);
  deleteCookie(c, exchangeCookie, options);
  if (!ticket) throw new BizError('公司登录已过期，请重试', 401);
  const token = await c.env.kv.get(`company-exchange:${ticket}`);
  if (!token) throw new BizError('公司登录已过期，请重试', 401);
  await c.env.kv.delete(`company-exchange:${ticket}`);
  return c.json(result.ok({ token }));
});

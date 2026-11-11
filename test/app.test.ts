// The whole app against the mock CPA (credentials, quota, usage queue): login / session, accounts, import / export,
// OAuth, settings. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';
import { queueRecord, BAN_SUMMARY } from './fixture-usage.ts';
import { readZip, writeZip } from '../src/zip.ts';
import { hashPassword } from '../src/util.ts';

const MGMT = 'mgmt-test', PW = 'correct horse battery';
const mock = startMockCPA({ mgmtKey: MGMT });
let app: ChildProcess;
let base = '', dir = '', logs = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  cookie = '';
  setCookie = '';
  async req(method: string, path: string, body?: any, opts: { raw?: Buffer; headers?: Record<string, string>; csrf?: boolean } = {}) {
    const headers: Record<string, string> = { ...(opts.csrf === false ? {} : { 'X-App-CSRF': '1' }), ...(opts.headers || {}) };
    if (this.cookie) headers.cookie = this.cookie;
    let b: any;
    if (opts.raw) { b = opts.raw; headers['Content-Type'] = 'application/octet-stream'; }
    else if (body !== undefined) { b = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const r = await fetch(base + path, { method, headers, body: b, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) if (c.startsWith('agyme_sid=')) { this.setCookie = c; this.cookie = c.split(';')[0]; }
    const buf = Buffer.from(await r.arrayBuffer());
    let data: any = buf.toString();
    try { data = JSON.parse(data); } catch {}
    return { status: r.status, data, buf, headers: r.headers };
  }
}
const me = new Client();

before(async () => {
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', () => r()));
  const cpaPort = (mock.server.address() as AddressInfo).port;
  dir = mkdtempSync(join(tmpdir(), 'agyme-app-'));
  mock.addCred('antigravity-ok@example.invalid.json', 'ok@example.invalid', { tier: 'g1-pro-tier', quota: { gemini: [1, 1], claude: [0, 0.5], argon: 0.4 } });
  mock.addCred('antigravity-tos@example.invalid.json', 'tos@example.invalid');
  mock.addCred('antigravity-off@example.invalid.json', 'off@example.invalid', { disabled: true });
  mock.addCred('gemini-other@example.invalid.json', 'other@example.invalid', { type: 'gemini-cli' }); // not shown, not reachable
  const ix = (id: string) => mock.st.creds.get(id)!.index;
  mock.st.queue.push(
    queueRecord(ix('antigravity-tos@example.invalid.json'), { ts: Date.now() - 60000, model: 'claude-opus-5-5', failed: true, status: 403, summary: BAN_SUMMARY }),
    queueRecord(ix('antigravity-ok@example.invalid.json'), { ts: Date.now() - 30000, model: 'gemini-3.8-flash', ttft: 500 }),
  );
  const port = 19000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}/me`;
  app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BASE_PATH: '/me', DATA_DIR: join(dir, 'data'), CPA_URL: `http://127.0.0.1:${cpaPort}`,
      CPA_MANAGEMENT_KEY: MGMT, APP_PASSWORD_HASH: hashPassword(PW), APP_PASSWORD: '', USAGE_POLL_MS: '500', QUOTA_REFRESH_MINUTES: '0', AUTO_DISABLE_SWEEP_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout!.on('data', (d) => (logs += d));
  app.stderr!.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    await sleep(100);
  }
  for (let i = 0; i < 50 && mock.st.queue.length; i++) await sleep(100); // first drain
});
after(async () => {
  if (app && app.exitCode === null) await new Promise((r) => { app.once('exit', r); app.kill(); });
  mock.server.closeAllConnections();
  mock.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('everything is under BASE_PATH; the API needs a session', async () => {
  assert.equal((await fetch(base.replace('/me', '') + '/api/me')).status, 404);
  assert.equal((await me.req('GET', '/api/me')).status, 401);
  assert.equal((await me.req('GET', '/api/accounts')).status, 401);
  assert.equal((await me.req('GET', '/api/overview')).status, 401);
  const page = await me.req('GET', '/');
  assert.equal(page.status, 200);
  assert.match(String(page.data), /AGY Me/);
});

test('login: wrong password refused and rate limited per IP, right one sets a safe cookie', async () => {
  const bad = new Client();
  const h = { 'X-Real-IP': '203.0.113.9' };
  for (let i = 0; i < 8; i++) assert.equal((await bad.req('POST', '/api/login', { password: 'nope' + i }, { headers: h })).status, 401);
  assert.equal((await bad.req('POST', '/api/login', { password: PW }, { headers: h })).status, 429, 'locked out even with the right password');
  // other clients are not affected
  assert.equal((await me.req('POST', '/api/login', { password: PW }, { csrf: false })).status, 403, 'CSRF header required');
  const ok = await me.req('POST', '/api/login', { password: PW });
  assert.equal(ok.status, 200);
  assert.match(me.setCookie, /HttpOnly/);
  assert.match(me.setCookie, /SameSite=Lax/);
  assert.match(me.setCookie, /Path=\/me/);
  assert.doesNotMatch(me.setCookie, /Secure/, 'plain http locally');
  assert.equal((await me.req('GET', '/api/me')).status, 200);
  // behind the https proxy the cookie is Secure
  const p = new Client();
  await p.req('POST', '/api/login', { password: PW }, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(p.setCookie, /; Secure/);
  // logout ends that session only
  assert.equal((await p.req('POST', '/api/logout')).status, 200);
  p.cookie = p.cookie || 'agyme_sid=gone';
  assert.equal((await p.req('GET', '/api/me')).status, 401);
  assert.equal((await me.req('GET', '/api/me')).status, 200);
});

test('accounts: status from CPA + quota + request log; refresh one; overview counts and ban banner', async () => {
  const r1 = await me.req('POST', '/api/accounts/antigravity-ok@example.invalid.json/refresh');
  assert.equal(r1.status, 200);
  assert.equal(r1.data.tier, 'PRO');
  assert.equal(r1.data.quota.claude.h5.frac, 0);
  const L = (await me.req('GET', '/api/accounts')).data.accounts;
  const st = Object.fromEntries(L.map((a: any) => [a.email, a.status]));
  assert.deepEqual(st, { 'ok@example.invalid': 'ok', 'tos@example.invalid': 'banned', 'off@example.invalid': 'disabled' });
  assert.ok(L.find((a: any) => a.email === 'ok@example.invalid').lastUsed > 0);
  const o = (await me.req('GET', '/api/overview')).data;
  assert.deepEqual(o.counts, { total: 3, ok: 1, cooldown: 0, banned: 1, disabled: 1 });
  assert.equal(o.healthy, 0.5);
  assert.deepEqual(o.bans.map((b: any) => b.email), ['tos@example.invalid']);
  assert.equal(o.bans[0].action.kind, 'appeal');
  assert.equal(o.fam.claude.withQuota, 0);
  assert.equal(o.fam.gemini.withQuota, 1);
  assert.equal(o.recent.length, 2);
  // one-click 停用 from the banner
  const off = await me.req('PATCH', '/api/accounts/antigravity-tos@example.invalid.json', { disabled: true, note: 'banned' });
  assert.equal(off.data.status, 'disabled');
  assert.equal(off.data.note, 'banned');
  assert.equal((await me.req('GET', '/api/overview')).data.bans.length, 0);
});

test('batch enable / disable / refresh, unknown ids counted as skipped; over 500 refused', async () => {
  const ids = ['antigravity-tos@example.invalid.json', 'antigravity-off@example.invalid.json', 'nope.json'];
  assert.deepEqual((await me.req('POST', '/api/accounts/batch', { op: 'enable', ids })).data, { ok: 2, failed: 0, skipped: 1 });
  assert.equal(mock.st.creds.get('antigravity-off@example.invalid.json')!.disabled, false);
  assert.equal((await me.req('POST', '/api/accounts/batch', { op: 'disable', ids })).data.ok, 2);
  assert.equal((await me.req('POST', '/api/accounts/batch', { op: 'refresh', ids })).data.queued, 2);
  assert.equal((await me.req('POST', '/api/accounts/batch', { op: 'explode', ids })).status, 400);
  const many = Array.from({ length: 501 }, (_, i) => `x${i}.json`);
  const big = await me.req('POST', '/api/accounts/batch', { op: 'disable', ids: many });
  assert.deepEqual([big.status, big.data.error], [400, 'too_many']);
});

test('id routes only reach antigravity credentials', async () => {
  const other = 'gemini-other@example.invalid.json';
  const enc = encodeURIComponent(other);
  assert.equal((await me.req('PATCH', '/api/accounts/' + enc, { disabled: true })).status, 404);
  assert.equal((await me.req('POST', `/api/accounts/${enc}/refresh`)).status, 404);
  assert.deepEqual((await me.req('POST', '/api/accounts/batch', { op: 'delete', ids: [other] })).data, { ok: 0, failed: 0, skipped: 1 });
  assert.equal((await me.req('POST', '/api/quota/refresh', { ids: [other] })).data.queued, 0);
  const ex = await me.req('POST', '/api/accounts/export', { ids: [other] });
  assert.equal(ex.data.error, 'export_incomplete');
  assert.ok(mock.st.creds.has(other));
  assert.equal(mock.st.creds.get(other)!.disabled, false);
});

test('add by refresh token: email from Google, temp credential removed, bad / duplicate reported', async () => {
  const r = await me.req('POST', '/api/accounts/refresh-token', { tokens: '1//aaaaaaaaaaaaaaaaaaaaaaaaRTONE1\n1//aaaaaaaaaaaaaaaaaaaaaaaaBAD999\nnot-a-token\n1//aaaaaaaaaaaaaaaaaaaaaaaaRTONE1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map((x: any) => x.ok ? x.email : x.error), ['rt-rtone1@gmail.com', 'invalid_token', 'invalid_token']);
  assert.ok(mock.st.creds.has('antigravity-rt-rtone1@gmail.com.json'));
  assert.equal(mock.st.files.get('antigravity-rt-rtone1@gmail.com.json').email, 'rt-rtone1@gmail.com');
  assert.ok(![...mock.st.creds.keys()].some((k) => k.startsWith('antigravity-rt-') && !k.includes('@')), 'temporary credentials are deleted');
  const dup = await me.req('POST', '/api/accounts/refresh-token', { tokens: '1//aaaaaaaaaaaaaaaaaaaaaaaaRTONE1' });
  assert.equal(dup.data.results[0].error, 'duplicate');
  assert.equal((await me.req('POST', '/api/accounts/refresh-token', { tokens: ' ' })).data.error, 'invalid_token');
  await me.req('POST', '/api/accounts/batch', { op: 'delete', ids: ['antigravity-rt-rtone1@gmail.com.json'] });
});

test('import several files (JSON + ZIP), duplicates skipped; export selected as one zip; delete', async () => {
  const j = (email: string) => Buffer.from(JSON.stringify({ type: 'antigravity', email, refresh_token: '1//rt', access_token: 'ya29.x', project_id: 'p' }));
  const one = await me.req('POST', '/api/accounts/import?name=antigravity-new1@example.invalid.json', undefined, { raw: j('new1@example.invalid') });
  assert.deepEqual(one.data.results.map((r: any) => [r.ok, r.id]), [[true, 'antigravity-new1@example.invalid.json']]);
  const zip = writeZip([{ name: 'a.json', data: j('new2@example.invalid') }, { name: 'b.json', data: j('ok@example.invalid') }, { name: 'c.json', data: Buffer.from('{"type":"other"}') }]);
  const z = await me.req('POST', '/api/accounts/import?name=x.zip', undefined, { raw: zip });
  assert.deepEqual(z.data.results.map((r: any) => r.ok ? 'ok' : r.error), ['ok', 'duplicate', 'invalid']);
  assert.ok(mock.st.creds.has('antigravity-new2@example.invalid.json'));
  const over = await me.req('POST', '/api/accounts/import?name=many.json', undefined, { raw: Buffer.from(JSON.stringify(Array.from({ length: 501 }, () => ({})))) });
  assert.deepEqual(over.data.results.map((r: any) => r.error), ['too_many']);
  assert.equal((await me.req('POST', '/api/accounts/import?name=x.zip', undefined, { raw: Buffer.from('PK\x03\x04 broken') })).data.error, 'invalid_zip');

  const ex = await me.req('POST', '/api/accounts/export', { ids: ['antigravity-new1@example.invalid.json', 'antigravity-new2@example.invalid.json'] });
  assert.equal(ex.headers.get('content-type'), 'application/zip');
  const files = readZip(ex.buf);
  assert.deepEqual(files.map((f) => f.name).sort(), ['antigravity-new1@example.invalid.json', 'antigravity-new2@example.invalid.json']);
  assert.equal(JSON.parse(files[0].data.toString()).type, 'antigravity');
  const single = await me.req('POST', '/api/accounts/export', { ids: ['antigravity-new1@example.invalid.json'] });
  assert.equal(single.headers.get('content-type'), 'application/json');
  assert.match(single.headers.get('content-disposition') || '', /filename="antigravity-new1@example\.invalid\.json"/);
  assert.equal(single.data.email, 'new1@example.invalid');
  const all = await me.req('POST', '/api/accounts/export', {});
  assert.equal(readZip(all.buf).length, 5);
  // a credential that can't be read fails the export (no zip with a hole in it), naming the account
  mock.st.noDownload.add('antigravity-new2@example.invalid.json');
  const holed = await me.req('POST', '/api/accounts/export', { ids: ['antigravity-new1@example.invalid.json', 'antigravity-new2@example.invalid.json'] });
  assert.equal(holed.status, 502);
  assert.equal(holed.data.error, 'export_incomplete');
  assert.equal(holed.data.message, 'new2@example.invalid');
  assert.equal((await me.req('POST', '/api/accounts/export', {})).status, 502);
  assert.equal((await me.req('POST', '/api/accounts/export', { ids: ['antigravity-new2@example.invalid.json'] })).status, 502);
  mock.st.noDownload.clear();

  const del = await me.req('POST', '/api/accounts/batch', { op: 'delete', ids: ['antigravity-new1@example.invalid.json', 'antigravity-new2@example.invalid.json'] });
  assert.equal(del.data.ok, 2);
  assert.ok(!mock.st.creds.has('antigravity-new1@example.invalid.json'));
});

test('add account through CPA OAuth (pasted callback)', async () => {
  const s = await me.req('POST', '/api/accounts/oauth');
  assert.match(s.data.url, /accounts\.google\.com/);
  assert.equal((await me.req('POST', '/api/accounts/oauth/callback', { state: 'other', url: 'http://localhost:51121/oauth-callback?state=other&code=x' })).status, 400);
  assert.equal((await me.req('POST', '/api/accounts/oauth/callback', { state: s.data.state, url: `http://localhost:51121/oauth-callback?state=${s.data.state}&code=fresh` })).status, 200);
  let r: any;
  for (let i = 0; i < 30; i++) {
    r = (await me.req('GET', '/api/accounts/oauth/' + s.data.state)).data;
    if (r.status !== 'wait') break;
    await sleep(100);
  }
  assert.equal(r.status, 'ok');
  assert.equal(r.email, 'fresh@example.invalid');
});

test('request log and usage come from the drained CPA usage queue', async () => {
  const l = (await me.req('GET', '/api/logs?facets=1&status=err')).data;
  assert.equal(l.available, true);
  assert.equal(l.total, 1);
  assert.equal(l.rows[0].status, 403);
  assert.ok(l.facets.models.includes('gemini-3.8-flash'));
  assert.equal((await me.req('GET', '/api/logs/' + l.rows[0].id)).data.account, 'tos@example.invalid');
  const u = (await me.req('GET', '/api/usage?range=24h&tz=480')).data;
  assert.equal(u.totals.req, 2);
  // new records keep arriving; a queue outage shows on the settings page and recovers
  mock.st.queue.push(queueRecord(mock.st.creds.get('antigravity-ok@example.invalid.json')!.index, { ts: Date.now(), model: 'gemini-3.8-flash', ttft: 700 }));
  let total = 0;
  for (let i = 0; i < 40 && total < 3; i++) { await sleep(100); total = (await me.req('GET', '/api/logs')).data.total; }
  assert.equal(total, 3);
  assert.equal((await me.req('GET', '/api/logs?account=ok@example.invalid')).data.rows[0].ttft, 700);
  mock.st.queueDown = true;
  await sleep(800);
  assert.equal((await me.req('GET', '/api/settings')).data.usage.ok, false);
  mock.st.queueDown = false;
  await sleep(800);
  assert.equal((await me.req('GET', '/api/settings')).data.usage.ok, true);
});

test('settings: CPA switches and the quota interval; tier table', async () => {
  const s = (await me.req('GET', '/api/settings')).data;
  assert.equal(s.cpa.ok, true);
  assert.equal(s.usage.ok, true);
  assert.equal(s.values.requestLog, false);
  assert.equal(s.values.keepalive, 15);
  assert.equal((await me.req('PATCH', '/api/settings', { key: 'requestLog', value: true })).status, 200);
  assert.equal(mock.st.config['observability/logs/request-log'], true);
  assert.equal((await me.req('PATCH', '/api/settings', { key: 'keepalive', value: 9999 })).data.value, 300, 'clamped');
  assert.equal((await me.req('PATCH', '/api/settings', { key: 'nope', value: 1 })).status, 400);
  assert.equal((await me.req('PATCH', '/api/settings', { key: 'quotaRefreshMinutes', value: 30 })).status, 200);
  assert.equal((await me.req('GET', '/api/settings')).data.app.quotaRefreshMinutes, 30);
  const t = (await me.req('GET', '/api/tiers')).data;
  assert.ok(t.families.some((f: any) => f.family === 'claude-opus-5-5'));
  assert.ok(t.untiered.some((u: any) => u.family === 'claude-sonnet-4-6'));
});

test('no unexpected server errors', () => {
  assert.doesNotMatch(logs, /\[error\]/, logs);
});

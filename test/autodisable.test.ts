// Auto-disable: 403 accounts go off with Google's reason, 429 / 401 / quota answers don't, the user's own toggles win,
// a probe that works brings back only accounts this app turned off, and the two settings switch it all off. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';
import { queueRecord, BAN_SUMMARY } from './fixture-usage.ts';
import { hashPassword } from '../src/util.ts';
import { match403 } from '../src/accerr.ts';

const MGMT = 'mgmt-test', PW = 'auto disable test';
const mock = startMockCPA({ mgmtKey: MGMT });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let app: ChildProcess;
let base = '', dir = '', logs = '', cookie = '';
const QUOTA_429 = '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}';
const AUTH_401 = '{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}';

async function req(method: string, path: string, body?: any) {
  const headers: Record<string, string> = { 'X-App-CSRF': '1' };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of r.headers.getSetCookie()) if (c.startsWith('agyme_sid=')) cookie = c.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) as any };
}
const off = (id: string) => mock.st.creds.get(id)!.disabled;
const acc = async (id: string) => (await req('GET', '/api/accounts')).data.accounts.find((a: any) => a.id === id);
async function until(what: string, f: () => boolean | Promise<boolean>, ms = 8000) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) if (await f()) return;
  assert.fail('timed out waiting for: ' + what + '\n' + logs);
}
const ix = (id: string) => mock.st.creds.get(id)!.index;
const log = (id: string, status: number, body: string) => mock.st.queue.push(queueRecord(ix(id), { ts: Date.now(), model: 'claude-opus-5-5', failed: true, status, summary: body }));

before(async () => {
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', () => r()));
  const cpaPort = (mock.server.address() as AddressInfo).port;
  dir = mkdtempSync(join(tmpdir(), 'agyme-auto-'));
  const old = new Date(Date.now() - 2 * 864e5).toISOString();
  mock.addCred('a403', 'a403@example.invalid');
  mock.addCred('a429', 'a429@example.invalid');
  mock.addCred('a401', 'a401@example.invalid');
  mock.addCred('aq403', 'aq403@example.invalid');           // status 403 on the log row, but the body is a quota answer
  mock.addCred('acd', 'acd@example.invalid', { status: 'error', unavailable: true, status_message: QUOTA_429 });
  mock.addCred('aquota', 'aquota@example.invalid', { forbidden: true });
  mock.addCred('aflip', 'aflip@example.invalid', { forbidden: true });
  mock.addCred('amanual', 'amanual@example.invalid', { disabled: true });
  mock.addCred('aidle', 'aidle@example.invalid', { forbidden: true, updated_at: old }); // nobody routes into it
  mock.addCred('aok', 'aok@example.invalid');
  log('a403', 403, BAN_SUMMARY);
  log('a429', 429, QUOTA_429);
  log('a401', 401, AUTH_401);
  log('aq403', 403, QUOTA_429);
  const port = 21000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BASE_PATH: '', DATA_DIR: join(dir, 'data'), CPA_URL: `http://127.0.0.1:${cpaPort}`,
      CPA_MANAGEMENT_KEY: MGMT, APP_PASSWORD_HASH: hashPassword(PW), APP_PASSWORD: '', USAGE_POLL_MS: '300', QUOTA_REFRESH_MINUTES: '0',
      AUTO_DISABLE_SWEEP_MS: '300', AUTO_DISABLE_PROBE_SECONDS: '1', AUTO_DISABLE_IDLE_SECONDS: '3600' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout!.on('data', (d) => (logs += d));
  app.stderr!.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    await sleep(100);
  }
  assert.equal((await req('POST', '/api/login', { password: PW })).status, 200);
  assert.equal((await req('PATCH', '/api/settings', { key: 'autoEnable', value: false })).status, 200);
});
after(async () => {
  if (app && app.exitCode === null) await new Promise((r) => { app.once('exit', r); app.kill(); });
  mock.server.closeAllConnections();
  mock.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('match403: 403 refusals yes; 429 / 401 / quota no', () => {
  assert.match(match403(BAN_SUMMARY)!, /^403 This service has been disabled/);
  assert.match(match403('403 {"error":{"message":"Verify your account to continue.","status":"PERMISSION_DENIED"}}')!, /^403 Verify your account/);
  assert.ok(match403('Your account has been suspended'));
  for (const s of [QUOTA_429, AUTH_401, '403 quota exceeded', '429 Too Many Requests', 'invalid_grant', 'rate limit 403', '', 'upstream error'])
    assert.equal(match403(s), null, s);
});

test('a 403 in the request log turns the account off with the reason, the time and the appeal link', async () => {
  await until('a403 off', () => off('a403'));
  const a = await acc('a403');
  assert.equal(a.status, 'disabled');
  assert.match(a.reason, /^自动停用 · 403 This service has been disabled/);
  assert.ok(a.autoAt > 0);
  assert.equal(a.action.kind, 'appeal');
  const o = (await req('GET', '/api/overview')).data;
  assert.ok(o.autoOff.some((x: any) => x.id === 'a403'));
  assert.ok(!o.bans.some((x: any) => x.id === 'a403'), 'the ban banner no longer asks to disable it');
});

test('the quota read (forbidden) and an idle probe catch 403s too; probes use a flash model the account has', async () => {
  await req('POST', '/api/accounts/aquota/refresh');
  await req('POST', '/api/accounts/aflip/refresh');
  await until('aquota, aflip, aidle off', () => off('aquota') && off('aflip') && off('aidle'));
  assert.match((await acc('aidle')).reason, /^自动停用 · 403/);
  assert.ok(mock.st.probes.length > 0);
  for (const p of mock.st.probes) {
    assert.match(p.model, /^gemini-.*flash/, p.model);
    assert.ok(mock.st.models.includes(p.model), 'a model the account has: ' + p.model);
  }
});

test('429 / quota text never turn an account off; a dead sign-in (401) does; manual-disabled stays untouched', async () => {
  await sleep(1500); // several sweeps
  for (const id of ['a429', 'aq403', 'acd', 'aok']) assert.equal(off(id), false, id);
  assert.equal(off('a401'), true, 'a401');
  assert.match((await acc('a401')).reason, /401/);
  assert.equal(off('amanual'), true);
  assert.equal((await acc('amanual')).autoAt, 0);
  // autoEnable is off: nothing came back although a403's probe would now succeed
  assert.equal(off('a403'), true);
});

test('the user turning an auto-disabled account on clears the mark; the old 403 row does not turn it off again', async () => {
  const r = await req('PATCH', '/api/accounts/a403', { disabled: false });
  assert.equal(r.data.status, 'banned', 'the log still shows the 403');
  assert.equal(r.data.autoAt, 0);
  await sleep(1500);
  assert.equal(off('a403'), false);
  assert.ok(!(await req('GET', '/api/overview')).data.autoOff.some((x: any) => x.id === 'a403'));
});

test('a working probe re-enables only accounts this app turned off', async () => {
  await req('PATCH', '/api/accounts/a403', { disabled: true }); // now off by hand
  mock.st.creds.get('aflip')!.forbidden = false;
  mock.st.creds.get('amanual')!.forbidden = false;
  assert.equal((await req('PATCH', '/api/settings', { key: 'autoEnable', value: true })).status, 200);
  await until('aflip back on', () => !off('aflip'));
  await sleep(1500);
  assert.equal(off('aflip'), false, 'the stale forbidden quota read does not turn it off again');
  assert.equal(off('aquota'), true, 'still 403');
  assert.equal(off('a403'), true, 'manual: never auto-enabled');
  assert.equal(off('amanual'), true);
  assert.equal((await acc('a403')).autoAt, 0);
});

test('switches off: nothing happens', async () => {
  assert.equal((await req('PATCH', '/api/settings', { key: 'autoDisable', value: false })).status, 200);
  assert.equal((await req('PATCH', '/api/settings', { key: 'autoEnable', value: false })).status, 200);
  const s = (await req('GET', '/api/settings')).data.app;
  assert.deepEqual([s.autoDisable, s.autoEnable], [false, false]);
  log('aok', 403, BAN_SUMMARY);
  mock.st.creds.get('aquota')!.forbidden = false;
  await sleep(2000);
  assert.equal(off('aok'), false);
  assert.equal(off('aquota'), true);
  assert.equal((await acc('aok')).status, 'banned');
});

test('no unexpected server errors', () => {
  assert.doesNotMatch(logs, /sweep failed|\[error\]/, logs);
});

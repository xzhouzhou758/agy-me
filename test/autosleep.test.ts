// 闲置自动休眠: off by default, idle accounts go to sleep, any new request wakes them (and gives a fresh idle period),
// manual stops are never woken, turning the switch off wakes everything. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';
import { queueRecord } from './fixture-usage.ts';
import { hashPassword } from '../src/util.ts';

const MGMT = 'mgmt-test', PW = 'auto sleep test';
const mock = startMockCPA({ mgmtKey: MGMT });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let app: ChildProcess;
let base = '', dir = '', logs = '', cookie = '';
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
  dir = mkdtempSync(join(tmpdir(), 'agyme-sleep-'));
  mock.addCred('s1', 's1@example.invalid');
  mock.addCred('s2', 's2@example.invalid');
  mock.addCred('smanual', 'smanual@example.invalid', { disabled: true });
  const port = 22000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BASE_PATH: '', DATA_DIR: join(dir, 'data'), CPA_URL: `http://127.0.0.1:${cpaPort}`,
      CPA_MANAGEMENT_KEY: MGMT, APP_PASSWORD_HASH: hashPassword(PW), APP_PASSWORD: '', USAGE_POLL_MS: '300', QUOTA_REFRESH_MINUTES: '0',
      AUTO_DISABLE_SWEEP_MS: '0', AUTO_SLEEP_SWEEP_MS: '300', AUTO_SLEEP_IDLE_SECONDS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout!.on('data', (d) => (logs += d));
  app.stderr!.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    await sleep(100);
  }
  assert.equal((await req('POST', '/api/login', { password: PW })).status, 200);
});
after(async () => {
  if (app && app.exitCode === null) await new Promise((r) => { app.once('exit', r); app.kill(); });
  mock.server.closeAllConnections();
  mock.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('off by default: nothing sleeps', async () => {
  assert.equal((await req('GET', '/api/settings')).data.app.autoSleep, false);
  await sleep(3000);
  assert.equal(off('s1'), false);
});

test('switch on: idle accounts sleep, manual stops stay as they are', async () => {
  assert.equal((await req('PATCH', '/api/settings', { key: 'autoSleep', value: true })).status, 200);
  await until('s1 and s2 asleep', () => off('s1') && off('s2'));
  const a = await acc('s1');
  assert.ok(a.sleepAt > 0 && a.disabled);
  assert.equal((await acc('smanual')).sleepAt, 0);
});

test('a new request wakes every sleeper, and they get a fresh idle period', async () => {
  mock.st.queue.push(queueRecord(mock.st.creds.get('s1')!.index, { ts: Date.now(), model: 'claude-opus-5-5' }));
  await until('both awake', () => !off('s1') && !off('s2'));
  assert.equal(off('smanual'), true, 'a manual stop is never woken');
  assert.equal((await acc('s1')).sleepAt, 0);
  await sleep(500);
  assert.equal(off('s2'), false, 'not put straight back to sleep');
});

test('turning the switch off wakes the sleepers', async () => {
  await until('asleep again', () => off('s1') && off('s2'), 10000);
  assert.equal((await req('PATCH', '/api/settings', { key: 'autoSleep', value: false })).status, 200);
  await until('awake', () => !off('s1') && !off('s2'));
  assert.equal(off('smanual'), true);
});

test('a manual toggle drops the sleep mark', async () => {
  assert.equal((await req('PATCH', '/api/settings', { key: 'autoSleep', value: true })).status, 200);
  await until('s1 asleep', () => off('s1'));
  assert.equal((await req('PATCH', '/api/accounts/s1', { disabled: false })).status, 200);
  assert.equal((await acc('s1')).sleepAt, 0);
  assert.equal(off('s1'), false);
});

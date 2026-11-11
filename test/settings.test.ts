// Settings page: changing the login password (other sessions end, survives a restart, wins over the env) and
// CPA's client API keys (masked list, reveal, add / generate, duplicates, delete, notes by hash). Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';
import { hashPassword, sha256 } from '../src/util.ts';

const MGMT = 'mgmt-test', PW = 'first password', PW2 = 'second password', PW3 = 'third password';
const mock = startMockCPA({ mgmtKey: MGMT });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let app: ChildProcess | null = null;
let base = '', dir = '', cpaPort = 0, logs = '';
const port = 20000 + Math.floor(Math.random() * 1000);
const statePath = () => join(dir, 'data', 'state.json');

async function start(env: Record<string, string> = {}) {
  app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BASE_PATH: '', DATA_DIR: join(dir, 'data'), CPA_URL: `http://127.0.0.1:${cpaPort}`,
      CPA_MANAGEMENT_KEY: MGMT, APP_PASSWORD_HASH: hashPassword(PW), APP_PASSWORD: '', USAGE_POLL_MS: '60000', QUOTA_REFRESH_MINUTES: '0', AUTO_DISABLE_SWEEP_MS: '0', APP_PASSWORD_RESET: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout!.on('data', (d) => (logs += d));
  app.stderr!.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('app did not start\n' + logs);
}
async function stop() {
  if (app && app.exitCode === null) await new Promise((r) => { app!.once('exit', r); app!.kill('SIGTERM'); });
  app = null;
}

class Client {
  cookie = '';
  async req(method: string, path: string, body?: any) {
    const headers: Record<string, string> = { 'X-App-CSRF': '1' };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) if (c.startsWith('agyme_sid=')) this.cookie = c.split(';')[0];
    const t = await r.text();
    let data: any = t;
    try { data = JSON.parse(t); } catch {}
    return { status: r.status, data };
  }
  async login(pw: string) { return (await this.req('POST', '/api/login', { password: pw })).status; }
  async ok() { return (await this.req('GET', '/api/me')).status === 200; }
}

before(async () => {
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', () => r()));
  cpaPort = (mock.server.address() as AddressInfo).port;
  dir = mkdtempSync(join(tmpdir(), 'agyme-set-'));
  base = `http://127.0.0.1:${port}`;
  await start();
});
after(async () => {
  await stop();
  mock.server.closeAllConnections();
  mock.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('password change: validation, wrong old password, other sessions end, this one stays', async () => {
  const a = new Client(), b = new Client(), anon = new Client();
  assert.equal(await a.login(PW), 200);
  assert.equal(await b.login(PW), 200);
  assert.equal((await anon.req('POST', '/api/password', { old: PW, password: PW2, confirm: PW2 })).status, 401);
  assert.equal((await a.req('POST', '/api/password', { old: PW, password: 'short', confirm: 'short' })).data.error, 'password_too_short');
  assert.equal((await a.req('POST', '/api/password', { old: PW, password: PW2, confirm: PW2 + 'x' })).data.error, 'password_mismatch');
  const bad = await a.req('POST', '/api/password', { old: 'wrong one', password: PW2, confirm: PW2 });
  assert.equal(bad.status, 403); // not 401: the UI would take that as "logged out"
  assert.equal(bad.data.error, 'bad_old_password');
  assert.ok(await a.ok());

  assert.equal((await a.req('POST', '/api/password', { old: PW, password: PW2, confirm: PW2 })).status, 200);
  assert.ok(await a.ok(), 'the session that changed it stays');
  assert.equal(await b.ok(), false, 'other sessions end');
  assert.equal(await new Client().login(PW), 401);
  assert.equal(await new Client().login(PW2), 200);
  const st = JSON.parse(readFileSync(statePath(), 'utf8'));
  assert.match(st.pwHash, /^scrypt:/);
  assert.ok(!JSON.stringify(st).includes(PW2));
});

test('wrong old passwords count against the login limit', async () => {
  const a = new Client();
  assert.equal(await a.login(PW2), 200);
  let last = 0;
  for (let i = 0; i < 9; i++) last = (await a.req('POST', '/api/password', { old: 'nope-' + i, password: PW3, confirm: PW3 })).status;
  assert.equal(last, 429);
  assert.equal(await new Client().login(PW2), 429);
});

test('a changed password survives a restart, keeps its session, and wins over the env', async () => {
  const a = new Client();
  await stop(); await start(); // restart also clears the login limit
  assert.equal(await a.login(PW2), 200);
  await stop();
  await start({ APP_PASSWORD_HASH: hashPassword('env changed meanwhile') });
  assert.ok(await a.ok(), 'no logout: the password in force did not change');
  assert.equal(await new Client().login('env changed meanwhile'), 401);
  assert.equal(await new Client().login(PW2), 200);
  await stop();
  await start({ APP_PASSWORD_RESET: '1' });
  assert.equal(await a.ok(), false, 'reset: the env password is back, sessions end');
  assert.equal(await new Client().login(PW2), 401);
  assert.equal(await new Client().login(PW), 200);
  assert.equal(JSON.parse(readFileSync(statePath(), 'utf8')).pwHash, undefined);
  await stop(); await start();
});

test('API keys: masked list, reveal, add, generate, duplicates, notes by hash, delete', async () => {
  const a = new Client();
  assert.equal(await a.login(PW), 200);
  const first = 'sk-mock-client-key-0001';
  let r = await a.req('GET', '/api/keys');
  assert.deepEqual(r.data.keys, [{ id: sha256(first), masked: 'sk-moc…0001', note: '' }]);
  assert.ok(!JSON.stringify(r.data).includes(first));
  assert.equal((await a.req('GET', '/api/keys/' + sha256(first))).data.key, first);
  assert.equal((await a.req('GET', '/api/keys/' + sha256('nope'))).status, 404);
  assert.equal((await new Client().req('GET', '/api/keys')).status, 401);

  const custom = 'my-custom-key-123456';
  r = await a.req('POST', '/api/keys', { key: '  ' + custom + ' ', note: '酒馆' });
  assert.equal(r.status, 200);
  assert.equal(r.data.key, custom);
  assert.deepEqual(mock.st.config['access/api-keys'], [first, custom]);
  assert.deepEqual(r.data.keys[1], { id: sha256(custom), masked: 'my-cus…3456', note: '酒馆' });
  assert.equal((await a.req('POST', '/api/keys', { key: custom })).data.error, 'duplicate');
  assert.equal((await a.req('POST', '/api/keys', { key: '   ' })).data.error, 'key_empty');
  assert.equal((await a.req('POST', '/api/keys', {})).data.error, 'key_empty');
  assert.equal((await a.req('POST', '/api/keys', { key: 'has space inside here' })).data.error, 'key_invalid');
  assert.equal((await a.req('POST', '/api/keys', { key: 'short' })).data.error, 'key_invalid');
  assert.equal((await a.req('POST', '/api/keys', { key: 'x'.repeat(201) })).data.error, 'key_invalid');

  mock.st.keyRace = 1; // someone else saves the config between our read and write: read again, don't overwrite
  const g = await a.req('POST', '/api/keys', { generate: true });
  assert.equal(g.status, 200);
  assert.match(g.data.key, /^sk-[A-Za-z0-9_-]{40}$/);
  assert.deepEqual(mock.st.config['access/api-keys'], [first, custom, g.data.key]);

  r = await a.req('PATCH', '/api/keys/' + g.data.id, { note: '手机' });
  assert.equal(r.data.keys[2].note, '手机');
  await sleep(100);
  let st = readFileSync(statePath(), 'utf8');
  assert.deepEqual(JSON.parse(st).keyNotes, { [sha256(custom)]: '酒馆', [sha256(g.data.key)]: '手机' });
  for (const k of [first, custom, g.data.key]) assert.ok(!st.includes(k), 'no plaintext key in state.json');

  // a key removed outside the panel takes its note with it
  mock.st.config['access/api-keys'] = [first, g.data.key];
  r = await a.req('GET', '/api/keys');
  assert.equal(r.data.keys.length, 2);
  await sleep(100);
  assert.deepEqual(JSON.parse(readFileSync(statePath(), 'utf8')).keyNotes, { [sha256(g.data.key)]: '手机' });

  r = await a.req('DELETE', '/api/keys/' + g.data.id);
  assert.deepEqual(r.data.keys.map((k: any) => k.id), [sha256(first)]);
  assert.deepEqual(mock.st.config['access/api-keys'], [first]);
  await sleep(100);
  assert.deepEqual(JSON.parse(readFileSync(statePath(), 'utf8')).keyNotes, {});
  // no keys at all would switch CPA's key check off and serve anyone: the last one stays
  assert.equal((await a.req('DELETE', '/api/keys/' + sha256(first))).data.error, 'last_key');
  assert.deepEqual(mock.st.config['access/api-keys'], [first]);
  assert.equal((await a.req('DELETE', '/api/keys/' + sha256('gone'))).status, 404);
  st = readFileSync(statePath(), 'utf8');
  assert.ok(!st.includes(first));
});

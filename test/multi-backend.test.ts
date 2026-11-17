// Multi-backend integration tests:
//  - CPA <-> Antigravity-Manager (AGM) switching & streaming usage logging
//  - Per-key backend override + `ais2/` model prefix direct routing
//  - Local client-keys.json resilience when CPA stops (no 502, no plaintext keys in state.json)
//  - AISTUDIO2_MODE=exclusive auto-claim from backend & re-import without 409
//  - Bidirectional OAuth credential sync (CPA <-> AGM) & /agm/ panel auth proxy isolation
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { hashPassword, sha256 } from '../src/util.ts';

const MGMT = 'mgmt-mb-secret';
const PW = 'multi-backend-pw';
const CLIENT_KEY = 'sk-mb-client-key-0001';
const AGM_API_KEY = 'sk-agm-api-secret-99';
const AGM_ADMIN_PW = 'agm-super-admin-pw';
const AIS2_KEY = 'sk-ais2-secret-01';
const AIS2_PASS = 'ais2-pass-01';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startCpaExtendedMock() {
  const keys = [CLIENT_KEY];
  const creds = new Map<string, any>([
    ['antigravity-cpa1@example.invalid.json', {
      id: 'antigravity-cpa1@example.invalid.json',
      auth_index: 'idx-1',
      type: 'antigravity',
      email: 'cpa1@example.invalid',
      disabled: false,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }],
  ]);
  const files = new Map<string, any>([
    ['antigravity-cpa1@example.invalid.json', {
      type: 'antigravity',
      email: 'cpa1@example.invalid',
      refresh_token: '1//cpa1-refresh-token-12345678901234567890',
    }],
  ]);
  const seenV1: { url: string; auth: string; body: string }[] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const P = url.pathname;
    const M = (req.method || 'GET').toUpperCase();
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (P.startsWith('/v8/management/')) {
      if (req.headers.authorization !== 'Bearer ' + MGMT) return send(401, { error: 'unauthorized' });
      const m = P.slice('/v8/management'.length);
      if (m === '/credentials' && M === 'GET') return send(200, { files: [...creds.values()] });
      if (m === '/credentials/download' && M === 'GET') {
        const name = url.searchParams.get('name') || '';
        const f = files.get(name);
        return f ? send(200, f) : send(404, { error: 'not_found' });
      }
      if (m === '/credentials' && M === 'POST') {
        const name = url.searchParams.get('name') || '';
        const j = JSON.parse(raw || '{}');
        files.set(name, j);
        creds.set(name, {
          id: name,
          auth_index: 'idx-' + creds.size,
          type: j.type || 'antigravity',
          email: j.email,
          disabled: false,
          status: 'active',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return send(200, { ok: true });
      }
      if (m === '/credentials/refresh' && M === 'POST') return send(200, { ok: true });
      if (m === '/config/access/api-keys' && M === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"e1"' });
        res.end(JSON.stringify([...keys]));
        return;
      }
      if (m === '/config/access/api-keys' && M === 'PUT') {
        const j = JSON.parse(raw || '[]');
        keys.splice(0, keys.length, ...(Array.isArray(j) ? j : []));
        return send(200, { ok: true });
      }
      if (m === '/observability/usage/queue' && M === 'GET') return send(200, []);
      if (m.startsWith('/config') && M === 'GET') return send(200, { value: false });
      return send(200, { ok: true });
    }

    if (P.startsWith('/v1')) {
      seenV1.push({ url: P + url.search, auth: String(req.headers.authorization || ''), body: raw });
      if (P === '/v1/models') return send(200, { object: 'list', data: [{ id: 'cpa-claude-4-6' }] });
      return send(200, { id: 'cpa-chat', choices: [{ message: { role: 'assistant', content: 'from-cpa' } }] });
    }
    send(404, { error: 'not_found' });
  });
  return { server, st: { keys, creds, files, seenV1 } };
}

function startAgmMock() {
  const accounts = new Map<string, any>([
    ['agm-1', { id: 'agm-1', email: 'agm1@example.invalid', name: 'agm1', disabled: false, proxy_disabled: false, is_current: true, quota: {}, last_used: 0 }],
  ]);
  const tokens = new Map<string, string>([
    ['agm-1', '1//agm1-refresh-token-12345678901234567890'],
  ]);
  const seenProxy: { url: string; auth: string; body: string }[] = [];
  const seenAdmin: { url: string; auth: string }[] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const P = url.pathname;
    const M = (req.method || 'GET').toUpperCase();
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (P === '/' && M === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><script src="./assets/app.js"></script></head><body>AGM</body></html>');
      return;
    }
    if (P.startsWith('/api/')) {
      seenAdmin.push({ url: P, auth: String(req.headers.authorization || '') });
      if (req.headers.authorization !== 'Bearer ' + AGM_ADMIN_PW) return send(401, { error: 'unauthorized' });
      if (P === '/api/accounts' && M === 'GET') {
        return send(200, { accounts: [...accounts.values()], current_account_id: 'agm-1' });
      }
      if (P === '/api/accounts' && M === 'POST') {
        const j = JSON.parse(raw || '{}');
        const email = String(j.email || '').toLowerCase();
        const id = 'agm-' + (accounts.size + 1);
        accounts.set(id, { id, email, name: email, disabled: false, proxy_disabled: false, is_current: false, quota: {}, last_used: 0 });
        tokens.set(id, String(j.refreshToken || ''));
        return send(200, { id, email });
      }
      if (P === '/api/accounts/export' && M === 'POST') {
        const j = JSON.parse(raw || '{}');
        const want: string[] = j.accountIds || [...accounts.keys()];
        return send(200, {
          accounts: want.map((id) => ({ email: accounts.get(id)?.email, refresh_token: tokens.get(id) })).filter((x) => x.email && x.refresh_token),
        });
      }
      if (P === '/api/accounts/refresh' && M === 'POST') return send(200, { ok: true });
      return send(404, { error: 'not_found' });
    }
    if (P.startsWith('/v1')) {
      seenProxy.push({ url: P + url.search, auth: String(req.headers.authorization || ''), body: raw });
      if (req.headers.authorization !== 'Bearer ' + AGM_API_KEY) return send(401, { error: 'bad_agm_key' });
      if (P === '/v1/models') return send(200, { object: 'list', data: [{ id: 'agm-gemini-pro' }] });
      const reqJson = JSON.parse(raw || '{}');
      if (reqJson.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write('data: {"choices":[{"delta":{"content":"from-agm"}}],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      return send(200, {
        id: 'agm-chat',
        choices: [{ message: { role: 'assistant', content: 'from-agm' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    send(404, { error: 'not_found' });
  });
  return { server, st: { accounts, tokens, seenProxy, seenAdmin } };
}

function startAis2Mock() {
  const accounts = new Map<string, any>([
    ['legacy_excl@example.invalid', { id: 'legacy_excl@example.invalid', state: 'ready', benefit_tier: 'pro', enabled: true }],
  ]);
  const seenGen: { url: string; acct: string; body: string }[] = [];
  let tok = 'tok-ais2';
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const P = url.pathname;
    const M = (req.method || 'GET').toUpperCase();
    const send = (code: number, obj: unknown, hdrs: Record<string, string> = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...hdrs });
      res.end(JSON.stringify(obj));
    };
    if (P.startsWith('/api/')) {
      if (P === '/api/auth/login' && M === 'POST') return send(200, { ok: true }, { 'Set-Cookie': `aistudio_admin=${tok}; Path=/api` });
      if (!String(req.headers.cookie || '').includes(tok)) return send(401, { error: { code: 'admin_auth_required' } });
      if (P === '/api/accounts' && M === 'GET') return send(200, { accounts: [...accounts.values()] });
      if (P === '/api/accounts/import/cookies/discover' && M === 'POST') {
        const email = 'legacy_excl@example.invalid';
        return send(200, { accounts: [{ email, auth_user: 0, imported: accounts.has(email), signed_out: false, restricted: false }] });
      }
      if (P === '/api/accounts/import/cookies' && M === 'POST') {
        const item = JSON.parse(raw || '{}').items?.[0];
        accounts.set(item.email, { id: item.email, state: 'ready', benefit_tier: 'pro', enabled: true });
        return send(202, { task: { id: 't1', state: 'done', items: [{ label: item.email, state: 'done' }] } });
      }
      if (P.startsWith('/api/accounts/tasks/') && M === 'DELETE') { res.writeHead(204).end(); return; }
      if (P === '/api/control/start' && M === 'POST') return send(200, { running: true });
      return send(200, { ok: true });
    }
    if (P === '/v1/models') return send(200, { object: 'list', data: [{ id: 'gemini-4-argon' }] });
    if (P === '/v1/chat/completions') {
      seenGen.push({ url: P, acct: String(req.headers['x-aistudio-account'] || ''), body: raw });
      return send(200, { id: 'ais2-chat', choices: [{ message: { role: 'assistant', content: 'from-ais2' } }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
    }
    send(404, { error: 'not_found' });
  });
  return { server, st: { accounts, seenGen } };
}

class Panel {
  base: string;
  cookie = '';
  constructor(base: string) { this.base = base; }
  async req(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (method !== 'GET' && method !== 'HEAD') headers['X-App-CSRF'] = '1';
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) if (c.startsWith('agyme_sid=')) this.cookie = c.split(';')[0];
    const t = await r.text();
    let data: any = t;
    try { data = JSON.parse(t); } catch {}
    return { status: r.status, data, text: t };
  }
}

const cpaMock = startCpaExtendedMock();
const agmMock = startAgmMock();
const ais2Mock = startAis2Mock();
let app: ChildProcess | null = null;
let dir = '', base = '', logs = '';
let panel: Panel;

before(async () => {
  await new Promise<void>((r) => cpaMock.server.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => agmMock.server.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => ais2Mock.server.listen(0, '127.0.0.1', () => r()));
  const cpaPort = (cpaMock.server.address() as AddressInfo).port;
  const agmPort = (agmMock.server.address() as AddressInfo).port;
  const ais2Port = (ais2Mock.server.address() as AddressInfo).port;
  const port = 24000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}/me`;
  panel = new Panel(base);
  dir = mkdtempSync(join(tmpdir(), 'agyme-mb-'));

  app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', BASE_PATH: '/me',
      DATA_DIR: join(dir, 'data'),
      APP_PASSWORD_HASH: hashPassword(PW), APP_PASSWORD: '',
      CPA_URL: `http://127.0.0.1:${cpaPort}`, CPA_MANAGEMENT_KEY: MGMT,
      AGM_URL: `http://127.0.0.1:${agmPort}`, AGM_API_KEY: AGM_API_KEY, AGM_ADMIN_PASSWORD: AGM_ADMIN_PW,
      AISTUDIO2_URL: `http://127.0.0.1:${ais2Port}`, AISTUDIO2_KEY: AIS2_KEY, AISTUDIO2_ADMIN_USER: 'admin', AISTUDIO2_ADMIN_PASSWORD: AIS2_PASS,
      AISTUDIO2_MODE: 'exclusive', AISTUDIO2_RECHECK_MINUTES: '0',
      QUOTA_REFRESH_MINUTES: '0', AUTO_DISABLE_SWEEP_MS: '0', USAGE_POLL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout!.on('data', (d) => (logs += d));
  app.stderr!.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    await sleep(50);
  }
  assert.equal((await panel.req('POST', '/api/login', { password: PW })).status, 200);
});

after(async () => {
  if (app && app.exitCode === null) await new Promise((r) => { app!.once('exit', r); app!.kill('SIGTERM'); });
  for (const s of [cpaMock.server, agmMock.server, ais2Mock.server]) { s.closeAllConnections(); s.close(); }
  rmSync(dir, { recursive: true, force: true });
});

test('CPA <-> AGM switching, SSE token logging, backend filter & per-key routing', async () => {
  const meInfo = await panel.req('GET', '/api/me');
  assert.equal(meInfo.data.cpa, true);
  assert.equal(meInfo.data.agm, true);
  assert.equal(meInfo.data.agyBackend, 'cpa');

  // Default routes /v1/* to CPA
  const rCpa = await (await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CLIENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
  })).json();
  assert.equal(rCpa.choices[0].message.content, 'from-cpa');

  // Switch global AGY backend to AGM
  const sw = await panel.req('PATCH', '/api/settings', { key: 'agyBackend', value: 'agm' });
  assert.equal(sw.status, 200);
  assert.equal(sw.data.value, 'agm');

  const rAgm = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CLIENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-3.8-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(rAgm.status, 200);
  const sseText = await rAgm.text();
  assert.match(sseText, /from-agm/);
  assert.equal(agmMock.st.seenProxy.at(-1)!.auth, 'Bearer ' + AGM_API_KEY);

  const lgAgm = await panel.req('GET', '/api/logs?backend=agm&facets=1');
  assert.equal(lgAgm.data.rows.length, 1);
  assert.equal(lgAgm.data.rows[0].backend, 'agm');
  assert.equal(lgAgm.data.rows[0].total, 20);
  assert.ok(lgAgm.data.facets.backends.includes('agm'));

  // Switch back to CPA globally, create a per-key pinned key -> AGM overrides global
  await panel.req('PATCH', '/api/settings', { key: 'agyBackend', value: 'cpa' });
  const kAgm = await panel.req('POST', '/api/keys', { generate: true, note: 'pinned-agm' });
  const pBind = await panel.req('PATCH', '/api/keys/' + kAgm.data.id, { backend: 'agm' });
  assert.equal(pBind.data.keys.find((x: any) => x.id === kAgm.data.id).backend, 'agm');

  const rPin = await (await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + kAgm.data.key } })).json();
  assert.equal(rPin.data[0].id, 'agm-gemini-pro');

  // state.json must NEVER store plaintext client keys
  const stRaw = readFileSync(join(dir, 'data', 'state.json'), 'utf8');
  assert.ok(!stRaw.includes(CLIENT_KEY));
  assert.ok(!stRaw.includes(kAgm.data.key));
  assert.ok(sha256(kAgm.data.key));
});

test('AISTUDIO2_MODE=exclusive auto-claims existing accounts & ais2/ prefix routes directly', async () => {
  // Exclusive startup sync should have claimed legacy_excl@example.invalid
  let list = await panel.req('GET', '/api/aistudio2');
  for (let i = 0; i < 20 && !list.data.accounts.length; i++) {
    await sleep(100);
    list = await panel.req('GET', '/api/aistudio2');
  }
  assert.equal(list.data.accounts.some((a: any) => a.email === 'legacy_excl@example.invalid'), true);

  // Re-uploading the same email in exclusive mode MUST succeed instead of 409 aistudio_taken
  const reup = await panel.req('POST', '/api/aistudio2', { cookies: 'SAPISID=legacy_excl@example.invalid; SID=1' });
  assert.equal(reup.status, 200);

  // Main /v1 endpoint with `ais2/` model prefix strips prefix and reaches AI Studio 2 even when global backend is CPA
  const rPref = await (await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CLIENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'ais2/gemini-4-argon-high', messages: [{ role: 'user', content: 'hi' }] }),
  })).json();
  assert.equal(rPref.choices[0].message.content, 'from-ais2');
  const seen = JSON.parse(ais2Mock.st.seenGen.at(-1)!.body);
  assert.equal(seen.model, 'gemini-4-argon');
  assert.equal(seen.reasoning_effort, 'high');
});

test('bidirectional OAuth credential sync (CPA <-> AGM) & /agm/ panel proxy isolation', async () => {
  const toRes = await panel.req('POST', '/api/agm/sync-to', {});
  assert.equal(toRes.status, 200);
  assert.equal(toRes.data.synced, 1);
  assert.ok([...agmMock.st.accounts.values()].some((a: any) => a.email === 'cpa1@example.invalid'));

  const fromRes = await panel.req('POST', '/api/agm/sync-from', {});
  assert.equal(fromRes.status, 200);
  assert.equal(fromRes.data.imported, 1);
  assert.ok(cpaMock.st.files.has('antigravity-agm1@example.invalid.json'));

  // /agm/ panel requires session auth & never exposes AGM_ADMIN_PASSWORD in HTML or __boot.js
  assert.equal((await fetch(base + '/agm/')).status, 401);
  const htmlRes = await panel.req('GET', '/agm/');
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.text, /__boot\.js/);
  assert.ok(!htmlRes.text.includes(AGM_ADMIN_PW));

  const bootRes = await panel.req('GET', '/agm/__boot.js');
  assert.equal(bootRes.status, 200);
  assert.match(bootRes.text, /abv_admin_api_key/);
  assert.ok(!bootRes.text.includes(AGM_ADMIN_PW));

  // Proxy /agm/api/accounts injects real AGM_ADMIN_PASSWORD on server side
  const agmApi = await panel.req('GET', '/agm/api/accounts');
  assert.equal(agmApi.status, 200);
  assert.ok(Array.isArray(agmApi.data.accounts));
});

test('local client-keys.json stays operational when CPA goes down', async () => {
  await panel.req('PATCH', '/api/settings', { key: 'agyBackend', value: 'agm' });
  await new Promise<void>((r) => { cpaMock.server.closeAllConnections(); cpaMock.server.close(() => r()); });

  const keysRes = await panel.req('GET', '/api/keys');
  assert.equal(keysRes.status, 200);
  assert.ok(keysRes.data.keys.length >= 2);

  const addedOffline = await panel.req('POST', '/api/keys', { generate: true, note: 'offline-cpa' });
  assert.equal(addedOffline.status, 200);

  // Gateway authenticates new key locally and forwards cleanly to AGM without 502!
  const rOff = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + addedOffline.data.key } });
  assert.equal(rOff.status, 200);
  assert.doesNotMatch(logs, /ReferenceError|TypeError|SyntaxError/, logs);
});

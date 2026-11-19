// Integration tests for AI Studio 2 self-use integration in agy-me:
//  - Strict isolation against shared AIStudio2API accounts (refuses foreign accounts, never deletes/rotates them)
//  - Cookie/JSON upload, list, toggle, single check, sweep, delete
//  - Gateway (/ais2/v1/* and /v1/*, /v1beta/*), tier expansion & rewriteAIS2TierRequest across OpenAI / Anthropic / Responses / Images / Gemini
//  - Client API key auth compatibility, 401/429 cooldown failover, usage sniffing into usage.sqlite, and daily overview quota
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';
import { hashPassword } from '../src/util.ts';
import { ais2Id } from '../src/aistudio2.ts';

const MGMT = 'mgmt-ais2-test', PW = 'ais2-test-password';
const AIS2_KEY = 'sk-ais2-backend-secret', AIS2_PASS = 'ais2-admin-pass';
const CLIENT_KEY = 'sk-mock-client-key-0001'; // seeded by startMockCPA in access/api-keys

function startMockGeoIP() {
  const rawMmdb = Buffer.concat([
    Buffer.alloc(2048, 0x42),
    Buffer.from('\xab\xcd\xefMaxMind.com', 'latin1'),
  ]);
  const gzMmdb = gzipSync(rawMmdb);
  const st = { hits: 0, fail: false, rawMmdb };
  const server = http.createServer((req, res) => {
    st.hits++;
    if (st.fail) {
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end('upstream geoip mirror down');
      return;
    }
    if (req.url === '/corrupt.mmdb') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end('not-a-valid-mmdb');
      return;
    }
    if (req.url === '/GeoLite2-City.mmdb.gz') {
      res.writeHead(200, { 'Content-Type': 'application/gzip' }).end(gzMmdb);
      return;
    }
    res.writeHead(404).end('not found');
  });
  return { server, st };
}

function startMockAIS2() {
  const st = {
    running: false,
    logins: 0,
    token: 'tok-1',
    accounts: new Map<string, { id: string; state: string; benefit_tier: string; enabled: boolean; message?: string }>(),
    tasks: new Map<string, any>(),
    seenGen: [] as Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>,
    failNextFor: new Map<string, number>(),
    refreshState: new Map<string, string>(),
    geoipPath: '',
    requireGeoipOrEnv: false,
    forceAlwaysGeoipFail: false,
    importCalls: [] as Array<{ email: string; locale?: string; timezone?: string }>,
  };

  let seq = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const P = url.pathname;
    const M = (req.method || 'GET').toUpperCase();
    const send = (code: number, obj: unknown, extraHeaders: Record<string, string> = {}) => {
      const b = obj === null ? '' : JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', ...extraHeaders });
      res.end(b);
    };

    if (P.startsWith('/api/')) {
      if (P === '/api/auth/login' && M === 'POST') {
        const j = JSON.parse(raw || '{}');
        if (j.username !== 'admin' || j.password !== AIS2_PASS) return send(401, { error: { message: 'bad credentials' } });
        st.logins++;
        st.token = 'tok-' + st.logins;
        return send(200, { authenticated: true, username: 'admin' }, { 'Set-Cookie': `aistudio_admin=${st.token}; Path=/api; HttpOnly` });
      }
      const ck = String(req.headers.cookie || '');
      if (!ck.includes(`aistudio_admin=${st.token}`)) {
        return send(401, { error: { code: 'admin_auth_required', message: '需要管理员登录' } });
      }
      if (P === '/api/status' && M === 'GET') {
        return send(200, { state: st.running ? 'running' : 'stopped', running: st.running, ready: st.running });
      }
      if (P === '/api/control/start' && M === 'POST') {
        st.running = true;
        return send(200, { running: true });
      }
      if (P === '/api/accounts' && M === 'GET') {
        return send(200, { accounts: [...st.accounts.values()] });
      }
      if (P === '/api/accounts/import/cookies/discover' && M === 'POST') {
        const j = JSON.parse(raw || '{}');
        const c = String(j.cookies || '');
        const m = /SAPISID=([a-zA-Z0-9._@-]+)/.exec(c);
        if (!m) return send(400, { error: { message: '缺少 SAPISID Cookie' } });
        const tag = m[1];
        const email = tag.includes('@') ? tag.toLowerCase() : `${tag.toLowerCase()}@example.invalid`;
        return send(200, { accounts: [{ email, auth_user: 0, imported: st.accounts.has(email), signed_out: false, restricted: false, device_bound: false }] });
      }
      if (P === '/api/accounts/import/cookies' && M === 'POST') {
        const j = JSON.parse(raw || '{}');
        const item = j.items?.[0];
        const email = String(item?.email || '').toLowerCase();
        const locale = typeof j.locale === 'string' ? j.locale : undefined;
        const timezone = typeof j.timezone === 'string' ? j.timezone : undefined;
        st.importCalls.push({ email, locale, timezone });
        const tid = 'task-' + (++seq);
        const tier = email.startsWith('ultra') ? 'ultra' : 'pro';
        const task: any = { id: tid, kind: 'cookie', state: 'running', items: [{ label: email, state: 'running' }] };
        st.tasks.set(tid, task);
        const hasMmdb = Boolean(st.geoipPath && existsSync(st.geoipPath));
        const hasEnvFallback = Boolean(locale && timezone);
        const failGeoip = st.forceAlwaysGeoipFail || (st.requireGeoipOrEnv && !hasMmdb && !hasEnvFallback);
        setTimeout(() => {
          if (failGeoip) {
            const geoErr = '按出口位置确定账户语言与时区: 下载 IP 库: https://github.com/daijro/geoip-all-in-one/releases/latest/download/geoip-aio-ipv4.mmdb.zip 返回 HTTP 404';
            task.state = 'failed';
            task.error = geoErr;
            task.items = [{ label: email, state: 'failed', error: geoErr }];
            return;
          }
          st.accounts.set(email, { id: email, state: 'ready', benefit_tier: tier, enabled: true });
          task.state = 'done';
          task.items = [{ label: email, state: 'done' }];
        }, 30);
        return send(202, { task });
      }
      if (P === '/api/accounts/tasks' && M === 'GET') {
        return send(200, { tasks: [...st.tasks.values()] });
      }
      if (P.startsWith('/api/accounts/tasks/') && M === 'DELETE') {
        const tid = decodeURIComponent(P.slice('/api/accounts/tasks/'.length));
        st.tasks.delete(tid);
        res.writeHead(204).end();
        return;
      }
      if (P.startsWith('/api/accounts/') && P.endsWith('/refresh') && M === 'POST') {
        const email = decodeURIComponent(P.slice('/api/accounts/'.length, -'/refresh'.length)).toLowerCase();
        const acc = st.accounts.get(email);
        if (!acc) return send(404, { error: { message: 'not found' } });
        const next = st.refreshState.get(email);
        if (next) acc.state = next;
        return send(200, { account: acc, tier: acc.benefit_tier });
      }
      if (P.startsWith('/api/accounts/') && M === 'DELETE') {
        const email = decodeURIComponent(P.slice('/api/accounts/'.length)).toLowerCase();
        st.accounts.delete(email);
        res.writeHead(204).end();
        return;
      }
    }

    // Generation plane
    const auth = String(req.headers.authorization || '');
    if (auth !== 'Bearer ' + AIS2_KEY) return send(401, { error: { message: 'bad backend api key' } });
    st.seenGen.push({ method: M, url: url.pathname + url.search, headers: req.headers, body: raw });

    if (M === 'GET' && P === '/v1/models') {
      return send(200, {
        object: 'list',
        data: [
          { id: 'gemini-4-hydrogen', object: 'model', name: 'Gemini 4 Hydrogen', default_thinking_level: 'high', thinking_levels: ['low', 'medium', 'high', 'extra_high'] },
          { id: 'gemini-4-argon', object: 'model', name: 'Gemini 4 Argon', default_thinking_level: 'medium', thinking_levels: ['low', 'medium', 'high'] },
          { id: 'gemini-3.8-flash', object: 'model', name: 'Gemini 3.8 Flash', default_thinking_level: 'medium', thinking_levels: ['low', 'medium', 'high'] },
          { id: 'gemini-4-argon-search', object: 'model', name: 'Gemini 4 Argon (Search)' },
          { id: 'lyria-3.5', object: 'model', name: 'Lyria 3.5' },
        ],
      });
    }
    if (M === 'GET' && P === '/v1beta/models') {
      return send(200, {
        models: [
          { name: 'models/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', defaultThinkingLevel: 'HIGH', thinkingLevels: ['LOW', 'MEDIUM', 'HIGH', 'EXTRA_HIGH'] },
          { name: 'models/gemini-4-argon', displayName: 'Gemini 4 Argon', defaultThinkingLevel: 'MEDIUM', thinkingLevels: ['LOW', 'MEDIUM', 'HIGH'] },
        ],
      });
    }
    if (M === 'GET' && P.startsWith('/v1/models/')) {
      const mid = decodeURIComponent(P.slice('/v1/models/'.length));
      if (!['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.8-flash'].includes(mid)) return send(404, { error: { message: 'not found' } });
      return send(200, { id: mid, object: 'model' });
    }

    const pinned = String(req.headers['x-aistudio-account'] || '').toLowerCase();
    if (!pinned || !st.accounts.has(pinned)) return send(503, { error: { message: 'account unavailable: ' + pinned } });
    const failStatus = st.failNextFor.get(pinned);
    if (failStatus) {
      st.failNextFor.delete(pinned);
      return send(failStatus, { error: { message: 'simulated failure ' + failStatus } });
    }

    if (P === '/v1/messages/count_tokens') {
      return send(200, { input_tokens: 42 });
    }
    if (P === '/v1/messages') {
      return send(200, { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'via-' + pinned }], usage: { input_tokens: 12, output_tokens: 8 } }, { 'X-AIStudio-Internal': 'secret' });
    }
    if (P === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 15, output_tokens: 10 } } })}\n\n`);
      return;
    }
    if (P === '/v1/images/generations' || P === '/v1/images/edits') {
      return send(200, { created: 1, data: [{ b64_json: 'AAAA' }], usage: { input_tokens: 5, output_tokens: 25 } });
    }
    if (P.startsWith('/v1beta/models/')) {
      return send(200, { candidates: [{ content: { parts: [{ text: 'gem-' + pinned }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6 } });
    }
    return send(200, {
      id: 'chat_1', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'chat-' + pinned } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
  });

  return { server, st };
}

const cpaMock = startMockCPA({ mgmtKey: MGMT });
const ais2Mock = startMockAIS2();
const geoipMock = startMockGeoIP();
let app: ChildProcess;
let base = '', dir = '', logs = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class PanelClient {
  cookie = '';
  async req(method: string, path: string, body?: any) {
    const headers: Record<string, string> = { 'X-App-CSRF': '1' };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) if (c.startsWith('agyme_sid=')) this.cookie = c.split(';')[0];
    const text = await r.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch {}
    return { status: r.status, data };
  }
}
const panel = new PanelClient();

before(async () => {
  await new Promise<void>((r) => cpaMock.server.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => ais2Mock.server.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => geoipMock.server.listen(0, '127.0.0.1', () => r()));
  const cpaPort = (cpaMock.server.address() as AddressInfo).port;
  const ais2Port = (ais2Mock.server.address() as AddressInfo).port;
  const geoipPort = (geoipMock.server.address() as AddressInfo).port;

  // Seed a foreign account owned by agy-pot in the shared AIStudio2API backend!
  ais2Mock.st.accounts.set('pot_user@example.invalid', {
    id: 'pot_user@example.invalid', state: 'ready', benefit_tier: 'ultra', enabled: true,
  });

  dir = mkdtempSync(join(tmpdir(), 'agyme-ais2-'));
  ais2Mock.st.geoipPath = join(dir, 'data', 'aistudio2api', 'runtime', 'geoip', 'geoip-aio-ipv4.mmdb');
  const port = 23000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}/me`;
  app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', BASE_PATH: '/me',
      DATA_DIR: join(dir, 'data'),
      CPA_URL: `http://127.0.0.1:${cpaPort}`, CPA_MANAGEMENT_KEY: MGMT,
      APP_PASSWORD_HASH: hashPassword(PW), APP_PASSWORD: '',
      AISTUDIO2_URL: `http://127.0.0.1:${ais2Port}`,
      AISTUDIO2_KEY: AIS2_KEY,
      AISTUDIO2_ADMIN_USER: 'admin',
      AISTUDIO2_ADMIN_PASSWORD: AIS2_PASS,
      AISTUDIO2_MODE: 'shared',
      AISTUDIO2_RECHECK_MINUTES: '0',
      AISTUDIO2_GEOIP_URLS: `http://127.0.0.1:${geoipPort}/corrupt.mmdb,http://127.0.0.1:${geoipPort}/GeoLite2-City.mmdb.gz`,
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
  if (app && app.exitCode === null) await new Promise((r) => { app.once('exit', r); app.kill('SIGTERM'); });
  for (const s of [cpaMock.server, ais2Mock.server, geoipMock.server]) { s.closeAllConnections(); s.close(); }
  rmSync(dir, { recursive: true, force: true });
});

test('account isolation: foreign account in shared AIStudio2API cannot be imported, rotated into, or deleted', async () => {
  const meInfo = await panel.req('GET', '/api/me');
  assert.equal(meInfo.data.aistudio2, true);

  // Gateway generation is blocked when agy-me has 0 accounts of its own (even though pot_user is ready in backend!)
  const g0 = await fetch(base + '/ais2/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CLIENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(g0.status, 403);

  // Attempting to import pot_user@example.invalid into agy-me is refused with 409!
  const dupPot = await panel.req('POST', '/api/aistudio2', { cookies: 'SAPISID=pot_user@example.invalid; SID=1' });
  assert.equal(dupPot.status, 409);
  assert.equal(dupPot.data.error, 'aistudio_taken');

  // Attempting to delete pot_user's id through agy-me returns 404 and leaves backend untouched!
  const delPot = await panel.req('DELETE', '/api/aistudio2/' + ais2Id('pot_user@example.invalid'));
  assert.equal(delPot.status, 404);
  assert.equal(ais2Mock.st.accounts.has('pot_user@example.invalid'), true);
});

test('upload own accounts (wrapper JSON + raw cookie), list, model expansion & slim toggle', async () => {
  const u1 = await panel.req('POST', '/api/aistudio2', {
    cookies: JSON.stringify({ cookies: 'SAPISID=me1@example.invalid; SID=1', authUser: 0 }),
  });
  assert.equal(u1.status, 200);
  assert.equal(u1.data.email, 'me1@example.invalid');
  assert.equal(u1.data.tier, 'PRO');
  assert.equal(ais2Mock.st.running, true);

  const u2 = await panel.req('POST', '/api/aistudio2', {
    cookies: 'SAPISID=ultra2@example.invalid; SID=2',
  });
  assert.equal(u2.status, 200);
  assert.equal(u2.data.tier, 'ULTRA');

  const list = await panel.req('GET', '/api/aistudio2');
  assert.equal(list.data.accounts.length, 2);
  assert.equal(list.data.counts.valid, 2);

  // Auth checks on gateway
  assert.equal((await fetch(base + '/ais2/v1/models')).status, 401);
  assert.equal((await fetch(base + '/ais2/v1/models', { headers: { Authorization: 'Bearer wrong-key' } })).status, 401);

  // Slim model list (default on): expands tiers, hides -search and lyria
  const mlSlim = await (await fetch(base + '/ais2/v1/models', { headers: { Authorization: 'Bearer ' + CLIENT_KEY } })).json();
  const slimIds = mlSlim.data.map((m: any) => m.id);
  for (const want of ['gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-high', 'gemini-4-argon-high', 'gemini-3.8-flash-low']) {
    assert.ok(slimIds.includes(want), 'missing ' + want);
  }
  assert.ok(!slimIds.includes('gemini-4-argon-search'));
  assert.ok(!slimIds.includes('lyria-3.5'));

  // Full model list when slim is turned off
  await panel.req('PATCH', '/api/settings', { key: 'ais2Slim', value: false });
  const mlFull = await (await fetch(base + '/ais2/v1/models', { headers: { Authorization: 'Bearer ' + CLIENT_KEY } })).json();
  assert.ok(mlFull.data.some((m: any) => m.id === 'lyria-3.5'));
  const mainPrefixed = await fetch(base + '/v1/models/ais2%2Fgemini-4-hydrogen-xhigh', { headers: { Authorization: 'Bearer ' + CLIENT_KEY } });
  assert.equal((await mainPrefixed.json()).id, 'gemini-4-hydrogen-xhigh');
  await panel.req('PATCH', '/api/settings', { key: 'ais2Slim', value: true });

  // Gemini /v1beta/models + single-model lookup
  const gml = await (await fetch(base + `/ais2/v1beta/models?key=${CLIENT_KEY}`)).json();
  assert.ok(gml.models.some((m: any) => m.name === 'models/gemini-4-hydrogen-xhigh'));
  const single = await fetch(base + '/ais2/v1/models/gemini-4-hydrogen-xhigh', { headers: { Authorization: 'Bearer ' + CLIENT_KEY } });
  assert.equal((await single.json()).id, 'gemini-4-hydrogen-xhigh');
});

test('all protocols + rewriteAIS2TierRequest + 429/401 cooldown failover + usage & overview quota', async () => {
  // 1. OpenAI chat with tier suffix overriding conflicting effort
  const rc = await fetch(base + '/ais2/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CLIENT_KEY, 'Content-Type': 'application/json', 'X-AIStudio-Account': 'pot_user@example.invalid' },
    body: JSON.stringify({
      model: 'gemini-4-argon-high',
      reasoning_effort: 'minimal',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.equal(rc.status, 200);
  const lastChat = ais2Mock.st.seenGen.at(-1)!;
  assert.notEqual(lastChat.headers['x-aistudio-account'], 'pot_user@example.invalid', 'client spoofed header stripped');
  assert.ok(['me1@example.invalid', 'ultra2@example.invalid'].includes(String(lastChat.headers['x-aistudio-account'])));
  const chatBody = JSON.parse(lastChat.body);
  assert.equal(chatBody.model, 'gemini-4-argon');
  assert.equal(chatBody.reasoning_effort, 'high');

  // 2. Anthropic /v1/messages & count_tokens
  const rct = await fetch(base + '/ais2/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'x-api-key': CLIENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-4-argon-low', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(rct.status, 200);
  assert.equal(JSON.parse(ais2Mock.st.seenGen.at(-1)!.body).model, 'gemini-4-argon');

  const rm = await fetch(base + '/ais2/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': CLIENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-4-argon-high', thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(rm.status, 200);
  assert.equal(rm.headers.get('x-aistudio-internal'), null, 'internal headers stripped');
  const msgBody = JSON.parse(ais2Mock.st.seenGen.at(-1)!.body);
  assert.equal(msgBody.output_config.effort, 'high');
  assert.equal(msgBody.thinking, undefined);

  // 3. Responses SSE stream
  const rr = await fetch(base + '/ais2/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CLIENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-3.8-flash-medium', stream: true, input: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(rr.status, 200);
  assert.equal(rr.headers.get('x-accel-buffering'), 'no');
  await rr.text();
  assert.equal(JSON.parse(ais2Mock.st.seenGen.at(-1)!.body).reasoning.effort, 'medium');

  // 4. Images generations & edits
  const ri = await fetch(base + '/ais2/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CLIENT_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'a cat' }),
  });
  assert.equal(ri.status, 200);
  const rie = await fetch(base + '/ais2/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CLIENT_KEY, 'Content-Type': 'multipart/form-data; boundary=---xyz' },
    body: '-----xyz--',
  });
  assert.equal(rie.status, 200);

  // 5. Gemini native :generateContent with ?key= stripped upstream
  const rg = await fetch(base + `/ais2/v1beta/models/gemini-4-argon-low:generateContent?alt=json&key=${CLIENT_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });
  assert.equal(rg.status, 200);
  assert.equal(ais2Mock.st.seenGen.at(-1)!.url, '/v1beta/models/gemini-4-argon:generateContent?alt=json');
  assert.equal(JSON.parse(ais2Mock.st.seenGen.at(-1)!.body).generationConfig.thinkingConfig.thinkingLevel, 'low');

  // 6. Failover on 429: if me1 returns 429, gateway transparently retries ultra2 and succeeds
  ais2Mock.st.failNextFor.set('me1@example.invalid', 429);
  const rf = await (await fetch(base + '/ais2/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CLIENT_KEY, 'Content-Type': 'application/json', 'x-session-id': 'failover-sess' },
    body: JSON.stringify({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'retry me' }] }),
  })).json();
  assert.equal(rf.choices[0].message.content, 'chat-ultra2@example.invalid');

  // 7. Verify usage logs & overview quota recorded
  const logsRes = await panel.req('GET', '/api/logs');
  assert.ok(logsRes.data.total >= 6);
  const ov = await panel.req('GET', '/api/overview');
  assert.equal(ov.data.ais2.counts.valid, 2);
  const argonQ = ov.data.ais2.quota.models.find((m: any) => m.model === 'gemini-4-argon');
  assert.equal(argonQ.reqLimit, 250); // PRO (50) + ULTRA (200)
  assert.ok(argonQ.usedReq >= 4);
});

test('sweep, single check, disable toggle, and delete keep pot_user untouched', async () => {
  const me1Id = ais2Id('me1@example.invalid');
  const ultra2Id = ais2Id('ultra2@example.invalid');

  // Local disable hides ultra2 from active rotation without deleting from backend
  const off = await panel.req('PATCH', `/api/aistudio2/${ultra2Id}`, { disabled: true });
  assert.equal(off.data.disabled, true);
  assert.equal(ais2Mock.st.accounts.has('ultra2@example.invalid'), true);

  // Single check detects dead account and removes ONLY me1 from backend
  ais2Mock.st.refreshState.set('me1@example.invalid', 'auth_required');
  const chk = await panel.req('POST', `/api/aistudio2/${me1Id}/check`);
  assert.equal(chk.data.state, 'dead');
  assert.equal(ais2Mock.st.accounts.has('me1@example.invalid'), false);

  // Batch recheck / sweep leaves pot_user@example.invalid untouched!
  const sw = await panel.req('POST', '/api/aistudio2/recheck');
  assert.equal(sw.status, 200);
  assert.equal(ais2Mock.st.accounts.has('pot_user@example.invalid'), true, 'pot_user MUST stay untouched!');

  // Delete ultra2
  assert.equal((await panel.req('DELETE', `/api/aistudio2/${ultra2Id}`)).status, 200);
  assert.equal(ais2Mock.st.accounts.has('ultra2@example.invalid'), false);
  assert.equal(ais2Mock.st.accounts.has('pot_user@example.invalid'), true);
  assert.doesNotMatch(logs, /\[error\]/, logs);
});

test('GeoIP 404 regression: locale/timezone fallback, local .mmdb.gz self-heal, and valid account protection', async () => {
  const ais2LocalDir = join(dir, 'data', 'aistudio2api');
  const v4Path = join(ais2LocalDir, 'runtime', 'geoip', 'geoip-aio-ipv4.mmdb');
  const v6Path = join(ais2LocalDir, 'runtime', 'geoip', 'geoip-aio-ipv6.mmdb');

  ais2Mock.st.requireGeoipOrEnv = true;

  // Scenario B (1): External mode (no local aistudio2api/ directory) -> falls back to locale/timezone without creating local dir
  assert.equal(existsSync(ais2LocalDir), false);
  ais2Mock.st.importCalls.length = 0;
  const b1 = await panel.req('POST', '/api/aistudio2', {
    cookies: 'SAPISID=geo_ext@example.invalid; SID=1',
  });
  assert.equal(b1.status, 200);
  assert.equal(b1.data.email, 'geo_ext@example.invalid');
  assert.equal(b1.data.status, 'valid');
  assert.equal(existsSync(ais2LocalDir), false, 'external mode must not create local aistudio2api dir');
  assert.equal(geoipMock.st.hits, 0);
  assert.deepEqual(ais2Mock.st.importCalls, [
    { email: 'geo_ext@example.invalid', locale: undefined, timezone: undefined },
    { email: 'geo_ext@example.invalid', locale: 'en-US', timezone: 'America/Los_Angeles' },
  ]);

  // Scenario B (2): Local aistudio2api/ exists, but GeoIP mirror is unreachable -> still succeeds via locale/timezone fallback
  mkdirSync(ais2LocalDir, { recursive: true });
  geoipMock.st.fail = true;
  ais2Mock.st.importCalls.length = 0;
  const b2 = await panel.req('POST', '/api/aistudio2', {
    cookies: 'SAPISID=geo_srcdown@example.invalid; SID=1',
  });
  assert.equal(b2.status, 200);
  assert.equal(b2.data.status, 'valid');
  assert.ok(geoipMock.st.hits > 0);
  assert.equal(existsSync(v4Path), false);
  assert.deepEqual(ais2Mock.st.importCalls, [
    { email: 'geo_srcdown@example.invalid', locale: undefined, timezone: undefined },
    { email: 'geo_srcdown@example.invalid', locale: 'en-US', timezone: 'America/Los_Angeles' },
  ]);

  // Scenario A: Local aistudio2api/ exists and GeoIP .mmdb.gz mirror works -> downloads, gunzips, verifies MaxMind.com, writes ipv4+ipv6, and succeeds on native retry!
  geoipMock.st.fail = false;
  ais2Mock.st.importCalls.length = 0;
  const a1 = await panel.req('POST', '/api/aistudio2', {
    cookies: 'SAPISID=geo_heal@example.invalid; SID=1',
  });
  assert.equal(a1.status, 200);
  assert.equal(a1.data.email, 'geo_heal@example.invalid');
  assert.equal(a1.data.status, 'valid');
  assert.equal(existsSync(v4Path), true);
  assert.equal(existsSync(v6Path), true);
  assert.deepEqual(readFileSync(v4Path), geoipMock.st.rawMmdb);
  assert.deepEqual(readFileSync(v6Path), geoipMock.st.rawMmdb);
  assert.ok(readFileSync(v4Path).includes(Buffer.from('MaxMind.com', 'ascii')));
  assert.deepEqual(ais2Mock.st.importCalls, [
    { email: 'geo_heal@example.invalid', locale: undefined, timezone: undefined },
    { email: 'geo_heal@example.invalid', locale: undefined, timezone: undefined },
  ]);

  // Scenario C: Backend still returns GeoIP download error even with locale/timezone -> returns 503 and NEVER marks existing valid account dead or removes it from backend!
  ais2Mock.st.forceAlwaysGeoipFail = true;
  const c1 = await panel.req('POST', '/api/aistudio2', {
    cookies: 'SAPISID=geo_heal@example.invalid; SID=2',
  });
  assert.equal(c1.status, 503);
  assert.equal(c1.data.error, 'aistudio_check_failed');
  assert.match(String(c1.data.message || ''), /GeoIP/);
  assert.match(String(c1.data.message || ''), /geoip-aio-ipv4\.mmdb/);
  assert.equal(ais2Mock.st.accounts.has('geo_heal@example.invalid'), true, 'existing valid account must NOT be removed from backend');

  const afterList1 = await panel.req('GET', '/api/aistudio2');
  const healedAcc = afterList1.data.accounts.find((x: any) => x.email === 'geo_heal@example.invalid');
  assert.ok(healedAcc);
  assert.equal(healedAcc.status, 'valid', 'existing valid account must NOT be marked dead');

  // Also ensure a brand-new account failing with GeoIP error cleans up its 'importing' placeholder
  const c2 = await panel.req('POST', '/api/aistudio2', {
    cookies: 'SAPISID=geo_brandnew@example.invalid; SID=1',
  });
  assert.equal(c2.status, 503);
  const afterList2 = await panel.req('GET', '/api/aistudio2');
  assert.equal(afterList2.data.accounts.some((x: any) => x.email === 'geo_brandnew@example.invalid'), false);

  ais2Mock.st.forceAlwaysGeoipFail = false;
  ais2Mock.st.requireGeoipOrEnv = false;
  assert.doesNotMatch(logs, /\[error\]/, logs);
});

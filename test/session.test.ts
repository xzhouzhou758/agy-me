// Sessions: password change logs everyone out, login-limit entries age out, browser WebSockets close with
// their session, foreign Origins are refused, a failed browser stop is not reported as stopped. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const dir = mkdtempSync(join(tmpdir(), 'agyme-s-'));
let stopFails = false;
const browserd = http.createServer((req, res) => {
  const bad = req.url === '/stop' && stopFails;
  res.writeHead(bad ? 500 : 200, { 'Content-Type': 'application/json' }).end(bad ? '{"error":"docker down"}' : '{"running":false}');
});
const upstream = net.createServer((s) => s.once('data', () => { s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); s.pipe(s); }));
const listen = (srv: http.Server | net.Server) => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)));
const bdPort = await listen(browserd), upPort = await listen(upstream);
Object.assign(process.env, { DATA_DIR: dir, APP_PASSWORD: 'one', APP_PASSWORD_HASH: '', BASE_PATH: '', BROWSERD_TOKEN: 't',
  BROWSERD_URL: `http://127.0.0.1:${bdPort}`, BROWSER_UPSTREAM: `http://127.0.0.1:${upPort}`, BROWSER_IDLE_MINUTES: '0' });
const { config } = await import('../src/config.ts');
const { state } = await import('../src/store.ts');
const auth = await import('../src/auth.ts');
const browser = await import('../src/browser.ts');
const { sha256 } = await import('../src/util.ts');

const app = http.createServer();
app.on('upgrade', browser.handleBrowserUpgrade);
const appPort = await listen(app);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeRes = () => ({ setHeader() {} }) as any;
function session(sid: string) { state.data.sessions[sha256(sid)] = Date.now() + 3600e3; return `agyme_sid=${sid}`; }
function ws(cookie: string, origin = `http://127.0.0.1:${appPort}`): Promise<{ sock: net.Socket; head: string; closed: Promise<void> }> {
  return new Promise((resolve) => {
    const sock = net.connect(appPort, '127.0.0.1');
    const closed = new Promise<void>((r) => sock.on('close', () => r()));
    sock.on('error', () => {});
    sock.once('data', (d) => resolve({ sock, head: d.toString(), closed }));
    sock.write(`GET /browser/ws HTTP/1.1\r\nHost: 127.0.0.1:${appPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\n\r\n`);
  });
}

before(async () => {
  auth.checkPasswordChange();
  await browser.start();
  for (let i = 0; i < 50 && browser.view().state !== 'running'; i++) await sleep(20);
});
after(() => {
  for (const s of [browserd, upstream, app] as any[]) { s.closeAllConnections?.(); s.close(); }
  rmSync(dir, { recursive: true, force: true });
});

test('a changed password logs every session out; the same one keeps them', () => {
  session('keep');
  assert.equal(auth.checkPasswordChange(), false);
  assert.ok(state.data.sessions[sha256('keep')]);
  config.password = 'two';
  assert.equal(auth.checkPasswordChange(), true);
  assert.deepEqual(state.data.sessions, {});
  config.password = 'one';
  auth.checkPasswordChange();
});

test('login-limit entries for addresses that never logged in age out', () => {
  let t = Date.now();
  auth.setClock(() => t);
  const req = { headers: { 'x-real-ip': '198.51.100.7' }, socket: {} } as any;
  assert.throws(() => auth.login(req, fakeRes(), { password: 'wrong' }));
  assert.equal(auth.limitSize(), 1);
  t += 16 * 60000;
  auth.pruneSessions();
  assert.equal(auth.limitSize(), 0);
  auth.setClock(() => Date.now());
});

test('browser WebSocket: foreign Origin refused; closes on logout and on expiry', async () => {
  assert.equal(browser.view().state, 'running');
  assert.match((await ws(session('o'), 'https://evil.example')).head, /403/);
  assert.match((await ws('agyme_sid=nope')).head, /403/);

  const c = session('a');
  const a = await ws(c);
  assert.match(a.head, /101/);
  auth.logout({ headers: { cookie: c }, socket: {} } as any, fakeRes());
  await a.closed;

  const b = await ws(session('b'));
  assert.match(b.head, /101/);
  state.data.sessions[sha256('b')] = Date.now() - 1;
  browser.dropEnded();
  await b.closed;
});

test('browser stop reports idle only when browserd stopped it', async () => {
  stopFails = true;
  const v = await browser.stop();
  assert.equal(v.state, 'running');
  assert.match(v.error, /docker down/);
  stopFails = false;
  assert.equal((await browser.stop()).state, 'idle');
});

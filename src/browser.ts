// Remote Chromium for signing in to Google from the server's IP. ops/browserd.py (this app's own instance, own
// port and container name) starts and removes the container; this server never touches docker. One user, so
// no queue and no time limit; the container is only removed after BROWSER_IDLE_MINUTES with nobody watching.
// The UI is proxied under <base>/browser/ for the logged-in session only, plain requests and WebSockets alike.
import http from 'node:http';
import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { config } from './config.ts';
import { authed, sessionKey, sessionValid, onSessionEnd } from './auth.ts';
import { HttpError } from './util.ts';
import { safeGoogleURL } from './accerr.ts';

export const browserOn = () => !!config.browserdToken;

type State = 'idle' | 'starting' | 'running';
let st: State = 'idle';
let lastSeen = 0;
let lastError = '';
const sockets = new Set<Duplex>();
const owner = new Map<Duplex, string>(); // client socket -> the session it was opened with

/** Close WebSockets whose session has ended (logout, expiry, password change). */
export function dropEnded() {
  for (const [s, k] of owner) if (!sessionValid(k)) s.destroy();
}
onSessionEnd(dropEnded);

async function helper(path: '/start' | '/stop' | '/open' | '/status', timeoutMs: number, body?: { url?: string }): Promise<any> {
  const r = await fetch(config.browserdURL + path, {
    method: path === '/status' ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + config.browserdToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let d: any = null;
  try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(`browserd ${path} ${r.status}${d?.error ? ': ' + d.error : ''}`);
  return d;
}

function need() {
  if (!browserOn()) throw new HttpError(404, 'not_found');
}

export function view() {
  if (st === 'running') lastSeen = Date.now();
  return { enabled: browserOn(), state: st, error: lastError };
}

export async function start(url?: string) {
  need();
  const u = url ? safeGoogleURL(url) : null;
  if (url && !u) throw new HttpError(400, 'invalid_url');
  if (st === 'running') {
    if (u) await helper('/open', 30000, { url: u });
    return view();
  }
  if (st === 'starting') return view();
  st = 'starting';
  lastError = '';
  helper('/start', 90000, u ? { url: u } : undefined)
    .then(() => { st = 'running'; lastSeen = Date.now(); })
    .catch((e) => { st = 'idle'; lastError = (e as Error).message; console.error('[browser]', lastError); });
  return view();
}

/** Idle only once browserd confirms; otherwise the state stays and the error shows (the idle reaper retries). */
export async function stop() {
  need();
  for (const s of sockets) s.destroy();
  sockets.clear();
  owner.clear();
  try {
    await helper('/stop', 30000);
    st = 'idle';
    lastError = '';
  } catch (e) {
    lastError = (e as Error).message;
    console.error('[browser] stop failed:', lastError);
  }
  return view();
}

export function startBrowser() {
  if (!browserOn()) return;
  // pick up a container that survived our restart
  helper('/status', 5000).then((d) => { if (d?.running) { st = 'running'; lastSeen = Date.now(); } }).catch(() => {});
  setInterval(() => {
    dropEnded();
    if (st !== 'running' || config.browserIdleMinutes <= 0) return;
    if (sockets.size) lastSeen = Date.now();
    else if (Date.now() - lastSeen > config.browserIdleMinutes * 60000) stop().catch(() => {});
  }, 30000).unref();
}

// ---------- proxy ----------
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'host', 'cookie', 'authorization', 'content-length']);

/** <base>/browser/... -> the container, which serves under the same full path. */
export async function handleBrowser(req: IncomingMessage, res: ServerResponse, url: URL) {
  need();
  if (url.pathname === '/browser') {
    res.writeHead(301, { Location: config.basePath + '/browser/' + url.search }).end();
    return;
  }
  if (!authed(req)) throw new HttpError(401, 'unauthorized');
  if (st !== 'running') throw new HttpError(409, 'browser_not_running');
  const target = new URL(config.browserUpstream);
  const headers: Record<string, any> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('x-forwarded') && k !== 'x-real-ip') headers[k] = v;
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  return new Promise<void>((resolve) => {
    const up = http.request({ hostname: target.hostname, port: target.port, path: config.basePath + url.pathname + url.search, method: req.method, headers }, (ur) => {
      const h: Record<string, any> = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k) && k !== 'set-cookie' && k !== 'x-frame-options') h[k] = v;
      h['x-frame-options'] = 'SAMEORIGIN';
      h['cache-control'] = 'no-store';
      res.writeHead(ur.statusCode || 502, h);
      ur.pipe(res);
      ur.on('end', () => resolve());
      ur.on('error', () => { res.destroy(); resolve(); });
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"browser_unavailable"}');
      else res.destroy();
      resolve();
    });
    req.pipe(up);
  });
}

/** WebSockets skip the API's CSRF header, so the page that opens one must be ours: Origin host = Host. */
export function sameOrigin(req: IncomingMessage): boolean {
  let o: URL;
  try { o = new URL(String(req.headers.origin || '')); } catch { return false; }
  const hosts = [req.headers.host, config.trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0] : '']
    .map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
  // nginx's `Host $host` drops the port, so a portless Host matches on the name
  return hosts.some((h) => h === o.host || (!/:\d+$/.test(h) && h === o.hostname));
}

function refuse(socket: Duplex, status: string) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** server.on('upgrade'): only <base>/browser/... for a logged-in session; everything else is refused. */
export function handleBrowserUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  socket.on('error', () => socket.destroy());
  let path: string;
  try {
    const u = new URL(req.url || '/', 'http://local');
    path = u.pathname + u.search;
  } catch {
    return refuse(socket, '400 Bad Request');
  }
  if (!browserOn() || !path.startsWith(config.basePath + '/browser/')) return refuse(socket, '404 Not Found');
  const key = sessionKey(req);
  if (!key || !sameOrigin(req)) return refuse(socket, '403 Forbidden');
  if (st !== 'running') return refuse(socket, '409 Conflict');
  const target = new URL(config.browserUpstream);
  const up = net.connect(Number(target.port) || 80, target.hostname);
  sockets.add(socket);
  sockets.add(up);
  owner.set(socket, key);
  const drop = () => { socket.destroy(); up.destroy(); sockets.delete(socket); sockets.delete(up); owner.delete(socket); lastSeen = Date.now(); };
  socket.on('close', drop);
  up.on('close', drop);
  up.on('error', drop);
  up.on('connect', () => {
    let raw = `${req.method} ${path} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i].toLowerCase();
      if (k === 'cookie' || k === 'authorization' || k.startsWith('x-forwarded') || k === 'x-real-ip') continue;
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    up.write(raw + '\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
}

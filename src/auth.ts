// Single-user login: one password (settings page, else the environment), opaque session cookie, login rate limit.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { state } from './store.ts';
import { HttpError, sha256, token, parseCookies, cookie, checkPassword, safeEqual, hashPassword } from './util.ts';

export const SID = 'agyme_sid';

let clock = () => Date.now();
/** Tests drive time by hand. */
export function setClock(fn: () => number) { clock = fn; }

/** A password set on the settings page (state.json) wins over APP_PASSWORD_HASH, which wins over APP_PASSWORD. */
export function passwordOK(pw: string): boolean {
  const h = state.data.pwHash || config.passwordHash;
  if (h) return checkPassword(pw, h);
  return !!config.password && safeEqual(pw, config.password);
}
const fingerprint = () => sha256('agy-me:' + (state.data.pwHash || config.passwordHash || config.password)).slice(0, 16);

function isHttps(req: IncomingMessage): boolean {
  if (config.cookieSecure !== 'auto') return config.cookieSecure === 'on';
  const p = config.trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : '';
  return p === 'https' || !!(req.socket as any).encrypted;
}

/** The stored key (sha256 of the cookie) of this request's live session, or '' when there is none. */
export function sessionKey(req: IncomingMessage): string {
  const sid = parseCookies(req.headers.cookie)[SID];
  if (!sid) return '';
  const k = sha256(sid);
  return sessionValid(k) ? k : '';
}
export function sessionValid(key: string): boolean {
  const exp = state.data.sessions[key];
  return !!exp && exp > clock();
}
export const authed = (req: IncomingMessage) => !!sessionKey(req);

// Long-lived things bound to a session (the browser's WebSockets) close when it ends.
const enders: (() => void)[] = [];
export function onSessionEnd(fn: () => void) { enders.push(fn); }
const ended = () => { for (const f of enders) f(); };

/** A changed password (hash) logs every session out: state.json keeps a fingerprint of the one they were made with.
 *  Startup only; APP_PASSWORD_RESET drops the settings-page password first, so the env one is back in force. */
export function checkPasswordChange() {
  if (config.passwordReset && state.data.pwHash) {
    delete state.data.pwHash;
    console.log('[auth] APP_PASSWORD_RESET: password set on the settings page dropped, the env one is in force');
  }
  const fp = fingerprint();
  if (state.data.pwFingerprint === fp) return false;
  const had = Object.keys(state.data.sessions).length > 0 && !!state.data.pwFingerprint;
  state.data.sessions = {};
  state.data.pwFingerprint = fp;
  state.save(0);
  ended();
  return had;
}

export function requireAuth(req: IncomingMessage) {
  if (!authed(req)) throw new HttpError(401, 'unauthorized');
}

// ---------- rate limit: per client IP, plus a global ceiling so rotating IPs don't help ----------
const WINDOW_MS = 15 * 60000, PER_IP = 8, GLOBAL = 40;
const fails = new Map<string, number[]>();
let globalFails: number[] = [];
const recent = (l: number[]) => l.filter((t) => t > clock() - WINDOW_MS);

export function clientIP(req: IncomingMessage): string {
  if (config.trustProxy) {
    const xr = String(req.headers['x-real-ip'] || '').trim();
    if (xr) return xr;
    const xf = String(req.headers['x-forwarded-for'] || '').split(',').pop()?.trim();
    if (xf) return xf;
  }
  return String(req.socket.remoteAddress || '');
}

/** Checks a password against the limiter: login and the settings page's old password share it. */
function attempt(req: IncomingMessage, v: unknown, status: number, code: string) {
  const ip = clientIP(req);
  const mine = recent(fails.get(ip) || []);
  globalFails = recent(globalFails);
  if (mine.length >= PER_IP || globalFails.length >= GLOBAL) throw new HttpError(429, 'too_many_attempts');
  const pw = typeof v === 'string' ? v.slice(0, 1024) : '';
  if (!pw || !passwordOK(pw)) {
    fails.set(ip, [...mine, clock()]);
    globalFails.push(clock());
    throw new HttpError(status, code);
  }
  fails.delete(ip);
}

export function login(req: IncomingMessage, res: ServerResponse, body: any) {
  attempt(req, body?.password, 401, 'bad_password');
  const sid = token(32);
  const maxAge = config.sessionDays * 86400;
  pruneSessions();
  state.data.sessions[sha256(sid)] = clock() + maxAge * 1000;
  state.save(0);
  res.setHeader('Set-Cookie', cookie(SID, sid, { maxAge, secure: isHttps(req) }));
}

/** Settings page: old password + new one twice. The new hash lives in state.json; every other session ends. */
export function changePassword(req: IncomingMessage, body: any) {
  const pw = typeof body?.password === 'string' ? body.password : '';
  if (pw.length < 8 || pw.length > 1024) throw new HttpError(400, 'password_too_short');
  if (pw !== body?.confirm) throw new HttpError(400, 'password_mismatch');
  attempt(req, body?.old, 403, 'bad_old_password');
  const key = sessionKey(req);
  state.data.pwHash = hashPassword(pw);
  state.data.pwFingerprint = fingerprint(); // a restart must not log this session out again
  state.data.sessions = key ? { [key]: state.data.sessions[key] } : {};
  state.flush();
  ended();
}

export function logout(req: IncomingMessage, res: ServerResponse) {
  const sid = parseCookies(req.headers.cookie)[SID];
  if (sid && state.data.sessions[sha256(sid)]) {
    delete state.data.sessions[sha256(sid)];
    state.save(0);
    ended();
  }
  res.setHeader('Set-Cookie', cookie(SID, '', { maxAge: 0, secure: isHttps(req) }));
}

/** Drops expired sessions (and what is bound to them) and login-limit entries that have aged out. */
export function pruneSessions() {
  const t = clock();
  let n = 0;
  for (const [k, exp] of Object.entries(state.data.sessions)) if (exp <= t) { delete state.data.sessions[k]; n++; }
  if (n) ended();
  for (const [ip, l] of fails) {
    const r = recent(l);
    if (r.length) fails.set(ip, r); else fails.delete(ip);
  }
  globalFails = recent(globalFails);
}
/** Test helper. */
export const limitSize = () => fails.size;

/** Test helper. */
export function resetLimits() {
  fails.clear();
  globalFails = [];
}

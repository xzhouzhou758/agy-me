// Account error details, without any database access (unit-testable):
//  - classify(): what kind of account problem a message describes (used by accounts.ts classifyAccount)
//  - errText(): CPA reasons / status codes / Google error bodies as short plain Chinese
//  - extractAction(): the verify / appeal link Google puts into a 403 body (details[].metadata)

export type ProblemKind = 'verify' | 'auth' | 'banned' | 'error';
export function classify(msg: string): ProblemKind | null {
  if (!msg) return null;
  if (/verify your account|validation_required|account verification/i.test(msg)) return 'verify';
  if (/has been disabled|suspended|terms of service|violat|account.{0,20}(banned|disabled)/i.test(msg)) return 'banned';
  if (/invalid_grant|invalid_token|unauthenticated|\b401\b|token.{0,20}(expired|revoked)|refresh.{0,20}fail/i.test(msg)) return 'auth';
  if (/\b403\b|permission_denied/i.test(msg)) return 'error';
  return null;
}

/** Short plain-Chinese reason. Unknown text comes back as is (trimmed); nothing at all -> ''. */
export function errText(msg: string | null | undefined, status?: number | null): string {
  const s = String(msg || '').replace(/\s+/g, ' ').trim();
  const code = Number(status) || 0;
  const k = classify(s);
  if (k === 'verify') return '需要验证账号';
  if (k === 'banned') return '账号被 Google 停用';
  if (/invalid_grant/i.test(s)) return '授权已失效，需要重新登录';
  if (/cloudflare/i.test(s)) return '被 Cloudflare 拦截';
  if (/payment_required|permission_denied|forbidden/i.test(s) || code === 403 || (!code && /\b403\b/.test(s))) return 'Google 拒绝访问 (403)';
  if (k === 'auth' || /unauthori[sz]ed/i.test(s) || code === 401 || (!code && /\b401\b/.test(s))) return '登录失效 (401)';
  if (/quota|exhaust|rate.?limit|too many requests/i.test(s) || code === 429 || (!code && /\b429\b/.test(s))) return '额度用完 (429)';
  if (/not.?found/i.test(s) || code === 404 || (!code && /\b404\b/.test(s))) return '模型不可用 (404)';
  if (/transient|unavailable|timeout|bad gateway|internal/i.test(s) || code >= 500 || (!code && /\b5\d\d\b/.test(s))) return '上游临时故障' + (code >= 500 ? ` (${code})` : '');
  if (s) return s.slice(0, 120);
  return code ? 'HTTP ' + code : '';
}

export type Action = { kind: 'verify' | 'appeal'; url: string };

/** Only https links on Google's own hosts. Returns the normalized URL or null. */
export function safeGoogleURL(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const h = u.hostname.toLowerCase();
  const ok = h === 'google.com' || h.endsWith('.google.com') || h === 'googleapis.com' || h.endsWith('.googleapis.com') || h === 'goo.gl' || h === 'forms.gle';
  return ok ? u.href : null;
}

const KEYS: [string, Action['kind']][] = [['appeal_url', 'appeal'], ['validation_url', 'verify']];

function fromJSON(v: any, depth = 0): Action | null {
  if (depth > 8 || v == null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && t.length < 200000) {
      try { return fromJSON(JSON.parse(t), depth + 1); } catch { return null; }
    }
    return null;
  }
  if (Array.isArray(v)) {
    for (const x of v) { const a = fromJSON(x, depth + 1); if (a) return a; }
    return null;
  }
  if (typeof v !== 'object') return null;
  const md = v.metadata;
  if (md && typeof md === 'object') {
    for (const [key, kind] of KEYS) {
      const url = typeof md[key] === 'string' ? safeGoogleURL(md[key]) : null;
      if (url) return { kind, url };
    }
  }
  for (const x of Object.values(v)) { const a = fromJSON(x, depth + 1); if (a) return a; }
  return null;
}

function unescapeURL(s: string): string {
  return s
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\+\//g, '/')
    .replace(/&amp;/gi, '&');
}

/** The verify / appeal link in an upstream error body (JSON, JSON inside a string, or plain text), or null. */
export function extractAction(body: string | null | undefined): Action | null {
  const s = String(body || '');
  if (!/validation_url|appeal_url/i.test(s)) return null;
  // the body may carry a status prefix ("403 {...}") or be wrapped by CPA: try the JSON part
  const at = s.search(/[{[]/);
  if (at >= 0) {
    try {
      const a = fromJSON(JSON.parse(s.slice(at)));
      if (a) return a;
    } catch {}
  }
  for (const [key, kind] of KEYS) {
    const re = new RegExp(key + '\\\\*["\']?\\s*[:=]\\s*\\\\*["\']?(https:(?:[^"\'\\s\\\\<>]|\\\\+u[0-9a-fA-F]{4}|\\\\+/)+)', 'gi');
    for (const m of s.matchAll(re)) {
      const url = safeGoogleURL(unescapeURL(m[1]));
      if (url) return { kind, url };
    }
  }
  return null;
}

export type Cooldown = { scope: string; model: string; reason: string; retryAt: string | null; remainingSeconds: number; backoffLevel: number | null; httpStatus: number | null };
export type CooldownView = { scope: string; model: string; text: string; status: number | null; retryAt: string };

/** Cooldowns whose retry time is still ahead, translated, soonest first. */
export function activeCooldowns(list: Cooldown[] | null | undefined, t = Date.now()): CooldownView[] {
  const out: CooldownView[] = [];
  for (const c of list || []) {
    const at = c.retryAt ? Date.parse(c.retryAt) : NaN;
    if (!(at > t)) continue;
    out.push({ scope: c.scope, model: c.model, text: errText(c.reason, c.httpStatus), status: c.httpStatus, retryAt: new Date(at).toISOString() });
  }
  return out.sort((a, b) => Date.parse(a.retryAt) - Date.parse(b.retryAt));
}

// 403 vs. everything else, for auto-disable. Structured "not a 403" markers win over everything; loose ones
// only lose to strong 403 markers (a 429 / 401 / quota answer must never turn an account off).
const NOT_403 = /"code"\s*:\s*(429|401)\b|RESOURCE_EXHAUSTED|UNAUTHENTICATED|invalid_grant/i;
const STRONG_403 = /"code"\s*:\s*403\b|PERMISSION_DENIED|verify your account|VALIDATION_REQUIRED/i;
const LOOSE_NOT = /\b(429|401)\b|quota|rate.?limit|cool.?down|too many requests|unauthori[sz]ed|expired/i;
const LOOSE_403 = /\b403\b|forbidden|\b(account|user|project)\b.{0,40}\b(disabled|suspended)\b|has been (disabled|suspended)|\bsuspended\b/i;

// 401 = the account's sign-in is dead (CPA already tried its refresh). Counts as 报错 / 封号 and is auto-disabled too.
const NOT_401 = /"code"\s*:\s*(429|403)\b|RESOURCE_EXHAUSTED|PERMISSION_DENIED/i;
const IS_401 = /"code"\s*:\s*401\b|UNAUTHENTICATED|invalid_grant|invalid_token|\b401\b|unauthori[sz]ed|token.{0,20}revoked|refresh.{0,20}fail/i;

/** "401 <short reason>" when the text says the account's sign-in is dead, else null. */
export function match401(s: string | null | undefined): string | null {
  const t = String(s || '');
  if (!t || NOT_401.test(t) || !IS_401.test(t)) return null;
  return /invalid_grant|refresh.{0,20}fail|revoked/i.test(t) ? '401 授权已失效，需要重新登录' : '401 登录失效';
}
/** A quota read that failed because Google answered 401 (only Google's own answer: CPA management errors never count). */
export function quota401(err: string | null | undefined): string | null {
  const m = /^fetchAvailableModels 401:\s*([\s\S]*)/.exec(String(err || ''));
  return m ? match401('401 ' + m[1]) || '401 登录失效' : null;
}
/** 403 refusal or dead sign-in: what auto-disable acts on. */
export const matchBad = (s: string | null | undefined): string | null => match403(s) || match401(s);

/** "403 <Google's message>" when the text is a 403 refusal of the account, else null. */
export function match403(s: string | null | undefined): string | null {
  const t = String(s || '');
  if (!t || NOT_403.test(t)) return null;
  if (!STRONG_403.test(t) && (LOOSE_NOT.test(t) || !LOOSE_403.test(t))) return null;
  const m = /"message"\s*:\s*"([^"]{1,160})"/.exec(t);
  return ('403 ' + (m ? m[1] : t.replace(/^\s*403\b/, '')).replace(/\s+/g, ' ').trim()).slice(0, 160).trim();
}

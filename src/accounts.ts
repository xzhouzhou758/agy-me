// Account status (正常 / 冷却 / 封号 / 停用), the account view the pages use, and dashboard aggregates.
// Pure functions: everything comes in as arguments.
import type { Cred } from './cpa.ts';
import type { Entry, Fam, Quota } from './quota.ts';
import type { TokEvent } from './usage.ts';
import { activeCooldowns, classify, errText, extractAction, type CooldownView, type Action } from './accerr.ts';
import type { AutoMark } from './store.ts';

export type Status = 'ok' | 'cooldown' | 'banned' | 'disabled';
export type Ban = { ts: number; status: number; message: string };

const BAN_RE = /terms of service|tos_violation|violat|has been disabled|suspended|\b403\b|permission_denied|forbidden|verify your account|validation_required/i;
export const isBanText = (s: string | null | undefined) => !!s && BAN_RE.test(s);

/**
 * 停用: disabled in CPA. 封号: Google refused the account (403 from quota calls, a ToS / verify / permission
 * message on the credential, or its latest request in the log was a 403), or its sign-in is dead.
 * 冷却: CPA has it unavailable / in error / cooling down. 正常: the rest.
 */
export function classifyAccount(c: Pick<Cred, 'disabled' | 'status' | 'statusMessage' | 'unavailable' | 'nextRetryAfter' | 'cooldowns'>, q: Quota | null, ban: Ban | null, now = Date.now()): { status: Status; reason: string } {
  if (c.disabled) return { status: 'disabled', reason: '' };
  if (q?.forbidden) return { status: 'banned', reason: errText(q.forbidden, 403) };
  const kind = classify(c.statusMessage);
  if (kind === 'banned' || kind === 'verify' || kind === 'auth' || (kind === 'error' && (c.status === 'error' || c.unavailable))) return { status: 'banned', reason: errText(c.statusMessage) };
  if (ban) return { status: 'banned', reason: errText(ban.message, ban.status) };
  const cds = activeCooldowns(c.cooldowns, now);
  const authCd = cds.find((x) => x.scope !== 'model');
  const retry = c.nextRetryAfter ? Date.parse(c.nextRetryAfter) : NaN;
  if (c.unavailable || c.status === 'error' || authCd || retry > now) {
    return { status: 'cooldown', reason: errText(c.statusMessage) || authCd?.text || (cds[0] ? `${cds[0].model} ${cds[0].text}` : '冷却中') };
  }
  return { status: 'ok', reason: '' };
}

export type AccountView = {
  id: string;
  email: string;
  note: string;
  disabled: boolean;
  status: Status;
  reason: string;
  tier: string | null;
  credits: number | null;
  quota: Quota | null;
  quotaAt: number;
  quotaErr: string | null;
  cooldowns: CooldownView[];
  action: Action | null; // Google's verify / appeal link
  autoAt: number; // turned off by auto-disable at (ms); 0 = not
  lastUsed: number;
  createdAt: string;
  success: number;
  failed: number;
  /** tokens used in each model group's current 5H / 7D window, from the request log; null = none recorded */
  used: Used;
};

export type UsedKey = 'gemini' | 'claude' | 'argon' | 'carbon';
export type Used = Partial<Record<UsedKey, { h5: number | null; week: number | null }>>;
const WIN_MS = { h5: 5 * 3600e3, week: 7 * 864e5 };
export const USED_SPAN_MS = WIN_MS.week;

/** Which quota group a model's requests count against (each request in exactly one). */
export function usedKeyOf(model: string): UsedKey | null {
  const m = model.trim().toLowerCase();
  if (m.includes('argon')) return 'argon';
  if (m.includes('carbon')) return 'carbon';
  if (m.startsWith('claude') || m.startsWith('gpt')) return 'claude';
  if (m.startsWith('gemini')) return 'gemini';
  return null;
}

/** Window start: reset minus the window length while the reset is ahead; since the reset once it has passed. */
function winStart(b: { reset: string | null } | null, len: number, now: number): number {
  const r = b?.reset ? Date.parse(b.reset) : NaN;
  if (!Number.isFinite(r)) return now - len;
  return r > now ? r - len : r;
}

export function usedTokens(q: Quota | null, ev: TokEvent[], now = Date.now()): Used {
  const out: Used = {};
  if (!q || q.forbidden) return out;
  for (const k of ['gemini', 'claude', 'argon', 'carbon'] as UsedKey[]) {
    const f = q[k];
    if (!f) continue;
    const sum = (b: Fam['h5'], len: number) => {
      if (!b) return null;
      const from = winStart(b, len, now);
      let t = 0;
      for (const e of ev) if (e.ts >= from && usedKeyOf(e.model) === k) t += e.tok;
      return t > 0 ? t : null;
    };
    out[k] = { h5: sum(f.h5, WIN_MS.h5), week: sum(f.week, WIN_MS.week) };
  }
  return out;
}

export function accountView(c: Cred, e: Entry | null, ban: Ban | null, lastUsed: number, now = Date.now(), mark: AutoMark | null = null, ev: TokEvent[] = []): AccountView {
  const q = e?.q || null;
  const auto = c.disabled ? mark : null;
  const { status, reason: r } = classifyAccount(c, q, ban, now);
  const reason = auto ? '自动停用 · ' + auto.reason : r;
  return {
    id: c.id,
    email: c.email || c.id,
    note: c.note,
    disabled: c.disabled,
    status,
    reason,
    tier: q?.tier ? ((q.tier as string) === 'ENTERPRISE' ? 'FREE' : q.tier) : null, // older cache entries
    credits: q?.credits ?? null,
    quota: q,
    quotaAt: e?.at || 0,
    quotaErr: e?.err || null,
    cooldowns: activeCooldowns(c.cooldowns, now),
    action: auto?.action || extractAction(q?.forbidden) || extractAction(c.statusMessage) || extractAction(ban?.message),
    autoAt: auto?.at || 0,
    lastUsed,
    createdAt: c.createdAt,
    success: c.success,
    failed: c.failed,
    used: usedTokens(q, ev, now),
  };
}

// ---------------------------------------------------------------- dashboard aggregates
export type FamKey = 'gemini' | 'claude' | 'argon' | 'carbon';
export type FamSummary = { total: number; withQuota: number; h5: number | null; week: number | null; earliest: string | null };

/** When an exhausted family comes back: the later reset among its empty windows. */
function backAt(f: Fam): string | null {
  const empty = [f.h5, f.week].filter((b) => b && b.frac <= 0 && b.reset).map((b) => b!.reset!);
  if (!empty.length) return null;
  return empty.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

/**
 * For one model family, over usable accounts (not 停用 / 封号) that report that family:
 * how many still have quota (no window at 0), average remaining per window, earliest comeback among the empty ones.
 */
export function famSummary(list: AccountView[], key: FamKey, now = Date.now()): FamSummary {
  let total = 0, withQuota = 0, earliest: number | null = null;
  const h5: number[] = [], week: number[] = [];
  for (const a of list) {
    if (a.status === 'disabled' || a.status === 'banned') continue;
    const f = a.quota?.[key];
    if (!f) continue;
    // a reset already behind us means the window has refilled since the last read
    const live = (b: Fam['h5']) => (b ? (b.reset && Date.parse(b.reset) <= now ? { ...b, frac: 1 } : b) : null);
    const lf: Fam = { h5: live(f.h5), week: live(f.week) };
    total++;
    if (lf.h5) h5.push(lf.h5.frac);
    if (lf.week) week.push(lf.week.frac);
    const empty = (lf.h5 && lf.h5.frac <= 0) || (lf.week && lf.week.frac <= 0);
    if (!empty) { withQuota++; continue; }
    const b = backAt(lf);
    if (b && (earliest == null || Date.parse(b) < earliest)) earliest = Date.parse(b);
  }
  const avg = (l: number[]) => (l.length ? l.reduce((x, y) => x + y, 0) / l.length : null);
  return { total, withQuota, h5: avg(h5), week: avg(week), earliest: earliest == null ? null : new Date(earliest).toISOString() };
}

export function counts(list: AccountView[]) {
  const n = { total: list.length, ok: 0, cooldown: 0, banned: 0, disabled: 0 };
  for (const a of list) n[a.status]++;
  return n;
}

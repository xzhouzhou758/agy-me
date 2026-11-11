// Auto-disable accounts Google answers with 403 (ToS ban / "verify your account" / suspended), so CPA stops
// routing into them; only accounts this module disabled (state.auto) are ever re-enabled, after a probe succeeds.
// 403 signals: the request log (an account's latest request was a 403), the quota fetch (forbidden), CPA's
// credential status message, and the probe. 429 / 401 / quota answers never count (match403).
// Probing works on a disabled credential: CPA's /requests/api-call looks auths up by index and never checks
// Disabled. Quota calls keep working on 403 accounts, so the probe is a tiny generation. Idle accounts get the
// probe now and then too, so a ban nobody routes into still turns the account off.
// The user's own toggles win: turning a marked account on or off by hand drops the mark, and turning an
// account on voids the 403 evidence from before that moment (state.autoSince).
import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { state, settings, type AutoMark } from './store.ts';
import { match403, extractAction, type Action } from './accerr.ts';
import { usageSource } from './usage.ts';
import * as cpa from './cpa.ts';
import * as quota from './quota.ts';
import type { Ban } from './accounts.ts';

const LOG_WINDOW_MS = 24 * 3600e3;    // a 403 as the latest request this recent counts
const QUOTA_FRESH_MS = 3600e3;        // a forbidden quota read this recent counts
const IDLE_PER_SWEEP = 2;             // idle probes per sweep (the rest wait for the next one)
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

const marks = () => (state.data.auto ||= {});
const sinceMap = () => (state.data.autoSince ||= {});
export const autoMark = (id: string): AutoMark | null => state.data.auto?.[id] || null;
/** 403 evidence from before this (ms) doesn't count: the account was turned on since. */
export const autoSince = (id: string): number => state.data.autoSince?.[id] || 0;

const seenDisabled = new Map<string, boolean>(); // last disabled state the sweep saw, to notice "turned on elsewhere"
const lastProbe = new Map<string, number>();
const lastIdle = new Map<string, number>();

/** The user turned an account on or off by hand (this panel). Their call wins over the auto mark. */
export function userToggled(id: string, disabled: boolean) {
  delete marks()[id];
  if (!disabled) sinceMap()[id] = Date.now();
  seenDisabled.set(id, disabled);
  lastProbe.delete(id);
  state.save(0);
}
/** Another module (auto-sleep) turned an account off / on: the sweep must not read that as the user's doing. */
export function markEnabled(id: string, disabled: boolean) { seenDisabled.set(id, disabled); }
export function forgetAccount(id: string) {
  delete marks()[id];
  delete sinceMap()[id];
  state.save();
}

export type Evidence = { reason: string; action: Action | null };
/** A 403 signal newer than `after`, from CPA's status, the request log or the quota read; null when there is none. */
export function evidence(c: Pick<cpa.Cred, 'status' | 'unavailable' | 'statusMessage'>, e: quota.Entry | null, ban: Ban | null, after: number, now = Date.now()): Evidence | null {
  if (c.status === 'error' || c.unavailable) {
    const r = match403(c.statusMessage);
    if (r) return { reason: r, action: extractAction(c.statusMessage) };
  }
  if (ban && ban.ts > after) {
    const r = match403('403 ' + ban.message);
    if (r) return { reason: r, action: extractAction(ban.message) };
  }
  const f = e?.q?.forbidden;
  if (f && e!.at > after && e!.at > now - QUOTA_FRESH_MS) {
    const r = match403('403 ' + f);
    if (r) return { reason: r, action: extractAction(f) };
  }
  return null;
}

const flashRank = (n: string) => (/lite/i.test(n) ? 0 : /-(high|medium)$/i.test(n) ? 3 : /-low$/i.test(n) ? 2 : 1);
/** Cheapest Gemini flash in this list, or null. */
export function pickFlash(names: string[]): string | null {
  const l = names.filter((n) => /^gemini/i.test(n) && /flash/i.test(n) && !/image|tts|audio|live/i.test(n));
  l.sort((a, b) => flashRank(a) - flashRank(b) || a.localeCompare(b));
  return l[0] || null;
}
/** The account's own models (last quota read, else CPA's model list for it), else what most other accounts have, else a fixed lite model. */
async function probeModel(id: string): Promise<string> {
  const own = pickFlash(quota.entry(id)?.q?.models.map((m) => m.name) || []);
  if (own) return own;
  const listed = pickFlash(await cpa.credentialModels(id).then((l) => l.map((m: any) => String(m?.id || m?.name || '')), () => []));
  if (listed) return listed;
  const n = new Map<string, number>();
  for (const e of Object.values(quota.entries())) for (const m of e.q?.models || []) n.set(m.name, (n.get(m.name) || 0) + 1);
  const common = [...n.keys()].sort((a, b) => n.get(b)! - n.get(a)!);
  return pickFlash(common.slice(0, 40)) || FALLBACK_MODEL;
}

export type Probe = { ok: boolean | null; reason?: string; action?: Action | null };
/** One tiny generation through the credential. true = gets past Google's permission check, false = 403, null = can't tell. */
export async function probe(c: cpa.Cred): Promise<Probe> {
  if (!c.projectId) return { ok: null }; // without a project Google answers 403 "no valid license", which says nothing about the account
  const headers = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': config.quotaUserAgent };
  const body = JSON.stringify({
    model: await probeModel(c.id), userAgent: 'antigravity', requestType: 'agent', project: c.projectId, requestId: 'agent-' + randomUUID(),
    request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 }, sessionId: randomUUID() },
  });
  for (const base of config.quotaBaseURLs) {
    let r: { status: number; body: string };
    try { r = await cpa.apiCall(c.authIndex, 'POST', base + '/v1internal:generateContent', headers, body); } catch { return { ok: null }; }
    if (r.status === 403) {
      const reason = match403('403 ' + r.body);
      return reason ? { ok: false, reason, action: extractAction(r.body) } : { ok: null };
    }
    // 2xx works; 429 is plain quota (CPA cools it down); 400 / 404 got past the permission check
    if ((r.status >= 200 && r.status < 300) || r.status === 400 || r.status === 404 || r.status === 429) return { ok: true };
    if (r.status && r.status < 500) return { ok: null }; // 401 etc.
  }
  return { ok: null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(Math.min(1000, Math.max(50, config.autoSweepMs)));
const disabledNow = async (id: string) => (await cpa.creds(0)).byId.get(id)?.disabled;

let running = false;
/** One pass over the accounts, probes one at a time. */
export async function sweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const c = await cpa.creds(5000);
    const src = usageSource();
    const now = Date.now();
    const bans = src.bans(now - LOG_WINDOW_MS);
    const lastUsed = src.lastUsed();
    const M = marks(), S = sinceMap();
    for (const id of Object.keys(M)) if (!c.byId.has(id)) delete M[id];
    for (const id of Object.keys(S)) if (!c.byId.has(id)) delete S[id];
    let idle = IDLE_PER_SWEEP;
    for (const cred of c.list) {
      if (cred.type !== 'antigravity') continue;
      const id = cred.id;
      const was = seenDisabled.get(id);
      seenDisabled.set(id, cred.disabled);
      const mark = M[id];
      if (mark) {
        if (!cred.disabled) { // turned back on elsewhere (CPA's own panel): the user's call
          delete M[id];
          S[id] = Date.now();
          lastProbe.delete(id);
          state.save();
          continue;
        }
        if (!settings().autoEnable || Date.now() - Math.max(mark.at, lastProbe.get(id) || 0) < config.autoProbeMs) continue;
        lastProbe.set(id, Date.now());
        const p = await probe(cred);
        if (M[id] !== mark) continue; // the user toggled it meanwhile
        if (p.ok === true && settings().autoEnable && (await disabledNow(id)) === true) {
          await cpa.setDisabled(id, false);
          delete M[id];
          S[id] = Date.now(); // the old 403 log row / quota read must not turn it off again
          seenDisabled.set(id, false);
          lastProbe.delete(id);
          quota.enqueue([id]);
          state.save(0);
          console.log('[autodisable] re-enabled', id);
        } else if (p.ok === false) {
          mark.reason = p.reason || mark.reason;
          mark.action = p.action || mark.action;
          state.save();
        }
        await pause();
        continue;
      }
      if (cred.disabled) continue; // off by hand: never ours
      if (was === true) { S[id] = Date.now(); state.save(); } // just turned on elsewhere: older evidence is void
      if (!settings().autoDisable) continue;
      const after = autoSince(id);
      let ev = evidence(cred, quota.entry(id), bans.get(id) || null, after);
      if (!ev) {
        const t = Date.now() - config.autoIdleMs;
        if (idle <= 0 || (lastUsed.get(id) || 0) > t || (lastIdle.get(id) || 0) > t || (Date.parse(cred.createdAt) || 0) > t) continue;
        idle--;
        lastIdle.set(id, Date.now());
        const p = await probe(cred);
        await pause();
        if (p.ok !== false) continue;
        ev = { reason: p.reason || '403', action: p.action || null };
      }
      // the user may have toggled it, or the setting, while we looked
      if (!settings().autoDisable || M[id] || autoSince(id) !== after || (await disabledNow(id)) !== false) continue;
      await cpa.setDisabled(id, true);
      const m: AutoMark = { at: Date.now(), reason: ev.reason, action: ev.action };
      M[id] = m;
      seenDisabled.set(id, true);
      state.save(0);
      console.log('[autodisable] disabled', id, ev.reason);
      if (!m.action) { // grab Google's verify / appeal link
        const p = await probe(cred);
        if (M[id] === m && p.ok === false && p.action) { m.action = p.action; state.save(); }
        await pause();
      }
    }
  } finally {
    running = false;
  }
}

export function startAutoDisable() {
  if (config.autoSweepMs <= 0) return;
  const tick = () => sweep().catch((e) => console.error('[autodisable] sweep failed:', (e as Error).message));
  setInterval(tick, config.autoSweepMs).unref();
  setTimeout(tick, Math.min(15000, config.autoSweepMs)).unref();
}

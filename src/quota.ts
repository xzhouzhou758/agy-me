// Per-account Antigravity quota, read from Google through CPA's /requests/api-call (CPA injects the
// account's access token, so this server never touches tokens or auth files). Port of fetch_quota in
// ref/tools-ui-server.py:
//   loadCodeAssist            -> tier (paidTier / currentTier), project, GOOGLE_ONE_AI credits; 403 = forbidden
//   fetchAvailableModels      -> per-model quotaInfo { remainingFraction, resetTime }
//   retrieveUserQuotaSummary  -> groups[{displayName, buckets[{bucketId, window: 5h|weekly, remainingFraction, resetTime}]}]
// Results are cached in DATA_DIR/quota.json; a background pass refreshes everything with bounded
// concurrency, so pages never wait on Google.
import { config } from './config.ts';
import { JsonFile, settings } from './store.ts';
import * as cpa from './cpa.ts';

export type Tier = 'ULTRA' | 'PRO' | 'FREE';
export type Bucket = { frac: number; reset: string | null };
export type Fam = { h5: Bucket | null; week: Bucket | null };
export type ModelQ = { name: string; label: string; pct: number; reset: string | null };
/** 'on' = Argon usable on this account, 'off' = listed only as disabled, null = not offered. */
export type ArgonState = 'on' | 'off' | null;
export type Quota = {
  tier: Tier | null;
  credits: number | null;
  forbidden: string | null; // Google answered 403 (ToS ban, verification, ...): the reason text
  gemini: Fam | null;
  claude: Fam | null; // Claude and GPT models (third-party group)
  argon: Fam | null;
  argonState: ArgonState;
  /** Gemini 4 Carbon: no group of its own upstream, it shares the Gemini group's windows. */
  carbon?: Fam | null;
  carbonState?: ArgonState;
  models: ModelQ[];
};
export type Entry = { q: Quota | null; at: number; err: string | null };

// ---------------------------------------------------------------- parsing (pure)
export function normalizeTier(t: string | null | undefined): string {
  const lo = String(t || '').trim().toLowerCase();
  if (!lo) return '';
  if (lo.includes('ultra') || lo.includes('helium')) return 'ULTRA';
  if (lo.includes('free') || lo.includes('starter')) return 'FREE';
  if (lo.includes('pro') || lo.includes('premium') || lo.includes('advanced')) return 'PRO';
  if (lo.includes('enterprise') || lo.includes('standard') || lo.includes('business') || lo.startsWith('gcp_') || lo.includes('vertex')) return 'FREE'; // same abilities as FREE; the panel has no separate tier for them
  return String(t);
}

export function tierFromLCA(d: any): Tier {
  const tid = (t: any) => (t && typeof t === 'object' ? t.id || t.name : null);
  let raw = tid(d?.paidTier) || tid(d?.currentTier);
  if (!raw) {
    for (const t of Array.isArray(d?.allowedTiers) ? d.allowedTiers : []) {
      if (t?.id === 'free-tier' || t?.is_default || t?.isDefault) { raw = t.id || t.name; break; }
    }
  }
  const n = normalizeTier(raw || 'free-tier');
  return (['ULTRA', 'PRO', 'FREE'].includes(n) ? n : 'FREE') as Tier;
}

export function creditsFromLCA(d: any): number | null {
  let credits: number | null = null;
  for (const c of Array.isArray(d?.paidTier?.availableCredits) ? d.paidTier.availableCredits : []) {
    if (String(c?.creditType || '').toUpperCase() === 'GOOGLE_ONE_AI') credits = Number(c?.creditAmount ?? c?.amount ?? 0) || 0;
  }
  return credits;
}

export type SBucket = { id: string; window: string; name: string; frac: number; reset: string | null };
export type SGroup = { name: string; buckets: SBucket[] };

export function parseSummary(body: any): SGroup[] {
  const out: SGroup[] = [];
  for (const g of Array.isArray(body?.groups) ? body.groups : []) {
    const buckets: SBucket[] = [];
    for (const b of Array.isArray(g?.buckets) ? g.buckets : []) {
      const f = Number(b?.remainingFraction);
      if (b?.remainingFraction == null || !Number.isFinite(f)) continue;
      buckets.push({ id: String(b.bucketId || ''), window: String(b.window || ''), name: String(b.displayName || ''), frac: clamp01(f), reset: b.resetTime ? String(b.resetTime) : null });
    }
    out.push({ name: String(g?.displayName || ''), buckets });
  }
  return out;
}

export const isArgonGroup = (g: SGroup) => g.name.toLowerCase().includes('argon') || g.buckets.some((b) => b.id.toLowerCase().includes('argon') || b.name.toLowerCase().includes('argon'));
export const is3pGroup = (g: SGroup) => { const n = g.name.toLowerCase(); return n.includes('claude') || n.includes('gpt') || n.includes('3p'); };

const winOf = (b: SBucket, keys: string[]) => { const w = b.window.toLowerCase(), id = b.id.toLowerCase(); return keys.some((k) => w.includes(k) || id.includes(k)); };
export function famOf(g: SGroup): Fam {
  const h = g.buckets.find((b) => winOf(b, ['5h', 'hour']));
  const w = g.buckets.find((b) => winOf(b, ['week', '7d']));
  const pick = (b?: SBucket) => (b ? { frac: b.frac, reset: b.reset } : null);
  if (!h && !w && g.buckets[0]) return { h5: null, week: pick(g.buckets[0]) };
  return { h5: pick(h), week: pick(w) };
}

/** The bucket that limits a group right now (Tools' rule): an empty week wins, else the lower one. */
function limiting(f: Fam): Bucket | null {
  const { h5: h, week: w } = f;
  if (h && w) {
    if (w.frac <= 0.001) return w;
    if (h.frac < w.frac) return h;
    if (w.frac < h.frac) return w;
    return w.reset ? w : h;
  }
  return h || w;
}

const clamp01 = (f: number) => Math.max(0, Math.min(1, f));
const SIX_H = 6 * 3600e3;
/** A lone per-model quotaInfo: guess its window from how far away the reset is. */
function single(frac: number, reset: string | null, now: number): Fam {
  const b = { frac: clamp01(frac), reset };
  return reset && Date.parse(reset) - now <= SIX_H ? { h5: b, week: null } : { h5: null, week: b };
}

const SKIP = (n: string) => n.includes('-disabled') || n.endsWith('_disabled') || n.startsWith('chat_') || n.startsWith('tab_') || n.includes('internal');

/** Everything above, from the three upstream answers (lca / summary may be null when those calls failed). */
export function buildQuota(lca: any, fam: any, summary: any, now = Date.now()): Quota {
  const tier = lca ? tierFromLCA(lca) : null;
  const credits = lca ? creditsFromLCA(lca) : null;
  const isUltra = tier === 'ULTRA';
  const groups = summary ? parseSummary(summary) : null;
  const ag = groups?.find(isArgonGroup) || null;
  const gg = groups?.find((g) => !isArgonGroup(g) && !is3pGroup(g)) || null;
  const cg = groups?.find((g) => !isArgonGroup(g) && is3pGroup(g)) || null;

  // official ids (Tools keeps only models the client would list)
  const official = new Set<string>();
  for (const s of Array.isArray(fam?.agentModelSorts) ? fam.agentModelSorts : []) for (const g of s?.groups || []) for (const id of g?.modelIds || []) official.add(String(id).trim().toLowerCase());
  for (const id of Array.isArray(fam?.imageGenerationModelIds) ? fam.imageGenerationModelIds : []) official.add(String(id).trim().toLowerCase());
  for (const ids of Object.values<any>(fam?.tieredModelIds || {})) for (const id of ids || []) official.add(String(id).trim().toLowerCase());

  const raw = fam?.models && typeof fam.models === 'object' ? Object.entries<any>(fam.models) : [];
  let argonState: ArgonState = null;
  let carbonState: ArgonState = null;
  const models: ModelQ[] = [];
  const famFallback = { gemini: null as Bucket | null, claude: null as Bucket | null, argon: null as Bucket | null, carbon: null as Bucket | null };
  const lower = (cur: Bucket | null, b: Bucket) => (!cur || b.frac < cur.frac ? b : cur);
  for (const [name, info] of raw) {
    const nl = name.trim().toLowerCase();
    const argon = nl.includes('argon');
    const carbon = !argon && nl.includes('carbon');
    if (info?.disabled === true || SKIP(nl)) {
      if (argon && !argonState) argonState = 'off';
      if (carbon && !carbonState) carbonState = 'off';
      continue;
    }
    if (argon) argonState = 'on';
    if (carbon) carbonState = 'on';
    const qi = info?.quotaInfo;
    const mFrac = qi && qi.remainingFraction != null && Number.isFinite(Number(qi.remainingFraction)) ? clamp01(Number(qi.remainingFraction)) : qi ? 0 : null;
    const mReset = qi?.resetTime ? String(qi.resetTime) : null;
    const third = !argon && !carbon && (nl.startsWith('claude') || nl.startsWith('gpt'));
    if (mFrac != null) {
      const k = argon ? 'argon' : carbon ? 'carbon' : third ? 'claude' : nl.startsWith('gemini') ? 'gemini' : null;
      if (k) famFallback[k] = lower(famFallback[k], { frac: mFrac, reset: mReset });
    }
    if (official.size && !official.has(nl) && !argon && !carbon) continue;
    // a model's own fraction, capped by its group's limiting window
    const grp = argon ? ag || (isUltra ? gg : null) : third ? cg : gg;
    const gb = grp ? limiting(famOf(grp)) : null;
    let pct: number, reset: string | null;
    if (mFrac != null && gb) {
      if (mFrac <= 0) { pct = 0; reset = mReset || gb.reset; }
      else { const g = gb.frac; pct = Math.min(mFrac, g); reset = pct === g ? gb.reset || mReset : mReset || gb.reset; }
    } else if (mFrac != null) { pct = mFrac; reset = mReset; }
    else if (gb) { pct = gb.frac; reset = gb.reset; }
    else { pct = 1; reset = null; }
    models.push({ name, label: String(info?.displayName || name), pct: Math.round(pct * 100), reset });
  }
  if (!argonState && (ag || isUltra)) argonState = 'on';
  models.sort((a, b) => a.name.localeCompare(b.name));

  const fb = (b: Bucket | null) => (b ? single(b.frac, b.reset, now) : null);
  const carbonFam = carbonState === 'on' ? (gg ? famOf(gg) : fb(famFallback.carbon)) : null;
  const argonFam = argonState === 'on' ? (ag ? famOf(ag) : fb(famFallback.argon) || (isUltra && gg ? famOf(gg) : null)) : null;
  return {
    tier, credits, forbidden: null,
    gemini: gg ? famOf(gg) : groups ? null : fb(famFallback.gemini),
    claude: cg ? famOf(cg) : groups ? null : fb(famFallback.claude),
    argon: argonFam,
    argonState,
    carbon: carbonFam,
    carbonState,
    models,
  };
}

export function forbiddenQuota(reason: string, tier: Tier | null = null): Quota {
  return { tier, credits: null, forbidden: reason.slice(0, 500), gemini: null, claude: null, argon: null, argonState: null, carbon: null, carbonState: null, models: [] };
}

// ---------------------------------------------------------------- upstream calls
type GRes = { status: number; json: any; text: string };
/** POST to cloudcode-pa through CPA, trying daily -> sandbox -> prod (stops on 400/401/403). */
async function gpost(authIndex: string, method: string, body: unknown, signal?: AbortSignal): Promise<GRes> {
  const headers = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': config.quotaUserAgent };
  let last: GRes = { status: 0, json: null, text: 'no upstream' };
  for (const base of config.quotaBaseURLs) {
    signal?.throwIfAborted();
    try {
      const r = await cpa.apiCall(authIndex, 'POST', base + '/v1internal:' + method, headers, JSON.stringify(body), 30000, signal);
      let json: any = null;
      try { json = JSON.parse(r.body); } catch {}
      last = { status: r.status, json, text: r.body.slice(0, 2000) };
      if (r.status === 200 || [400, 401, 403].includes(r.status)) return last;
    } catch (e) {
      last = { status: 0, json: null, text: String((e as Error)?.message || e) };
    }
  }
  return last;
}

async function fetchQuota(id: string, signal?: AbortSignal, retried = false): Promise<Quota> {
  let cred = (await cpa.creds(5000)).byId.get(id);
  if (!cred) cred = (await cpa.creds(0)).byId.get(id); // added since the last list
  if (!cred) throw new Error('credential not found');
  const lca = await gpost(cred.authIndex, 'loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, signal);
  if (lca.status === 401 && !retried && (await cpa.refreshCredential(id, signal)).ok) return fetchQuota(id, signal, true);
  if (lca.status === 403) return forbiddenQuota(lca.text);
  const pid = (lca.status === 200 && lca.json?.cloudaicompanionProject) || cred.projectId;
  const payload = pid ? { project: pid } : {};
  const fam = await gpost(cred.authIndex, 'fetchAvailableModels', payload, signal);
  if (fam.status === 403) return forbiddenQuota(fam.text, lca.status === 200 ? tierFromLCA(lca.json) : null);
  if (fam.status !== 200 || !fam.json) throw new Error(`fetchAvailableModels ${fam.status}: ${fam.text.slice(0, 200)}`);
  const sum = await gpost(cred.authIndex, 'retrieveUserQuotaSummary', payload, signal);
  return buildQuota(lca.status === 200 ? lca.json : null, fam.json, sum.status === 200 ? sum.json : null);
}

// ---------------------------------------------------------------- cache + scheduler
const cache = new JsonFile<Record<string, Entry>>('quota.json', () => ({}));
export const entry = (id: string): Entry | null => cache.data[id] || null;
export const entries = (): Readonly<Record<string, Entry>> => cache.data;
export function forget(id: string) {
  delete cache.data[id];
  cache.save();
}

export const REFRESH_TIMEOUT_MS = 60000;
const inflight = new Map<string, Promise<Entry>>();

/** Refresh one account now; concurrent calls share one fetch. Never rejects: errors land in the entry.
 *  The timeout aborts the upstream calls, and the promise settles only once they have stopped, so a slot in
 *  the queue is never handed on while an old fetch still runs. */
export function refreshOne(id: string, timeoutMs = REFRESH_TIMEOUT_MS): Promise<Entry> {
  const cur = inflight.get(id);
  if (cur) return cur;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const p: Promise<Entry> = fetchQuota(id, ac.signal)
    .then((q) => ({ q, at: Date.now(), err: null }))
    .catch((e) => ({ q: cache.data[id]?.q || null, at: Date.now(), err: ac.signal.aborted ? 'timed out after ' + Math.round(timeoutMs / 1000) + 's' : String(e?.message || e).slice(0, 300) }))
    .then((en) => {
      cache.data[id] = en;
      cache.save(2000);
      return en;
    })
    .finally(() => {
      clearTimeout(timer);
      if (inflight.get(id) === p) inflight.delete(id);
    });
  inflight.set(id, p);
  return p;
}

// Queue for background / bulk refreshes: at most QUOTA_CONCURRENCY at once, each account once.
const queue: string[] = [];
const queued = new Set<string>();
let running = 0;
let job = { total: 0, done: 0, startedAt: 0 };

export function progress() {
  return { running: running > 0 || queue.length > 0, total: job.total, done: job.done, startedAt: job.startedAt };
}

const passDone: (() => void)[] = [];
/** Called whenever the refresh queue runs empty (a background pass or a single refresh finished). */
export function onPassDone(f: () => void) { passDone.push(f); }

const waiters = new Map<string, ((e: Entry) => void)[]>();
function pump() {
  while (running < config.quotaConcurrency && queue.length) {
    const id = queue.shift()!;
    running++;
    refreshOne(id).then((en) => {
      queued.delete(id);
      running--;
      job.done++;
      const w = waiters.get(id) || [];
      waiters.delete(id);
      pump();
      for (const f of w) f(en);
      if (!running && !queue.length) for (const f of passDone) f();
    });
  }
}

/** Queue accounts for a refresh (skips ones already waiting). Returns how many were added. */
export function enqueue(ids: string[]): number {
  if (!running && !queue.length) job = { total: 0, done: 0, startedAt: Date.now() };
  let n = 0;
  for (const id of ids) {
    if (queued.has(id)) continue;
    queued.add(id);
    queue.push(id);
    n++;
  }
  job.total += n;
  pump();
  return n;
}

/** One account now, through the same queue (goes first), so it counts against QUOTA_CONCURRENCY too. */
export function refreshNow(id: string): Promise<Entry> {
  return new Promise((resolve) => {
    if (!waiters.has(id)) waiters.set(id, []);
    waiters.get(id)!.push(resolve);
    if (!queued.has(id)) {
      if (!running && !queue.length) job = { total: 0, done: 0, startedAt: Date.now() };
      queued.add(id);
      job.total++;
    } else {
      const i = queue.indexOf(id);
      if (i < 0) return pump(); // already running
      queue.splice(i, 1);
    }
    queue.unshift(id);
    pump();
  });
}

/** Every enabled account, least recently refreshed first. */
export async function enqueueAll(): Promise<number> {
  const c = await cpa.creds(10000);
  const ids = c.list.filter((x) => !x.disabled && x.type === 'antigravity').map((x) => x.id);
  ids.sort((a, b) => (cache.data[a]?.at || 0) - (cache.data[b]?.at || 0));
  return enqueue(ids);
}

let timer: NodeJS.Timeout | null = null;
let gen = 0;
/** (Re)arm the background refresh from the current setting. */
export function startQuotaRefresher(firstDelayMs = Object.keys(cache.data).length ? 20000 : 2000) {
  if (timer) clearTimeout(timer);
  timer = null;
  const g = ++gen; // a tick still awaiting enqueueAll from before a re-arm must not schedule itself again
  const min = settings().quotaRefreshMinutes;
  if (min <= 0) return;
  const tick = async () => {
    try { await enqueueAll(); } catch (e) { console.error('[quota] background refresh:', (e as Error).message); }
    if (g !== gen || settings().quotaRefreshMinutes <= 0) return;
    timer = setTimeout(tick, settings().quotaRefreshMinutes * 60000);
    timer.unref();
  };
  timer = setTimeout(tick, firstDelayMs);
  timer.unref();
}

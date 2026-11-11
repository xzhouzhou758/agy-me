// 闲置自动休眠 (settings switch, off by default): an enabled antigravity account that served no request for
// AUTO_SLEEP_IDLE_SECONDS is turned off in CPA and marked in state.sleep. Any new request in CPA's usage queue
// (this app never proxies requests, the queue is the only sign of traffic) wakes every sleeping account again, and
// a woken account gets a fresh idle period. Only accounts this module put to sleep are ever woken; a manual
// on/off or a delete drops the mark, and accounts auto-disabled for a 403 are never put to sleep.
import { config } from './config.ts';
import { state, settings } from './store.ts';
import { usageSource, drainStatus } from './usage.ts';
import { autoMark, markEnabled } from './autodisable.ts';
import * as cpa from './cpa.ts';

const marks = () => (state.data.sleep ||= {});
/** When the account was put to sleep (ms); 0 = awake. */
export const sleepMark = (id: string): number => state.data.sleep?.[id] || 0;
export function dropMark(id: string) {
  if (state.data.sleep?.[id]) { delete state.data.sleep[id]; state.save(); }
}

const startedAt = Date.now();
const wokeAt = new Map<string, number>(); // woken accounts get a fresh idle period; so does a restart
let waking = false;

export async function sweep(): Promise<void> {
  if (!settings().autoSleep) return;
  const src = usageSource();
  if (!src.available() || drainStatus()) return; // without a request log everything would look idle
  const c = await cpa.creds(5000);
  const M = marks();
  for (const id of Object.keys(M)) if (!c.byId.get(id)?.disabled) delete M[id]; // gone, or turned on elsewhere
  const cut = Date.now() - config.autoSleepIdleMs;
  const lastUsed = src.lastUsed();
  for (const cred of c.list) {
    const id = cred.id;
    if (cred.type !== 'antigravity' || cred.disabled || M[id] || autoMark(id)) continue;
    const last = Math.max(lastUsed.get(id) || 0, Date.parse(cred.createdAt) || 0, wokeAt.get(id) || 0, startedAt);
    if (last > cut) continue;
    try {
      await cpa.setDisabled(id, true);
      M[id] = Date.now();
      markEnabled(id, true);
      state.save(0);
      console.log('[autosleep] sleep', id);
    } catch (e) {
      console.error('[autosleep] sleep failed', id, (e as Error).message);
    }
  }
}

/** Wake every sleeping account. Returns how many were woken. */
export async function wakeAll(): Promise<number> {
  if (waking) return 0;
  waking = true;
  let n = 0;
  try {
    for (const id of Object.keys(marks())) {
      try {
        await cpa.setDisabled(id, false);
        delete marks()[id];
        wokeAt.set(id, Date.now());
        markEnabled(id, false);
        n++;
      } catch (e) {
        console.error('[autosleep] wake failed', id, (e as Error).message);
      }
    }
    if (n) { state.save(0); console.log('[autosleep] woke', n); }
  } finally {
    waking = false;
  }
  return n;
}

/** The usage drainer stored `n` new request records: somebody is using CPA, so wake the sleepers. */
export function onTraffic(n: number) {
  if (n > 0 && Object.keys(state.data.sleep || {}).length) void wakeAll();
}

export function startAutoSleep() {
  if (config.autoSleepSweepMs <= 0) return;
  const tick = () => sweep().catch((e) => console.error('[autosleep] sweep failed:', (e as Error).message));
  setInterval(tick, config.autoSleepSweepMs).unref();
  setTimeout(tick, Math.min(30000, config.autoSleepSweepMs)).unref();
}

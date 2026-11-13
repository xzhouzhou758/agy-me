// 按额度自动排除模型 (settings switch, on by default): from the cached quota, each antigravity credential gets
// CPA's per-credential excluded_models set so CPA's account picking skips accounts that don't have a model
// (argonState / carbonState 'off') or whose group is used up (h5 or week at 0 with the reset still ahead).
// The exclusion is lifted as soon as the reset time passes (checked every minute), not at the next quota pass.
// CPA facts (v8.0.66, checked on the live instance):
//   - PATCH /credentials/fields {name, excluded_models: string[] | null} writes the list into the auth JSON
//     file (survives a restart; the file watcher re-registers just that credential), GET /credentials doesn't
//     show it, /credentials/download does.
//   - Entries match upstream model names, exact or with a leading / trailing '*'. model-alias names (the
//     -low / -medium / plain forks of xxx-high) follow their upstream model; excluding an alias name does nothing.
//   - An excluded model is dropped from the credential's model list and from account picking.
// Unknown quota (none yet, read failed, 403) excludes nothing. Safety valve: a group that would end up excluded
// on every enabled account is excluded nowhere, so CPA still tries instead of answering "no credential".
// Only entries this module added are ever removed (DATA_DIR/autoexclude.json); the user's own entries stay.
import { JsonFile, settings } from './store.ts';
import * as cpa from './cpa.ts';
import * as quota from './quota.ts';

export const GROUPS = ['gemini', 'claude', 'argon', 'carbon'] as const;
export type Group = typeof GROUPS[number];

const isEmpty = (b: quota.Bucket | null | undefined, now: number) => !!b && b.frac <= 0 && !!b.reset && Date.parse(b.reset) > now;

/** Groups this account can't serve right now; [] when the quota is unknown. */
export function blockedGroups(e: quota.Entry | null | undefined, now = Date.now()): Group[] {
  const q = e?.q;
  if (!q || e!.err || q.forbidden) return [];
  return GROUPS.filter((g) => {
    const st = g === 'argon' ? q.argonState : g === 'carbon' ? q.carbonState : null;
    const f = q[g];
    return st === 'off' || (!!f && (isEmpty(f.h5, now) || isEmpty(f.week, now)));
  });
}

/** CPA excluded_models entries (upstream names) for one group. Gemini has no clean wildcard (argon / carbon are gemini-* too), so it lists the account's own models. */
export function patternsFor(g: Group, q: quota.Quota): string[] {
  if (g === 'argon') return ['*argon*'];
  if (g === 'carbon') return ['*carbon*'];
  if (g === 'claude') return ['claude*', 'gpt*'];
  return q.models.map((m) => m.name).filter((n) => /^gemini/i.test(n) && !/argon|carbon/i.test(n));
}

export type Acct = { id: string; enabled: boolean; entry: quota.Entry | null };
/** id -> sorted entries this module wants on the credential (accounts that need none are left out). */
export function plan(accts: Acct[], now = Date.now()): Record<string, string[]> {
  const blocked = new Map(accts.map((a) => [a.id, blockedGroups(a.entry, now)]));
  const on = accts.filter((a) => a.enabled);
  const valve = new Set(GROUPS.filter((g) => on.every((a) => blocked.get(a.id)!.includes(g))));
  const out: Record<string, string[]> = {};
  for (const a of accts) {
    const q = a.entry?.q;
    const gs = blocked.get(a.id)!.filter((g) => !valve.has(g));
    if (!q || !gs.length) continue;
    const p = [...new Set(gs.flatMap((g) => patternsFor(g, q)))].sort();
    if (p.length) out[a.id] = p;
  }
  return out;
}

// want: the last list this module computed; own: the entries it actually added (ones the user had already stay theirs)
type Rec = { want: string[]; own: string[] };
const rec = new JsonFile<{ managed: Record<string, Rec> }>('autoexclude.json', () => ({ managed: {} }));
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

let busy = false;
/** Bring every credential's panel-managed entries in line with the plan; CPA is only called for ones that changed. */
export async function sync(now = Date.now()): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const c = await cpa.creds(30000);
    const accts = c.list.filter((x) => x.type === 'antigravity');
    const want = settings().autoExclude ? plan(accts.map((x) => ({ id: x.id, enabled: !x.disabled, entry: quota.entry(x.id) })), now) : {};
    const M = rec.data.managed;
    for (const id of Object.keys(M)) if (!c.byId.has(id)) { delete M[id]; rec.save(); }
    for (const { id } of accts) {
      const old = M[id] || { want: [], own: [] };
      const next = want[id] || [];
      if (same(old.want, next)) continue;
      try {
        const cur = await cpa.excludedModels(id);
        const user = cur.filter((p) => !old.own.includes(p));
        const own = next.filter((p) => !user.includes(p));
        const list = [...user, ...own];
        await cpa.setExcludedModels(id, list.length ? list : null);
        if (next.length) M[id] = { want: next, own }; else delete M[id];
        rec.save();
        const add = own.filter((p) => !old.own.includes(p)), del = old.own.filter((p) => !own.includes(p));
        console.log('[autoexclude]', id, add.length ? '+' + add.join(',') : '', del.length ? '-' + del.join(',') : '');
      } catch (e) {
        console.error('[autoexclude] failed', id, (e as Error).message);
      }
    }
  } finally {
    busy = false;
  }
}

export function startAutoExclude() {
  const tick = () => sync().catch((e) => console.error('[autoexclude] sync failed:', (e as Error).message));
  quota.onPassDone(tick);
  setInterval(tick, 60000).unref();
  setTimeout(tick, 30000).unref();
}

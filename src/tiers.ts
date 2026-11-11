// Model tier names (read-only): upstream exposes <model>-low / -medium / -high; CPA's oauth model-alias config
// adds the client-facing names (<model>, <model>-low, ...). Shows each model family's four names side by side
// and the families in CPA's model list that have no alias configured yet.
import * as cpa from './cpa.ts';

export const TIERS = ['', 'low', 'medium', 'high'] as const;
export type TierName = { name: string; level: typeof TIERS[number]; listed: boolean; target: string | null };
export type TierFamily = { family: string; names: TierName[] };
export type TierTable = { families: TierFamily[]; untiered: { family: string; models: string[] }[] };

export const familyOf = (id: string) => id.replace(/-(low|medium|high)$/i, '');

/** aliases: [{name (upstream), alias (client name)}]; models: ids CPA lists for the accounts. */
export function tierTable(aliases: { name: string; alias: string }[], models: string[]): TierTable {
  const listed = new Set(models);
  const target = new Map<string, string>();
  for (const a of aliases) if (a.alias) target.set(a.alias, a.name);
  const aliased = new Set<string>();
  for (const a of aliases) { aliased.add(familyOf(a.alias)); aliased.add(familyOf(a.name)); }
  const families: TierFamily[] = [...aliased].filter(Boolean).sort().map((family) => ({
    family,
    names: TIERS.map((level) => {
      const name = level ? `${family}-${level}` : family;
      return { name, level, listed: listed.has(name) || target.has(name), target: target.get(name) || null };
    }),
  }));
  const rest = new Map<string, string[]>();
  for (const m of [...listed].sort()) {
    const f = familyOf(m);
    if (aliased.has(f)) continue;
    rest.set(f, [...(rest.get(f) || []), m]);
  }
  return { families, untiered: [...rest].map(([family, ms]) => ({ family, models: ms })) };
}

let modelCache: { at: number; ids: string[] } | null = null;
/** Union of the models CPA lists for enabled accounts (cached 30 min, up to 4 calls at once). */
async function cpaModels(): Promise<string[]> {
  if (modelCache && Date.now() - modelCache.at < 30 * 60000) return modelCache.ids;
  const c = await cpa.creds(10000);
  const ids = c.list.filter((x) => !x.disabled && x.type === 'antigravity').map((x) => x.id);
  const all = new Set<string>();
  for (let i = 0; i < ids.length; i += 4) {
    const r = await Promise.allSettled(ids.slice(i, i + 4).map((id) => cpa.credentialModels(id)));
    for (const x of r) if (x.status === 'fulfilled') for (const m of x.value) if (m?.id) all.add(String(m.id));
  }
  modelCache = { at: Date.now(), ids: [...all] };
  return modelCache.ids;
}

export async function tiers(): Promise<TierTable> {
  const [cfg, models] = await Promise.all([cpa.getConfig('oauth/model-alias'), cpaModels()]);
  const list = Array.isArray(cfg?.antigravity) ? cfg.antigravity : [];
  return tierTable(list.map((x: any) => ({ name: String(x?.name || ''), alias: String(x?.alias || '') })), models);
}

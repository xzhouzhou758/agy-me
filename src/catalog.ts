// CPA model catalog: CPA only registers models its catalog lists, and the official catalog
// (models.router-for.me) has just the -high forks of most antigravity models. CPA's config.yaml points
// models.catalog at a file in its catalog dir, and this module keeps that file = the official catalog as is
// + the antigravity models at least one enabled account really offers (from the cached quota) that the
// official one lacks. A new entry is a copy of an official one of the same family (same id without
// -low / -medium / -high / -xhigh) with id / name / display_name / description changed; no family = a bare entry.
// CPA facts (v8.0.66): it rereads the catalog every 3 hours and when the file changes, keeps the last good one
// when a read fails, and a custom catalog never falls back to the official one.
// Official catalog: fetched every 3 hours, cached in DATA_DIR/models-official.json; nothing cached and nothing
// fetched = nothing written (an antigravity-only file would drop every other provider from CPA).
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.ts';
import * as cpa from './cpa.ts';
import * as quota from './quota.ts';

type Model = Record<string, any> & { id: string };
type Catalog = Record<string, Model[]>;

const SKIP = (n: string) => /^chat_|^tab_|-disabled$|^gemini-2\.5-/.test(n);
const family = (id: string) => id.toLowerCase().replace(/-(minimal|low|medium|high|xhigh)$/, '');

/** Official catalog + the given antigravity models it lacks (name -> label). Official entries are never changed. */
export function build(official: Catalog, have: Map<string, string>): Catalog {
  const ag = official.antigravity || [];
  const ids = new Set(ag.map((m) => m.id.toLowerCase()));
  const extra: Model[] = [];
  for (const [id, label] of [...have].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (ids.has(id.toLowerCase()) || SKIP(id.toLowerCase())) continue;
    const t = ag.find((m) => family(m.id) === family(id));
    const base: Model = t ? structuredClone(t) : { id, object: 'model', owned_by: 'antigravity', type: 'antigravity' };
    extra.push({ ...base, id, name: id, display_name: label, description: label });
  }
  return { ...official, antigravity: [...ag, ...extra] };
}

/** Model name -> label, over enabled accounts whose quota is known and not 403. */
export function offered(accts: { enabled: boolean; entry: quota.Entry | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of accts) {
    const q = a.entry?.q;
    if (!a.enabled || !q || q.forbidden) continue;
    for (const m of q.models) if (!out.has(m.name)) out.set(m.name, m.label);
  }
  return out;
}

const valid = (d: any): d is Catalog => !!d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.antigravity) && d.antigravity.every((m: any) => typeof m?.id === 'string');

// ---------------------------------------------------------------- official catalog (cached)
const CACHE = join(config.dataDir, 'models-official.json');
const EVERY = 3 * 3600e3;
let official: Catalog | null = null;
let fetchedAt = 0;
try {
  const d = JSON.parse(readFileSync(CACHE, 'utf8'));
  if (valid(d)) { official = d; fetchedAt = statSync(CACHE).mtimeMs; }
} catch {}

async function fetchOfficial(): Promise<void> {
  for (const url of config.catalogURLs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (!valid(d)) throw new Error('not a model catalog');
      official = d;
      fetchedAt = Date.now();
      writeFileSync(CACHE + '.tmp', JSON.stringify(d), { mode: 0o600 });
      renameSync(CACHE + '.tmp', CACHE);
      return;
    } catch (e) {
      console.error('[catalog] official catalog', url, (e as Error).message);
    }
  }
  fetchedAt = Date.now() - EVERY + 600e3; // all failed: keep using the cache, try again in 10 minutes
}

// ---------------------------------------------------------------- CPA's catalog file
let added: string[] | null = null; // antigravity ids this module added last time (null = not read yet)
let busy = false;
let warned = false;

/** Rewrite CPA's catalog file if its content would change. */
export async function sync(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (Date.now() - fetchedAt >= EVERY) await fetchOfficial();
    if (!official) return;
    const path = config.catalogPath;
    if (!existsSync(dirname(path))) {
      if (!warned) console.error('[catalog] no directory for', path, '- not written');
      warned = true;
      return;
    }
    const c = await cpa.creds(30000);
    const accts = c.list.filter((x) => x.type === 'antigravity').map((x) => ({ enabled: !x.disabled, entry: quota.entry(x.id) }));
    let cur = '';
    try { cur = readFileSync(path, 'utf8'); } catch {}
    const ogIds = new Set(official.antigravity.map((m) => m.id));
    // models already in the file stay (only ever added): a quota gap must not make CPA drop a model
    const kept = new Map<string, string>();
    try { for (const m of JSON.parse(cur).antigravity || []) if (!ogIds.has(m.id)) kept.set(m.id, m.display_name || m.id); } catch {}
    if (added === null) added = [...kept.keys()];
    const have = offered(accts);
    for (const [id, label] of kept) if (!have.has(id)) have.set(id, label);
    const next = build(official, have);
    const text = JSON.stringify(next, null, 2) + '\n';
    if (text === cur) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + '.tmp', text, { mode: 0o644 });
    renameSync(path + '.tmp', path);
    const now = next.antigravity.map((m) => m.id).filter((id) => !ogIds.has(id));
    const add = now.filter((id) => !added!.includes(id)), del = added!.filter((id) => !now.includes(id));
    added = now;
    console.log('[catalog] written', add.length ? '+' + add.join(',') : '', del.length ? '-' + del.join(',') : '');
  } finally {
    busy = false;
  }
}

export function startCatalog() {
  const tick = () => sync().catch((e) => console.error('[catalog] sync failed:', (e as Error).message));
  quota.onPassDone(tick);
  setInterval(tick, EVERY).unref();
  setTimeout(tick, 30000).unref();
}

// Request log + token usage. This app is the single reader of CPA's usage queue (GET /observability/usage/queue:
// popping deletes, records expire after redis-usage-queue-retention-seconds) and keeps one row per upstream
// attempt in its own sqlite, DATA_DIR/usage.sqlite, pruned after USAGE_RETENTION_DAYS.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { maskSecrets } from './util.ts';
import * as cpa from './cpa.ts';
import type { Ban } from './accounts.ts';

export type Req = {
  id: number;
  ts: number;
  account: string;     // email (snapshot at request time)
  authId: string;      // CPA auth file name
  model: string;       // what the client asked for
  upstream: string;    // what CPA sent upstream, when different
  status: number;
  failed: boolean;
  ttft: number | null; // ms to first byte; null when unknown
  latency: number | null;
  stream: boolean;
  in: number; out: number; cache: number; think: number; total: number;
  error: string;       // short failure summary
};
export type ReqDetail = Req & { path: string; requestId: string; effort: string; userAgent: string; session: string; failBody: string };
export type LogQuery = { q?: string; account?: string; model?: string; status?: 'ok' | 'err' | string; from?: number; to?: number; page?: number; size?: number };
export type LogPage = { rows: Req[]; total: number; ok: number; err: number; page: number; size: number };
export type UsageRow = { name: string; req: number; ok: number; in: number; out: number; cache: number; think: number; tok: number; ttft: number | null };
export type Usage = {
  range: string; step: number; from: number;
  totals: UsageRow & { accounts: number; models: number };
  models: UsageRow[];
  accounts: UsageRow[];
  series: string[];                                      // top models + '其他'
  trend: { t: number; req: number; by: Record<string, number> }[];
};

export interface UsageSource {
  readonly kind: string;
  available(): boolean;
  recent(limit: number): Req[];
  logs(q: LogQuery): LogPage;
  log(id: number): ReqDetail | null;
  facets(): { accounts: string[]; models: string[] };
  usage(range: string, tzOffsetMin: number, now?: number): Usage;
  /** auth file -> last request time (ms) */
  lastUsed(): Map<string, number>;
  /** auth file -> its latest request in the window, when that was a 403 */
  bans(sinceMs: number): Map<string, Ban>;
  /** auth file -> every request since sinceMs: model actually used, time, total tokens */
  tokenEvents(sinceMs: number): Map<string, TokEvent[]>;
}
export type TokEvent = { model: string; ts: number; tok: number };

const RANGES: Record<string, { span: number; step: number }> = {
  '24h': { span: 864e5, step: 36e5 },
  '7d': { span: 7 * 864e5, step: 864e5 },
  '30d': { span: 30 * 864e5, step: 864e5 },
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, timestamp_ms INTEGER NOT NULL, request_id TEXT NOT NULL DEFAULT '',
  auth_file TEXT NOT NULL DEFAULT '', account TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT NOT NULL DEFAULT '',
  failed INTEGER NOT NULL, status INTEGER NOT NULL, fail_summary TEXT NOT NULL DEFAULT '', fail_body TEXT NOT NULL DEFAULT '',
  ttft_ms INTEGER, latency_ms INTEGER, stream INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
  effort TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '', session TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_ts ON events(timestamp_ms);
CREATE INDEX IF NOT EXISTS events_auth_ts ON events(auth_file, timestamp_ms);`;

const MODEL = 'model';
const ACCOUNT = 'account';
const COLS = `id, timestamp_ms, account, auth_file, model AS m, upstream AS up, failed, status, ttft_ms, latency_ms, stream,
  input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, fail_summary`;

function short(s: string | null | undefined): string {
  const t = String(s || '');
  const i = t.search(/[[{]/);
  for (const part of i < 0 ? [] : [t.slice(i), t.slice(i, Math.max(t.lastIndexOf('}'), t.lastIndexOf(']')) + 1)]) {
    try {
      const j = JSON.parse(part);
      const e = Array.isArray(j) ? j[0]?.error : j?.error;
      if (e?.message) return String(e.message).replace(/\s+/g, ' ').slice(0, 300);
    } catch {}
  }
  return t.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function mapReq(r: any): Req {
  const failed = !!r.failed;
  const status = Number(r.status);
  const ttft = r.ttft_ms == null || Number(r.ttft_ms) <= 0 ? null : Number(r.ttft_ms);
  return {
    id: Number(r.id), ts: Number(r.timestamp_ms), account: String(r.account), authId: String(r.auth_file || ''),
    model: String(r.m || ''), upstream: r.up && r.up !== r.m ? String(r.up) : '',
    status, failed, ttft, latency: r.latency_ms == null ? null : Number(r.latency_ms), stream: !!r.stream,
    in: Number(r.input_tokens) || 0, out: Number(r.output_tokens) || 0, cache: Number(r.cached_tokens) || 0,
    think: Number(r.reasoning_tokens) || 0, total: Number(r.total_tokens) || 0,
    error: failed ? r.fail_summary || 'HTTP ' + status : '',
  };
}

/** One CPA usage-queue record (internal/redisqueue/plugin.go in CPA v8) -> a row. The account comes from the
 *  credential list by auth_index at drain time, so the log keeps the email even after the credential is gone. */
export function toRow(rec: any, who: (authIndex: string) => { id: string; email: string } | null) {
  const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.round(x) : 0; };
  const t = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const tok = rec?.tokens || {};
  const failed = !!rec?.failed;
  let status = n(rec?.fail?.status_code) || (failed ? 500 : 200);
  if (failed && status < 400) status = 500;
  const body = failed ? String(rec?.fail?.body || '') : '';
  const w = who(String(rec?.auth_index || ''));
  const up = t(rec?.model, 160);
  const ts = Date.parse(String(rec?.timestamp || ''));
  return {
    ts: Number.isFinite(ts) ? ts : Date.now(),
    requestId: t(rec?.request_id, 80), authFile: w?.id || '', account: w?.email || w?.id || 'unknown',
    model: t(rec?.alias, 160) || up || 'unknown', upstream: t(rec?.response_model, 160) || up,
    failed: failed ? 1 : 0, status,
    summary: failed ? maskSecrets(short(body) || t(rec?.fail?.code, 120)) : '',
    body: failed ? maskSecrets(body).slice(0, 8000) : '',
    ttft: n(rec?.ttft_ms) || null, latency: n(rec?.latency_ms) || null, stream: rec?.stream ? 1 : 0,
    in: n(tok.input_tokens), out: n(tok.output_tokens), cache: n(tok.cache_read_tokens) || n(tok.cached_tokens),
    think: n(tok.reasoning_tokens), total: n(tok.total_tokens),
    effort: t(rec?.reasoning_effort, 20), path: t(rec?.endpoint, 200), ua: t(rec?.user_agent, 300), session: t(rec?.session_id, 120),
  };
}

export class QueueStore implements UsageSource {
  readonly kind = 'queue';
  private db: DatabaseSync | null = null;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const d = new DatabaseSync(path);
      d.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL;' + SCHEMA);
      this.db = d;
    } catch (e) {
      console.error('[usage] cannot open', path + ':', (e as Error).message);
    }
  }
  private q<T>(fn: (d: DatabaseSync) => T, fallback: T): T {
    if (!this.db) return fallback;
    try { return fn(this.db); } catch (e) {
      console.error('[usage] query failed:', (e as Error).message);
      return fallback;
    }
  }

  available() { return !!this.db; }

  /** Store popped queue records (one transaction). Returns how many were written. */
  ingest(recs: any[], who: (authIndex: string) => { id: string; email: string } | null): number {
    const d = this.db;
    if (!d || !recs.length) return 0;
    const ins = d.prepare(`INSERT INTO events (timestamp_ms, request_id, auth_file, account, model, upstream, failed, status, fail_summary, fail_body,
      ttft_ms, latency_ms, stream, input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, effort, path, user_agent, session)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let n = 0;
    d.exec('BEGIN');
    try {
      for (const rec of recs) {
        if (!rec || typeof rec !== 'object') continue;
        n++;
        const r = toRow(rec, who);
        ins.run(r.ts, r.requestId, r.authFile, r.account, r.model, r.upstream, r.failed, r.status, r.summary, r.body,
          r.ttft, r.latency, r.stream, r.in, r.out, r.cache, r.think, r.total, r.effort, r.path, r.ua, r.session);
      }
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
    return n;
  }

  /** Drop rows older than `days`. */
  prune(days: number, now = Date.now()) {
    return this.q((d) => Number(d.prepare('DELETE FROM events WHERE timestamp_ms < ?').run(now - days * 864e5).changes), 0);
  }

  close() { try { this.db?.close(); } catch {} this.db = null; }

  recent(limit: number): Req[] {
    return this.q((d) => (d.prepare(`SELECT ${COLS} FROM events ORDER BY timestamp_ms DESC, id DESC LIMIT ?`).all(limit) as any[]).map(mapReq).reverse(), []);
  }

  private where(f: LogQuery): [string, any[]] {
    const w: string[] = [], p: any[] = [];
    if (f.from) { w.push('timestamp_ms >= ?'); p.push(f.from); }
    if (f.to) { w.push('timestamp_ms < ?'); p.push(f.to); }
    if (f.account) { w.push(`(auth_file = ? OR ${ACCOUNT} = ?)`); p.push(f.account, f.account); }
    if (f.model) { w.push(`${MODEL} = ?`); p.push(f.model); }
    if (f.status === 'ok') w.push('failed = 0');
    else if (f.status === 'err') w.push('failed = 1');
    else if (f.status && /^\d{3}$/.test(f.status)) { w.push('status = ?'); p.push(Number(f.status)); }
    for (const term of String(f.q || '').split(/\s+/).filter(Boolean).slice(0, 5)) {
      const like = '%' + term.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
      w.push(`(${MODEL} LIKE ? ESCAPE '\\' OR upstream LIKE ? ESCAPE '\\' OR ${ACCOUNT} LIKE ? ESCAPE '\\' OR fail_summary LIKE ? ESCAPE '\\' OR CAST(status AS TEXT) = ?)`);
      p.push(like, like, like, like, term);
    }
    return [w.length ? ' WHERE ' + w.join(' AND ') : '', p];
  }

  logs(f: LogQuery): LogPage {
    const size = Math.max(10, Math.min(200, Math.round(f.size || 50)));
    const page = Math.max(1, Math.round(f.page || 1));
    const empty = { rows: [], total: 0, ok: 0, err: 0, page, size };
    return this.q((d) => {
      const [w, p] = this.where(f);
      const c = d.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(failed),0) AS e FROM events${w}`).get(...p) as any;
      const rows = (d.prepare(`SELECT ${COLS} FROM events${w} ORDER BY timestamp_ms DESC, id DESC LIMIT ? OFFSET ?`).all(...p, size, (page - 1) * size) as any[]).map(mapReq);
      return { rows, total: Number(c.n), ok: Number(c.n) - Number(c.e), err: Number(c.e), page, size };
    }, empty);
  }

  log(id: number): ReqDetail | null {
    return this.q((d) => {
      const r = d.prepare(`SELECT ${COLS}, path, request_id AS rid, effort, user_agent AS ua, session AS sess, fail_body AS fb FROM events WHERE id = ?`).get(id) as any;
      if (!r) return null;
      return { ...mapReq(r), path: r.path, requestId: r.rid, effort: r.effort, userAgent: r.ua, session: r.sess, failBody: String(r.fb) };
    }, null);
  }

  facets() {
    return this.q((d) => {
      const since = Date.now() - 30 * 864e5;
      const col = (sql: string) => (d.prepare(sql).all(since) as any[]).map((r) => String(r.k)).filter(Boolean);
      return {
        accounts: col(`SELECT DISTINCT ${ACCOUNT} AS k FROM events WHERE timestamp_ms >= ? ORDER BY k`),
        models: col(`SELECT DISTINCT ${MODEL} AS k FROM events WHERE timestamp_ms >= ? ORDER BY k`),
      };
    }, { accounts: [], models: [] });
  }

  usage(range: string, tzOffsetMin: number, now = Date.now()): Usage {
    const R = RANGES[range] || RANGES['7d'];
    const tz = Math.max(-840, Math.min(840, Math.round(tzOffsetMin || 0))) * 60000;
    // bucket edges at local midnight / full hours
    const end = Math.floor((now + tz) / R.step) * R.step + R.step - tz;
    const from = end - Math.ceil(R.span / R.step) * R.step;
    const AGG = `COUNT(*) AS req, SUM(failed = 0) AS ok, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
      COALESCE(SUM(cached_tokens),0) AS c, COALESCE(SUM(reasoning_tokens),0) AS r, COALESCE(SUM(total_tokens),0) AS t,
      AVG(CASE WHEN failed = 0 AND ttft_ms > 0 THEN ttft_ms END) AS ttft`;
    const row = (name: string, r: any): UsageRow => ({ name, req: Number(r.req) || 0, ok: Number(r.ok) || 0, in: Number(r.i) || 0, out: Number(r.o) || 0, cache: Number(r.c) || 0, think: Number(r.r) || 0, tok: Number(r.t) || 0, ttft: r.ttft == null ? null : Math.round(Number(r.ttft)) });
    const blank: Usage = { range, step: R.step, from, totals: { ...row('', {}), accounts: 0, models: 0 }, models: [], accounts: [], series: [], trend: [] };
    return this.q((d) => {
      const t = d.prepare(`SELECT ${AGG}, COUNT(DISTINCT ${ACCOUNT}) AS na, COUNT(DISTINCT ${MODEL}) AS nm FROM events WHERE timestamp_ms >= ?`).get(from) as any;
      const models = (d.prepare(`SELECT ${MODEL} AS k, ${AGG} FROM events WHERE timestamp_ms >= ? GROUP BY k ORDER BY t DESC, req DESC`).all(from) as any[]).map((r) => row(String(r.k), r));
      const accounts = (d.prepare(`SELECT ${ACCOUNT} AS k, ${AGG} FROM events WHERE timestamp_ms >= ? GROUP BY k ORDER BY t DESC, req DESC`).all(from) as any[]).map((r) => row(String(r.k), r));
      const top = models.slice(0, 5).map((m) => m.name);
      const series = models.length > 5 ? [...top, '其他'] : top;
      const buckets = new Map<number, { t: number; req: number; by: Record<string, number> }>();
      for (let x = from; x < end; x += R.step) buckets.set(x, { t: x, req: 0, by: {} });
      const tr = d.prepare(`SELECT CAST((timestamp_ms + ?) / ? AS INTEGER) * ? - ? AS b, ${MODEL} AS k, COUNT(*) AS n, COALESCE(SUM(total_tokens),0) AS t
        FROM events WHERE timestamp_ms >= ? GROUP BY b, k`).all(tz, R.step, R.step, tz, from) as any[];
      for (const r of tr) {
        const b = buckets.get(Number(r.b));
        if (!b) continue;
        const k = top.includes(String(r.k)) ? String(r.k) : '其他';
        b.req += Number(r.n);
        b.by[k] = (b.by[k] || 0) + Number(r.t);
      }
      return { range, step: R.step, from, totals: { ...row('', t), accounts: Number(t.na) || 0, models: Number(t.nm) || 0 }, models, accounts, series, trend: [...buckets.values()] };
    }, blank);
  }

  lastUsed(): Map<string, number> {
    return this.q((d) => new Map((d.prepare(`SELECT auth_file AS k, MAX(timestamp_ms) AS t FROM events WHERE auth_file <> '' GROUP BY k`).all() as any[]).map((r) => [String(r.k), Number(r.t)])), new Map());
  }

  tokenEvents(sinceMs: number): Map<string, TokEvent[]> {
    return this.q((d) => {
      const out = new Map<string, TokEvent[]>();
      for (const r of d.prepare(`SELECT auth_file AS k, COALESCE(NULLIF(upstream, ''), model) AS m, timestamp_ms AS ts, total_tokens AS t
        FROM events WHERE timestamp_ms >= ? AND auth_file <> '' AND total_tokens > 0`).all(sinceMs) as any[]) {
        const k = String(r.k);
        if (!out.has(k)) out.set(k, []);
        out.get(k)!.push({ model: String(r.m), ts: Number(r.ts), tok: Number(r.t) || 0 });
      }
      return out;
    }, new Map());
  }

  bans(sinceMs: number): Map<string, Ban> {
    return this.q((d) => {
      // latest by request time (rows can land out of order), id breaks ties
      const rows = d.prepare(`SELECT k, ts, msg FROM (SELECT auth_file AS k, timestamp_ms AS ts, failed, status AS st, fail_body AS msg,
          ROW_NUMBER() OVER (PARTITION BY auth_file ORDER BY timestamp_ms DESC, id DESC) AS rn
        FROM events WHERE timestamp_ms >= ? AND auth_file <> '') WHERE rn = 1 AND failed = 1 AND st = 403`).all(sinceMs) as any[];
      return new Map(rows.map((r) => [String(r.k), { ts: Number(r.ts), status: 403, message: String(r.msg || '').slice(0, 4000) }]));
    }, new Map());
  }
}

// ---------------------------------------------------------------- drainer
let draining = false;
let drainError = '';
/** Last drain problem ('' = fine), for the settings page. */
export const drainStatus = () => drainError;

/** Pop everything waiting in CPA's queue (500 at a time) into the store. */
export async function drainOnce(store: QueueStore): Promise<number> {
  if (draining) return 0;
  draining = true;
  let n = 0;
  try {
    let c = await cpa.creds(60000);
    let fresh = false;
    for (let round = 0; round < 20; round++) {
      const recs = await cpa.popUsage(500);
      // a record from a credential added since the last list: re-read the list once
      if (!fresh && recs.some((r) => r?.auth_index && !c.byIndex.has(String(r.auth_index)))) { c = await cpa.creds(0); fresh = true; }
      n += store.ingest(recs, (ix) => {
        const id = c.byIndex.get(ix);
        const cr = id ? c.byId.get(id) : null;
        return cr ? { id: cr.id, email: cr.email || cr.id } : null;
      });
      if (recs.length < 500) break;
    }
    if (drainError) console.log('[usage] draining again');
    drainError = '';
  } catch (e) {
    const msg = (e as Error).message;
    if (msg !== drainError) console.error('[usage] drain failed:', msg); // once per distinct problem
    drainError = msg;
  } finally {
    draining = false;
  }
  return n;
}

export function startUsageDrainer(store: QueueStore, pollMs: number, retentionDays: number) {
  void drainOnce(store);
  setInterval(() => void drainOnce(store), pollMs).unref();
  store.prune(retentionDays);
  setInterval(() => store.prune(retentionDays), 3600000).unref();
}

let source: UsageSource | null = null;
export function usageSource(): UsageSource {
  if (!source) throw new Error('usage source not initialised');
  return source;
}
export function setUsageSource(s: UsageSource) { source = s; }

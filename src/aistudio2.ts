// AI Studio 2 self-use pool ("AI Studio"): backed by Mag1cFall/AIStudio2API.
// Strict isolation when sharing an AIStudio2API instance with agy-pot:
//  - Ownership lives in DATA_DIR/aistudio2.sqlite (aistudio2_accounts).
//  - Upload refuses emails already present in AIStudio2API unless already owned by agy-me.
//  - Recheck, sweep, delete, and gateway rotation ONLY ever touch accounts recorded in agy-me's own DB.
//  - Zero proxy / mihomo / exit / multi-user sharing logic.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { gunzipSync } from 'node:zlib';
import { config } from './config.ts';
import { HttpError, sleep } from './util.ts';
import type { UsageSource } from './usage.ts';

export const aistudio2On = () => !!config.aistudio2Key;
export const NOT_ELIGIBLE_2 = 'AI Studio 池里还没有有效且启用的账号，请先在 AI Studio 页面上传有效凭证';
const MAX_ACCOUNTS = 100;

export const ais2Id = (email: string) =>
  'ais2_' + createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);

export const isAIS2 = (id: string | null | undefined) => !!id && /^ais2_[0-9a-f]{16}$/.test(id);

// ---------- local SQLite ownership store ----------
type Row = Record<string, any>;
let dbInst: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (dbInst) return dbInst;
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const d = new DatabaseSync(join(config.dataDir, 'aistudio2.sqlite'));
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS aistudio2_accounts (
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      tier TEXT,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'valid',
      disabled INTEGER NOT NULL DEFAULT 0,
      in_relay INTEGER NOT NULL DEFAULT 1,
      last_checked_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  dbInst = d;
  return d;
}

export function closeAIS2DB() {
  try { dbInst?.close(); } catch {}
  dbInst = null;
}

const one = (sql: string, ...p: any[]): Row | undefined => db().prepare(sql).get(...p) as Row | undefined;
const all = (sql: string, ...p: any[]): Row[] => db().prepare(sql).all(...p) as Row[];
const run = (sql: string, ...p: any[]) => db().prepare(sql).run(...p);
const now = () => Date.now();

export type AllowedAcc = { id: string; email: string };
export function allowedAccounts(): AllowedAcc[] {
  if (!aistudio2On()) return [];
  return all(`SELECT account_id, email FROM aistudio2_accounts WHERE status = 'valid' AND disabled = 0 ORDER BY account_id`)
    .map((r) => ({ id: String(r.account_id), email: String(r.email) }));
}

export function ais2Email(accountId: string): string {
  const r = one('SELECT email FROM aistudio2_accounts WHERE account_id = ?', accountId);
  return r?.email ? String(r.email) : accountId;
}

// ---------- AIStudio2API admin client ----------
type ApiReply = { status: number; j: any; text: string };
let adminCookie = '';

async function loginAdmin(): Promise<string> {
  if (!config.aistudio2AdminPass) return '';
  const r = await fetch(config.aistudio2URL + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: config.aistudio2AdminUser || 'admin',
      password: config.aistudio2AdminPass,
      remember: true,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('aistudio2 login ' + r.status);
  for (const c of r.headers.getSetCookie()) {
    if (c.startsWith('aistudio_admin=')) {
      adminCookie = c.split(';')[0];
      return adminCookie;
    }
  }
  return adminCookie;
}

async function adminReq(method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<ApiReply> {
  if (config.aistudio2AdminPass && !adminCookie) await loginAdmin();
  const once = async (): Promise<ApiReply> => {
    const headers: Record<string, string> = {};
    if (adminCookie) headers.Cookie = adminCookie;
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(config.aistudio2URL + path, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, j, text };
  };
  let rep = await once();
  if (rep.status === 401 && config.aistudio2AdminPass) {
    adminCookie = '';
    await loginAdmin();
    rep = await once();
  }
  return rep;
}

const apiMsg = (j: any) =>
  String(j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || j?.message || '').replace(/\s+/g, ' ').trim();

async function backendRemove(email: string) {
  const r = await adminReq('DELETE', '/api/accounts/' + encodeURIComponent(email), undefined, 15000);
  if (r.status !== 204 && r.status !== 200 && r.status !== 404) {
    throw new Error('aistudio2 remove ' + r.status);
  }
}

async function ensureStarted() {
  try {
    const st = await adminReq('GET', '/api/status', undefined, 10000);
    if (st.status === 200 && st.j && st.j.running === false) {
      await adminReq('POST', '/api/control/start', {}, 15000);
    }
  } catch {}
}

/** Support Cookie-Editor JSON, raw header, Netscape, AND the Tampermonkey {cookies, authUser} wrapper. */
export function unwrapCookieInput(raw: string): { cookieText: string; preferredAuthUser: number | null } {
  const t = raw.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.cookies === 'string' && j.cookies.trim()) {
        const au = Number(j.authUser);
        return { cookieText: j.cookies.trim(), preferredAuthUser: Number.isInteger(au) && au >= 0 ? au : null };
      }
      if (j && typeof j === 'object' && !Array.isArray(j) && Array.isArray(j.cookies)) {
        const au = Number(j.authUser);
        return { cookieText: JSON.stringify(j.cookies), preferredAuthUser: Number.isInteger(au) && au >= 0 ? au : null };
      }
    } catch {}
  }
  return { cookieText: t, preferredAuthUser: null };
}

export type Verdict = { state: 'alive' | 'dead' | 'unknown'; tier?: string | null; error?: string };
const TRANSIENT = /network error|fetch failed|timed? ?out|timeout|aborted|socket|ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|\bHTTP 5\d\d\b|temporarily unavailable/i;
const GEOIP_ERR = /下载 IP 库|打开 IP 库|查询 IP 库|创建 IP 库目录|IP 库中没有|国家代码无效|查询出口 IP 失败|geoip-aio-|Failed to download the IP database/i;
const MAXMIND_MARKER = Buffer.from('MaxMind.com', 'ascii');

function isValidMmdbBuffer(buf: Buffer): boolean {
  if (buf.byteLength < 64) return false;
  return buf.subarray(Math.max(0, buf.byteLength - 131072)).includes(MAXMIND_MARKER);
}

function isValidMmdbFile(filePath: string): boolean {
  let fd: number | null = null;
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size < 64) return false;
    const len = Math.min(st.size, 131072);
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(filePath, 'r');
    const n = readSync(fd, buf, 0, len, st.size - len);
    return buf.subarray(0, n).includes(MAXMIND_MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function syncIpv6Mmdb(v4Path: string, v6Path: string, forceReplace = false) {
  if (!forceReplace && isValidMmdbFile(v6Path)) return;
  rmSync(v6Path, { force: true });
  try {
    linkSync(v4Path, v6Path);
  } catch {
    copyFileSync(v4Path, v6Path);
  }
}

let geoipFlight: Promise<boolean> | null = null;

async function ensureLocalAIS2GeoipInner(): Promise<boolean> {
  try {
    const ais2Root = config.aistudio2DataDir || join(config.dataDir, 'aistudio2api');
    if (!existsSync(ais2Root)) return false;

    const geoipDir = join(ais2Root, 'runtime', 'geoip');
    const v4Path = join(geoipDir, 'geoip-aio-ipv4.mmdb');
    const v6Path = join(geoipDir, 'geoip-aio-ipv6.mmdb');

    if (isValidMmdbFile(v4Path)) {
      syncIpv6Mmdb(v4Path, v6Path);
      return true;
    }

    if (!config.aistudio2GeoipURLs.length) return false;
    mkdirSync(geoipDir, { recursive: true });

    for (const rawUrl of config.aistudio2GeoipURLs) {
      let tmpPath = '';
      try {
        const r = await fetch(rawUrl, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) {
          console.warn(`[aistudio2] geoip HTTP ${r.status} from ${rawUrl}`);
          continue;
        }
        let buf: Buffer = Buffer.from(await r.arrayBuffer());
        const isGz = rawUrl.split('?')[0].toLowerCase().endsWith('.gz')
          || (buf.byteLength >= 2 && buf[0] === 0x1f && buf[1] === 0x8b);
        if (isGz) buf = gunzipSync(buf);
        if (!isValidMmdbBuffer(buf)) {
          console.warn(`[aistudio2] invalid mmdb payload from ${rawUrl} (${buf.byteLength} bytes)`);
          continue;
        }
        tmpPath = join(geoipDir, `geoip-aio-ipv4.mmdb.${process.pid}.tmp`);
        writeFileSync(tmpPath, buf, { mode: 0o644 });
        renameSync(tmpPath, v4Path);
        tmpPath = '';
        syncIpv6Mmdb(v4Path, v6Path, true);
        return true;
      } catch (e) {
        if (tmpPath) {
          try { rmSync(tmpPath, { force: true }); } catch {}
        }
        console.warn(`[aistudio2] geoip download failed (${rawUrl}):`, (e as Error).message);
      }
    }
    return false;
  } catch (e) {
    console.warn('[aistudio2] ensureLocalAIS2Geoip failed:', (e as Error).message);
    return false;
  }
}

export function ensureLocalAIS2Geoip(): Promise<boolean> {
  if (geoipFlight) return geoipFlight;
  geoipFlight = ensureLocalAIS2GeoipInner().finally(() => {
    geoipFlight = null;
  });
  return geoipFlight;
}

function normTier(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const u = v.trim().toUpperCase();
  if (u.includes('ULTRA') || u.includes('HELIUM')) return 'ULTRA';
  if (u.includes('PRO') || u.includes('PREMIUM') || u.includes('ADVANCED')) return 'PRO';
  if (u.includes('FREE') || u.includes('STARTER') || u.includes('STANDARD') || u.includes('ENTERPRISE')) return 'FREE';
  return u.slice(0, 20);
}

async function refreshAccount(email: string): Promise<Verdict> {
  let r: ApiReply;
  try {
    r = await adminReq('POST', `/api/accounts/${encodeURIComponent(email)}/refresh`, {}, 90000);
  } catch (e) {
    return { state: 'unknown', error: (e as Error).message };
  }
  if (r.status === 404) return { state: 'dead', error: '后端中找不到该账号' };
  if (r.status >= 500) {
    const msg = apiMsg(r.j) || `后端返回 ${r.status}`;
    return { state: 'unknown', error: msg };
  }
  const acc = r.j?.account;
  if (r.status === 200 && acc) {
    if (acc.state === 'ready' && acc.enabled !== false) {
      return { state: 'alive', tier: normTier(acc.benefit_tier || r.j?.tier) };
    }
    if (acc.state === 'auth_required' || acc.state === 'restricted' || acc.enabled === false) {
      return { state: 'dead', error: String(acc.message || acc.state || '账号已失效').slice(0, 200) };
    }
  }
  const msg = apiMsg(r.j) || `后端返回 ${r.status}`;
  if (GEOIP_ERR.test(msg) || TRANSIENT.test(msg)) return { state: 'unknown', error: msg };
  if (r.status === 400 || r.status === 401 || r.status === 403) return { state: 'dead', error: msg };
  return { state: 'unknown', error: msg };
}

// Serialize mutations & checks so imports, refreshes and deletes do not interleave.
let lock: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const job = lock.then(fn);
  lock = job.catch(() => {});
  return job;
}

// ---------- views ----------
export type AIS2View = {
  id: string;
  email: string;
  tier: string | null;
  label: string;
  status: 'valid' | 'dead';
  disabled: boolean;
  checkedAt: number | null;
  error: string | null;
  created: number;
};

export function view(r: Row): AIS2View {
  return {
    id: String(r.account_id),
    email: String(r.email || ''),
    tier: r.tier ? String(r.tier) : null,
    label: String(r.label || r.email || r.account_id),
    status: r.status === 'valid' ? 'valid' : 'dead',
    disabled: !!r.disabled,
    checkedAt: r.last_checked_at ? Number(r.last_checked_at) : null,
    error: r.last_error ? String(r.last_error) : null,
    created: Number(r.created_at || 0),
  };
}

export function list(): AIS2View[] {
  if (!aistudio2On()) return [];
  return all('SELECT * FROM aistudio2_accounts ORDER BY created_at, email').map(view);
}

const short = (s: string | undefined) => (s ? s.slice(0, 200) : null);
function markDead(accountId: string, error: string | undefined, inRelay: boolean) {
  run(
    `UPDATE aistudio2_accounts SET status = 'dead', in_relay = ?, last_checked_at = ?, last_error = ?, updated_at = ? WHERE account_id = ?`,
    inRelay ? 1 : 0, now(), short(error), now(), accountId,
  );
}

async function runCookieImportTask(
  email: string,
  cookieText: string,
  authUser: number,
  envFallback?: { locale: string; timezone: string },
) {
  let imp: ApiReply;
  try {
    imp = await adminReq(
      'POST',
      '/api/accounts/import/cookies',
      {
        items: [{ email, cookies: cookieText, auth_user: authUser }],
        ...(envFallback ? { locale: envFallback.locale, timezone: envFallback.timezone } : {}),
      },
      30000,
    );
  } catch {
    throw new HttpError(502, 'aistudio_unreachable', 'AI Studio 后端暂时连不上，请稍后再试');
  }
  if ((imp.status !== 202 && imp.status !== 200) || !imp.j?.task?.id) {
    throw new HttpError(400, 'aistudio_cookie', apiMsg(imp.j) || '导入任务创建失败');
  }

  const taskId = String(imp.j.task.id);
  let doneTask: any = imp.j.task;
  const deadline = Date.now() + 120000;
  try {
    while (doneTask?.state === 'running' && Date.now() < deadline) {
      await sleep(600);
      const tr = await adminReq('GET', '/api/accounts/tasks', undefined, 15000);
      if (tr.status === 200 && Array.isArray(tr.j?.tasks)) {
        const foundTask = tr.j.tasks.find((t: any) => String(t?.id) === taskId);
        if (foundTask) doneTask = foundTask;
        else break;
      }
    }
  } finally {
    await adminReq('DELETE', '/api/accounts/tasks/' + encodeURIComponent(taskId), undefined, 10000).catch(() => {});
  }

  const item = Array.isArray(doneTask?.items) ? doneTask.items[0] : null;
  const failed = Boolean(doneTask?.state === 'failed' || item?.state === 'failed');
  const err = failed ? String(item?.error || doneTask?.error || '校验未通过').replace(/\s+/g, ' ').trim() : '';
  return { doneTask, item, failed, err };
}

export async function upload(cookies: string) {
  if (!aistudio2On()) throw new HttpError(404, 'not_found');
  const text = cookies.trim();
  if (!text) throw new HttpError(400, 'aistudio_cookie', '请粘贴 Cookie 或 JSON 凭证');
  if (text.length > 131072) throw new HttpError(400, 'aistudio_cookie', '凭证内容太长');
  const { cookieText, preferredAuthUser } = unwrapCookieInput(text);

  return serial(async () => {
    // Step 1: Discover Google account(s) without mutating backend state.
    let disc: ApiReply;
    try {
      disc = await adminReq('POST', '/api/accounts/import/cookies/discover', { cookies: cookieText }, 45000);
    } catch {
      throw new HttpError(502, 'aistudio_unreachable', 'AI Studio 后端暂时连不上，请稍后再试');
    }
    if (disc.status === 401 || disc.status === 403) {
      throw new HttpError(502, 'aistudio_unreachable', 'AI Studio 后端管理鉴权失败，请检查 AISTUDIO2_ADMIN_PASSWORD');
    }
    if (disc.status !== 200 || !Array.isArray(disc.j?.accounts)) {
      throw new HttpError(400, 'aistudio_cookie', apiMsg(disc.j) || '凭证格式无效');
    }

    const found: any[] = disc.j.accounts;
    let cand: any = null;
    if (preferredAuthUser !== null) {
      cand = found.find((a) => Number(a?.auth_user) === preferredAuthUser) || null;
      if (cand) {
        if (cand.restricted) throw new HttpError(400, 'aistudio_dead', '该账号在 Google AI Studio 受限，无法使用');
        if (cand.signed_out) throw new HttpError(400, 'aistudio_cookie', 'Cookie 已退出登录，请重新登录 AI Studio 后导出');
        if (cand.error || !cand.email) throw new HttpError(400, 'aistudio_cookie', 'Cookie 无效：' + String(cand.error || '无法识别邮箱').slice(0, 160));
      }
    }
    if (!cand) {
      const usable = found.filter((a) => a && typeof a.email === 'string' && a.email.trim() && !a.signed_out && !a.restricted && !a.error);
      if (!usable.length) {
        if (found.some((a) => a?.restricted)) throw new HttpError(400, 'aistudio_dead', '该账号在 Google AI Studio 受限，无法使用');
        if (found.some((a) => a?.signed_out)) throw new HttpError(400, 'aistudio_cookie', 'Cookie 已退出登录，请重新登录 AI Studio 后导出');
        const firstErr = found.find((a) => a?.error)?.error;
        throw new HttpError(400, 'aistudio_cookie', firstErr ? '凭证校验失败：' + String(firstErr).slice(0, 160) : '未识别到有效的 Google 账号，请导出完整 Cookie 后重试');
      }
      cand = usable.find((a) => Number(a.auth_user) === 0) || usable[0];
    }

    const email = String(cand.email).trim().toLowerCase();
    const authUser = Number.isInteger(Number(cand.auth_user)) ? Number(cand.auth_user) : 0;
    const id = ais2Id(email);

    // Step 2: Mode-aware ownership check BEFORE writing anything to AIStudio2API.
    // In shared mode, block emails already present in AIStudio2API unless owned by agy-me.
    // In exclusive mode (default single-tenant), claim and overwrite/re-import cleanly.
    const existing = one('SELECT * FROM aistudio2_accounts WHERE account_id = ? OR email = ?', id, email);
    if (!existing) {
      if (Number(one('SELECT COUNT(*) AS n FROM aistudio2_accounts')?.n || 0) >= MAX_ACCOUNTS) {
        throw new HttpError(400, 'aistudio_too_many', `最多保存 ${MAX_ACCOUNTS} 个账号`);
      }
      if (config.aistudio2Mode === 'shared') {
        let preRep: ApiReply;
        try {
          preRep = await adminReq('GET', '/api/accounts', undefined, 15000);
        } catch {
          throw new HttpError(502, 'aistudio_unreachable', 'AI Studio 后端暂时连不上，请稍后再试');
        }
        if (preRep.status !== 200) {
          throw new HttpError(502, 'aistudio_unreachable', '无法读取 AI Studio 后端账号列表');
        }
        const rawList = Array.isArray(preRep.j) ? preRep.j : (preRep.j?.accounts || preRep.j?.items || []);
        const inBackend = !!cand.imported || rawList.some((a: any) => String(a?.id || a?.email || '').trim().toLowerCase() === email);
        if (inBackend) {
          throw new HttpError(409, 'aistudio_taken', '该账号已存在于共享 AI Studio 后端（如门户号池），为隔离账号禁止在此重复导入');
        }
      }
    }
    if (!existing) {
      const ts0 = now();
      run(
        `INSERT OR IGNORE INTO aistudio2_accounts(account_id, email, tier, label, status, disabled, in_relay, last_checked_at, last_error, created_at, updated_at)
         VALUES(?,?,NULL,?,'importing',1,0,NULL,NULL,?,?)`,
        id, email, email, ts0, ts0,
      );
    }

    // Step 3: Import into AIStudio2API and wait for async validation task (no proxy / no exit).
    const cleanImporting = () => {
      if (!existing) run("DELETE FROM aistudio2_accounts WHERE account_id = ? AND status = 'importing'", id);
    };

    let taskRes: Awaited<ReturnType<typeof runCookieImportTask>>;
    try {
      taskRes = await runCookieImportTask(email, cookieText, authUser);
      if (taskRes.failed && GEOIP_ERR.test(taskRes.err)) {
        const healed = await ensureLocalAIS2Geoip();
        if (healed) {
          taskRes = await runCookieImportTask(email, cookieText, authUser);
        }
        if (taskRes.failed && GEOIP_ERR.test(taskRes.err) && config.aistudio2FallbackLocale && config.aistudio2FallbackTimezone) {
          taskRes = await runCookieImportTask(email, cookieText, authUser, {
            locale: config.aistudio2FallbackLocale,
            timezone: config.aistudio2FallbackTimezone,
          });
        }
      }
    } catch (e) {
      cleanImporting();
      throw e;
    }

    if (taskRes.doneTask?.state === 'running') {
      cleanImporting();
      if (!existing || existing.status !== 'valid') await backendRemove(email).catch(() => {});
      throw new HttpError(503, 'aistudio_check_failed', '账号校验超时，请稍后再试');
    }

    if (taskRes.failed) {
      const err = taskRes.err;
      if (GEOIP_ERR.test(err)) {
        cleanImporting();
        throw new HttpError(
          503,
          'aistudio_check_failed',
          'AI Studio 后端缺少 GeoIP 库且自动兜底未生效，请重跑 deploy.sh --upgrade 或将 GeoLite2-City.mmdb 放到 <DATA_DIR>/aistudio2api/runtime/geoip/geoip-aio-ipv4.mmdb（原始错误：' + err.slice(0, 100) + '）',
        );
      }
      if (TRANSIENT.test(err)) {
        cleanImporting();
        throw new HttpError(503, 'aistudio_check_failed', '暂时无法检测该账号，请稍后再试');
      }
      let removed = true;
      try { await backendRemove(email); } catch { removed = false; }
      if (existing) markDead(String(existing.account_id), err, !removed);
      else cleanImporting();
      throw new HttpError(400, 'aistudio_dead', '该账号无效：' + err.slice(0, 160));
    }

    // Step 4: Read account state & tier from AIStudio2API and ensure generation plane is running.
    const listRep = await adminReq('GET', '/api/accounts', undefined, 15000).catch(() => ({ status: 0, j: null, text: '' }));
    const rawAfter = Array.isArray(listRep.j) ? listRep.j : (listRep.j?.accounts || listRep.j?.items || []);
    const backendAcc = rawAfter.find((a: any) => String(a?.id || a?.email || '').toLowerCase() === email);
    if (!backendAcc || backendAcc.state !== 'ready') {
      const err = String(backendAcc?.message || backendAcc?.state || '导入后账号未就绪').slice(0, 160);
      let removed = true;
      try { await backendRemove(email); } catch { removed = false; }
      if (existing) markDead(String(existing.account_id), err, !removed);
      else run("DELETE FROM aistudio2_accounts WHERE account_id = ? AND status = 'importing'", id);
      throw new HttpError(400, 'aistudio_dead', '该账号无效：' + err);
    }

    await ensureStarted();

    const tier = normTier(backendAcc.benefit_tier);
    const ts = now();
    run(
      `INSERT INTO aistudio2_accounts(account_id, email, tier, label, status, disabled, in_relay, last_checked_at, last_error, created_at, updated_at)
       VALUES(?,?,?,?,'valid',0,1,?,NULL,?,?)
       ON CONFLICT(account_id) DO UPDATE SET email = excluded.email, tier = COALESCE(excluded.tier, aistudio2_accounts.tier),
         disabled = CASE WHEN aistudio2_accounts.status = 'importing' THEN 0 ELSE aistudio2_accounts.disabled END,
         status = 'valid', in_relay = 1, last_checked_at = excluded.last_checked_at, last_error = NULL, updated_at = excluded.updated_at`,
      id, email, tier, existing?.label || email, ts, ts, ts,
    );

    return {
      ...view(one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', id)!),
      deviceBound: !!cand.device_bound,
    };
  });
}

// ---------- local patch (enable/disable or label, never touches shared backend) ----------
export function patch(accountId: string, fields: { disabled?: boolean; label?: string }): AIS2View {
  if (!aistudio2On()) throw new HttpError(404, 'not_found');
  const row = one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId);
  if (!row) throw new HttpError(404, 'not_found');
  if (typeof fields.disabled === 'boolean') {
    run('UPDATE aistudio2_accounts SET disabled = ?, updated_at = ? WHERE account_id = ?', fields.disabled ? 1 : 0, now(), accountId);
  }
  if (typeof fields.label === 'string') {
    const clean = fields.label.trim().slice(0, 120) || String(row.email);
    run('UPDATE aistudio2_accounts SET label = ?, updated_at = ? WHERE account_id = ?', clean, now(), accountId);
  }
  return view(one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId)!);
}

// ---------- re-check & sweep (ONLY agy-me's own accounts!) ----------
async function checkLocked(accountId: string): Promise<Verdict['state'] | 'skip'> {
  const row = one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId);
  if (!row || row.status !== 'valid') return 'skip';
  const v = await refreshAccount(String(row.email));
  if (v.state === 'alive') {
    run('UPDATE aistudio2_accounts SET tier = COALESCE(?, tier), last_checked_at = ?, last_error = NULL, updated_at = ? WHERE account_id = ?',
      v.tier ?? null, now(), now(), accountId);
  } else if (v.state === 'dead') {
    let removed = true;
    try { await backendRemove(String(row.email)); } catch { removed = false; }
    markDead(accountId, v.error, !removed);
  } else {
    console.warn('[aistudio2] check inconclusive', accountId, v.error);
  }
  return v.state;
}

export async function recheck(accountId: string) {
  if (!aistudio2On()) throw new HttpError(404, 'not_found');
  const row = one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId);
  if (!row) throw new HttpError(404, 'not_found');
  if (row.status !== 'valid') throw new HttpError(400, 'aistudio_dead', '该账号已失效，请重新上传凭证');
  const state = await serial(() => checkLocked(accountId));
  return { state, account: view(one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId)!) };
}

const recentReactive = new Map<string, number>();
/** Non-blocking reactive check when gateway sees 401/403 from an agy-me pinned account. */
export function notifyAuthSuspect(accountId: string) {
  if (!aistudio2On()) return;
  const last = recentReactive.get(accountId) || 0;
  if (now() - last < 180000) return;
  recentReactive.set(accountId, now());
  void serial(() => checkLocked(accountId)).catch(() => {});
}

export async function syncExclusiveFromBackend(): Promise<number> {
  if (!aistudio2On() || config.aistudio2Mode !== 'exclusive') return 0;
  try {
    const rep = await adminReq('GET', '/api/accounts', undefined, 15000);
    if (rep.status !== 200) return 0;
    const list = Array.isArray(rep.j) ? rep.j : (rep.j?.accounts || rep.j?.items || []);
    let added = 0;
    const ts = now();
    for (const a of list) {
      const email = String(a?.id || a?.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) continue;
      const id = ais2Id(email);
      const row = one('SELECT account_id FROM aistudio2_accounts WHERE account_id = ? OR email = ?', id, email);
      if (row) continue;
      if (Number(one('SELECT COUNT(*) AS n FROM aistudio2_accounts')?.n || 0) >= MAX_ACCOUNTS) break;
      const st = String(a?.state || 'ready') === 'ready' ? 'valid' : 'dead';
      const tier = normTier(a?.benefit_tier);
      run(
        `INSERT OR IGNORE INTO aistudio2_accounts(account_id, email, tier, label, status, disabled, in_relay, last_checked_at, last_error, created_at, updated_at)
         VALUES(?,?,?,?,?,0,1,?,NULL,?,?)`,
        id, email, tier, email, st, ts, ts, ts,
      );
      added++;
    }
    return added;
  } catch {
    return 0;
  }
}

export async function sweep() {
  if (!aistudio2On()) return { checked: 0, dead: 0 };
  return serial(async () => {
    if (config.aistudio2Mode === 'exclusive') await syncExclusiveFromBackend();
    let checked = 0, dead = 0;
    for (const r of all(`SELECT account_id FROM aistudio2_accounts WHERE status = 'valid' ORDER BY last_checked_at`)) {
      const s = await checkLocked(String(r.account_id));
      if (s !== 'skip') checked++;
      if (s === 'dead') dead++;
    }
    // Only clean up dead accounts recorded in agy-me's own DB — NEVER delete other accounts in shared AIStudio2API!
    for (const r of all(`SELECT account_id, email FROM aistudio2_accounts WHERE status != 'valid' AND in_relay = 1`)) {
      try {
        await backendRemove(String(r.email));
        run('UPDATE aistudio2_accounts SET in_relay = 0 WHERE account_id = ?', r.account_id);
      } catch {}
    }
    const validCount = Number(one(`SELECT COUNT(*) AS n FROM aistudio2_accounts WHERE status = 'valid'`)?.n || 0);
    if (validCount > 0) await ensureStarted();
    return { checked, dead };
  });
}

// ---------- delete (ONLY agy-me's own accounts!) ----------
export async function remove(accountId: string) {
  if (!aistudio2On()) throw new HttpError(404, 'not_found');
  const row = one('SELECT * FROM aistudio2_accounts WHERE account_id = ?', accountId);
  if (!row) throw new HttpError(404, 'not_found');
  await serial(async () => {
    if (row.in_relay) {
      try {
        await backendRemove(String(row.email));
      } catch {
        throw new HttpError(502, 'aistudio_unreachable', 'AI Studio 后端暂时连不上，请稍后再试');
      }
    }
    run('DELETE FROM aistudio2_accounts WHERE account_id = ?', accountId);
  });
  return { ok: true };
}

export function startAIStudio2Recheck(): void {
  if (!aistudio2On()) return;
  if (config.aistudio2Mode === 'exclusive') {
    setTimeout(() => { void serial(() => syncExclusiveFromBackend()).catch(() => {}); }, 800).unref();
  }
  if (config.aistudio2RecheckMinutes <= 0) return;
  const tick = () => sweep().catch((e) => console.error('[aistudio2] recheck failed:', (e as Error).message));
  setInterval(tick, config.aistudio2RecheckMinutes * 60000).unref();
}

export async function ping(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t = now();
  try {
    const r = await fetch(config.aistudio2URL + '/v1/models', {
      headers: { Authorization: 'Bearer ' + config.aistudio2Key, 'x-api-key': config.aistudio2Key },
      signal: AbortSignal.timeout(4000),
    });
    return { ok: r.status < 500 && r.status !== 401 && r.status !== 403, ms: now() - t, error: r.ok ? undefined : 'HTTP ' + r.status };
  } catch (e) {
    return { ok: false, ms: now() - t, error: (e as Error).message };
  }
}

// ---------- Daily quota summary (16:00 Beijing reset) ----------
export const AIS2_MODELS_ORDER = [
  'gemini-4-argon',
  'gemini-4-carbon',
  'gemini-4-hydrogen',
  'gemini-3.1-pro-preview',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
] as const;

type TierRule = { req: number | null; tok: number | null; unknown?: boolean } | null;
const AIS2_TIER_QUOTA: Record<'FREE' | 'PRO' | 'ULTRA', Record<string, TierRule>> = {
  FREE: {
    'gemini-4-argon': null,
    'gemini-4-carbon': null,
    'gemini-4-hydrogen': { req: 50, tok: 10_000_000 },
    'gemini-3.1-pro-preview': null,
    'gemini-3.8-flash': { req: 50, tok: 5_000_000 },
    'gemini-3.6-flash': { req: 50, tok: 5_000_000 },
    'gemini-3-flash-preview': { req: 50, tok: 5_000_000 },
    'gemini-3.5-flash-lite': { req: 50, tok: 5_000_000 },
    'gemini-3.1-flash-lite': { req: 50, tok: 5_000_000 },
  },
  PRO: {
    'gemini-4-argon': { req: 50, tok: 15_000_000 },
    'gemini-4-carbon': null,
    'gemini-4-hydrogen': { req: 100, tok: 25_000_000 },
    'gemini-3.1-pro-preview': { req: 50, tok: 13_000_000 },
    'gemini-3.8-flash': { req: 150, tok: 25_000_000 },
    'gemini-3.6-flash': { req: 150, tok: 25_000_000 },
    'gemini-3-flash-preview': { req: 150, tok: 25_000_000 },
    'gemini-3.5-flash-lite': { req: 150, tok: 25_000_000 },
    'gemini-3.1-flash-lite': { req: 150, tok: 25_000_000 },
  },
  ULTRA: {
    'gemini-4-argon': { req: 200, tok: null },
    'gemini-4-carbon': { req: 200, tok: null },
    'gemini-4-hydrogen': { req: null, tok: null, unknown: true },
    'gemini-3.1-pro-preview': { req: 100, tok: null },
    'gemini-3.8-flash': { req: 200, tok: null },
    'gemini-3.6-flash': { req: 200, tok: null },
    'gemini-3-flash-preview': { req: 200, tok: null },
    'gemini-3.5-flash-lite': { req: 200, tok: null },
    'gemini-3.1-flash-lite': { req: 200, tok: null },
  },
};

export function quotaPeriodStart(t = now()): number {
  const bj = t + 8 * 3600e3;
  const dayStartBj = bj - (bj % 86400e3);
  let resetBj = dayStartBj + 16 * 3600e3;
  if (bj < resetBj) resetBj -= 86400e3;
  return resetBj - 8 * 3600e3;
}

export function normQuotaModel(raw: string): string {
  let m = String(raw || '').trim().toLowerCase().replace(/^models\//, '');
  m = m.replace(/\([^)]*\)$/, '').replace(/-(?:minimal|low|medium|high|xhigh|extra[_-]high|max)(?:-search)?$/, '').replace(/-search$/, '').trim();
  return m;
}

export function overviewQuota(src: UsageSource, t = now()) {
  const accs = list();
  const valid = accs.filter((a) => a.status === 'valid' && !a.disabled);
  const counts = {
    total: accs.length,
    valid: valid.length,
    dead: accs.filter((a) => a.status !== 'valid').length,
    disabled: accs.filter((a) => a.status === 'valid' && a.disabled).length,
  };
  const qSince = quotaPeriodStart(t);
  const tiers = valid.map((a) => {
    const u = String(a.tier || 'FREE').toUpperCase();
    return (u.includes('ULTRA') ? 'ULTRA' : u.includes('PRO') ? 'PRO' : 'FREE') as 'FREE' | 'PRO' | 'ULTRA';
  });
  const activeIds = valid.map((a) => a.id);
  const usedMap = new Map<string, { req: number; tok: number }>();
  for (const r of src.ais2QuotaUsage(qSince, activeIds)) {
    const nm = normQuotaModel(r.model);
    if (!nm) continue;
    const cur = usedMap.get(nm) || { req: 0, tok: 0 };
    cur.req += r.req;
    cur.tok += r.tok;
    usedMap.set(nm, cur);
  }
  const models = AIS2_MODELS_ORDER.map((m) => {
    let reqLimit = 0, tokLimit = 0, hasTokLimit = false, supported = false, hasUnknown = false;
    for (const tier of tiers) {
      const rule = AIS2_TIER_QUOTA[tier][m];
      if (!rule) continue;
      supported = true;
      if (rule.unknown) hasUnknown = true;
      if (rule.req != null) reqLimit += rule.req;
      if (rule.tok != null) { tokLimit += rule.tok; hasTokLimit = true; }
    }
    const used = usedMap.get(m) || { req: 0, tok: 0 };
    return {
      model: m,
      supported,
      unknown: hasUnknown && reqLimit === 0,
      partialUnknown: hasUnknown && reqLimit > 0,
      usedReq: used.req,
      reqLimit: supported && reqLimit > 0 ? reqLimit : null,
      usedTok: used.tok,
      tokLimit: supported && hasTokLimit && !tiers.some((tr) => AIS2_TIER_QUOTA[tr][m] && AIS2_TIER_QUOTA[tr][m]!.tok == null) ? tokLimit : null,
    };
  });
  return {
    counts,
    accounts: accs,
    quota: { resetAt: qSince + 86400e3, tiers, models },
  };
}

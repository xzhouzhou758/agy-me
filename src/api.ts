// JSON API for the web UI. Everything except login needs the session cookie.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { HttpError, sendJSON, readJSON, readBody, str, clampInt, token } from './util.ts';
import { requireAuth, authed, login, logout, changePassword } from './auth.ts';
import { settings, setSettings } from './store.ts';
import * as cpa from './cpa.ts';
import * as quota from './quota.ts';
import * as browser from './browser.ts';
import * as keys from './keys.ts';
import { accountView, famSummary, counts, USED_SPAN_MS, type AccountView } from './accounts.ts';
import { usageSource, drainStatus } from './usage.ts';
import { tiers } from './tiers.ts';
import * as auto from './autodisable.ts';
import * as sleeper from './autosleep.ts';
import * as excluder from './autoexclude.ts';
import { readZip, writeZip } from './zip.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, p: Record<string, string>, url: URL) => Promise<unknown> | unknown;
const routes: { method: string; re: RegExp; keys: string[]; open: boolean; h: Handler }[] = [];
function route(method: string, path: string, h: Handler, open = false) {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, open, h });
}

export async function handleAPI(req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method || 'GET';
  // CSRF: state-changing calls must carry a custom header (forces a CORS preflight cross-site).
  if (method !== 'GET' && method !== 'HEAD' && req.headers['x-app-csrf'] !== '1') throw new HttpError(403, 'csrf');
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    if (!r.open) requireAuth(req);
    const p: Record<string, string> = {};
    r.keys.forEach((k, i) => (p[k] = decodeURIComponent(m[i + 1])));
    const out = await r.h(req, res, p, url);
    if (!res.headersSent) sendJSON(res, 200, out ?? { ok: true });
    return;
  }
  throw new HttpError(404, 'not_found');
}

// ---------- session ----------
route('POST', '/api/login', async (req, res) => { login(req, res, await readJSON(req, 4096)); return { ok: true }; }, true);
route('POST', '/api/logout', (req, res) => { logout(req, res); return { ok: true }; }, true);
route('GET', '/api/me', (req) => {
  if (!authed(req)) throw new HttpError(401, 'unauthorized');
  return { ok: true, browser: browser.browserOn() };
}, true);

// ---------- accounts ----------
const BAN_WINDOW_MS = 3 * 86400e3;
async function accountList(maxAgeMs = 5000): Promise<AccountView[]> {
  const c = await cpa.creds(maxAgeMs);
  const src = usageSource();
  const lu = src.lastUsed();
  const bans = src.bans(Date.now() - BAN_WINDOW_MS);
  const tok = src.tokenEvents(Date.now() - USED_SPAN_MS - 3600e3);
  return c.list
    .filter((x) => x.type === 'antigravity')
    .map((x) => accountView(x, quota.entry(x.id), bans.get(x.id) || null, lu.get(x.id) || 0, Date.now(), auto.autoMark(x.id), tok.get(x.id) || [], sleeper.sleepMark(x.id)))
    .sort((a, b) => a.email.localeCompare(b.email));
}
// Every id-taking route only reaches antigravity credentials, the only ones the panel shows.
const isAG = (c: cpa.Creds, id: string) => c.byId.get(id)?.type === 'antigravity';
async function known(id: string) {
  const c = await cpa.creds(5000);
  if (!isAG(c, id)) throw new HttpError(404, 'not_found');
  return c.byId.get(id)!;
}
export const MAX_IDS = 500;
function ids(v: unknown): string[] {
  const l = Array.isArray(v) ? [...new Set(v.map(String))] : [];
  if (l.length > MAX_IDS) throw new HttpError(400, 'too_many', `at most ${MAX_IDS}`);
  return l;
}

route('GET', '/api/accounts', async () => ({ accounts: await accountList(), progress: quota.progress() }));

route('PATCH', '/api/accounts/:id', async (req, _res, p) => {
  await known(p.id);
  const b = await readJSON(req);
  if (typeof b.disabled === 'boolean') {
    await cpa.setDisabled(p.id, b.disabled);
    auto.userToggled(p.id, b.disabled);
    sleeper.dropMark(p.id);
  }
  if (typeof b.note === 'string') await cpa.patchFields(p.id, { note: str(b.note, 200) });
  return (await accountList(0)).find((a) => a.id === p.id);
});

route('POST', '/api/accounts/:id/refresh', async (_req, _res, p) => {
  await known(p.id);
  await quota.refreshNow(p.id);
  return (await accountList()).find((a) => a.id === p.id);
});

route('POST', '/api/accounts/batch', async (req) => {
  const b = await readJSON(req);
  const list = ids(b.ids);
  const op = String(b.op || '');
  if (!list.length || !['enable', 'disable', 'refresh', 'delete'].includes(op)) throw new HttpError(400, 'invalid');
  const c = await cpa.creds(0);
  const valid = list.filter((id) => isAG(c, id));
  const skipped = list.length - valid.length; // gone or not antigravity: reported, not silently dropped
  if (op === 'refresh') return { ok: valid.length, failed: 0, skipped, queued: quota.enqueue(valid) };
  let ok = 0;
  const failed: string[] = [];
  for (const id of valid) {
    try {
      if (op === 'delete') { await cpa.deleteCredential(id); quota.forget(id); auto.forgetAccount(id); sleeper.dropMark(id); }
      else { await cpa.setDisabled(id, op === 'disable'); auto.userToggled(id, op === 'disable'); sleeper.dropMark(id); }
      ok++;
    } catch { failed.push(id); }
  }
  await cpa.refreshCreds().catch(() => {});
  return { ok, failed: failed.length, skipped };
});

// ---------- quota ----------
route('GET', '/api/quota/progress', () => quota.progress());
route('POST', '/api/quota/refresh', async (req) => {
  const b = await readJSON(req);
  const list = ids(b.ids);
  const c = list.length ? await cpa.creds(5000) : null;
  const valid = c ? list.filter((id) => isAG(c, id)) : [];
  const queued = c ? quota.enqueue(valid) : await quota.enqueueAll();
  const probed = await auto.recheck(c ? valid : undefined).catch(() => 0);
  return { queued, probed, progress: quota.progress() };
});

// ---------- dashboard ----------
route('GET', '/api/overview', async () => {
  const list = await accountList();
  const n = counts(list);
  const src = usageSource();
  const usable = n.total - n.disabled;
  const bans = list.filter((a) => a.status === 'banned').map((a) => ({ id: a.id, email: a.email, reason: a.reason, action: a.action }));
  const autoOff = list.filter((a) => a.autoAt).sort((a, b) => b.autoAt - a.autoAt).map((a) => ({ id: a.id, email: a.email, reason: a.reason, at: a.autoAt, action: a.action }));
  return {
    counts: n,
    healthy: usable ? n.ok / usable : null,
    fam: { gemini: famSummary(list, 'gemini'), claude: famSummary(list, 'claude'), argon: famSummary(list, 'argon'), carbon: famSummary(list, 'carbon') },
    dots: list.map((a) => ({ id: a.id, email: a.email, status: a.status, reason: a.reason })),
    bans,
    autoOff,
    recent: src.recent(30),
    usageOK: src.available(),
    progress: quota.progress(),
  };
});

// ---------- add: Google OAuth through CPA's management flow ----------
const flows = new Map<string, { at: number; snap: Record<string, string>; result?: any }>();
route('POST', '/api/accounts/oauth', async () => {
  for (const [k, f] of flows) if (Date.now() - f.at > 15 * 60000) flows.delete(k);
  if (flows.size >= 5) throw new HttpError(429, 'too_many_pending');
  const c = await cpa.creds(0);
  const { url, state } = await cpa.oauthStart();
  flows.set(state, { at: Date.now(), snap: Object.fromEntries(c.list.map((x) => [x.id, x.updatedAt])) });
  return { url, state };
});
route('POST', '/api/accounts/oauth/callback', async (req) => {
  const b = await readJSON(req);
  const cb = str(b.url, 4000);
  let st = '';
  try { st = new URL(cb).searchParams.get('state') || ''; } catch { throw new HttpError(400, 'invalid_callback'); }
  if (!st || st !== String(b.state || '') || !flows.has(st)) throw new HttpError(400, 'state_mismatch');
  const r = await cpa.oauthCallback(cb);
  if (!r.ok) throw new HttpError(400, 'callback_rejected', r.error);
  return { ok: true };
});
route('GET', '/api/accounts/oauth/:state', async (_req, _res, p) => {
  const f = flows.get(p.state);
  if (!f) throw new HttpError(404, 'not_found');
  if (f.result) return f.result;
  const s = await cpa.oauthStatus(p.state);
  if (s.status === 'wait') return { status: 'wait' };
  if (s.status === 'error') return (f.result = { status: 'error', message: s.error });
  await cpa.refreshCreds();
  const c = await cpa.creds(0);
  const changed = c.list.filter((x) => x.type === 'antigravity' && f.snap[x.id] !== x.updatedAt);
  f.result = changed.length ? { status: 'ok', account: changed[0].id, email: changed[0].email, reauth: changed[0].id in f.snap } : { status: 'error', message: 'not_found' };
  if (changed[0]) quota.enqueue([changed[0].id]);
  return f.result;
});

// ---------- import CPA auth files (JSON, JSON array, or ZIP of them) ----------
type ImportResult = { name: string; ok: boolean; error?: string; id?: string; email?: string };
const SAFE_NAME = /^[A-Za-z0-9@._+-]{1,160}\.json$/;
async function importOne(name: string, data: Buffer, seen: Set<string>): Promise<ImportResult> {
  let j: any;
  try { j = JSON.parse(data.toString('utf8')); } catch { return { name, ok: false, error: 'invalid' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.type !== 'antigravity' || !(j.refresh_token || j.access_token)) return { name, ok: false, error: 'invalid' };
  const email = String(j.email || '').trim().toLowerCase();
  if (!email.includes('@')) return { name, ok: false, error: 'invalid' };
  const c = await cpa.creds(0);
  if (seen.has(email) || c.list.some((x) => x.email.toLowerCase() === email)) return { name, ok: false, error: 'duplicate', email };
  const base = name.split('/').pop() || '';
  const id = SAFE_NAME.test(base) && base.startsWith('antigravity-') ? base : `antigravity-${email.replace(/[^A-Za-z0-9@._+-]/g, '_').slice(0, 120)}.json`;
  if (c.byId.has(id)) return { name, ok: false, error: 'duplicate', email };
  await cpa.uploadCredential(id, Buffer.from(JSON.stringify(j)));
  seen.add(email);
  return { name, ok: true, id, email };
}
/** One item never throws: a CPA failure lands in that item's result, the ones before it keep theirs. */
async function tryOne(name: string, data: Buffer, seen: Set<string>): Promise<ImportResult> {
  try { return await importOne(name, data, seen); } catch (e) {
    return { name, ok: false, error: e instanceof HttpError ? e.code : 'failed' };
  }
}
async function importMany(name: string, data: Buffer, seen: Set<string>): Promise<ImportResult[]> {
  let j: any;
  try { j = JSON.parse(data.toString('utf8')); } catch { return [{ name, ok: false, error: 'invalid' }]; }
  if (!Array.isArray(j)) return [await tryOne(name, data, seen)];
  if (j.length > MAX_IDS) return [{ name, ok: false, error: 'too_many' }];
  const out: ImportResult[] = [];
  for (const [i, x] of j.entries()) out.push(await tryOne(`${name} #${i + 1}`, Buffer.from(JSON.stringify(x)), seen));
  return out;
}
const ZIP_TOTAL_BYTES = 16 * 1024 * 1024; // all entries together, unpacked
route('POST', '/api/accounts/import', async (req, _res, _p, url) => {
  const name = (url.searchParams.get('name') || 'upload.json').slice(0, 160);
  const buf = await readBody(req, config.maxBodyBytes);
  const seen = new Set<string>();
  const results: ImportResult[] = [];
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    let entries;
    try { entries = readZip(buf, 1000, 1024 * 1024, ZIP_TOTAL_BYTES, (n) => n.toLowerCase().endsWith('.json')); } catch (e) {
      throw (e as Error).message === 'too large' ? new HttpError(413, 'zip_too_large') : new HttpError(400, 'invalid_zip');
    }
    for (const e of entries) results.push(...(await importMany(e.name, e.data, seen)));
    if (!results.length) throw new HttpError(400, 'empty_zip');
  } else {
    results.push(...(await importMany(name, buf, seen)));
  }
  const added = results.filter((r) => r.ok).map((r) => r.id!);
  if (added.length) quota.enqueue(added);
  return { results };
});

// ---------- add via a Google refresh token: CPA exchanges it, Google's userinfo names the account ----------
const RT_RE = /^1\/\/[A-Za-z0-9_\-]{20,400}$/;
async function importRefreshToken(rt: string): Promise<ImportResult> {
  const name = rt.slice(0, 6) + '…' + rt.slice(-4);
  if (!RT_RE.test(rt)) return { name, ok: false, error: 'invalid_token' };
  const tmp = `antigravity-rt-${token(6)}.json`;
  try {
    await cpa.uploadCredential(tmp, Buffer.from(JSON.stringify({ type: 'antigravity', refresh_token: rt, disabled: true })));
    if (!(await cpa.refreshCredential(tmp)).ok) return { name, ok: false, error: 'invalid_token' };
    await cpa.refreshCreds();
    const t = (await cpa.creds(0)).byId.get(tmp);
    if (!t) return { name, ok: false, error: 'failed' };
    const ui = await cpa.apiCall(t.authIndex, 'GET', 'https://www.googleapis.com/oauth2/v2/userinfo', { Authorization: 'Bearer $TOKEN$' });
    let email = '';
    try { email = String(JSON.parse(ui.body)?.email || '').trim().toLowerCase(); } catch {}
    if (ui.status !== 200 || !email.includes('@')) return { name, ok: false, error: 'invalid_token' };
    const c = await cpa.creds(0);
    if (c.list.some((x) => x.id !== tmp && x.email && x.email.toLowerCase() === email)) return { name, ok: false, error: 'duplicate', email };
    const id = `antigravity-${email.replace(/[^A-Za-z0-9@._+-]/g, '_').slice(0, 120)}.json`;
    if (c.byId.has(id)) return { name, ok: false, error: 'duplicate', email };
    const j = await cpa.downloadCredential(tmp); // refreshed access token, project_id, capability hints
    if (!j || typeof j !== 'object' || !j.refresh_token) return { name, ok: false, error: 'failed' };
    for (const k of ['proxy_url', 'disabled', 'priority', 'prefix', 'base_url', 'headers', 'note']) delete j[k];
    j.type = 'antigravity';
    j.email = email;
    await cpa.uploadCredential(id, Buffer.from(JSON.stringify(j)));
    return { name, ok: true, id, email };
  } catch (e) {
    console.error('[rt-import]', (e as Error).message);
    return { name, ok: false, error: e instanceof HttpError ? e.code : 'failed' };
  } finally {
    await cpa.deleteCredential(tmp).catch(() => {});
  }
}
let rtLock: Promise<unknown> = Promise.resolve();
route('POST', '/api/accounts/refresh-token', async (req) => {
  const b = await readJSON(req);
  const list = [...new Set(String(b.tokens ?? '').split(/[\s,;]+/).map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean))];
  if (!list.length) throw new HttpError(400, 'invalid_token');
  if (list.length > 50) throw new HttpError(400, 'too_many_tokens');
  // one import at a time: each one briefly holds a temporary credential in CPA
  const job = rtLock.then(async () => {
    const results: ImportResult[] = [];
    for (const rt of list) results.push(await importRefreshToken(rt));
    const added = results.filter((r) => r.ok).map((r) => r.id!);
    if (added.length) quota.enqueue(added);
    await cpa.refreshCreds().catch(() => {});
    return { results };
  });
  rtLock = job.catch(() => {});
  return job;
});

// ---------- export: the CPA auth files as they are; one file -> .json, several -> .zip ----------
route('POST', '/api/accounts/export', async (req, res) => {
  const b = await readJSON(req);
  const c = await cpa.creds(0);
  const want = ids(b.ids);
  const list = want.length ? want : c.list.filter((x) => x.type === 'antigravity').map((x) => x.id);
  if (!list.length) throw new HttpError(404, 'not_found');
  // a backup with holes looks complete, so any credential that can't be read fails the whole export
  const files: { name: string; data: Buffer }[] = [];
  const missing: string[] = [];
  for (const id of list) {
    const j = isAG(c, id) ? await cpa.downloadCredential(id).catch(() => null) : null;
    if (j && typeof j === 'object' && !Array.isArray(j)) files.push({ name: id, data: Buffer.from(JSON.stringify(j, null, 2)) });
    else missing.push(c.byId.get(id)?.email || id);
  }
  if (missing.length) throw new HttpError(502, 'export_incomplete', missing.join(', '));
  const zip = files.length > 1;
  const out = zip ? writeZip(files) : files[0].data;
  const fname = zip ? `antigravity-auths-${new Date().toISOString().slice(0, 10)}.zip` : files[0].name;
  res.writeHead(200, {
    'Content-Type': zip ? 'application/zip' : 'application/json',
    'Content-Disposition': `attachment; filename="${fname.replace(/[^\w.@+-]/g, '_')}"`,
    'Content-Length': out.length, 'Cache-Control': 'no-store',
  });
  res.end(out);
});

// ---------- request log + usage (drained from CPA's usage queue) ----------
route('GET', '/api/logs', (_req, _res, _p, url) => {
  const q = url.searchParams;
  const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
  const src = usageSource();
  return {
    ...src.logs({ q: q.get('q') || '', account: q.get('account') || '', model: q.get('model') || '', status: q.get('status') || '', from: num('from'), to: num('to'), page: num('page'), size: num('size') }),
    ...(q.get('facets') ? { facets: src.facets() } : {}),
    available: src.available(),
  };
});
route('GET', '/api/logs/:id', (_req, _res, p) => {
  const r = usageSource().log(Number(p.id));
  if (!r) throw new HttpError(404, 'not_found');
  return r;
});
route('GET', '/api/usage', (_req, _res, _p, url) => {
  const src = usageSource();
  return { ...src.usage(url.searchParams.get('range') || '7d', Number(url.searchParams.get('tz') || 0)), available: src.available() };
});

// ---------- settings ----------
// CPA config switches shown on the settings page: [key, CPA config path, kind, min, max]
const CPA_SETTINGS: [string, string, 'bool' | 'int', number, number][] = [
  ['requestLog', 'observability/logs/request-log', 'bool', 0, 0],
  ['keepalive', 'requests/streaming/keepalive-seconds', 'int', 0, 300],
  ['bootstrapRetries', 'requests/streaming/bootstrap-retries', 'int', 0, 10],
  ['requestRetry', 'routing/retry/request-retry', 'int', 0, 10],
  ['maxRetryCredentials', 'routing/retry/max-retry-credentials', 'int', 0, 50],
  ['maxRetryInterval', 'routing/retry/max-retry-interval', 'int', 0, 600],
  ['disableCooling', 'routing/cooldown/disable-cooling', 'bool', 0, 0],
];
route('GET', '/api/settings', async () => {
  const ping = await cpa.ping();
  const cpaValues: Record<string, unknown> = {};
  if (ping.ok) {
    await Promise.all(CPA_SETTINGS.map(async ([k, path]) => {
      const v = await cpa.getConfig(path).catch(() => undefined);
      if (v !== undefined && v !== null && typeof v !== 'object') cpaValues[k] = v;
    }));
  }
  const src = usageSource();
  return { cpa: { url: config.cpaURL, ...ping }, usage: { kind: src.kind, ok: src.available() && !drainStatus(), error: drainStatus() }, values: cpaValues, app: settings() };
});
route('PATCH', '/api/settings', async (req) => {
  const b = await readJSON(req);
  const key = String(b.key || '');
  if (key === 'quotaRefreshMinutes') {
    setSettings({ quotaRefreshMinutes: clampInt(b.value, 0, 1440) });
    quota.startQuotaRefresher(5000);
    return { ok: true };
  }
  if (key === 'autoDisable' || key === 'autoEnable') {
    setSettings({ [key]: !!b.value });
    return { ok: true, value: !!b.value };
  }
  if (key === 'autoSleep') {
    setSettings({ autoSleep: !!b.value });
    if (!b.value) await sleeper.wakeAll();
    return { ok: true, value: !!b.value };
  }
  if (key === 'autoExclude') {
    setSettings({ autoExclude: !!b.value });
    await excluder.sync(); // off: takes this panel's entries out again
    return { ok: true, value: !!b.value };
  }
  const s = CPA_SETTINGS.find((x) => x[0] === key);
  if (!s) throw new HttpError(400, 'invalid');
  const v = s[2] === 'bool' ? !!b.value : clampInt(b.value, s[3], s[4]);
  await cpa.putConfig(s[1], v);
  return { ok: true, value: v };
});
route('GET', '/api/tiers', () => tiers());
route('POST', '/api/password', async (req) => { changePassword(req, await readJSON(req, 8192)); return { ok: true }; });

// ---------- client API keys (CPA access.api-keys) ----------
route('GET', '/api/keys', async () => ({ keys: await keys.list() }));
route('GET', '/api/keys/:id', async (_req, _res, p) => keys.reveal(p.id));
route('POST', '/api/keys', async (req) => {
  const b = await readJSON(req, 4096);
  return keys.add(b.key, b.generate === true, str(b.note, 40));
});
route('PATCH', '/api/keys/:id', async (req, _res, p) => ({ keys: await keys.setNote(p.id, str((await readJSON(req, 4096)).note, 40)) }));
route('DELETE', '/api/keys/:id', async (_req, _res, p) => ({ keys: await keys.remove(p.id) }));

// ---------- browser ----------
route('GET', '/api/browser', () => browser.view());
route('POST', '/api/browser/start', async (req) => {
  const b = await readJSON(req);
  const urls = Array.isArray(b.urls) ? b.urls.slice(0, 5).map((u: unknown) => str(u, 2048)).filter(Boolean) : undefined;
  const url = str(b.url, 2048) || undefined;
  return browser.start({ url, urls, fresh: b.fresh === true });
});
route('POST', '/api/browser/stop', () => browser.stop());


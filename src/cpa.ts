// Client for the CLIProxyAPI v8 management API. Only this server holds the management key.
import { config } from './config.ts';
import { HttpError } from './util.ts';
import type { Cooldown } from './accerr.ts';

export type Cred = {
  id: string;
  authIndex: string;
  type: string;
  email: string;
  disabled: boolean;
  status: string; // active | error | disabled | ...
  statusMessage: string;
  unavailable: boolean;
  nextRetryAfter: string | null;
  projectId: string;
  note: string;
  updatedAt: string;
  createdAt: string;
  cooldowns: Cooldown[]; // CPA's per-auth / per-model cooldowns (may include expired ones)
  success: number;
  failed: number;
  lastRefresh: string | null;
};

const numOr = (v: unknown, d: number | null) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
export function mapCooldowns(raw: unknown): Cooldown[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c) => c && typeof c === 'object').map((c: any) => {
    const rem = numOr(c.remaining_seconds ?? c.remainingSeconds, 0)!;
    const at = c.retry_at ?? c.retryAt;
    return {
      scope: String(c.scope || 'auth'),
      model: String(c.model_key ?? c.modelKey ?? c.model ?? ''),
      reason: String(c.reason || ''),
      retryAt: at ? String(at) : rem > 0 ? new Date(Date.now() + rem * 1000).toISOString() : null,
      remainingSeconds: rem,
      backoffLevel: numOr(c.backoff_level ?? c.backoffLevel, null),
      httpStatus: numOr(c.http_status ?? c.httpStatus, null),
    };
  });
}

async function mgmt(method: string, path: string, opts: { body?: unknown; raw?: Buffer | string; query?: Record<string, string>; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ status: number; data: any; etag: string }> {
  const url = new URL(config.cpaURL + '/v8/management' + path);
  for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { ...opts.headers, Authorization: 'Bearer ' + config.cpaMgmtKey };
  let body: any;
  if (opts.raw !== undefined) {
    body = opts.raw;
    headers['Content-Type'] = 'application/json';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    const t = AbortSignal.timeout(opts.timeoutMs ?? 15000);
    res = await fetch(url, { method, headers, body, signal: opts.signal ? AbortSignal.any([t, opts.signal]) : t });
  } catch (e) {
    throw new HttpError(502, 'cpa_unreachable', String((e as Error)?.message || e));
  }
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data, etag: res.headers.get('etag') || '' };
}

function expectOK(r: { status: number; data: any }, what: string) {
  if (r.status < 200 || r.status >= 300) {
    const msg = typeof r.data === 'object' && r.data ? r.data.error || r.data.message : String(r.data || '');
    throw new HttpError(r.status === 404 ? 404 : 502, 'cpa_' + what + '_failed', String(msg || r.status));
  }
  return r.data;
}

// ---------- credentials (cached) ----------
let credCache: { at: number; list: Cred[]; byId: Map<string, Cred>; byIndex: Map<string, string> } | null = null;
let credInflight: Promise<void> | null = null;

export function mapCred(f: any): Cred {
  return {
    id: String(f.id || f.name || ''),
    authIndex: String(f.auth_index || ''),
    type: String(f.type || f.provider || ''),
    email: String(f.email || f.account || ''),
    disabled: !!f.disabled,
    status: String(f.status || ''),
    statusMessage: String(f.status_message || ''),
    unavailable: !!f.unavailable,
    nextRetryAfter: f.next_retry_after ? String(f.next_retry_after) : null,
    projectId: String(f.project_id || ''),
    note: String(f.note || ''),
    updatedAt: String(f.updated_at || f.modtime || ''),
    createdAt: String(f.created_at || ''),
    cooldowns: mapCooldowns(f.cooldowns),
    success: Number(f.success) || 0,
    failed: Number(f.failed) || 0,
    lastRefresh: f.last_refresh ? String(f.last_refresh) : null,
  };
}

export async function refreshCreds(): Promise<void> {
  if (credInflight) return credInflight;
  credInflight = (async () => {
    const r = await mgmt('GET', '/credentials');
    const files: any[] = expectOK(r, 'list')?.files || [];
    const list = files.map(mapCred).filter((c) => c.id);
    const byId = new Map<string, Cred>();
    const byIndex = new Map<string, string>();
    for (const c of list) {
      byId.set(c.id, c);
      if (c.authIndex) byIndex.set(c.authIndex, c.id);
    }
    credCache = { at: Date.now(), list, byId, byIndex };
  })().finally(() => {
    credInflight = null;
  });
  return credInflight;
}

export type Creds = { list: Cred[]; byId: Map<string, Cred>; byIndex: Map<string, string> };
export async function creds(maxAgeMs = 10000): Promise<Creds> {
  if (!credCache || Date.now() - credCache.at > maxAgeMs) await refreshCreds();
  return credCache!;
}

export async function uploadCredential(name: string, json: Buffer) {
  expectOK(await mgmt('POST', '/credentials', { raw: json, query: { name } }), 'upload');
  await refreshCreds();
}

export async function setDisabled(id: string, disabled: boolean) {
  expectOK(await mgmt('PATCH', '/credentials/status', { body: { name: id, disabled } }), 'status');
  await refreshCreds();
}

export async function patchFields(id: string, fields: Record<string, unknown>) {
  expectOK(await mgmt('PATCH', '/credentials/fields', { body: { name: id, ...fields } }), 'fields');
  await refreshCreds();
}

/** Done once CPA accepts the DELETE; the list refresh after it is best effort (the cache drops the id either way). */
export async function deleteCredential(id: string) {
  expectOK(await mgmt('DELETE', '/credentials', { query: { name: id } }), 'delete');
  if (credCache?.byId.has(id)) {
    const c = credCache.byId.get(id)!;
    credCache.byId.delete(id);
    credCache.byIndex.delete(c.authIndex);
    credCache.list = credCache.list.filter((x) => x.id !== id);
  }
  await refreshCreds().catch(() => {});
}

/** Force CPA to refresh a credential's access token now (CPA also fills project_id on refresh). */
export async function refreshCredential(id: string, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  const r = await mgmt('POST', '/credentials/refresh', { query: { name: id }, timeoutMs: 30000, signal });
  if (r.status >= 200 && r.status < 300 && r.data?.ok !== false) return { ok: true };
  return { ok: false, error: String(r.data?.error || r.data?.message || r.status) };
}

export async function downloadCredential(id: string): Promise<any> {
  return expectOK(await mgmt('GET', '/credentials/download', { query: { name: id } }), 'download');
}

export async function credentialModels(id: string): Promise<any[]> {
  const d = expectOK(await mgmt('GET', '/credentials/models', { query: { name: id }, timeoutMs: 8000 }), 'models');
  return Array.isArray(d?.models) ? d.models : [];
}

// ---------- OAuth ----------
export async function oauthStart(): Promise<{ url: string; state: string }> {
  const d = expectOK(await mgmt('GET', '/oauth/auth-url', { query: { provider: 'antigravity' } }), 'oauth');
  if (!d?.url || !d?.state) throw new HttpError(502, 'cpa_oauth_failed');
  return { url: String(d.url), state: String(d.state) };
}

export async function oauthCallback(redirectURL: string): Promise<{ ok: boolean; error?: string }> {
  const r = await mgmt('POST', '/oauth/callback', { body: { provider: 'antigravity', redirect_url: redirectURL } });
  if (r.status >= 200 && r.status < 300) return { ok: true };
  return { ok: false, error: String(r.data?.error || r.status) };
}

export async function oauthStatus(state: string): Promise<{ status: 'ok' | 'wait' | 'error'; error?: string }> {
  const r = await mgmt('GET', '/oauth/status', { query: { state } });
  const d = r.data || {};
  if (d.status === 'ok') return { status: 'ok' };
  if (d.status === 'error') return { status: 'error', error: String(d.error || '') };
  return { status: 'wait' };
}

// ---------- upstream call through a credential (CPA swaps $TOKEN$ for the account's access token) ----------
export async function apiCall(authIndex: string, method: string, url: string, headers: Record<string, string>, data?: string, timeoutMs = 30000, signal?: AbortSignal): Promise<{ status: number; body: string }> {
  const r = await mgmt('POST', '/requests/api-call', {
    body: { auth_index: authIndex, method, url, header: headers, data: data ?? '' },
    timeoutMs, signal,
  });
  const d = expectOK(r, 'api_call');
  return { status: Number(d?.status_code || 0), body: String(d?.body || '') };
}


// ---------- usage queue (popping deletes; this app is its only reader) ----------
export async function popUsage(count: number): Promise<any[]> {
  const d = expectOK(await mgmt('GET', '/observability/usage/queue', { query: { count: String(count) }, timeoutMs: 8000 }), 'usage');
  return Array.isArray(d) ? d : [];
}

// ---------- config (hot-reloaded by CPA's config watcher) ----------
/** GET /config/<path>, e.g. 'requests/streaming'. undefined when CPA doesn't know the path. */
export async function getConfig(path: string): Promise<any> {
  const r = await mgmt('GET', '/config/' + path, { timeoutMs: 5000 });
  if (r.status === 404) return undefined;
  return expectOK(r, 'config');
}
/** PUT a scalar: CPA takes the raw JSON value as the body. */
export async function putConfig(path: string, value: number | boolean | string) {
  expectOK(await mgmt('PUT', '/config/' + path, { raw: JSON.stringify(value), timeoutMs: 8000 }), 'config');
}

// ---------- client API keys: access.api-keys, a plain string list (CPA has no dedicated v8 route for it) ----------
const KEYS = '/config/access/api-keys';
/** The list and the config ETag it was read at ('' when CPA sent none). */
export async function clientKeys(): Promise<{ keys: string[]; etag: string }> {
  const r = await mgmt('GET', KEYS, { timeoutMs: 8000 });
  if (r.status === 404) return { keys: [], etag: r.etag }; // no access.api-keys in the config
  const d = expectOK(r, 'keys');
  return { keys: Array.isArray(d) ? d.filter((k): k is string => typeof k === 'string') : [], etag: r.etag };
}
/** Replaces the whole list (CPA reloads it at once). false = the config changed since the read (412 on If-Match). */
export async function putClientKeys(keys: string[], etag: string): Promise<boolean> {
  const r = await mgmt('PUT', KEYS, { raw: JSON.stringify(keys), headers: etag ? { 'If-Match': etag } : {}, timeoutMs: 8000 });
  if (r.status === 412) return false;
  expectOK(r, 'keys');
  return true;
}

/** CPA's own up-check: the management API answers. */
export async function ping(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t = Date.now();
  try {
    const r = await mgmt('GET', '/config/requests/streaming', { timeoutMs: 4000 });
    return { ok: r.status < 500 && r.status !== 401, ms: Date.now() - t, error: r.status === 401 ? 'management key rejected' : undefined };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: (e as Error).message };
  }
}

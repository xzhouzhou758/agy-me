// Client for lbjlaq/Antigravity-Manager HTTP API and bidirectional credential sync with CLIProxyAPI.
import { config, agmOn, cpaOn } from './config.ts';
import { HttpError } from './util.ts';
import * as cpa from './cpa.ts';
import * as quota from './quota.ts';

export type AgmPing = {
  ok: boolean;
  ms: number;
  total: number;
  active: number;
  currentAccountId: string | null;
  error?: string;
};

export type AgmAccount = {
  id: string;
  email: string;
  name: string;
  disabled: boolean;
  isCurrent: boolean;
  quota: unknown;
  lastUsed: number;
};

function authHeaders(admin = true): Record<string, string> {
  const k = admin ? config.agmAdminKey : (config.agmApiKey || config.agmAdminKey);
  return {
    Authorization: 'Bearer ' + k,
    'x-api-key': k,
    Accept: 'application/json',
  };
}

async function agmReq(method: string, path: string, body?: unknown, timeoutMs = 15000): Promise<any> {
  if (!agmOn()) throw new HttpError(404, 'agm_disabled', 'Antigravity-Manager 未配置');
  const headers: Record<string, string> = authHeaders(true);
  let raw: string | undefined;
  if (body !== undefined) {
    raw = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(config.agmURL + path, {
      method,
      headers,
      body: raw,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new HttpError(502, 'agm_unreachable', String((e as Error)?.message || e));
  }
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = (typeof data === 'object' && data ? data.error?.message || data.error || data.message : text) || `HTTP ${res.status}`;
    throw new HttpError(res.status === 401 || res.status === 403 ? 502 : 502, 'agm_error', String(msg).slice(0, 200));
  }
  return data;
}

export async function ping(): Promise<AgmPing> {
  const t = Date.now();
  try {
    const data = await agmReq('GET', '/api/accounts', undefined, 5000);
    const list = Array.isArray(data?.accounts) ? data.accounts : [];
    const active = list.filter((a: any) => !a?.disabled && !a?.proxy_disabled).length;
    return {
      ok: true,
      ms: Date.now() - t,
      total: list.length,
      active,
      currentAccountId: data?.current_account_id ? String(data.current_account_id) : null,
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t,
      total: 0,
      active: 0,
      currentAccountId: null,
      error: String((e as Error)?.message || e).slice(0, 160),
    };
  }
}

export async function listAccounts(): Promise<AgmAccount[]> {
  const data = await agmReq('GET', '/api/accounts', undefined, 10000);
  const list = Array.isArray(data?.accounts) ? data.accounts : [];
  return list.map((a: any) => ({
    id: String(a.id || ''),
    email: String(a.email || ''),
    name: String(a.name || a.email || ''),
    disabled: Boolean(a.disabled || a.proxy_disabled),
    isCurrent: Boolean(a.is_current),
    quota: a.quota ?? null,
    lastUsed: Number(a.last_used || 0),
  }));
}

export async function refreshQuotas(): Promise<{ ok: true }> {
  await agmReq('POST', '/api/accounts/refresh', {}, 30000);
  return { ok: true };
}

export async function syncCpaToAgm(selectedIds?: string[]): Promise<{
  total: number; synced: number; skipped: number; failed: number; errors: string[];
}> {
  if (!cpaOn() || !agmOn()) throw new HttpError(400, 'backend_required', '需要同时配置 CPA 和 Antigravity-Manager');
  const [c, agmList] = await Promise.all([cpa.creds(0), listAccounts()]);
  const existing = new Set(agmList.map((a) => a.email.trim().toLowerCase()).filter(Boolean));
  const want = selectedIds?.length ? new Set(selectedIds) : null;
  const targets = c.list.filter((x) => x.type === 'antigravity' && (!want || want.has(x.id)));

  let synced = 0, skipped = 0, failed = 0;
  const errors: string[] = [];
  for (const acc of targets) {
    const em = String(acc.email || '').trim().toLowerCase();
    if (em && existing.has(em)) { skipped++; continue; }
    try {
      const cred = await cpa.downloadCredential(acc.id);
      const email = String(cred?.email || acc.email || '').trim().toLowerCase();
      const rt = String(cred?.refresh_token || '').trim();
      if (!email || !rt) {
        failed++;
        errors.push(`${acc.email || acc.id}: 缺少 refresh_token`);
        continue;
      }
      if (existing.has(email)) { skipped++; continue; }
      await agmReq('POST', '/api/accounts', { email, refreshToken: rt }, 20000);
      existing.add(email);
      synced++;
    } catch (e) {
      failed++;
      errors.push(`${acc.email || acc.id}: ${String((e as Error)?.message || e).slice(0, 100)}`);
    }
  }
  return { total: targets.length, synced, skipped, failed, errors: errors.slice(0, 10) };
}

export async function syncAgmToCpa(agmAccountIds?: string[]): Promise<{
  total: number; imported: number; skipped: number; failed: number; errors: string[];
}> {
  if (!cpaOn() || !agmOn()) throw new HttpError(400, 'backend_required', '需要同时配置 CPA 和 Antigravity-Manager');
  const [c, agmList] = await Promise.all([cpa.creds(0), listAccounts()]);
  const cpaEmails = new Set(c.list.map((x) => String(x.email || '').trim().toLowerCase()).filter(Boolean));
  const ids = agmAccountIds?.length ? agmAccountIds : agmList.map((a) => a.id).filter(Boolean);
  if (!ids.length) return { total: 0, imported: 0, skipped: 0, failed: 0, errors: [] };

  const exp = await agmReq('POST', '/api/accounts/export', { accountIds: ids }, 20000);
  const items: any[] = Array.isArray(exp) ? exp : (Array.isArray(exp?.accounts) ? exp.accounts : []);

  let imported = 0, skipped = 0, failed = 0;
  const errors: string[] = [];
  const addedIds: string[] = [];

  for (const item of items) {
    const email = String(item?.email || '').trim().toLowerCase();
    const rt = String(item?.refresh_token || item?.refreshToken || '').trim();
    if (!email || !email.includes('@') || !rt) {
      failed++;
      errors.push(`${email || 'unknown'}: 导出凭证缺少 email 或 refresh_token`);
      continue;
    }
    if (cpaEmails.has(email)) { skipped++; continue; }
    const id = `antigravity-${email.replace(/[^A-Za-z0-9@._+-]/g, '_').slice(0, 120)}.json`;
    if (c.byId.has(id)) { skipped++; continue; }
    try {
      await cpa.uploadCredential(id, Buffer.from(JSON.stringify({ type: 'antigravity', email, refresh_token: rt })));
      await cpa.refreshCredential(id).catch(() => {});
      cpaEmails.add(email);
      addedIds.push(id);
      imported++;
    } catch (e) {
      failed++;
      errors.push(`${email}: ${String((e as Error)?.message || e).slice(0, 100)}`);
    }
  }
  if (addedIds.length) {
    await cpa.refreshCreds().catch(() => {});
    quota.enqueue(addedIds);
  }
  return { total: items.length, imported, skipped, failed, errors: errors.slice(0, 10) };
}

// A small stand-in for CLIProxyAPI v8's management API, for tests and `npm run dev`.
import http from 'node:http';

export type MockCred = {
  id: string; email: string; disabled: boolean; note?: string; index: string; project_id?: string; updated_at: string;
  status?: string; status_message?: string; unavailable?: boolean; cooldowns?: any[] | null; type?: string;
  // what Google answers for this account through /requests/api-call
  tier?: string;                       // paidTier id, e.g. g1-pro-tier / g1-ultra-tier; none = free
  forbidden?: boolean;                 // 403 ToS ban on the quota calls
  quota?: { gemini?: [number, number]; claude?: [number, number]; argon?: number | null }; // [5h, weekly] fractions
};

const iso = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
const BAN = JSON.stringify({ error: { code: 403, message: 'This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.', status: 'PERMISSION_DENIED',
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TOS_VIOLATION', domain: 'cloudcode-pa.googleapis.com', metadata: { appeal_url: 'https://support.google.com/accounts/contact/disabled2' } }] } });

export function startMockCPA(opts: { mgmtKey: string }) {
  const st = {
    creds: new Map<string, MockCred>(),
    files: new Map<string, any>(),     // uploaded credential JSON by id
    oauth: new Map<string, { status: string }>(),
    nextIndex: 1,
    hang: new Set<string>(),           // auth ids whose api-call never answers
    noDownload: new Set<string>(),     // auth ids whose download fails
    queue: [] as any[],                // usage-queue records waiting to be popped
    queueDown: false,                  // the usage queue endpoint fails
    config: {
      'observability/logs/request-log': false,
      'requests/streaming/keepalive-seconds': 15,
      'requests/streaming/bootstrap-retries': 1,
      'routing/retry/request-retry': 2,
      'routing/retry/max-retry-credentials': 3,
      'routing/retry/max-retry-interval': 45,
      'routing/cooldown/disable-cooling': false,
      'access/api-keys': ['sk-mock-client-key-0001'],
    } as Record<string, unknown>,
    cfgVersion: 1,                      // the config ETag; any write bumps it
    keyRace: 0,                         // this many key-list writes first find the config changed (412)
    alias: [
      { name: 'claude-opus-5-5-high', alias: 'claude-opus-5-5', fork: true },
      { name: 'claude-opus-5-5-high', alias: 'claude-opus-5-5-low', fork: true },
      { name: 'claude-opus-5-5-high', alias: 'claude-opus-5-5-medium', fork: true },
      { name: 'gemini-3.8-flash-high', alias: 'gemini-3.8-flash', fork: true },
    ],
    models: ['claude-opus-5-5-high', 'claude-opus-5-5', 'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.8-flash', 'gemini-3-flash', 'claude-sonnet-4-6', 'gpt-oss-120b-medium'],
    calls: 0,                           // api-calls answered (quota reads)
    probes: [] as { id: string; model: string }[], // generateContent calls (auto-disable probes)
  };
  const addCred = (id: string, email: string, extra: Partial<MockCred> = {}) => {
    const c: MockCred = { id, email, disabled: false, index: (st.nextIndex++).toString(16).padStart(16, 'a'), project_id: 'p-' + id, updated_at: new Date().toISOString(), ...extra };
    st.creds.set(id, c);
    if (!st.files.has(id)) st.files.set(id, { type: 'antigravity', email, refresh_token: '1//rt-' + id, access_token: 'ya29.mock', project_id: c.project_id });
    return c;
  };

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    const b = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
    res.end(b);
  };
  const read = (req: http.IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

  function google(c: MockCred, url: string, data = '') {
    st.calls++;
    if (url.includes(':generateContent')) {
      let model = '';
      try { model = String(JSON.parse(data).model || ''); } catch {}
      st.probes.push({ id: c.id, model });
    }
    if (c.forbidden) return { status_code: 403, body: BAN };
    if (url.includes(':generateContent')) return { status_code: 200, body: JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'hi' }] } }] } }) };
    if (url.includes('oauth2/v2/userinfo')) {
      const rt = String(st.files.get(c.id)?.refresh_token || '');
      return rt.includes('BAD') ? { status_code: 401, body: '{}' } : { status_code: 200, body: JSON.stringify({ email: 'rt-' + rt.slice(-6).toLowerCase() + '@gmail.com' }) };
    }
    const q = c.quota || {};
    if (url.includes('loadCodeAssist')) {
      return { status_code: 200, body: JSON.stringify({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: c.project_id, ...(c.tier ? { paidTier: { id: c.tier, availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '1000' }] } } : {}) }) };
    }
    if (url.includes('fetchAvailableModels')) {
      const g = q.gemini || [1, 1], cl = q.claude || [1, 1];
      const models: Record<string, any> = {
        'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', quotaInfo: { remainingFraction: Math.min(...g), resetTime: iso(4) } },
        'gemini-3.8-flash-low': { displayName: 'Gemini 3.8 Flash (Low)', quotaInfo: { remainingFraction: Math.min(...g), resetTime: iso(4) } },
        'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', quotaInfo: { remainingFraction: Math.min(...cl), resetTime: iso(3) } },
        'chat_20706': { quotaInfo: { remainingFraction: 1 } },
      };
      if (q.argon != null) models['gemini-4-argon-high'] = { displayName: 'Gemini 4 Argon (High)', quotaInfo: { remainingFraction: q.argon, resetTime: iso(90) } };
      else models['gemini-4-argon-disabled'] = { displayName: 'Gemini 4 Argon', disabled: true };
      return { status_code: 200, body: JSON.stringify({ models, agentModelSorts: [{ groups: [{ modelIds: Object.keys(models).filter((m) => !m.startsWith('chat_')) }] }] }) };
    }
    if (url.includes('retrieveUserQuotaSummary')) {
      const g = q.gemini || [1, 1], cl = q.claude || [1, 1];
      const bk = (id: string, w: string, f: number, h: number) => ({ bucketId: id, displayName: w === '5h' ? 'Five Hour Limit Remaining' : 'Weekly Limit Remaining', window: w, remainingFraction: f, resetTime: iso(h) });
      return { status_code: 200, body: JSON.stringify({ groups: [
        { displayName: 'Gemini Models', buckets: [bk('gemini-weekly', 'weekly', g[1], 120), bk('gemini-5h', '5h', g[0], 4)] },
        { displayName: 'Claude and GPT models', buckets: [bk('3p-weekly', 'weekly', cl[1], 100), bk('3p-5h', '5h', cl[0], 3)] },
      ] }) };
    }
    return { status_code: 404, body: '' };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;
    const body = await read(req);
    if (!p.startsWith('/v8/management')) return json(res, 404, { error: 'not found' });
    if (req.headers.authorization !== 'Bearer ' + opts.mgmtKey) return json(res, 401, { error: 'bad key' });
    const sub = p.slice('/v8/management'.length);
    let b: any = {};
    try { b = body.length ? JSON.parse(body.toString()) : {}; } catch { if (req.method !== 'PUT') return json(res, 400, { error: 'invalid_json' }); }
    if (sub === '/credentials' && req.method === 'GET') {
      return json(res, 200, { files: [...st.creds.values()].map((c) => ({ id: c.id, name: c.id, auth_index: c.index, type: c.type || 'antigravity', provider: c.type || 'antigravity', email: c.email, disabled: c.disabled, status: c.disabled ? 'disabled' : c.status || 'active', status_message: c.disabled ? '' : c.status_message || '', unavailable: !c.disabled && !!c.unavailable, note: c.note, project_id: c.project_id, updated_at: c.updated_at, created_at: c.updated_at, cooldowns: c.cooldowns ?? [], success: 0, failed: 0 })) });
    }
    if (sub === '/credentials' && req.method === 'POST') {
      const name = url.searchParams.get('name')!;
      const j = JSON.parse(body.toString());
      st.files.set(name, j);
      addCred(name, j.email, { disabled: !!j.disabled });
      return json(res, 200, { status: 'ok' });
    }
    if (sub === '/credentials' && req.method === 'DELETE') {
      const id = url.searchParams.get('name')!;
      st.creds.delete(id);
      st.files.delete(id);
      return json(res, 200, { status: 'ok' });
    }
    if (sub === '/credentials/status') {
      const c = st.creds.get(b.name);
      if (!c) return json(res, 404, { error: 'auth file not found' });
      c.disabled = !!b.disabled;
      c.status = undefined; c.status_message = ''; c.unavailable = false; // like CPA: a toggle resets the status
      c.updated_at = new Date().toISOString();
      return json(res, 200, { status: 'ok' });
    }
    if (sub === '/credentials/fields') {
      const c = st.creds.get(b.name);
      if (!c) return json(res, 404, { error: 'auth file not found' });
      if ('note' in b) c.note = b.note;
      return json(res, 200, { status: 'ok' });
    }
    if (sub === '/credentials/refresh' && req.method === 'POST') return json(res, 200, { ok: true });
    if (sub === '/credentials/download') {
      if (st.noDownload.has(url.searchParams.get('name') || '')) return json(res, 500, { error: 'read failed' });
      const f = st.files.get(url.searchParams.get('name') || '');
      return f ? json(res, 200, f) : json(res, 404, { error: 'auth file not found' });
    }
    if (sub === '/credentials/models') {
      if (!st.creds.has(url.searchParams.get('name') || '')) return json(res, 200, { models: [] });
      return json(res, 200, { models: st.models.map((id) => ({ id, type: 'antigravity', owned_by: 'antigravity' })) });
    }
    if (sub === '/observability/usage/queue') {
      if (st.queueDown) return json(res, 500, { error: 'queue unavailable' });
      return json(res, 200, st.queue.splice(0, Math.max(1, Number(url.searchParams.get('count')) || 1)));
    }
    if (sub === '/config/oauth/model-alias') return json(res, 200, { antigravity: st.alias });
    if (sub.startsWith('/config/')) {
      // like CPA: an ETag on every read, If-Match fences writes (412), lists are replaced whole
      const k = sub.slice('/config/'.length), etag = () => `"v${st.cfgVersion}"`;
      if (req.method !== 'GET') {
        if (k === 'access/api-keys' && st.keyRace > 0) { st.keyRace--; st.cfgVersion++; }
        const im = req.headers['if-match'];
        if (im && im !== etag()) { res.setHeader('ETag', etag()); return json(res, 412, { error: 'precondition_failed' }); }
      }
      if (!(k in st.config)) return json(res, 404, { error: 'not found' });
      if (req.method === 'GET') { res.setHeader('ETag', etag()); return json(res, 200, st.config[k]); }
      if (req.method === 'PUT') {
        try { st.config[k] = JSON.parse(body.toString()); } catch { return json(res, 400, { error: 'invalid_json' }); }
        st.cfgVersion++;
        res.setHeader('ETag', etag());
        return json(res, 200, { status: 'ok', 'config-version': 8 });
      }
      if (req.method === 'DELETE') {
        delete st.config[k];
        st.cfgVersion++;
        return json(res, 200, { status: 'ok', 'config-version': 8 });
      }
    }
    if (sub === '/oauth/auth-url') {
      const state = 'st' + Math.random().toString(36).slice(2, 10);
      st.oauth.set(state, { status: 'wait' });
      return json(res, 200, { status: 'ok', url: 'https://accounts.google.com/o/oauth2/v2/auth?state=' + state, state });
    }
    if (sub === '/oauth/callback') {
      const u = new URL(b.redirect_url);
      const state = u.searchParams.get('state')!;
      const s = st.oauth.get(state);
      if (!s) return json(res, 404, { status: 'error', error: 'unknown or expired state' });
      const email = u.searchParams.get('code') + '@example.invalid'; // test hook: code = mailbox
      setTimeout(() => {
        const id = `antigravity-${email}.json`;
        const ex = st.creds.get(id);
        if (ex) ex.updated_at = new Date(Date.now() + 1000).toISOString();
        else addCred(id, email);
        s.status = 'ok';
      }, 200);
      return json(res, 200, { status: 'ok' });
    }
    if (sub === '/oauth/status') {
      const s = st.oauth.get(url.searchParams.get('state')!);
      if (!s) return json(res, 200, { status: 'error', error: 'unknown or expired state' });
      return json(res, 200, { status: s.status });
    }
    if (sub === '/requests/api-call') {
      const c = [...st.creds.values()].find((x) => x.index === b.auth_index);
      if (!c) return json(res, 400, { error: 'auth credential not found for auth_index' });
      if (st.hang.has(c.id)) return; // never answers
      return json(res, 200, google(c, String(b.url), String(b.data || '')));
    }
    return json(res, 404, { error: 'not found' });
  });
  return { server, st, addCred };
}

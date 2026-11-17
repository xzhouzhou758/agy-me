// Unified multi-backend gateway for agy-me:
//  - Main entrypoint (/v1/*, /v1beta/*): routes to active AGY backend (CPA or Antigravity-Manager),
//    or directly to self-use AI Studio 2 when per-key bound or model starts with `ais2/`.
//  - Dedicated entrypoint (/ais2/v1/*, /ais2/v1beta/*): always routes to self-use AI Studio 2.
//  - Authenticates client keys via keys.ts local snapshot (CPA-resilient) with optional per-key backend override.
import https from 'node:https';
import http, { type IncomingMessage, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { config, cpaOn, agmOn } from './config.ts';
import { sha256, readBody, HttpError } from './util.ts';
import { settings, type AgyBackend, type KeyBackend } from './store.ts';
import * as keys from './keys.ts';
import * as autosleep from './autosleep.ts';
import { usageSource } from './usage.ts';
import { aistudio2On, allowedAccounts, notifyAuthSuspect, NOT_ELIGIBLE_2, type AllowedAcc } from './aistudio2.ts';

// ---------- client API key verification (local snapshot backed + per-key backend binding) ----------
type KeyCacheEntry = {
  at: number;
  byHash: Map<string, { raw: string; backend: KeyBackend; cpaKnown: boolean }>;
  firstCpaKey: string;
};
let keyCache: KeyCacheEntry | null = null;
let keyInflight: Promise<KeyCacheEntry> | null = null;

export function invalidateClientKeyCache() {
  keyCache = null;
}

async function loadClientKeyCache(maxAgeMs: number): Promise<KeyCacheEntry> {
  if (keyCache && Date.now() - keyCache.at <= maxAgeMs) return keyCache;
  if (keyInflight) return keyInflight;
  keyInflight = (async () => {
    try {
      const snap = await keys.rawKeysSnapshot();
      const byHash = new Map<string, { raw: string; backend: KeyBackend; cpaKnown: boolean }>();
      for (const k of snap.keys) {
        const h = sha256(k);
        byHash.set(h, { raw: k, backend: snap.backends[h] || 'auto', cpaKnown: snap.cpaSet.has(k) });
      }
      const entry: KeyCacheEntry = { at: Date.now(), byHash, firstCpaKey: snap.firstCpaKey };
      keyCache = entry;
      return entry;
    } catch (e) {
      if (keyCache) return keyCache;
      throw e;
    }
  })().finally(() => {
    keyInflight = null;
  });
  return keyInflight;
}

async function verifyClientKey(raw: string): Promise<{
  ok: boolean; keyHash: string; rawKey: string; firstCpaKey: string; cpaKnown: boolean; boundBackend: KeyBackend; authDown?: boolean;
}> {
  const h = sha256(raw);
  try {
    let entry = await loadClientKeyCache(5000);
    let hit = entry.byHash.get(h);
    if (hit) return { ok: true, keyHash: h, rawKey: hit.raw, firstCpaKey: entry.firstCpaKey, cpaKnown: hit.cpaKnown, boundBackend: hit.backend };
    if (!keyCache || Date.now() - keyCache.at > 1000) {
      entry = await loadClientKeyCache(0);
      hit = entry.byHash.get(h);
      if (hit) return { ok: true, keyHash: h, rawKey: hit.raw, firstCpaKey: entry.firstCpaKey, cpaKnown: hit.cpaKnown, boundBackend: hit.backend };
    }
    return { ok: false, keyHash: h, rawKey: '', firstCpaKey: '', cpaKnown: false, boundBackend: 'auto' };
  } catch {
    return { ok: false, keyHash: h, rawKey: '', firstCpaKey: '', cpaKnown: false, boundBackend: 'auto', authDown: true };
  }
}

function clientKey(req: IncomingMessage, url: URL): string {
  const a = req.headers.authorization;
  if (a && /^bearer\s+/i.test(a)) return a.replace(/^bearer\s+/i, '').trim();
  const x = req.headers['x-api-key'] || req.headers['x-goog-api-key'];
  if (typeof x === 'string' && x) return x.trim();
  return (url.searchParams.get('key') || '').trim();
}

// ---------- protocol-shaped gateway errors ----------
type Dialect = 'openai' | 'anthropic' | 'gemini';
function dialectOf(path: string): Dialect {
  if (/^\/v1\/messages(\/|$)/.test(path)) return 'anthropic';
  if (/^\/(v1beta|v1alpha|v1internal)\//.test(path) || /:(stream)?generateContent|:countTokens/i.test(path)) return 'gemini';
  return 'openai';
}
const ANTH: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 502: 'api_error', 503: 'overloaded_error' };
const GSTAT: Record<number, string> = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 413: 'INVALID_ARGUMENT', 429: 'RESOURCE_EXHAUSTED', 502: 'UNAVAILABLE', 503: 'UNAVAILABLE' };

export function errorBody(path: string, status: number, code: string, message: string): string {
  switch (dialectOf(path)) {
    case 'anthropic':
      return JSON.stringify({ type: 'error', error: { type: ANTH[status] || (status >= 500 ? 'api_error' : 'invalid_request_error'), message } });
    case 'gemini':
      return JSON.stringify({ error: { code: status, message, status: GSTAT[status] || (status >= 500 ? 'INTERNAL' : 'FAILED_PRECONDITION') } });
    default:
      return JSON.stringify({ error: { message, type: code, code } });
  }
}

export function sendGatewayError(res: ServerResponse, path: string, status: number, code: string, message: string, retryAfter?: number) {
  if (res.headersSent) return res.destroy();
  const body = errorBody(path, status, code, message);
  const h: Record<string, string | number> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  };
  if (retryAfter && retryAfter > 0) h['Retry-After'] = String(Math.ceil(retryAfter));
  res.writeHead(status, h);
  res.end(body);
}

// ---------- usage sniffer (OpenAI / Responses / Anthropic / Gemini, streaming or JSON) ----------
export type Tok = { in: number; out: number; think: number; cache: number; cacheWrite: number; total: number };
export function usageSniffer() {
  const t: Tok = { in: 0, out: 0, think: 0, cache: 0, cacheWrite: 0, total: 0 };
  let rest = '', whole = '', wholeOK = true;
  const max = (k: keyof Tok, v: unknown) => { const n = Number(v); if (Number.isFinite(n) && n > t[k]) t[k] = Math.round(n); };
  const take = (j: any) => {
    if (!j || typeof j !== 'object') return;
    if (Array.isArray(j)) return j.forEach(take);
    const a = j.message?.usage || (j.type === 'message_delta' || j.type === 'message' ? j.usage : null);
    if (a) {
      const cr = Number(a.cache_read_input_tokens || 0), cw = Number(a.cache_creation_input_tokens || 0);
      if (a.input_tokens != null) max('in', Number(a.input_tokens) + cr + cw);
      max('cache', cr); max('cacheWrite', cw); max('out', a.output_tokens);
    } else if (j.usage || (j.type === 'response.completed' && j.response?.usage)) {
      const u = j.usage || j.response.usage;
      max('in', u.prompt_tokens ?? u.input_tokens); max('out', u.completion_tokens ?? u.output_tokens);
      max('cache', u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens);
      max('think', u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens);
      max('total', u.total_tokens);
    }
    const g = j.usageMetadata || j.response?.usageMetadata;
    if (g) {
      max('in', g.promptTokenCount); max('out', g.candidatesTokenCount);
      max('think', g.thoughtsTokenCount); max('cache', g.cachedContentTokenCount); max('total', g.totalTokenCount);
    }
  };
  const line = (l: string) => {
    const m = /^data:\s?(.*)$/.exec(l.trim());
    if (!m || m[1] === '[DONE]' || !m[1].includes('sage')) return;
    try { take(JSON.parse(m[1])); } catch {}
  };
  return {
    feed(c: Buffer) {
      const s = c.toString('utf8');
      if (wholeOK) {
        if (/^\s*(data:|event:)/m.test(s)) { wholeOK = false; whole = ''; }
        else { whole += s; if (whole.length > 4 << 20) { wholeOK = false; whole = ''; } }
      }
      const parts = (rest + s).split('\n');
      rest = parts.pop() || '';
      if (rest.length > 1 << 20) rest = '';
      for (const p of parts) line(p);
    },
    done(): Tok {
      if (rest) line(rest);
      if (wholeOK && whole && !/^\s*(data:|event:)/m.test(whole)) { try { take(JSON.parse(whole)); } catch {} }
      if (!t.total && (t.in || t.out || t.think)) t.total = t.in + t.out + t.think;
      return t;
    },
  };
}

// ---------- session affinity key ----------
const SESSION_HEADERS = ['x-claude-code-session-id', 'session-id', 'session_id', 'x-session-id', 'x-session-affinity', 'x-conversation-id', 'x-thread-id', 'thread-id'];
function explicitID(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s && s.length <= 200 ? s : '';
}
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  const parts: string[] = [];
  for (const it of v) {
    if (typeof it === 'string') parts.push(it);
    else if (it && typeof it === 'object') {
      const o = it as any;
      if (typeof o.text === 'string') parts.push(o.text);
      else if (typeof o.content === 'string') parts.push(o.content);
    }
  }
  return parts.join('\n');
}
function conversationAnchor(b: any): string {
  if (!b || typeof b !== 'object') return '';
  let sys = textOf(b.system ?? b.systemInstruction ?? b.system_instruction ?? b.instructions);
  let user = '';
  const list = Array.isArray(b.messages) ? b.messages : (Array.isArray(b.contents) ? b.contents : (Array.isArray(b.input) ? b.input : null));
  if (list) {
    for (const m of list) {
      const role = String(m?.role || '').toLowerCase();
      if (!sys && (role === 'system' || role === 'developer')) sys = textOf(m.content);
      if (!user && (role === 'user' || (!role && list === b.contents))) user = textOf(m.content ?? m.parts ?? m);
      if (sys && user) break;
    }
  }
  if (!user && typeof b.input === 'string') user = b.input;
  if (!user && typeof b.prompt === 'string') user = b.prompt;
  if (!sys && !user) return '';
  return sys.slice(0, 20000) + '\u0000' + user.slice(0, 20000);
}
function claudeSession(userID: string): string {
  if (userID.startsWith('{')) {
    try { return explicitID(JSON.parse(userID)?.session_id); } catch { return ''; }
  }
  const m = /_session_([0-9a-zA-Z-]+)$/.exec(userID);
  return m ? m[1] : userID;
}
function deriveSessionKey(keyHash: string, model: string, headers: IncomingHttpHeaders, body: any): string {
  let source = '', value = '';
  for (const h of SESSION_HEADERS) {
    const v = explicitID(Array.isArray(headers[h]) ? (headers[h] as string[])[0] : headers[h]);
    if (v) { source = 'header'; value = v; break; }
  }
  const b = body && typeof body === 'object' ? body : null;
  if (!value && b) {
    const pck = explicitID(b.prompt_cache_key ?? b.promptCacheKey);
    if (pck) { source = 'prompt_cache_key'; value = pck; }
  }
  if (!value && b) {
    const uid = typeof b.metadata?.user_id === 'string' ? b.metadata.user_id.trim() : '';
    const sid = uid ? explicitID(claudeSession(uid)) : '';
    if (sid) { source = 'claude_user_id'; value = sid; }
  }
  if (!value && b) {
    const a = conversationAnchor(b);
    if (a) { source = 'first_message'; value = a; }
  }
  if (!value) return '';
  return createHash('sha256').update(['agyme-ais2:v1', keyHash, model.toLowerCase(), source, value].join('\u0000')).digest('hex').slice(0, 24);
}

// ---------- headers & model parsing ----------
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding', 'cookie', 'authorization', 'x-api-key', 'x-goog-api-key', 'x-real-ip', 'forwarded']);
const RESP_DROP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'x-cpa-trace-id']);
const AIS_DROP = (k: string) => k.startsWith('x-relay-') || k === 'x-google-cookies' || k === 'x-goog-authuser' || k === 'x-aistudio-g1-tier' || k === 'x-aistudio-account' || k.startsWith('x-aistudio-');

export function forwardHeaders(h: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (v === undefined || HOP.has(lk) || lk.startsWith('x-agy') || lk.startsWith('x-forwarded-') || AIS_DROP(lk)) continue;
    out[lk] = v;
  }
  return out;
}

function modelFrom(path: string, body: Buffer, ct: string | undefined): { model: string; stream: boolean; json: any } {
  let model = '', stream = false, json: any = null;
  const m = /\/models\/([^/:]+)(?::(\w+))?/.exec(path);
  if (m) {
    model = decodeURIComponent(m[1]);
    if (m[2] && /stream/i.test(m[2])) stream = true;
  }
  if (body.length && (!ct || ct.includes('json'))) {
    try {
      const j = JSON.parse(body.toString('utf8'));
      json = j;
      if (typeof j?.model === 'string') model = j.model;
      if (j?.stream === true) stream = true;
    } catch {}
  }
  return { model: model.slice(0, 160), stream, json };
}

function stripAIS2Prefix(P: string, body: Buffer, json: any): {
  prefixed: boolean; nextPath: string; nextBody: Buffer; nextJson: any;
} {
  let prefixed = false;
  let nextPath = P;
  let nextBody = body;
  let nextJson = json;

  const pm = /^(\/v1(?:beta)?\/models\/)([^/:]+)((?::\w+)?)$/.exec(P);
  if (pm) {
    const rawId = decodeURIComponent(pm[2]);
    if (/^ais2\//i.test(rawId)) {
      prefixed = true;
      nextPath = pm[1] + encodeURIComponent(rawId.slice(5)) + pm[3];
    }
  }
  if (json && typeof json === 'object' && !Array.isArray(json) && typeof json.model === 'string' && /^ais2\//i.test(json.model)) {
    prefixed = true;
    nextJson = structuredClone(json);
    nextJson.model = nextJson.model.slice(5);
    nextBody = Buffer.from(JSON.stringify(nextJson));
  }
  return { prefixed, nextPath, nextBody, nextJson };
}

function thinkingFix(j: any): boolean {
  const m = String(j.model || '').replace(/^models\//, '');
  const suffix = m.match(/-(high|medium|low|minimal)$/i)?.[1].toLowerCase();
  const noMinimal = !/flash/i.test(m);
  let changed = false;
  const fix = (o: any, k: string) => {
    if (!o || typeof o !== 'object' || typeof o[k] !== 'string') return;
    let v = suffix || o[k];
    if (noMinimal && v.trim().toLowerCase() === 'minimal') v = 'low';
    if (v !== o[k]) { o[k] = v; changed = true; }
  };
  for (const o of [j, j.extra_body]) {
    if (!o || typeof o !== 'object') continue;
    fix(o, 'reasoning_effort'); fix(o, 'reasoningEffort'); fix(o.reasoning, 'effort');
    for (const c of [o.thinking_config, o.thinkingConfig, o.google?.thinking_config]) { fix(c, 'thinking_level'); fix(c, 'thinkingLevel'); }
  }
  return changed;
}

const AIS2_TIER_EXPAND = new Set(['gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash']);
const AIS2_TIER_ORDER: Array<[string, string]> = [
  ['extra_high', 'xhigh'],
  ['high', 'high'],
  ['medium', 'medium'],
  ['low', 'low'],
  ['minimal', 'minimal'],
];

export function parseAIS2ModelTier(rawModel: string): { baseModel: string; suffix: string; apiEffort: string } | null {
  const trimmed = rawModel.trim();
  const hasPrefix = /^models\//i.test(trimmed);
  const clean = trimmed.replace(/^models\//i, '');
  const m = /^((?:gemini|gemma)-[a-z0-9._-]+?)-(minimal|low|medium|high|xhigh|extra_high|extra-high|max)(-search)?$/i.exec(clean);
  if (!m) return null;
  const rawTier = m[2].toLowerCase();
  const suffix = rawTier === 'extra_high' || rawTier === 'extra-high' || rawTier === 'max' ? 'xhigh' : rawTier;
  const baseClean = m[1] + (m[3] ? '-search' : '');
  return {
    baseModel: hasPrefix ? 'models/' + baseClean : baseClean,
    suffix,
    apiEffort: suffix,
  };
}

export function isAIS2SlimModel(rawId: string): boolean {
  const id = rawId.replace(/^models\//i, '').toLowerCase();
  if (!id.startsWith('gemini-')) return false;
  if (/-(search|build|tts|live|latest)(-|$)/.test(id)) return false;
  if (/(transcribe|translate|robotics|decision|omni|extended-thinking)/.test(id)) return false;
  return true;
}

export function expandAIS2ModelList(bodyText: string, slim = false): string {
  let j: any;
  try { j = JSON.parse(bodyText); } catch { return bodyText; }
  if (!j || typeof j !== 'object') return bodyText;

  if (Array.isArray(j.data)) {
    const src = slim ? j.data.filter((m: any) => isAIS2SlimModel(String(m?.id || ''))) : j.data;
    const have = new Set(src.map((m: any) => String(m?.id || '')));
    const out: any[] = [];
    for (const item of src) {
      out.push(item);
      const id = String(item?.id || '');
      if (!AIS2_TIER_EXPAND.has(id)) continue;
      const rawLevels: string[] = Array.isArray(item.thinking_levels) && item.thinking_levels.length
        ? item.thinking_levels.map((x: unknown) => String(x).toLowerCase())
        : id === 'gemini-4-hydrogen' ? ['low', 'medium', 'high', 'extra_high'] : ['low', 'medium', 'high'];
      const lvlSet = new Set(rawLevels);
      for (const [rawLvl, suf] of AIS2_TIER_ORDER) {
        if (!lvlSet.has(rawLvl)) continue;
        const vid = `${id}-${suf}`;
        if (have.has(vid)) continue;
        have.add(vid);
        const clone = { ...item, id: vid, default_thinking_level: rawLvl };
        if (typeof clone.name === 'string' && clone.name) clone.name = `${clone.name} (${suf.toUpperCase()})`;
        out.push(clone);
      }
    }
    j.data = out;
    if ('first_id' in j) j.first_id = j.data?.[0]?.id ?? null;
    if ('last_id' in j) j.last_id = j.data?.length ? j.data[j.data.length - 1].id : null;
    return JSON.stringify(j);
  }

  if (Array.isArray(j.models)) {
    const src = slim ? j.models.filter((m: any) => isAIS2SlimModel(String(m?.name || m?.id || ''))) : j.models;
    const have = new Set(src.map((m: any) => String(m?.name || '')));
    const out: any[] = [];
    for (const item of src) {
      out.push(item);
      const rawName = String(item?.name || '');
      const id = rawName.replace(/^models\//i, '');
      if (!AIS2_TIER_EXPAND.has(id)) continue;
      const rawLevels: string[] = Array.isArray(item.thinkingLevels) && item.thinkingLevels.length
        ? item.thinkingLevels.map((x: unknown) => String(x).toLowerCase())
        : id === 'gemini-4-hydrogen' ? ['low', 'medium', 'high', 'extra_high'] : ['low', 'medium', 'high'];
      const lvlSet = new Set(rawLevels);
      for (const [rawLvl, suf] of AIS2_TIER_ORDER) {
        if (!lvlSet.has(rawLvl)) continue;
        const vname = `models/${id}-${suf}`;
        if (have.has(vname)) continue;
        have.add(vname);
        const clone = { ...item, name: vname, defaultThinkingLevel: rawLvl.toUpperCase() };
        if (typeof clone.displayName === 'string' && clone.displayName) clone.displayName = `${clone.displayName} (${suf.toUpperCase()})`;
        out.push(clone);
      }
    }
    j.models = out;
    return JSON.stringify(j);
  }

  return bodyText;
}

export function filterAIS2ModelsByPick(bodyText: string, picks: string[] | null | undefined): string {
  if (!picks || !picks.length) return bodyText;
  const allow = new Set(picks.map((x) => x.replace(/^models\//i, '').toLowerCase()));
  let j: any;
  try { j = JSON.parse(bodyText); } catch { return bodyText; }
  if (!j || typeof j !== 'object') return bodyText;
  if (Array.isArray(j.data)) {
    j.data = j.data.filter((m: any) => allow.has(String(m?.id || '').replace(/^models\//i, '').toLowerCase()));
    if ('first_id' in j) j.first_id = j.data?.[0]?.id ?? null;
    if ('last_id' in j) j.last_id = j.data?.length ? j.data[j.data.length - 1].id : null;
    return JSON.stringify(j);
  }
  if (Array.isArray(j.models)) {
    j.models = j.models.filter((m: any) => allow.has(String(m?.name || m?.id || '').replace(/^models\//i, '').toLowerCase()));
    return JSON.stringify(j);
  }
  return bodyText;
}

export function rewriteAIS2TierRequest(
  P: string,
  body: Buffer,
  ct: string,
  parsedJson?: any,
): { upstreamPath: string; body: Buffer; baseModel?: string; effort?: string; requestedSingleId?: string } {
  const gm = /^(\/v1(?:beta)?\/models\/)([^/:]+)$/.exec(P);
  if (gm) {
    const rawId = decodeURIComponent(gm[2]);
    const parsed = parseAIS2ModelTier(rawId);
    if (parsed) {
      return { upstreamPath: gm[1] + encodeURIComponent(parsed.baseModel.replace(/^models\//i, '')), body, baseModel: parsed.baseModel, effort: parsed.apiEffort, requestedSingleId: rawId };
    }
    return { upstreamPath: P, body };
  }

  const bm = /^(\/v1(?:beta)?\/models\/)([^/:]+)(:\w+)$/.exec(P);
  if (bm) {
    const rawId = decodeURIComponent(bm[2]);
    const parsed = parseAIS2ModelTier(rawId);
    let nextPath = P;
    let nextBody = body;
    if (parsed) {
      nextPath = bm[1] + encodeURIComponent(parsed.baseModel.replace(/^models\//i, '')) + bm[3];
      if (body.length && (!ct || ct.includes('json')) && !/:countTokens$/i.test(bm[3])) {
        try {
          const j = parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
            ? structuredClone(parsedJson)
            : JSON.parse(body.toString('utf8'));
          if (j && typeof j === 'object' && !Array.isArray(j)) {
            j.generationConfig = j.generationConfig && typeof j.generationConfig === 'object' ? j.generationConfig : {};
            j.generationConfig.thinkingConfig = j.generationConfig.thinkingConfig && typeof j.generationConfig.thinkingConfig === 'object'
              ? j.generationConfig.thinkingConfig : {};
            j.generationConfig.thinkingConfig.thinkingLevel = parsed.apiEffort;
            nextBody = Buffer.from(JSON.stringify(j));
          }
        } catch {}
      }
      return { upstreamPath: nextPath, body: nextBody, baseModel: parsed.baseModel, effort: parsed.apiEffort };
    }
    return { upstreamPath: P, body };
  }

  if (!body.length || (ct && !ct.includes('json'))) return { upstreamPath: P, body };
  let j: any = parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson) ? structuredClone(parsedJson) : null;
  if (!j) { try { j = JSON.parse(body.toString('utf8')); } catch { return { upstreamPath: P, body }; } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { upstreamPath: P, body };

  let changed = false;
  if ('cookies' in j) { delete j.cookies; changed = true; }

  const rawModel = typeof j.model === 'string' ? j.model : '';
  const parsed = rawModel ? parseAIS2ModelTier(rawModel) : null;
  if (parsed) {
    j.model = parsed.baseModel;
    changed = true;
    const eff = parsed.apiEffort;
    if (P === '/v1/chat/completions') {
      j.reasoning_effort = eff;
      if (j.stream === true && (!j.stream_options || typeof j.stream_options !== 'object' || Array.isArray(j.stream_options) || j.stream_options.include_usage !== true)) {
        j.stream_options = { ...(j.stream_options && typeof j.stream_options === 'object' && !Array.isArray(j.stream_options) ? j.stream_options : {}), include_usage: true };
      }
      if (j.reasoning && typeof j.reasoning === 'object') j.reasoning.effort = eff;
      if (j.extra_body && typeof j.extra_body === 'object') {
        if ('reasoning_effort' in j.extra_body) j.extra_body.reasoning_effort = eff;
        if (j.extra_body.reasoning && typeof j.extra_body.reasoning === 'object') j.extra_body.reasoning.effort = eff;
        for (const c of [j.extra_body.thinking_config, j.extra_body.thinkingConfig, j.extra_body.google?.thinking_config]) {
          if (c && typeof c === 'object') {
            if ('thinking_level' in c || !('thinkingLevel' in c)) c.thinking_level = eff;
            if ('thinkingLevel' in c) c.thinkingLevel = eff;
          }
        }
      }
    } else if (P === '/v1/messages') {
      j.output_config = { ...(j.output_config && typeof j.output_config === 'object' ? j.output_config : {}), effort: eff };
      if (j.thinking?.type === 'disabled') delete j.thinking;
    } else if (P === '/v1/responses') {
      j.reasoning = { ...(j.reasoning && typeof j.reasoning === 'object' ? j.reasoning : {}), effort: eff };
      if (Array.isArray(j.input)) {
        for (const it of j.input) {
          if (it && typeof it === 'object' && it.type === 'configuration_update' && it.reasoning && typeof it.reasoning === 'object') {
            it.reasoning.effort = eff;
          }
        }
      }
    } else if (P === '/v1/messages/count_tokens') {
      // Only rewrite model name
    }
    return {
      upstreamPath: P,
      body: Buffer.from(JSON.stringify(j)),
      baseModel: parsed.baseModel.replace(/^models\//i, ''),
      effort: eff,
    };
  }

  if (P === '/v1/chat/completions') {
    if (thinkingFix(j)) changed = true;
    if (j.stream === true && (!j.stream_options || typeof j.stream_options !== 'object' || Array.isArray(j.stream_options) || j.stream_options.include_usage !== true)) {
      j.stream_options = { ...(j.stream_options && typeof j.stream_options === 'object' && !Array.isArray(j.stream_options) ? j.stream_options : {}), include_usage: true };
      changed = true;
    }
  }
  const explicitEff = typeof j.reasoning_effort === 'string' ? j.reasoning_effort
    : typeof j.reasoning?.effort === 'string' ? j.reasoning.effort
    : typeof j.output_config?.effort === 'string' ? j.output_config.effort
    : typeof j.extra_body?.google?.thinking_config?.thinking_level === 'string' ? j.extra_body.google.thinking_config.thinking_level
    : undefined;
  return {
    upstreamPath: P,
    body: changed ? Buffer.from(JSON.stringify(j)) : body,
    effort: explicitEff ? explicitEff.toLowerCase().slice(0, 20) : undefined,
  };
}

// ---------- cooldown & round-robin for AIS2 ----------
let ais2Rr = 0;
const ais2DownUntil = new Map<string, number>();
const ais2SessionLast = new Map<string, string>();
const markAIS2Down = (id: string, ms: number) => ais2DownUntil.set(id, Date.now() + ms);
const isAIS2Down = (id: string) => (ais2DownUntil.get(id) || 0) > Date.now();

setInterval(() => {
  const t = Date.now();
  for (const [id, until] of ais2DownUntil) if (until <= t) ais2DownUntil.delete(id);
  if (ais2SessionLast.size > 2000) ais2SessionLast.clear();
}, 60000).unref();

function orderAccounts(allAccs: AllowedAcc[], sk: string): AllowedAcc[] {
  if (!allAccs.length) return [];
  const idx = (ais2Rr = (ais2Rr + 1) >>> 0) % allAccs.length;
  const rotated = [...allAccs.slice(idx), ...allAccs.slice(0, idx)];
  const healthy = rotated.filter((a) => !isAIS2Down(a.id));
  const cooling = rotated.filter((a) => isAIS2Down(a.id));
  const ordered = [...healthy, ...cooling];
  if (sk) {
    const prev = ais2SessionLast.get(sk);
    if (prev && healthy.some((a) => a.id === prev)) {
      const i = ordered.findIndex((a) => a.id === prev);
      if (i > 0) {
        const [picked] = ordered.splice(i, 1);
        ordered.unshift(picked);
      }
    }
  }
  return ordered;
}

export function errMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    const e = (Array.isArray(j) ? j[0] : j)?.error;
    const m = typeof e === 'string' ? e : e?.message;
    if (m) return String(m).replace(/\s+/g, ' ').slice(0, 200);
  } catch {}
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

const zeroTok = (): Tok => ({ in: 0, out: 0, think: 0, cache: 0, cacheWrite: 0, total: 0 });

// ---------- CPA / Antigravity-Manager forwarding ----------
async function forwardAGY(
  backend: AgyBackend,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  P: string,
  url: URL,
  body: Buffer,
  requestedModel: string,
  streamHint: boolean,
  auth: { rawKey: string; firstCpaKey: string; cpaKnown: boolean },
) {
  const targetBase = backend === 'cpa' ? config.cpaURL : config.agmURL;
  const t = new URL(targetBase);
  const tls = t.protocol === 'https:';
  const sp = new URLSearchParams(url.search);
  if (backend === 'agm') sp.delete('key');
  const qs = sp.toString() ? '?' + sp.toString() : '';
  const upPath = t.pathname.replace(/\/+$/, '') + P + qs;

  const headers = forwardHeaders(req.headers);
  const apiKey = backend === 'cpa'
    ? (auth.cpaKnown ? auth.rawKey : (auth.firstCpaKey || auth.rawKey))
    : (config.agmApiKey || config.agmAdminKey);
  if (apiKey) {
    headers['authorization'] = 'Bearer ' + apiKey;
    headers['x-api-key'] = apiKey;
    headers['x-goog-api-key'] = apiKey;
  }
  if (body.length) headers['content-length'] = String(body.length);

  if (backend === 'cpa') autosleep.onTraffic(1);

  const count = method === 'POST' && (P === '/v1/messages/count_tokens' || /^\/v1(?:beta)?\/models\/[^/:]+:countTokens$/i.test(P));
  const gen = method === 'POST' && !count && /^\/v1(?:beta)?\//.test(P) && P !== '/v1/models';
  const recordAGM = backend === 'agm' && gen;
  const recordCPA = backend === 'cpa' && gen && config.usagePollMs === 0;
  const shouldSniff = recordAGM || recordCPA;

  const start = Date.now();
  const ua = String(req.headers['user-agent'] || '');
  let ttfb: number | null = null;
  let finished = false;
  let clientClosed = false;

  const recordLog = (status: number, failed: boolean, tok: Tok, errSum = '', errBody = '', reqId = '', accName = '') => {
    if (finished) return;
    finished = true;
    if (!shouldSniff) return;
    const defLabel = backend === 'cpa' ? 'CPA' : 'AGM';
    const acct = accName || defLabel;
    usageSource().recordDirect({
      backend,
      ts: start,
      requestId: reqId || randomUUID(),
      authFile: accName || backend,
      account: acct,
      model: requestedModel || 'unknown',
      upstream: '',
      failed,
      status,
      summary: errSum,
      body: errBody,
      ttft: ttfb,
      latency: Date.now() - start,
      stream: streamHint,
      in: tok.in,
      out: tok.out,
      cache: tok.cache,
      think: tok.think,
      total: tok.total || (tok.in + tok.out + tok.think),
      effort: '',
      path: P,
      ua,
      session: '',
    });
  };

  const up = (tls ? https : http).request({
    host: t.hostname,
    port: t.port || (tls ? 443 : 80),
    method,
    path: upPath,
    headers,
  });
  up.setTimeout(config.upstreamTimeoutMs, () => up.destroy(new Error('upstream_timeout')));

  res.on('close', () => {
    if (!res.writableFinished) {
      clientClosed = true;
      up.destroy();
      recordLog(499, true, zeroTok(), '客户端断开');
    }
  });

  up.on('error', (err) => {
    if (finished) return;
    const label = backend === 'cpa' ? 'CPA' : 'Antigravity-Manager';
    if (!res.headersSent) sendGatewayError(res, P, 502, 'upstream_error', `${label} 不可达`);
    else res.destroy();
    recordLog(502, true, zeroTok(), `${label} 不可达`, String(err?.message || ''));
  });

  up.on('response', (ur) => {
    if (finished || clientClosed) { ur.destroy(); return; }
    const status = ur.statusCode || 502;
    const tHead = Date.now() - start;
    const upReqId = String(ur.headers['x-request-id'] || '');
    const accName = String(ur.headers['x-account-email'] || ur.headers['x-antigravity-account'] || '').trim();
    const sn = shouldSniff ? usageSniffer() : null;
    const errBuf: Buffer[] = [];
    let errSize = 0;

    const out: Record<string, string | string[]> = { 'Access-Control-Allow-Origin': '*' };
    for (const [k, v] of Object.entries(ur.headers)) {
      const lk = k.toLowerCase();
      if (v !== undefined && !RESP_DROP.has(lk) && lk !== 'access-control-allow-origin') out[k] = v;
    }
    if (streamHint || String(ur.headers['content-type'] || '').includes('event-stream')) {
      out['x-accel-buffering'] = 'no';
    }
    res.writeHead(status, out);

    ur.once('data', () => { ttfb ??= Date.now() - start; });
    if (shouldSniff) {
      ur.on('data', (c: Buffer) => {
        if (status < 300) sn!.feed(c);
        else if (errSize < 65536) { errBuf.push(c); errSize += c.length; }
      });
    }
    ur.pipe(res);
    ur.on('error', (err) => {
      res.destroy();
      recordLog(502, true, sn ? sn.done() : zeroTok(), '上游连接中断', String(err?.message || ''), upReqId, accName);
    });
    ur.on('end', () => {
      if (status < 300) {
        ttfb ??= tHead;
        return recordLog(status, false, sn ? sn.done() : zeroTok(), '', '', upReqId, accName);
      }
      const rawErr = errBuf.length ? Buffer.concat(errBuf).toString('utf8') : '';
      recordLog(status, true, sn ? sn.done() : zeroTok(), errMessage(rawErr) || `HTTP ${status}`, rawErr, upReqId, accName);
    });
  });

  if (body.length) up.end(body);
  else up.end();
}

// ---------- AI Studio 2 forwarding ----------
async function forwardAIS2(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  P: string,
  url: URL,
  body: Buffer,
  parsed: { model: string; stream: boolean; json: any },
  keyHash: string,
) {
  const list = method === 'GET' && (P === '/v1/models' || /^\/v1\/models\/[^/:]+$/.test(P) || P === '/v1beta/models' || /^\/v1beta\/models\/[^/:]+$/.test(P));
  const count = method === 'POST' && (P === '/v1/messages/count_tokens' || /^\/v1(?:beta)?\/models\/[^/:]+:countTokens$/i.test(P));
  const gen = method === 'POST' && !count && (
    P === '/v1/chat/completions' ||
    P === '/v1/messages' ||
    P === '/v1/responses' ||
    P === '/v1/images/generations' ||
    P === '/v1/images/edits' ||
    /^\/v1(?:beta)?\/models\/[^/:]+:(generateContent|streamGenerateContent)$/i.test(P)
  );
  if (!list && !count && !gen) {
    return sendGatewayError(res, P, 404, 'unsupported_endpoint', 'AI Studio 不支持该接口路径');
  }
  if (!aistudio2On()) {
    return sendGatewayError(res, P, 503, 'aistudio_disabled', 'AI Studio 未开启（缺少 AISTUDIO2_KEY 配置）');
  }

  const start = Date.now();
  let { model: requestedModel, stream, json } = parsed;
  if (!requestedModel && P.startsWith('/v1/images/')) requestedModel = 'gemini-image';

  const ct = String(req.headers['content-type'] || '');
  const rw = rewriteAIS2TierRequest(P, body, ct, json);
  body = rw.body;
  json = null;
  const upstreamModel = rw.baseModel || requestedModel;
  const effort = rw.effort || '';
  const ua = String(req.headers['user-agent'] || '');
  const sk = gen ? deriveSessionKey(keyHash, upstreamModel || requestedModel, req.headers, parsed.json) : '';

  const sp = new URLSearchParams(url.search);
  sp.delete('key');
  const qs = sp.toString() ? '?' + sp.toString() : '';

  const baseHeaders = forwardHeaders(req.headers);
  baseHeaders['authorization'] = 'Bearer ' + config.aistudio2Key;
  baseHeaders['x-api-key'] = config.aistudio2Key;
  baseHeaders['x-goog-api-key'] = config.aistudio2Key;
  if (body.length) baseHeaders['content-length'] = String(body.length);

  const t = new URL(config.aistudio2URL);
  const tls = t.protocol === 'https:';
  const reqBase = t.pathname.replace(/\/+$/, '') + rw.upstreamPath + qs;

  if (list) {
    const up = (tls ? https : http).request({ host: t.hostname, port: t.port || (tls ? 443 : 80), method, path: reqBase, headers: baseHeaders });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    up.setTimeout(config.upstreamTimeoutMs, () => up.destroy(new Error('upstream_timeout')));
    up.on('error', () => { if (!res.headersSent) sendGatewayError(res, P, 502, 'upstream_error', 'AI Studio 后端不可达'); else res.destroy(); });
    up.on('response', (ur) => {
      const status = ur.statusCode || 502;
      const out: Record<string, string | string[]> = { 'Access-Control-Allow-Origin': '*' };
      for (const [k, v] of Object.entries(ur.headers)) {
        const lk = k.toLowerCase();
        if (v !== undefined && !RESP_DROP.has(lk) && lk !== 'content-length' && !lk.startsWith('x-aistudio-') && lk !== 'access-control-allow-origin') out[k] = v;
      }
      const chunks: Buffer[] = [];
      ur.on('data', (c: Buffer) => chunks.push(c));
      ur.on('end', () => {
        let rawBuf = Buffer.concat(chunks);
        if (status === 200) {
          const text = rawBuf.toString('utf8');
          if (rw.requestedSingleId) {
            try {
              const mj = JSON.parse(text);
              if (mj && typeof mj === 'object') {
                if ('id' in mj) mj.id = rw.requestedSingleId;
                else if ('name' in mj) mj.name = 'models/' + rw.requestedSingleId.replace(/^models\//i, '');
                rawBuf = Buffer.from(JSON.stringify(mj));
              }
            } catch {}
          } else {
            const st = settings();
            const picks = Array.isArray(st.ais2Models) && st.ais2Models.length ? st.ais2Models : null;
            const expanded = expandAIS2ModelList(text, picks ? false : st.ais2Slim !== false);
            rawBuf = Buffer.from(filterAIS2ModelsByPick(expanded, picks));
          }
        }
        out['content-length'] = String(rawBuf.length);
        res.writeHead(status, out);
        res.end(rawBuf);
      });
      ur.on('error', () => res.destroy());
    });
    up.end();
    return;
  }

  const allowed = allowedAccounts();
  if (!allowed.length) {
    if (gen) {
      usageSource().recordDirect({
        backend: 'ais2',
        ts: start, requestId: randomUUID(), authFile: '', account: 'AI Studio',
        model: requestedModel || 'unknown', upstream: upstreamModel || '',
        failed: true, status: 403, summary: NOT_ELIGIBLE_2, body: '',
        ttft: null, latency: Date.now() - start, stream,
        in: 0, out: 0, cache: 0, think: 0, total: 0,
        effort, path: P, ua, session: sk,
      });
    }
    return sendGatewayError(res, P, 403, 'no_available_account', NOT_ELIGIBLE_2);
  }

  const ordered = orderAccounts(allowed, sk);
  const maxAttempts = Math.min(ordered.length, 3);
  let finished = false;
  let clientClosed = false;
  let ttfb: number | null = null;
  let activeUp: http.ClientRequest | null = null;

  const finish = (status: number, failed: boolean, cand: AllowedAcc | null, tok: Tok, errSum = '', errBody = '', reqId = '') => {
    if (finished) return;
    finished = true;
    if (gen) {
      usageSource().recordDirect({
        backend: 'ais2',
        ts: start,
        requestId: reqId || randomUUID(),
        authFile: cand ? cand.id : '',
        account: cand ? cand.email : 'AI Studio',
        model: requestedModel || upstreamModel || 'unknown',
        upstream: upstreamModel || requestedModel || '',
        failed,
        status,
        summary: errSum,
        body: errBody,
        ttft: ttfb,
        latency: Date.now() - start,
        stream,
        in: tok.in,
        out: tok.out,
        cache: tok.cache,
        think: tok.think,
        total: tok.total || (tok.in + tok.out + tok.think),
        effort,
        path: P,
        ua,
        session: sk,
      });
    }
  };

  res.on('close', () => {
    if (!res.writableFinished) {
      clientClosed = true;
      activeUp?.destroy();
      finish(499, true, null, zeroTok(), '客户端断开');
    }
  });

  const tryAttempt = (attempt: number) => {
    if (finished || clientClosed) return;
    const cand = ordered[attempt];
    const headers = { ...baseHeaders, 'x-aistudio-account': cand.email };
    const up = (tls ? https : http).request({
      host: t.hostname,
      port: t.port || (tls ? 443 : 80),
      method,
      path: reqBase,
      headers,
    });
    activeUp = up;
    up.setTimeout(config.upstreamTimeoutMs, () => {
      up.destroy(new Error('upstream_timeout'));
    });

    up.on('error', (err) => {
      if (finished || activeUp !== up) return;
      markAIS2Down(cand.id, 20000);
      if (attempt + 1 < maxAttempts && !clientClosed && !res.headersSent) {
        tryAttempt(attempt + 1);
        return;
      }
      if (!res.headersSent) sendGatewayError(res, P, 502, 'upstream_error', 'AI Studio 后端不可达');
      else res.destroy();
      finish(502, true, cand, zeroTok(), 'AI Studio 后端不可达', String(err?.message || ''));
    });

    up.on('response', (ur) => {
      let sn: ReturnType<typeof usageSniffer> | null = null;
      const status = ur.statusCode || 502;
      const upReqId = String(ur.headers['x-request-id'] || '');
      ur.on('error', (err) => {
        if (activeUp !== up || finished) return;
        res.destroy();
        finish(502, true, cand, sn ? sn.done() : zeroTok(), 'AI Studio 后端连接中断', String(err?.message || ''), upReqId);
      });
      if (finished || clientClosed || activeUp !== up) {
        ur.destroy();
        return;
      }
      const tHead = Date.now() - start;
      const retryable = status === 429 || status === 401 || status === 403 || status === 500 || status === 502 || status === 503 || status === 504;

      if (gen && (status === 401 || status === 403)) {
        markAIS2Down(cand.id, 60000);
        notifyAuthSuspect(cand.id);
      } else if (gen && (status === 429 || status >= 500)) {
        markAIS2Down(cand.id, 20000);
      }

      if (retryable && attempt + 1 < maxAttempts && !clientClosed && !res.headersSent) {
        ur.resume();
        tryAttempt(attempt + 1);
        return;
      }

      if (gen && status < 300 && sk) {
        ais2SessionLast.set(sk, cand.id);
      }

      sn = usageSniffer();
      const errBuf: Buffer[] = [];
      let errSize = 0;
      const out: Record<string, string | string[]> = { 'Access-Control-Allow-Origin': '*' };
      for (const [k, v] of Object.entries(ur.headers)) {
        const lk = k.toLowerCase();
        if (v !== undefined && !RESP_DROP.has(lk) && !lk.startsWith('x-relay-') && !lk.startsWith('x-aistudio-') && lk !== 'access-control-allow-origin') out[k] = v;
      }
      if (stream || String(ur.headers['content-type'] || '').includes('event-stream')) {
        out['x-accel-buffering'] = 'no';
      }
      res.writeHead(status, out);
      ur.once('data', () => { ttfb ??= Date.now() - start; });
      ur.on('data', (c: Buffer) => {
        if (status < 300) sn!.feed(c);
        else if (errSize < 65536) { errBuf.push(c); errSize += c.length; }
      });
      ur.pipe(res);
      ur.on('end', () => {
        if (status < 300) {
          ttfb ??= tHead;
          return finish(status, false, cand, sn!.done(), '', '', upReqId);
        }
        const rawErr = Buffer.concat(errBuf).toString('utf8');
        finish(status, true, cand, sn!.done(), errMessage(rawErr) || `HTTP ${status}`, rawErr, upReqId);
      });
    });

    up.end(body);
  };

  tryAttempt(0);
}

// ---------- main gateway handler ----------
export async function handleGateway(req: IncomingMessage, res: ServerResponse, url: URL, entry: 'main' | 'ais2' = 'main') {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }
  const P = url.pathname;
  const raw = clientKey(req, url);
  if (!raw) return sendGatewayError(res, P, 401, 'invalid_api_key', '缺少 API Key');
  const auth = await verifyClientKey(raw);
  if (!auth.ok) {
    if (auth.authDown) return sendGatewayError(res, P, 502, 'auth_unavailable', '密钥校验服务暂时不可达');
    return sendGatewayError(res, P, 401, 'invalid_api_key', 'API Key 无效');
  }

  let body: Buffer;
  try {
    body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req, config.maxBodyBytes);
  } catch (e) {
    return sendGatewayError(res, P, e instanceof HttpError ? e.status : 400, 'invalid_request', e instanceof HttpError && e.status === 413 ? '请求体太大' : '无法读取请求体');
  }

  const parsed = modelFrom(P, body, req.headers['content-type']);
  const stripped = entry === 'main'
    ? stripAIS2Prefix(P, body, parsed.json)
    : { prefixed: false, nextPath: P, nextBody: body, nextJson: parsed.json };

  // Route selection: explicit /ais2 entry, per-key 'ais2' binding, or `ais2/` model prefix -> AI Studio 2
  if (entry === 'ais2' || auth.boundBackend === 'ais2' || stripped.prefixed) {
    const p2 = stripped.prefixed
      ? { ...parsed, model: parsed.model.replace(/^ais2\//i, ''), json: stripped.nextJson }
      : parsed;
    return forwardAIS2(req, res, method, stripped.nextPath, url, stripped.nextBody, p2, auth.keyHash);
  }

  // Resolve active AGY backend: per-key override -> global settings().agyBackend -> available fallback
  let target: AgyBackend = auth.boundBackend === 'cpa' || auth.boundBackend === 'agm'
    ? auth.boundBackend
    : settings().agyBackend;

  if (target === 'cpa' && !cpaOn() && agmOn()) target = 'agm';
  if (target === 'agm' && !agmOn() && cpaOn()) target = 'cpa';

  if ((target === 'cpa' && !cpaOn()) || (target === 'agm' && !agmOn())) {
    if (aistudio2On()) {
      return sendGatewayError(res, P, 503, 'backend_unavailable', '未配置 AGY 后端（CPA / AGM），AI Studio 请走 /ais2/v1 或 ais2/ 模型前缀');
    }
    return sendGatewayError(res, P, 503, 'backend_unavailable', '当前未配置可用的后端引擎');
  }

  return forwardAGY(target, req, res, method, P, url, body, parsed.model, parsed.stream, auth);
}

export async function fetchAIS2ModelIds(): Promise<string[]> {
  if (!aistudio2On()) return [];
  const r = await fetch(config.aistudio2URL + '/v1/models', {
    headers: { Authorization: 'Bearer ' + config.aistudio2Key, 'x-api-key': config.aistudio2Key },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('上游模型列表不可达');
  const expanded = expandAIS2ModelList(await r.text(), false);
  const j = JSON.parse(expanded);
  const arr = Array.isArray(j?.data) ? j.data : [];
  return arr.map((m: any) => String(m?.id || '')).filter(Boolean);
}

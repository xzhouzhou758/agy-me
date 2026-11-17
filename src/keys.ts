// Client API keys: backed by DATA_DIR/client-keys.json (0600) and synced with CPA access.api-keys when CPA is configured & reachable.
// state.json only stores sha256-indexed notes and optional per-key backend bindings (never plaintext keys).
import { randomBytes } from 'node:crypto';
import { HttpError, sha256 } from './util.ts';
import { cpaOn } from './config.ts';
import { JsonFile, state, type KeyBackend } from './store.ts';
import * as cpa from './cpa.ts';
import { invalidateClientKeyCache } from './gateway.ts';

export type KeyView = { id: string; masked: string; note: string; backend?: KeyBackend };

const KEY_RE = /^[A-Za-z0-9._~+\/=-]{12,200}$/;
export const generateKey = () => 'sk-' + randomBytes(30).toString('base64url'); // sk- + 40 url-safe chars
export const maskKey = (k: string) => (k.length > 14 ? k.slice(0, 6) + '…' + k.slice(-4) : k.slice(0, 2) + '…');

const keyStore = new JsonFile<{ keys: string[] }>('client-keys.json', () => ({ keys: [] }));
const notes = () => (state.data.keyNotes ||= {});
const backends = () => (state.data.keyBackends ||= {});

function saveMirror(keys: string[]) {
  keyStore.data.keys = [...keys];
  keyStore.flush();
}

async function readKeys(): Promise<{ keys: string[]; etag: string; fromCpa: boolean }> {
  if (cpaOn()) {
    try {
      const r = await cpa.clientKeys();
      saveMirror(r.keys);
      return { keys: r.keys, etag: r.etag, fromCpa: true };
    } catch {
      if (keyStore.data.keys.length > 0) {
        return { keys: [...keyStore.data.keys], etag: '', fromCpa: false };
      }
      throw new HttpError(502, 'cpa_unreachable');
    }
  }
  if (!keyStore.data.keys.length) {
    saveMirror([generateKey()]);
  }
  return { keys: [...keyStore.data.keys], etag: '', fromCpa: false };
}

/** The view of a list; notes & bindings of keys no longer in it are dropped. */
function view(keys: string[]): KeyView[] {
  const live = new Set(keys.map(sha256)), n = notes(), b = backends();
  let gone = 0;
  for (const h of Object.keys(n)) if (!live.has(h)) { delete n[h]; gone++; }
  for (const h of Object.keys(b)) if (!live.has(h)) { delete b[h]; gone++; }
  if (gone) state.save(0);
  return keys.map((k) => {
    const id = sha256(k);
    const out: KeyView = { id, masked: maskKey(k), note: n[id] || '' };
    const bk = b[id];
    if (bk && bk !== 'auto') out.backend = bk;
    return out;
  });
}

async function edit(fn: (keys: string[]) => string[]): Promise<string[]> {
  if (cpaOn()) {
    try {
      for (let i = 0; i < 3; i++) {
        const { keys, etag } = await cpa.clientKeys();
        const next = fn(keys);
        if (await cpa.putClientKeys(next, etag)) {
          saveMirror(next);
          return next;
        }
      }
      throw new HttpError(409, 'conflict');
    } catch (e) {
      if (e instanceof HttpError && e.code !== 'cpa_unreachable') throw e;
      if (!keyStore.data.keys.length) throw e;
    }
  }
  if (!keyStore.data.keys.length) saveMirror([generateKey()]);
  const next = fn([...keyStore.data.keys]);
  saveMirror(next);
  return next;
}

async function find(id: string): Promise<{ keys: string[]; key: string }> {
  const { keys } = await readKeys();
  const key = keys.find((k) => sha256(k) === id);
  if (!key) throw new HttpError(404, 'not_found');
  return { keys, key };
}

export const list = async () => view((await readKeys()).keys);
export const reveal = async (id: string) => ({ key: (await find(id)).key });

export async function add(raw: unknown, generate: boolean, note: string) {
  if (!generate && typeof raw !== 'string') throw new HttpError(400, 'key_empty');
  const key = generate ? generateKey() : (raw as string).trim();
  if (!key) throw new HttpError(400, 'key_empty');
  if (!KEY_RE.test(key)) throw new HttpError(400, 'key_invalid');
  const next = await edit((keys) => {
    if (keys.includes(key)) throw new HttpError(409, 'duplicate');
    return [...keys, key];
  });
  if (note) { notes()[sha256(key)] = note; state.save(0); }
  invalidateClientKeyCache();
  return { id: sha256(key), key, keys: view(next) };
}

/** At least one key stays so CPA / local gateway auth is never disabled. */
export async function remove(id: string) {
  const next = await edit((keys) => {
    if (!keys.some((k) => sha256(k) === id)) throw new HttpError(404, 'not_found');
    const rest = keys.filter((k) => sha256(k) !== id);
    if (!rest.length) throw new HttpError(409, 'last_key');
    return rest;
  });
  invalidateClientKeyCache();
  return view(next);
}

export async function setNote(id: string, note: string) {
  const { keys } = await find(id);
  if (note) notes()[id] = note; else delete notes()[id];
  state.save(0);
  return view(keys);
}

export async function setBackend(id: string, backend: KeyBackend) {
  if (!['auto', 'cpa', 'agm', 'ais2'].includes(backend)) throw new HttpError(400, 'invalid_backend');
  const { keys } = await find(id);
  if (backend === 'auto') delete backends()[id];
  else backends()[id] = backend;
  state.save(0);
  invalidateClientKeyCache();
  return view(keys);
}

export async function rawKeysSnapshot(): Promise<{ keys: string[]; firstCpaKey: string; cpaSet: Set<string>; backends: Record<string, KeyBackend> }> {
  let listKeys: string[] = [];
  let cpaFirst = '';
  let cpaSet = new Set<string>();
  if (cpaOn()) {
    try {
      const r = await cpa.clientKeys();
      listKeys = r.keys;
      cpaFirst = r.keys[0] || '';
      cpaSet = new Set(r.keys);
      saveMirror(r.keys);
    } catch {
      listKeys = [...keyStore.data.keys];
      cpaFirst = listKeys[0] || '';
    }
  } else {
    if (!keyStore.data.keys.length) saveMirror([generateKey()]);
    listKeys = [...keyStore.data.keys];
  }
  return { keys: listKeys, firstCpaKey: cpaFirst, cpaSet, backends: { ...backends() } };
}

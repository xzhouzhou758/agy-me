// Client API keys (CPA's access.api-keys). Notes live in state.json keyed by sha256 of the key, never the key itself.
import { randomBytes } from 'node:crypto';
import { HttpError, sha256 } from './util.ts';
import { state } from './store.ts';
import * as cpa from './cpa.ts';

export type KeyView = { id: string; masked: string; note: string };

const KEY_RE = /^[A-Za-z0-9._~+\/=-]{12,200}$/;
export const generateKey = () => 'sk-' + randomBytes(30).toString('base64url'); // sk- + 40 url-safe chars
export const maskKey = (k: string) => (k.length > 14 ? k.slice(0, 6) + '…' + k.slice(-4) : k.slice(0, 2) + '…');
const notes = () => (state.data.keyNotes ||= {});

/** The view of a list; notes of keys no longer in it are dropped. */
function view(keys: string[]): KeyView[] {
  const live = new Set(keys.map(sha256)), n = notes();
  let gone = 0;
  for (const h of Object.keys(n)) if (!live.has(h)) { delete n[h]; gone++; }
  if (gone) state.save(0);
  return keys.map((k) => ({ id: sha256(k), masked: maskKey(k), note: n[sha256(k)] || '' }));
}

/** Read, change, write back with If-Match; someone else saving the config in between means read again. */
async function edit(fn: (keys: string[]) => string[]): Promise<string[]> {
  for (let i = 0; i < 3; i++) {
    const { keys, etag } = await cpa.clientKeys();
    const next = fn(keys);
    if (await cpa.putClientKeys(next, etag)) return next;
  }
  throw new HttpError(409, 'conflict');
}
async function find(id: string): Promise<{ keys: string[]; key: string }> {
  const { keys } = await cpa.clientKeys();
  const key = keys.find((k) => sha256(k) === id);
  if (!key) throw new HttpError(404, 'not_found');
  return { keys, key };
}

export const list = async () => view((await cpa.clientKeys()).keys);
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
  return { id: sha256(key), key, keys: view(next) };
}

/** No keys at all turns CPA's key check off (it then serves anyone), so the last one can't go. */
export async function remove(id: string) {
  const next = await edit((keys) => {
    if (!keys.some((k) => sha256(k) === id)) throw new HttpError(404, 'not_found');
    const rest = keys.filter((k) => sha256(k) !== id);
    if (!rest.length) throw new HttpError(409, 'last_key');
    return rest;
  });
  return view(next);
}

export async function setNote(id: string, note: string) {
  const { keys } = await find(id);
  if (note) notes()[id] = note; else delete notes()[id];
  state.save(0);
  return view(keys);
}

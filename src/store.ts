// Small JSON files in DATA_DIR, loaded once and written atomically (tmp + rename), debounced.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import type { Action } from './accerr.ts';

const files: JsonFile<any>[] = [];

export class JsonFile<T extends object> {
  readonly path: string;
  data: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(name: string, def: () => T) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.path = join(config.dataDir, name);
    let d: T;
    try { d = { ...def(), ...JSON.parse(readFileSync(this.path, 'utf8')) }; } catch { d = def(); }
    this.data = d;
    files.push(this);
  }

  /** Write soon (coalesces bursts). */
  save(delayMs = 500) {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), delayMs);
    this.timer.unref();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export type Settings = { quotaRefreshMinutes: number; autoDisable: boolean; autoEnable: boolean; autoSleep: boolean };
/** An account this app turned off because Google answered 403: when, Google's reason, the verify / appeal link. */
export type AutoMark = { at: number; reason: string; action: Action | null };
// sessions: sha256(token) -> expires (ms); pwFingerprint: which password they were made with;
// pwHash: password set on the settings page (wins over the env); keyNotes: sha256(client API key) -> note;
// sleep: auth id -> put to sleep at (ms, 闲置自动休眠); auto: auth id -> auto-disable mark; autoSince: auth id -> 403 evidence older than this no longer counts (turned on again)
type State = {
  sessions: Record<string, number>; settings: Settings; pwFingerprint?: string; pwHash?: string; keyNotes?: Record<string, string>;
  auto?: Record<string, AutoMark>; autoSince?: Record<string, number>; sleep?: Record<string, number>;
};

const defaults = (): Settings => ({ quotaRefreshMinutes: config.quotaRefreshMinutes, autoDisable: true, autoEnable: true, autoSleep: false });
export const state = new JsonFile<State>('state.json', () => ({ sessions: {}, settings: defaults() }));

export function settings(): Settings {
  return { ...defaults(), ...state.data.settings };
}
export function setSettings(p: Partial<Settings>) {
  state.data.settings = { ...settings(), ...p };
  state.save(0);
}

export function flushAll() {
  for (const f of files) f.flush();
}

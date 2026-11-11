// Quota parsing (ported from tools-ui-server.py fetch_quota) and the background refresher. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA } from './mock-cpa.ts';

const mock = startMockCPA({ mgmtKey: 'm' });
let dataDir = '';
let quota: typeof import('../src/quota.ts');

before(async () => {
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', () => r()));
  dataDir = mkdtempSync(join(tmpdir(), 'agyme-q-'));
  Object.assign(process.env, { DATA_DIR: dataDir, CPA_URL: `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`, CPA_MANAGEMENT_KEY: 'm', QUOTA_CONCURRENCY: '2', QUOTA_BASE_URLS: 'https://daily.example' });
  quota = await import('../src/quota.ts');
});
after(() => {
  mock.server.closeAllConnections();
  mock.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-11T06:00:00Z');
// Shapes as Google returns them (trimmed from a real Pro account; no personal data).
const LCA_PRO = {
  currentTier: { id: 'free-tier', name: 'Antigravity' },
  allowedTiers: [{ id: 'free-tier', isDefault: true }, { id: 'standard-tier' }],
  paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro', availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '1000' }] },
};
const FAM_PRO = {
  models: {
    'gemini-4-argon-disabled': { displayName: 'Gemini 4 Argon', disabled: true },
    'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-11T11:15:03Z' } },
    'gemini-3.8-flash-low': { displayName: 'Gemini 3.8 Flash (Low)', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-11T11:15:03Z' } },
    'claude-opus-4-6-thinking': { displayName: 'Claude Opus 4.6 (Thinking)', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-11T11:15:03Z' } },
    'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', quotaInfo: { remainingFraction: 1 } },
    chat_20706: { quotaInfo: { remainingFraction: 1 } },
    tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
  },
  agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'claude-opus-4-6-thinking'] }] }],
};
const SUM_PRO = {
  groups: [
    { displayName: 'Gemini Models', buckets: [
      { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-11-18T06:15:01Z', remainingFraction: 1 },
      { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-11-11T11:15:01Z', remainingFraction: 0.6 },
    ] },
    { displayName: 'Claude and GPT models', buckets: [
      { bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-11-18T06:15:01Z', remainingFraction: 0 },
      { bucketId: '3p-5h', window: '5h', resetTime: '2026-11-11T11:15:01Z', remainingFraction: 0.5 },
    ] },
  ],
};

test('normalizeTier / tierFromLCA follow Tools', () => {
  assert.equal(quota.normalizeTier('g1-ultra-tier'), 'ULTRA');
  assert.equal(quota.normalizeTier('GOOGLE_ONE_HELIUM'), 'ULTRA');
  assert.equal(quota.normalizeTier('g1-pro-tier'), 'PRO');
  assert.equal(quota.normalizeTier('free-tier'), 'FREE');
  assert.equal(quota.normalizeTier('standard-tier'), 'FREE');
  assert.equal(quota.normalizeTier(''), '');
  assert.equal(quota.tierFromLCA(LCA_PRO), 'PRO');
  assert.equal(quota.tierFromLCA({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }), 'FREE');
  assert.equal(quota.tierFromLCA({ currentTier: { id: 'something-odd' } }), 'FREE');
  assert.equal(quota.creditsFromLCA(LCA_PRO), 1000);
});

test('buildQuota: Pro account, summary groups, Argon not offered', () => {
  const q = quota.buildQuota(LCA_PRO, FAM_PRO, SUM_PRO, NOW);
  assert.equal(q.tier, 'PRO');
  assert.equal(q.credits, 1000);
  assert.deepEqual(q.gemini, { h5: { frac: 0.6, reset: '2026-11-11T11:15:01Z' }, week: { frac: 1, reset: '2026-11-18T06:15:01Z' } });
  assert.equal(q.claude?.week?.frac, 0);
  assert.equal(q.argonState, 'off');
  assert.equal(q.argon, null);
  // chat_ / tab_ / disabled and models outside the official list are dropped
  assert.deepEqual(q.models.map((m) => m.name), ['claude-opus-4-6-thinking', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low']);
  const m = Object.fromEntries(q.models.map((x) => [x.name, x]));
  assert.equal(m['gemini-3.8-flash-high'].pct, 60, 'capped by the group 5h window');
  assert.equal(m['claude-opus-4-6-thinking'].pct, 0, 'empty week wins over the 5h window');
  assert.equal(m['claude-opus-4-6-thinking'].reset, '2026-11-18T06:15:01Z');
});

test('buildQuota: Ultra with its own Argon group', () => {
  const fam = { models: { 'gemini-4-argon-high': { quotaInfo: { remainingFraction: 0.3, resetTime: '2026-11-14T07:00:00Z' } }, 'gemini-3.8-flash-high': { quotaInfo: { remainingFraction: 1 } } } };
  const sum = { groups: [...SUM_PRO.groups, { displayName: 'Gemini 4 Argon', buckets: [{ bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.25, resetTime: '2026-11-14T07:00:00Z' }] }] };
  const q = quota.buildQuota({ paidTier: { id: 'g1-ultra-tier' } }, fam, sum, NOW);
  assert.equal(q.tier, 'ULTRA');
  assert.equal(q.argonState, 'on');
  assert.deepEqual(q.argon, { h5: null, week: { frac: 0.25, reset: '2026-11-14T07:00:00Z' } });
  assert.equal(q.models.find((x) => x.name === 'gemini-4-argon-high')?.pct, 25);
  // gemini group stays the gemini one, not the argon one
  assert.equal(q.gemini?.h5?.frac, 0.6);
});

test('buildQuota: no summary -> per-model fallback, Argon window guessed from its reset', () => {
  const fam = { models: {
    'gemini-3.8-flash-high': { quotaInfo: { remainingFraction: 0.4, resetTime: '2026-11-11T09:00:00Z' } }, // 3h away -> 5H
    'claude-opus-5-5-high': { quotaInfo: { remainingFraction: 0.2, resetTime: '2026-11-11T08:00:00Z' } },
    'gemini-4-argon-high': { quotaInfo: { remainingFraction: 0, resetTime: '2026-11-14T00:00:00Z' } }, // days away -> weekly
  } };
  const q = quota.buildQuota(null, fam, null, NOW);
  assert.equal(q.tier, null);
  assert.deepEqual(q.gemini, { h5: { frac: 0.4, reset: '2026-11-11T09:00:00Z' }, week: null });
  assert.equal(q.claude?.h5?.frac, 0.2);
  assert.deepEqual(q.argon, { h5: null, week: { frac: 0, reset: '2026-11-14T00:00:00Z' } });
});

test('refresh through the mock CPA: tier, families, 403 ban', async () => {
  const ok = mock.addCred('a-ok.json', 'ok@example.invalid', { tier: 'g1-pro-tier', quota: { gemini: [0.5, 0.9], claude: [0, 0.4], argon: null } });
  mock.addCred('a-ban.json', 'ban@example.invalid', { forbidden: true });
  const e = await quota.refreshOne('a-ok.json');
  assert.equal(e.err, null);
  assert.equal(e.q?.tier, 'PRO');
  assert.equal(e.q?.gemini?.h5?.frac, 0.5);
  assert.equal(e.q?.claude?.h5?.frac, 0);
  assert.equal(e.q?.argonState, 'off');
  const b = await quota.refreshOne('a-ban.json');
  assert.match(b.q?.forbidden || '', /Terms of Service/);
  assert.ok(quota.entry(ok.id));
});

test('refresher: bounded concurrency, a hung account times out and keeps its old data', async () => {
  for (let i = 0; i < 6; i++) mock.addCred(`c${i}.json`, `c${i}@example.invalid`);
  mock.st.hang.add('c0.json');
  const before = quota.entry('a-ok.json');
  const p = quota.refreshOne('c0.json', 200);
  assert.equal(quota.refreshOne('c0.json', 200), p, 'concurrent calls share one fetch');
  const hung = await p;
  assert.match(hung.err || '', /timed out/);
  mock.st.hang.delete('c0.json');
  const n = quota.enqueue(['c1.json', 'c2.json', 'c3.json', 'c4.json', 'c5.json', 'c1.json']);
  assert.equal(n, 5);
  assert.equal(quota.progress().running, true);
  for (let i = 0; i < 100 && quota.progress().running; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual({ ...quota.progress(), startedAt: 0 }, { running: false, total: 5, done: 5, startedAt: 0 });
  for (let i = 1; i < 6; i++) assert.equal(quota.entry(`c${i}.json`)?.err, null);
  assert.equal(quota.entry('a-ok.json'), before);
});

test('a single refresh runs through the same queue', async () => {
  const e = await quota.refreshNow('c2.json');
  assert.equal(e.err, null);
  assert.equal(quota.progress().running, false);
});

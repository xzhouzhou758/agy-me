// Account status (正常 / 冷却 / 封号 / 停用), dashboard aggregates and the model tier table. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAccount, famSummary, counts, accountView, type AccountView } from '../src/accounts.ts';
import { mapCred } from '../src/cpa.ts';
import { forbiddenQuota, type Quota } from '../src/quota.ts';
import { tierTable, familyOf } from '../src/tiers.ts';

const NOW = Date.parse('2026-11-11T06:00:00Z');
const cred = (f: Record<string, unknown> = {}) => mapCred({ id: 'a.json', auth_index: '1', type: 'antigravity', email: 'a@example.invalid', status: 'active', ...f });
const later = (h: number) => new Date(NOW + h * 3600e3).toISOString();

test('停用 wins over everything', () => {
  assert.equal(classifyAccount(cred({ disabled: true, status: 'error', status_message: 'violation of Terms of Service' }), forbiddenQuota('403'), null, NOW).status, 'disabled');
});

test('封号: 403 on the quota calls, ToS / verify text on the credential, or a 403 as its latest request', () => {
  assert.equal(classifyAccount(cred(), forbiddenQuota('{"error":{"code":403,"message":"This service has been disabled in this account for violation of Terms of Service."}}'), null, NOW).status, 'banned');
  const tos = classifyAccount(cred({ status: 'error', unavailable: true, status_message: 'This service has been disabled in this account for violation of Terms of Service.' }), null, null, NOW);
  assert.deepEqual(tos, { status: 'banned', reason: '账号被 Google 停用' });
  assert.equal(classifyAccount(cred({ status: 'error', status_message: 'Verify your account to continue.' }), null, null, NOW).status, 'banned');
  assert.equal(classifyAccount(cred({ status: 'error', status_message: 'invalid_grant: token revoked' }), null, null, NOW).status, 'banned');
  assert.equal(classifyAccount(cred(), null, { ts: NOW, status: 403, message: 'PERMISSION_DENIED' }, NOW).status, 'banned');
});

test('冷却: CPA has it unavailable / in error / cooling down', () => {
  const q429 = cred({ status: 'error', unavailable: true, status_message: '{"error":{"code":429,"message":"Individual quota reached. Resets in 83h4m44s.","status":"RESOURCE_EXHAUSTED"}}' });
  assert.deepEqual(classifyAccount(q429, null, null, NOW), { status: 'cooldown', reason: '额度用完 (429)' });
  const cd = cred({ cooldowns: [{ scope: 'auth', reason: 'rate limited', retry_at: later(1), http_status: 429 }] });
  assert.equal(classifyAccount(cd, null, null, NOW).status, 'cooldown');
  assert.equal(classifyAccount(cred({ next_retry_after: later(1) }), null, null, NOW).status, 'cooldown');
  // expired cooldowns and model-only cooldowns do not make the account yellow
  assert.equal(classifyAccount(cred({ cooldowns: [{ scope: 'auth', retry_at: later(-1) }] }), null, null, NOW).status, 'ok');
  assert.equal(classifyAccount(cred({ cooldowns: [{ scope: 'model', model_key: 'gemini-4-argon-high', retry_at: later(30), http_status: 429 }] }), null, null, NOW).status, 'ok');
});

test('正常 otherwise', () => {
  assert.deepEqual(classifyAccount(cred(), null, null, NOW), { status: 'ok', reason: '' });
});

const fam = (h5: number | null, week: number | null, h5Reset = later(3), weekReset = later(90)) => ({ h5: h5 == null ? null : { frac: h5, reset: h5Reset }, week: week == null ? null : { frac: week, reset: weekReset } });
const qWith = (p: Partial<Quota>): Quota => ({ tier: 'PRO', credits: null, forbidden: null, gemini: null, claude: null, argon: null, argonState: null, models: [], ...p });
const view = (id: string, q: Quota | null, c: Record<string, unknown> = {}) => accountView(cred({ id, ...c }), q ? { q, at: NOW, err: null } : null, null, 0, NOW);

test('famSummary: accounts with quota, averages, earliest comeback among the empty ones', () => {
  const L: AccountView[] = [
    view('1', qWith({ gemini: fam(1, 1) })),
    view('2', qWith({ gemini: fam(0, 0.5, later(2)) })),          // 5h empty -> back in 2h
    view('3', qWith({ gemini: fam(0.2, 0, later(1), later(50)) })), // week empty -> back in 50h
    view('4', qWith({ gemini: fam(0, 0, later(4), later(30)) })),   // both empty -> back when both refill: 30h
    view('5', qWith({ gemini: fam(1, 1) }), { disabled: true }),    // 停用: not counted
    view('6', forbiddenQuota('403')),                                // 封号: not counted
    view('7', null),                                                 // no data
  ];
  const s = famSummary(L, 'gemini', NOW);
  assert.equal(s.total, 4);
  assert.equal(s.withQuota, 1);
  assert.equal(s.earliest, later(2));
  assert.equal(s.h5, (1 + 0 + 0.2 + 0) / 4);
  assert.equal(s.week, (1 + 0.5 + 0 + 0) / 4);
  // a window whose reset has passed counts as refilled
  const s2 = famSummary([view('8', qWith({ gemini: fam(0, 1, later(-1)) }))], 'gemini', NOW);
  assert.equal(s2.withQuota, 1);
  assert.equal(s2.earliest, null);
  assert.deepEqual(counts(L), { total: 7, ok: 5, cooldown: 0, banned: 1, disabled: 1 });
});

test('tier table: four names per family, untiered models flagged', () => {
  assert.equal(familyOf('gemini-4-argon-medium'), 'gemini-4-argon');
  assert.equal(familyOf('gpt-oss-120b-medium'), 'gpt-oss-120b');
  const t = tierTable(
    [{ name: 'claude-opus-5-5-high', alias: 'claude-opus-5-5' }, { name: 'claude-opus-5-5-high', alias: 'claude-opus-5-5-low' }],
    ['claude-opus-5-5-high', 'claude-opus-5-5', 'claude-opus-5-5-low', 'claude-sonnet-4-6', 'gpt-oss-120b-medium'],
  );
  assert.deepEqual(t.families.map((f) => f.family), ['claude-opus-5-5']);
  assert.deepEqual(t.families[0].names.map((n) => [n.name, n.listed, n.target]), [
    ['claude-opus-5-5', true, 'claude-opus-5-5-high'],
    ['claude-opus-5-5-low', true, 'claude-opus-5-5-high'],
    ['claude-opus-5-5-medium', false, null],
    ['claude-opus-5-5-high', true, null],
  ]);
  assert.deepEqual(t.untiered, [{ family: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] }, { family: 'gpt-oss-120b', models: ['gpt-oss-120b-medium'] }]);
});

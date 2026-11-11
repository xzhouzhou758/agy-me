// Accounts page: filters and "select all only selects the filtered rows". Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const FILTER_JS: string = '../public/filter.js'; // plain browser script, sets globalThis.AF
await import(FILTER_JS);
const AF = (globalThis as any).AF;

const L = [
  { id: 'a', email: 'alice@x.io', note: '', tier: 'PRO', status: 'ok' },
  { id: 'b', email: 'bob@x.io', note: 'spare', tier: 'ULTRA', status: 'ok' },
  { id: 'c', email: 'carol@x.io', note: '', tier: 'PRO', status: 'banned' },
  { id: 'd', email: 'dave@y.io', note: '', tier: null, status: 'disabled' },
  { id: 'e', email: 'erin@x.io', note: '', tier: 'PRO', status: 'cooldown' },
];
const ids = (f: any) => AF.filter(L, f).map((a: any) => a.id);

test('search (email or note), tier and status filters combine', () => {
  assert.deepEqual(ids({ q: 'X.IO' }), ['a', 'b', 'c', 'e']);
  assert.deepEqual(ids({ q: 'spare' }), ['b']);
  assert.deepEqual(ids({ tier: 'PRO' }), ['a', 'c', 'e']);
  assert.deepEqual(ids({ tier: 'PRO', status: 'ok' }), ['a']);
  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd', 'e']);
});

test('chip counts ignore their own dimension; zero tiers stay zero (the page hides them)', () => {
  assert.deepEqual(AF.tierCounts(L, { tier: 'PRO', status: 'ok' }), { all: 2, PRO: 1, ULTRA: 1, FREE: 0 });
  assert.deepEqual(AF.statusCounts(L, { tier: 'PRO', status: 'ok' }), { all: 3, ok: 1, cooldown: 1, banned: 1, disabled: 0 });
});

test('select all touches only the visible rows and keeps nothing hidden', () => {
  const vis = ids({ tier: 'PRO' });
  let sel = AF.toggleAll(new Set(['b']), vis, true);
  assert.deepEqual([...sel].sort(), ['a', 'b', 'c', 'e']);
  assert.equal(AF.headState(sel, vis), 'all');
  sel = AF.toggleAll(sel, vis, false);
  assert.deepEqual([...sel], ['b']);
  assert.equal(AF.headState(sel, vis), 'none');
  assert.equal(AF.headState(new Set(['a']), vis), 'some');
  // changing the filter drops selections that are no longer visible
  assert.deepEqual([...AF.prune(new Set(['a', 'b', 'd']), ids({ tier: 'PRO' }))], ['a']);
});

test('shift-click selects the range between the anchor and the row, in visible order', () => {
  const vis = ids({ q: 'x.io' }); // a b c e
  assert.deepEqual([...AF.rangeSelect(new Set(), vis, 'e', 'b', true)].sort(), ['b', 'c', 'e']);
  assert.deepEqual([...AF.rangeSelect(new Set(['a', 'b', 'c', 'e']), vis, 'a', 'c', false)], ['e']);
  // anchor no longer visible -> just this row
  assert.deepEqual([...AF.rangeSelect(new Set(), vis, 'd', 'c', true)], ['c']);
});

test('reconcile after data / filter changes: hidden selections dropped, anchor reset when asked or gone', () => {
  const vis = ids({ status: 'ok' }); // a b
  assert.deepEqual(AF.reconcile(new Set(['a', 'c']), 'a', vis, false), { sel: new Set(['a']), anchor: 'a' });
  assert.deepEqual(AF.reconcile(new Set(['a', 'c']), 'a', vis, true), { sel: new Set(['a']), anchor: null });
  assert.equal(AF.reconcile(new Set(['a']), 'c', vis, false).anchor, null, 'anchor no longer visible');
  // after a batch 停用 the rows leave the 正常 filter: nothing hidden stays selected
  const after = L.map((x) => (x.id === 'a' || x.id === 'b' ? { ...x, status: 'disabled' } : x));
  const r = AF.reconcile(new Set(['a', 'b']), 'b', AF.filter(after, { status: 'ok' }).map((x: any) => x.id), false);
  assert.deepEqual([...r.sel], []);
  assert.equal(r.anchor, null);
});

// ---------------------------------------------------------------- sorting (column headers)
const NOW = Date.parse('2026-11-11T12:00:00Z');
const at = (h: number) => new Date(NOW + h * 3600e3).toISOString();
const fam = (h5: number | null, wk: number | null, r5 = at(2), rw = at(48)) => ({ h5: h5 == null ? null : { frac: h5, reset: r5 }, week: wk == null ? null : { frac: wk, reset: rw } });
const S = [
  { id: 'u', email: 'uma@x.io', tier: 'FREE', status: 'ok', lastUsed: NOW - 5000, quota: { gemini: fam(0.5, 0.9), claude: fam(0.2, 0.8, at(1)) } },
  { id: 'v', email: 'vic@x.io', tier: 'ULTRA', status: 'cooldown', lastUsed: NOW - 1000, quota: { gemini: fam(1, 1), claude: fam(1, 0.3, at(3), at(5)) } },
  { id: 'w', email: 'wes@x.io', tier: 'PRO', status: 'banned', lastUsed: 0, quota: { forbidden: '403', gemini: null, claude: null } },
  { id: 'x', email: 'xia@x.io', tier: null, status: 'disabled', lastUsed: NOW - 9000, quota: null },
  { id: 'y', email: 'yan@x.io', tier: 'PRO', status: 'ok', lastUsed: NOW - 1000, quota: { gemini: fam(0, 1, at(-1)), claude: fam(1, 1) } }, // empty 5h already reset -> full
  { id: 'z', email: 'zed@x.io', tier: 'FREE', status: 'ok', lastUsed: 0, quota: { gemini: fam(0.2, 0.3, at(4), at(10)) } },
];
const sorted = (k: string) => AF.sort(S, k, NOW).map((a: any) => a.id);

test('sort: status (default) both ways, ties by email; email both ways', () => {
  assert.deepEqual(sorted(''), ['w', 'v', 'u', 'y', 'z', 'x']);
  assert.deepEqual(sorted('status'), sorted(''));
  assert.deepEqual(sorted('-status'), ['x', 'u', 'y', 'z', 'v', 'w'], 'ties stay A→Z');
  assert.deepEqual(sorted('email'), ['u', 'v', 'w', 'x', 'y', 'z']);
  assert.deepEqual(sorted('-email'), ['z', 'y', 'x', 'w', 'v', 'u']);
  assert.deepEqual(AF.sort([...S].reverse(), 'email', NOW).map((a: any) => a.id), sorted('email'), 'input order does not matter');
});

test('sort: 5H / 7天 remaining both ways, min across families, expired reset = recovered, no quota always last', () => {
  // 5h: u .2, v 1, y 1 (reset passed), z .2; w forbidden, x none
  assert.deepEqual(sorted('h5'), ['u', 'z', 'v', 'y', 'w', 'x']);
  assert.deepEqual(sorted('-h5'), ['v', 'y', 'u', 'z', 'w', 'x']);
  // week: u .8, v .3, y 1, z .3
  assert.deepEqual(sorted('week'), ['v', 'z', 'u', 'y', 'w', 'x']);
  assert.deepEqual(sorted('-week'), ['y', 'u', 'v', 'z', 'w', 'x']);
});

test('sort: earliest comeback, recently used, tier (each both ways, missing last)', () => {
  // u: claude 5h at(1); v: claude week at(5) (5h full); z: 5h at(4); y full
  assert.deepEqual(sorted('reset'), ['u', 'z', 'v', 'w', 'x', 'y']);
  assert.deepEqual(sorted('-reset'), ['v', 'z', 'u', 'w', 'x', 'y']);
  assert.deepEqual(sorted('used'), ['v', 'y', 'u', 'x', 'w', 'z']);
  assert.deepEqual(sorted('-used'), ['x', 'u', 'v', 'y', 'w', 'z']);
  assert.deepEqual(sorted('tier'), ['v', 'w', 'y', 'u', 'z', 'x']);
  assert.deepEqual(sorted('-tier'), ['u', 'z', 'w', 'y', 'v', 'x']);
  assert.deepEqual(AF.SORTS.map((s: any) => s[0]), ['email', 'status', 'tier', 'used', 'h5', 'week', 'reset']);
});

test('header clicks: new column ascending, same column flips; default is status', () => {
  assert.equal(AF.nextSort('', 'status'), '-status');
  assert.equal(AF.nextSort('', 'h5'), 'h5');
  assert.equal(AF.nextSort('h5', 'h5'), '-h5');
  assert.equal(AF.nextSort('-h5', 'h5'), 'h5');
  assert.equal(AF.nextSort('-h5', 'email'), 'email');
});

test('sort works with filters, select-all and shift ranges in displayed order', () => {
  const vis = AF.sort(AF.filter(S, { q: 'x.io', status: 'ok' }), 'h5', NOW).map((a: any) => a.id); // u z y
  assert.deepEqual(vis, ['u', 'z', 'y']);
  assert.deepEqual([...AF.rangeSelect(new Set(), vis, 'u', 'z', true)].sort(), ['u', 'z']);
  assert.deepEqual([...AF.toggleAll(new Set(), vis, true)].sort(), ['u', 'y', 'z']);
  assert.ok(Array.isArray(AF.sort([], 'h5')) && AF.sort(S, 'nope', NOW).length === S.length);
});

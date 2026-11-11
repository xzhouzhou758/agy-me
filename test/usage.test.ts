// Request log store: CPA usage-queue records in, logs / usage / bans out; pruning. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueRecord, BAN_SUMMARY, type Ev } from './fixture-usage.ts';
import { QueueStore } from '../src/usage.ts';

let dir = '';
let src: QueueStore;
const NOW = Date.parse('2026-11-11T06:30:00Z');
const H = 3600e3;
// auth_index -> credential, like CPA's list
const WHO: Record<string, { id: string; email: string }> = Object.fromEntries(['a', 'b', 'c', 'late', 'leak'].map((u, i) => [`ix${i}`, { id: `antigravity-${u}@x.io.json`, email: `${u}@x.io` }]));
const who = (ix: string) => WHO[ix] || null;
const rec = (u: string, e: Ev) => queueRecord(Object.keys(WHO).find((k) => WHO[k].email === u + '@x.io') || 'gone', e);

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'agyme-u-'));
  src = new QueueStore(join(dir, 'sub', 'usage.sqlite'));
  src.ingest([
    rec('a', { ts: NOW - 30 * H, model: 'claude-opus-5-5', resolved: 'claude-opus-5-5-high', in: 1000, out: 100, cache: 500, ttft: 900, latency: 4000 }),
    rec('a', { ts: NOW - 3 * H, model: 'gemini-4-argon-low', resolved: 'gemini-4-argon-high', in: 2000, out: 200, ttft: 1100, latency: 5000 }),
    rec('b', { ts: NOW - 2 * H, model: 'claude-opus-5-5', failed: true, status: 429, body: '{"error":{"code":429,"message":"Individual quota reached.","status":"RESOURCE_EXHAUSTED"}}\nAuthorization: Bearer ya29.secret-token-value' }),
    rec('c', { ts: NOW - 1 * H, model: 'gemini-3.8-flash', failed: true, status: 403, summary: BAN_SUMMARY }),
    rec('b', { ts: NOW - 0.5 * H, model: 'gemini-3.8-flash', in: 10, out: 5, ttft: 300, latency: 700, stream: false }),
  ], who);
});
after(() => {
  src.close();
  rmSync(dir, { recursive: true, force: true });
});

test('recent: oldest first, ttft / failures mapped', () => {
  const r = src.recent(3);
  assert.deepEqual(r.map((x) => x.account), ['b@x.io', 'c@x.io', 'b@x.io']);
  assert.equal(r[0].failed, true);
  assert.equal(r[0].status, 429);
  assert.equal(r[0].error, 'Individual quota reached.');
  assert.equal(r[0].ttft, null);
  assert.equal(r[2].ttft, 300);
  assert.equal(r[2].stream, false);
  assert.equal(r[2].authId, 'antigravity-b@x.io.json');
});

test('logs: filters, totals, paging; detail masks secrets', () => {
  const all = src.logs({ page: 1, size: 10 });
  assert.equal(all.total, 5);
  assert.equal(all.err, 2);
  assert.equal(all.rows[0].account, 'b@x.io'); // newest first
  assert.equal(src.logs({ status: 'err' }).total, 2);
  assert.equal(src.logs({ status: '403' }).total, 1);
  assert.equal(src.logs({ account: 'antigravity-a@x.io.json' }).total, 2);
  assert.equal(src.logs({ model: 'claude-opus-5-5' }).total, 2);
  assert.equal(src.logs({ q: 'argon' }).total, 1);
  assert.equal(src.logs({ from: NOW - 4 * H }).total, 4);
  assert.equal(src.logs({ q: '100%_' }).total, 0, 'LIKE wildcards are escaped');
  assert.equal(src.logs({ page: 2, size: 10 }).rows.length, 0);
  const row = src.logs({ model: 'gemini-4-argon-low' }).rows[0];
  assert.equal(row.upstream, 'gemini-4-argon-high');
  assert.equal(row.cache, 0);
  assert.equal(src.logs({ model: 'claude-opus-5-5', status: 'ok' }).rows[0].cache, 500);
  const d = src.log(src.logs({ status: '429' }).rows[0].id)!;
  assert.match(d.failBody, /Individual quota/);
  assert.ok(!d.failBody.includes('secret-token-value'));
  assert.equal(d.path, '/v1/chat/completions');
  assert.equal(src.log(99999), null);
});

test('usage: totals by model / account and a trend over local buckets', () => {
  const u = src.usage('24h', 480, NOW);
  assert.equal(u.totals.req, 4); // the 30h-old one is outside
  assert.equal(u.totals.ok, 2);
  assert.equal(u.models[0].name, 'gemini-4-argon-low');
  assert.equal(u.accounts.length, 3);
  assert.equal(u.trend.length, 24);
  assert.equal(u.trend.reduce((n, b) => n + b.req, 0), 4);
  assert.equal((u.from + 480 * 60000) % H, 0);
  const w = src.usage('7d', 480, NOW);
  assert.equal(w.totals.req, 5);
  assert.equal((w.from + 480 * 60000) % (24 * H), 0);
});

test('lastUsed and bans (latest request per account was a 403)', () => {
  assert.equal(src.lastUsed().get('antigravity-b@x.io.json'), NOW - 0.5 * H);
  const bans = src.bans(NOW - 24 * H);
  assert.deepEqual([...bans.keys()], ['antigravity-c@x.io.json']);
  assert.match(bans.get('antigravity-c@x.io.json')!.message, /appeal_url/);
});

test('bans pick the latest request by time, not by arrival order; error summaries are masked', () => {
  const s = new QueueStore(join(dir, 'order.sqlite'));
  s.ingest([
    rec('late', { ts: NOW - 0.2 * H, model: 'm' }),                                                  // newer, arrives first
    rec('late', { ts: NOW - 0.8 * H, model: 'm', failed: true, status: 403, summary: BAN_SUMMARY }),  // older, arrives later
    rec('leak', { ts: NOW - 0.1 * H, model: 'm', failed: true, status: 401, summary: 'Authorization: Bearer ya29.leakedtokenvalue' }),
    rec('nobody', { ts: NOW - 0.1 * H, model: 'm' }),                                                // credential not in the list
  ], who);
  assert.equal(s.bans(NOW - 24 * H).has('antigravity-late@x.io.json'), false);
  const err = s.logs({ status: 'err' }).rows.map((r) => r.error).join('\n');
  assert.ok(!err.includes('leakedtokenvalue'), err);
  assert.equal(s.logs({ account: 'unknown' }).total, 1);
  s.close();
});

test('retention: rows older than the setting are pruned; the store survives a restart', () => {
  const s = new QueueStore(join(dir, 'prune.sqlite'));
  s.ingest([rec('a', { ts: NOW - 40 * 24 * H, model: 'm' }), rec('a', { ts: NOW - 2 * H, model: 'm' }), null], who);
  assert.equal(s.prune(30, NOW), 1);
  assert.equal(s.logs({}).total, 1);
  s.close();
  const again = new QueueStore(join(dir, 'prune.sqlite'));
  assert.equal(again.logs({}).total, 1);
  again.close();
});

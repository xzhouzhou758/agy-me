// Local preview against a mock CPA whose usage queue starts with a week of generated requests:
//   npm run dev        -> http://127.0.0.1:8321/me/   password: agyme-dev
// Data lives in ./.dev (deleted on each start).
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockCPA, type MockCred } from './mock-cpa.ts';
import { queueRecord, BAN_SUMMARY } from './fixture-usage.ts';

const MGMT = 'dev-mgmt-key';
const PORT = Number(process.env.PORT || 8321);
const dir = join(process.cwd(), '.dev');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const mock = startMockCPA({ mgmtKey: MGMT });
const accounts: [string, Partial<MockCred>][] = [];
const tiers = ['g1-ultra-tier', 'g1-pro-tier', 'g1-pro-tier', undefined, 'g1-pro-tier', 'standard-tier'];
for (let i = 1; i <= 26; i++) {
  const extra: Partial<MockCred> = { tier: tiers[i % tiers.length], quota: { gemini: [Math.max(0, 1 - (i % 5) * 0.25), Math.max(0, 1 - (i % 7) * 0.15)], claude: [i % 4 === 0 ? 0 : 0.2 + (i % 3) * 0.3, i % 9 === 0 ? 0 : 0.6], argon: i % 3 === 0 ? 0.4 : i % 3 === 1 ? null : 0 } };
  if (i === 4 || i === 17) Object.assign(extra, { forbidden: true });
  if (i === 7) Object.assign(extra, { status: 'error', unavailable: true, status_message: '{"error":{"code":429,"message":"Individual quota reached. Resets in 83h4m44s.","status":"RESOURCE_EXHAUSTED"}}' });
  if (i === 12) Object.assign(extra, { cooldowns: [{ scope: 'auth', reason: 'rate limited', retry_at: new Date(Date.now() + 20 * 60000).toISOString(), http_status: 429 }], unavailable: true });
  if (i === 20 || i === 21) Object.assign(extra, { disabled: true });
  accounts.push([`user${String(i).padStart(2, '0')}@example.invalid`, extra]);
}
for (const [email, extra] of accounts) mock.addCred(`antigravity-${email}.json`, email, extra);

const MODELS = ['claude-opus-5-5', 'claude-opus-5-5-low', 'gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.8-flash-medium', 'claude-sonnet-5-5'];
const now = Date.now();
const ix = (email: string) => mock.st.creds.get(`antigravity-${email}.json`)!.index;
for (let k = 0; k < 900; k++) {
  const ts = now - Math.floor(Math.pow(Math.random(), 1.6) * 7 * 864e5);
  const email = accounts[Math.floor(Math.random() * accounts.length)][0];
  const model = MODELS[Math.floor(Math.random() * MODELS.length)];
  const fail = Math.random() < 0.08;
  mock.st.queue.push(queueRecord(ix(email), { ts, model, resolved: model.replace(/(-low|-medium)?$/, '-high'), failed: fail, status: fail ? (Math.random() < 0.5 ? 429 : 502) : 200,
    summary: fail ? 'RESOURCE_EXHAUSTED: Individual quota reached' : undefined, ttft: fail ? 0 : 300 + Math.floor(Math.random() * 6000),
    latency: 2000 + Math.floor(Math.random() * 60000), in: 2000 + Math.floor(Math.random() * 200000), out: Math.floor(Math.random() * 8000), cache: Math.floor(Math.random() * 150000), think: Math.floor(Math.random() * 3000) }));
}
mock.st.queue.push(queueRecord(ix(accounts[16][0]), { ts: now - 3600e3, model: 'claude-opus-5-5', failed: true, status: 403, summary: BAN_SUMMARY }));

mock.server.listen(0, '127.0.0.1', () => {
  const cpaPort = (mock.server.address() as AddressInfo).port;
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_PATH: '/me', DATA_DIR: join(dir, 'data'), CPA_URL: `http://127.0.0.1:${cpaPort}`,
      CPA_MANAGEMENT_KEY: MGMT, APP_PASSWORD: 'agyme-dev', QUOTA_REFRESH_MINUTES: '15' },
    stdio: 'inherit',
  });
  console.log(`[dev] mock CPA on :${cpaPort}; open http://127.0.0.1:${PORT}/me/  (password: agyme-dev)`);
  const bye = () => { app.kill('SIGTERM'); mock.server.close(); setTimeout(() => process.exit(0), 500); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  app.on('exit', (c) => { mock.server.close(); process.exit(c ?? 0); });
});

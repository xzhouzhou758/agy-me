// Runtime configuration, read once from the environment.

const env = process.env;

function str(name: string, def = ''): string {
  const v = env[name];
  return v === undefined ? def : v.trim();
}
function int(name: string, def: number): number {
  const v = Number.parseInt(str(name), 10);
  return Number.isFinite(v) ? v : def;
}
function bool(name: string, def = false): boolean {
  const v = str(name).toLowerCase();
  if (!v) return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const config = {
  host: str('HOST', '127.0.0.1'),
  port: int('PORT', 8321),
  dataDir: str('DATA_DIR', './data'),
  basePath: str('BASE_PATH', '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/'), // e.g. /me
  // Secure cookie: 'auto' = only when the request came in over https (X-Forwarded-Proto behind the proxy)
  cookieSecure: (['1', 'true', 'on'].includes(str('COOKIE_SECURE').toLowerCase()) ? 'on' : ['0', 'false', 'off'].includes(str('COOKIE_SECURE').toLowerCase()) ? 'off' : 'auto') as 'on' | 'off' | 'auto',
  sessionDays: int('SESSION_DAYS', 30),
  trustProxy: bool('TRUST_PROXY', true),

  // Login: APP_PASSWORD_HASH (scrypt:salt:hash, from `npm run passwd`) wins over a plain APP_PASSWORD.
  passwordHash: str('APP_PASSWORD_HASH'),
  password: str('APP_PASSWORD'),
  // A password changed on the settings page (state.json) wins over both; APP_PASSWORD_RESET=1 drops it at startup.
  passwordReset: bool('APP_PASSWORD_RESET'),

  // CLIProxyAPI management API
  cpaURL: str('CPA_URL', 'http://127.0.0.1:8318').replace(/\/+$/, ''),
  cpaMgmtKey: str('CPA_MANAGEMENT_KEY'),

  // Quota (Google calls go through CPA /requests/api-call, CPA injects the account's token)
  quotaBaseURLs: (str('QUOTA_BASE_URLS') || 'https://daily-cloudcode-pa.googleapis.com,https://daily-cloudcode-pa.sandbox.googleapis.com,https://cloudcode-pa.googleapis.com')
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  quotaUserAgent: str('QUOTA_USER_AGENT', 'antigravity/hub/2.28.0 (aidev_client; os_type=windows; arch=amd64)'),
  quotaRefreshMinutes: int('QUOTA_REFRESH_MINUTES', 15), // default for the setting; 0 = off
  quotaConcurrency: Math.max(1, int('QUOTA_CONCURRENCY', 4)),

  // Auto-disable (403 accounts): how often to look (0 = never, for tests), how often to probe an auto-disabled account,
  // when an account counts as idle
  autoSweepMs: Math.max(0, int('AUTO_DISABLE_SWEEP_MS', 30000)),
  autoProbeMs: Math.max(1, int('AUTO_DISABLE_PROBE_SECONDS', 1800)) * 1000,
  autoIdleMs: Math.max(1, int('AUTO_DISABLE_IDLE_SECONDS', 3600)) * 1000,

  // Request log: drained from CPA's usage queue into DATA_DIR/usage.sqlite
  usageRetentionDays: Math.max(1, int('USAGE_RETENTION_DAYS', 30)),
  usagePollMs: Math.max(500, int('USAGE_POLL_MS', 5000)),

  // Remote browser (ops/browserd.py on the host, own instance). Empty token = page hidden.
  browserdURL: str('BROWSERD_URL', 'http://127.0.0.1:8331').replace(/\/+$/, ''),
  browserdToken: str('BROWSERD_TOKEN'),
  browserUpstream: str('BROWSER_UPSTREAM', 'http://127.0.0.1:3011').replace(/\/+$/, ''),
  browserIdleMinutes: int('BROWSER_IDLE_MINUTES', 30), // stop the container after this long with no viewer; 0 = never

  maxBodyBytes: int('MAX_BODY_MB', 20) * 1024 * 1024,
};

export function validateConfig(): string[] {
  const errs: string[] = [];
  if (!config.cpaMgmtKey) errs.push('CPA_MANAGEMENT_KEY is required');
  if (!config.passwordHash && !config.password) errs.push('APP_PASSWORD_HASH (or APP_PASSWORD) is required');
  if (config.passwordHash && !/^scrypt:[^:]+:[^:]+$/.test(config.passwordHash)) errs.push('APP_PASSWORD_HASH must look like scrypt:<salt>:<hash> (npm run passwd)');
  return errs;
}

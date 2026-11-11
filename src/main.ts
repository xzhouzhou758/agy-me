import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateConfig } from './config.ts';
import { sendError, HttpError } from './util.ts';
import { handleAPI } from './api.ts';
import { pruneSessions, checkPasswordChange } from './auth.ts';
import { flushAll } from './store.ts';
import { startQuotaRefresher } from './quota.ts';
import { handleBrowser, handleBrowserUpgrade, startBrowser } from './browser.ts';
import { handleCpaPanel } from './cpapanel.ts';
import { QueueStore, setUsageSource, startUsageDrainer } from './usage.ts';
import * as cpa from './cpa.ts';
import { startAutoDisable } from './autodisable.ts';

const errs = validateConfig();
if (errs.length) {
  for (const e of errs) console.error('[config]', e);
  process.exit(1);
}
const usage = new QueueStore(join(config.dataDir, 'usage.sqlite'));
setUsageSource(usage);
if (checkPasswordChange()) console.log('[auth] password changed: all sessions logged out');

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const SEC = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

// static files are small: load once
const files = new Map<string, Buffer>();
for (const f of ['index.html', 'app.js', 'filter.js', 'app.css', 'theme.js', 'icons/gemini.svg', 'icons/claude.svg', 'icons/openai.svg', 'icons/openai-dark.svg', 'favicon.png', 'apple-touch-icon.png', 'logo.jpg', 'fonts/manrope-brand.woff2']) {
  const p = join(PUBLIC, f);
  if (existsSync(p)) files.set(f, readFileSync(p));
}
// version stamp on the page's own scripts / styles, so a deploy is picked up at once instead of after the 5-minute cache
{
  const v = (f: string) => createHash('sha256').update(files.get(f) || '').digest('hex').slice(0, 10);
  const html = files.get('index.html');
  if (html) files.set('index.html', Buffer.from(html.toString().replace(/(src|href)="(app\.js|filter\.js|app\.css|theme\.js)"/g, (_m, k, f) => `${k}="${f}?v=${v(f)}"`)));
}
function sendStatic(res: http.ServerResponse, name: string) {
  const b = files.get(name);
  if (!b) throw new HttpError(404, 'not_found');
  const ext = name.slice(name.lastIndexOf('.'));
  res.writeHead(200, { ...SEC, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  let url: URL;
  try {
    url = new URL(req.url || '/', 'http://local');
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (config.basePath) {
    if (url.pathname === config.basePath) {
      res.writeHead(301, { Location: config.basePath + '/' + url.search }).end();
      return;
    }
    if (!url.pathname.startsWith(config.basePath + '/')) {
      res.writeHead(404).end();
      return;
    }
    url.pathname = url.pathname.slice(config.basePath.length);
  }
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await handleAPI(req, res, url);
    if (p === '/browser' || p.startsWith('/browser/')) return await handleBrowser(req, res, url);
    if (p === '/cpa' || p.startsWith('/cpa/')) return await handleCpaPanel(req, res, url);
    if (p === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    if (p === '/' || p === '/index.html') return sendStatic(res, 'index.html');
    if (files.has(p.slice(1))) return sendStatic(res, p.slice(1));
    throw new HttpError(404, 'not_found');
  } catch (e) {
    if (res.headersSent) return res.destroy();
    sendError(res, e);
  }
});
server.on('upgrade', handleBrowserUpgrade);
server.headersTimeout = 60000;
server.requestTimeout = 120000;
server.keepAliveTimeout = 65000;

server.listen(config.port, config.host, () => {
  console.log(`[agy-me] listening on ${config.host}:${config.port}${config.basePath || ''}`);
  startQuotaRefresher();
  startBrowser();
  startUsageDrainer(usage, config.usagePollMs, config.usageRetentionDays);
  startAutoDisable();
  cpa.refreshCreds().catch((e) => console.error('[cpa] initial credential list failed:', e.message));
  setInterval(() => { try { pruneSessions(); } catch (e) { console.error('[prune]', e); } }, 3600000).unref();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { flushAll(); } catch (e) { console.error('[store] flush on exit failed:', e); }
    server.close();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

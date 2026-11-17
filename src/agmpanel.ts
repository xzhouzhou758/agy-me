// Antigravity-Manager native web panel served under <base>/agm/ behind agy-me session auth.
// Real AGM admin password / API key stays on this server; browser uses an opaque placeholder token replaced here.
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config, agmOn } from './config.ts';
import { requireAuth } from './auth.ts';
import { HttpError } from './util.ts';

const HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer',
  'host', 'cookie', 'authorization', 'x-api-key', 'content-length', 'accept-encoding',
]);

function bootScript(prefix: string): string {
  const p = JSON.stringify(prefix);
  return `(function(){
  try { localStorage.setItem('abv_admin_api_key', 'agy-session-proxy'); } catch (_) {}
  var P = ${p};
  function rewrite(u) {
    if (typeof u !== 'string') return u;
    if (u.indexOf('/api/') === 0 || u.indexOf('/v1/') === 0) return P + u;
    return u;
  }
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(input, init) {
      if (typeof input === 'string') input = rewrite(input);
      else if (input && typeof input.url === 'string') {
        var r = rewrite(input.url);
        if (r !== input.url) input = new Request(r, input);
      }
      return origFetch.call(this, input, init);
    };
  }
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof url === 'string') args[1] = rewrite(url);
    return origOpen.apply(this, args);
  };
})();`;
}

export async function handleAgmPanel(req: IncomingMessage, res: ServerResponse, url: URL) {
  requireAuth(req);
  if (!agmOn()) throw new HttpError(404, 'not_found', 'Antigravity-Manager 未配置');

  const sub = url.pathname.slice('/agm'.length) || '/';
  const prefix = config.basePath + '/agm';

  if (url.pathname === '/agm') {
    res.writeHead(301, { Location: prefix + '/' + url.search });
    return res.end();
  }

  // CSRF defense on mutating requests through the panel proxy
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      try {
        if (new URL(String(origin)).host !== host) throw new HttpError(403, 'csrf_origin');
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(403, 'csrf_origin');
      }
    }
  }

  if (sub === '/__boot.js') {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    const js = bootScript(prefix);
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(js);
  }

  if (sub === '/' || sub === '/index.html') {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    let r: Response;
    try {
      r = await fetch(config.agmURL + '/', { signal: AbortSignal.timeout(8000) });
    } catch {
      throw new HttpError(502, 'agm_panel_unavailable');
    }
    if (!r.ok) throw new HttpError(502, 'agm_panel_unavailable');
    let html = await r.text();
    html = html
      .replace(/(src|href)=(["'])(?:\.\/|\/)assets\//g, `$1=$2${prefix}/assets/`)
      .replace(/<head([^>]*)>/i, `<head$1><script src="${prefix}/__boot.js"></script>`);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self' 'unsafe-inline' data: blob:; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    return res.end(html);
  }

  if (sub.startsWith('/assets/') || sub === '/icon.png' || sub === '/favicon.ico' || sub.startsWith('/api/') || sub.startsWith('/v1/')) {
    return proxy(req, res, sub + url.search);
  }
  throw new HttpError(404, 'not_found');
}

function proxy(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const target = new URL(config.agmURL + path);
  const tls = target.protocol === 'https:';
  const headers: Record<string, any> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (!HOP.has(lk) && !lk.startsWith('x-forwarded') && lk !== 'x-real-ip') headers[k] = v;
  }
  headers.authorization = 'Bearer ' + config.agmAdminKey;
  headers['x-api-key'] = config.agmAdminKey;

  return new Promise((resolve) => {
    const up = (tls ? https : http).request({
      hostname: target.hostname,
      port: target.port || (tls ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    }, (ur) => {
      const h: Record<string, any> = {};
      for (const [k, v] of Object.entries(ur.headers)) {
        const lk = k.toLowerCase();
        if (!HOP.has(lk) && !lk.startsWith('access-control-') && lk !== 'set-cookie') h[k] = v;
      }
      if (path.startsWith('/api/')) h['cache-control'] = 'no-store';
      res.writeHead(ur.statusCode || 502, h);
      ur.pipe(res);
      ur.on('end', () => resolve());
      ur.on('error', () => { res.destroy(); resolve(); });
    });
    up.setTimeout(30000, () => up.destroy(new Error('timeout')));
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"agm_unavailable"}');
      else res.destroy();
      resolve();
    });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  });
}

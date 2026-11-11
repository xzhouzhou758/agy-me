// CPA usage-queue records (the shape of internal/redisqueue/plugin.go in CPA v8) for tests and `npm run dev`.

export type Ev = {
  ts: number; model: string; resolved?: string; failed?: boolean; status?: number; summary?: string; body?: string;
  ttft?: number; latency?: number; in?: number; out?: number; cache?: number; think?: number; stream?: boolean;
};

let n = 0;
/** One queue record for the credential with this auth_index. `summary` becomes the failure body (CPA sends the raw upstream body). */
export function queueRecord(authIndex: string, e: Ev) {
  n++;
  const failed = !!e.failed;
  const i = e.in ?? (failed ? 0 : 1000), o = e.out ?? (failed ? 0 : 200), c = e.cache ?? 0, r = e.think ?? 0;
  return {
    timestamp: new Date(e.ts).toISOString(), latency_ms: e.latency ?? 3000, ttft_ms: e.ttft ?? (failed ? 0 : 800),
    source: 'antigravity', auth_index: authIndex, user_agent: 'test-agent', request_id: 'req-' + n,
    provider: 'antigravity', executor_type: 'antigravity', model: e.resolved || e.model, alias: e.model, endpoint: '/v1/chat/completions',
    auth_type: 'oauth', reasoning_effort: '', session_id: '',
    tokens: { input_tokens: i, output_tokens: o, reasoning_tokens: r, cached_tokens: c, cache_read_tokens: c, cache_creation_tokens: 0, total_tokens: i + o + r },
    failed, generate: true, stream: e.stream !== false,
    fail: failed ? { status_code: e.status ?? 500, body: e.body || e.summary || 'upstream error' } : { status_code: 200, body: '' },
  };
}

export const BAN_SUMMARY = '{\n  "error": {\n    "code": 403,\n    "message": "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.",\n    "status": "PERMISSION_DENIED",\n    "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "TOS_VIOLATION", "metadata": {"appeal_url": "https://support.google.com/accounts/contact/disabled2"}}]\n  }\n}';

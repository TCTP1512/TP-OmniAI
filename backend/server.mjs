// TP OmniAI — backend trung gian (không cần cài thêm thư viện, Node.js >= 20).
//
// Vai trò:
//   Trình duyệt (GitHub Pages) -> backend này -> OmniRoute (chỉ nội bộ, 127.0.0.1)
// Backend xác thực mật khẩu dùng chung, cấp phiên có thời hạn, giới hạn tần suất,
// kiểm tra dữ liệu đầu vào rồi chuyển tiếp tới OmniRoute. Khóa API (nếu có) chỉ nằm ở đây.
//
// Cấu hình hoàn toàn bằng biến môi trường (xem .env.example).

import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

const cfg = {
  host: env.HOST || '127.0.0.1',
  port: num(env.PORT, 8080),
  omniUrl: (env.OMNIROUTE_URL || 'http://127.0.0.1:20128').replace(/\/+$/, ''),
  omniKey: env.OMNIROUTE_API_KEY || '',
  sitePassword: env.SITE_PASSWORD || '',
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionTtlMs: num(env.SESSION_TTL_MINUTES, 720) * 60_000,
  allowedOrigins: (env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  maxBodyBytes: num(env.MAX_BODY_BYTES, 1_500_000),
  loginMaxFailures: num(env.LOGIN_MAX_FAILURES, 5),
  loginWindowMs: num(env.LOGIN_WINDOW_MINUTES, 15) * 60_000,
  chatPerMinute: num(env.CHAT_PER_MINUTE, 20),
  maxConcurrentChats: num(env.MAX_CONCURRENT_CHATS, 6),
  upstreamTimeoutMs: num(env.UPSTREAM_TIMEOUT_SECONDS, 120) * 1000,
  streamIdleMs: num(env.STREAM_IDLE_SECONDS, 90) * 1000,
};

// ---------- Kiểm tra cấu hình khi khởi động (thất bại thì dừng, không chạy ở chế độ lỏng lẻo) ----------
function fatal(msg) {
  console.error('[TP OmniAI] Lỗi cấu hình: ' + msg);
  process.exit(1);
}
if (cfg.sitePassword.length < 8) fatal('SITE_PASSWORD phải có ít nhất 8 ký tự.');
if (cfg.allowedOrigins.length === 0) fatal('ALLOWED_ORIGIN chưa được đặt (ví dụ https://tenban.github.io).');
for (const o of cfg.allowedOrigins) {
  let u;
  try {
    u = new URL(o);
  } catch {
    fatal('ALLOWED_ORIGIN không hợp lệ: ' + o);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.origin !== o || !(u.protocol === 'https:' || (local && u.protocol === 'http:'))) {
    fatal('ALLOWED_ORIGIN phải có dạng https://tenmien (không có đường dẫn phía sau): ' + o);
  }
}
try {
  const u = new URL(cfg.omniUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname) && env.ALLOW_REMOTE_ROUTER !== '1') {
    fatal('OMNIROUTE_URL phải trỏ về máy này (127.0.0.1). Đây là biện pháp chống chuyển tiếp tới địa chỉ tùy ý.');
  }
} catch {
  fatal('OMNIROUTE_URL không hợp lệ.');
}
const allowedOrigins = new Set(cfg.allowedOrigins);

// ---------- Tiện ích ----------
const EXPOSED_HEADERS = ['X-OmniRoute-Decision', 'X-OmniRoute-Model', 'X-OmniRoute-Provider', 'X-OmniRoute-Fallback-Attempts'];
const SECRET_PATTERNS = [/sk-[A-Za-z0-9_\-]{8,}/g, /Bearer\s+[A-Za-z0-9._\-]{8,}/gi, /[A-Za-z0-9_\-]{32,}/g];

function redact(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[đã ẩn]');
  return out.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
}
function cleanHeaderValue(v) {
  return String(v).replace(/[^\x20-\x7e]/g, '').slice(0, 200);
}
function log(req, status, started) {
  // Chỉ ghi phương thức, đường dẫn và mã trạng thái. Không ghi nội dung, khóa hay mật khẩu.
  const path = (req.url || '').split('?')[0];
  console.log(`${new Date().toISOString()} ${req.method} ${path} ${status} ${Date.now() - started}ms`);
}

class SlidingWindow {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  _prune(key, now) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    return arr;
  }
  count(key) {
    return this._prune(key, Date.now()).length;
  }
  add(key) {
    const now = Date.now();
    const arr = this._prune(key, now);
    arr.push(now);
    this.hits.set(key, arr);
  }
  retryAfterSec(key) {
    const arr = this._prune(key, Date.now());
    if (!arr.length) return 0;
    return Math.max(1, Math.ceil((arr[0] + this.windowMs - Date.now()) / 1000));
  }
  sweep() {
    const now = Date.now();
    for (const k of [...this.hits.keys()]) this._prune(k, now);
  }
}
const loginFailuresByIp = new SlidingWindow(cfg.loginMaxFailures, cfg.loginWindowMs);
const loginFailuresGlobal = new SlidingWindow(cfg.loginMaxFailures * 6, cfg.loginWindowMs);
const chatRate = new SlidingWindow(cfg.chatPerMinute, 60_000);
setInterval(() => {
  loginFailuresByIp.sweep();
  loginFailuresGlobal.sweep();
  chatRate.sweep();
}, 60_000).unref();

function clientIp(req) {
  // Backend chỉ nhận kết nối từ ngrok (cùng máy). Dòng cuối của X-Forwarded-For do ngrok thêm vào.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || 'unknown';
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------- Phiên đăng nhập (token ký HMAC, có hạn dùng) ----------
const hmac = (data) => crypto.createHmac('sha256', cfg.sessionSecret).update(data).digest();

function signToken() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + cfg.sessionTtlMs, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return { token: payload + '.' + hmac(payload).toString('base64url'), exp: now + cfg.sessionTtlMs };
}
function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let given;
  try {
    given = Buffer.from(parts[1], 'base64url');
  } catch {
    return null;
  }
  const expected = hmac(parts[0]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}
function passwordMatches(candidate) {
  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(cfg.sitePassword).digest();
  return crypto.timingSafeEqual(a, b);
}
function authenticate(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  return verifyToken(h.slice(7).trim());
}

// ---------- Phản hồi ----------
function baseHeaders(req) {
  const h = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Origin',
  };
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, ngrok-skip-browser-warning';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Expose-Headers'] = [...EXPOSED_HEADERS, 'Retry-After'].join(', ');
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}
function sendJson(req, res, status, body, extra = {}) {
  if (res.headersSent) return res.end();
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...baseHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...extra });
  res.end(payload);
}
function sendError(req, res, status, code, message, extra = {}, detail) {
  const body = { error: { code, message } };
  if (detail) body.error.detail = redact(detail);
  sendJson(req, res, status, body, extra);
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json'), { code: 'bad_request' });
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > cfg.maxBodyBytes) throw Object.assign(new Error('Request too large'), { code: 'payload_too_large' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cfg.maxBodyBytes) throw Object.assign(new Error('Request too large'), { code: 'payload_too_large' });
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { code: 'bad_request' });
  }
}

// ---------- Gọi OmniRoute ----------
function routerHeaders(extra = {}) {
  const h = { Accept: 'application/json', ...extra };
  if (cfg.omniKey) h.Authorization = 'Bearer ' + cfg.omniKey;
  return h;
}
function classifyFetchError(err) {
  const name = err?.name;
  const code = err?.cause?.code || err?.code;
  if (name === 'AbortError' || name === 'TimeoutError') return { status: 504, code: 'router_timeout', message: 'OmniRoute did not respond in time.' };
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || name === 'TypeError')
    return { status: 503, code: 'router_unreachable', message: 'Cannot reach OmniRoute.' };
  return { status: 502, code: 'provider_error', message: 'Unexpected error while contacting OmniRoute.' };
}
async function upstreamError(upstream) {
  let text = '';
  try {
    text = (await upstream.text()).slice(0, 4000);
  } catch {
    /* bỏ qua */
  }
  let message = text;
  try {
    const j = JSON.parse(text);
    message = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : text);
  } catch {
    /* không phải JSON */
  }
  const s = upstream.status;
  const retry = upstream.headers.get('retry-after');
  const extra = retry && /^\d+$/.test(retry) ? { 'Retry-After': retry } : {};
  if (s === 401 || s === 403) return { status: 502, code: 'router_auth', msg: 'OmniRoute rejected the access key.', extra, message };
  if (s === 404) return { status: 404, code: /model/i.test(message) ? 'model_not_found' : 'upstream_not_found', msg: 'Model or route not found.', extra, message };
  if (s === 429) return { status: 429, code: /quota|credit|exhaust|billing|insufficient/i.test(message) ? 'quota_exhausted' : 'rate_limited', msg: 'Provider limit reached.', extra, message };
  if (s === 400 || s === 413 || s === 422) return { status: 400, code: 'bad_request', msg: 'The router rejected the request.', extra, message };
  return { status: 502, code: 'provider_error', msg: 'The provider returned an error.', extra, message };
}
function copyRouterHeaders(upstream) {
  const out = {};
  for (const name of EXPOSED_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) out[name] = cleanHeaderValue(v);
  }
  return out;
}

// ---------- Kiểm tra dữ liệu chat ----------
const MODEL_RE = /^(?!.*(?:\.\.|:\/\/))[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,199}$/;
function validateChat(body) {
  if (typeof body.model !== 'string' || !MODEL_RE.test(body.model)) return 'model is missing or invalid';
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 200) return 'messages must contain 1-200 items';
  for (const m of body.messages) {
    if (!m || typeof m !== 'object') return 'invalid message';
    if (!['system', 'user', 'assistant'].includes(m.role)) return 'invalid role';
    if (typeof m.content !== 'string' || m.content.length === 0 || m.content.length > 600_000) return 'invalid content';
  }
  if (body.temperature !== undefined && !(typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2)) return 'invalid temperature';
  if (body.max_tokens !== undefined && !(Number.isInteger(body.max_tokens) && body.max_tokens >= 1 && body.max_tokens <= 65536)) return 'invalid max_tokens';
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return 'invalid stream';
  return null;
}

// ---------- Các endpoint ----------
let activeChats = 0;

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (loginFailuresByIp.count(ip) >= cfg.loginMaxFailures || loginFailuresGlobal.count('*') >= cfg.loginMaxFailures * 6) {
    const wait = Math.max(loginFailuresByIp.retryAfterSec(ip), loginFailuresGlobal.retryAfterSec('*'));
    return sendError(req, res, 429, 'too_many_attempts', 'Too many failed attempts. Try again later.', { 'Retry-After': String(wait) });
  }
  const body = await readJson(req);
  if (typeof body.password !== 'string' || body.password.length === 0 || body.password.length > 200 || !passwordMatches(body.password)) {
    loginFailuresByIp.add(ip);
    loginFailuresGlobal.add('*');
    await new Promise((r) => setTimeout(r, 400));
    return sendError(req, res, 401, 'bad_credentials', 'Wrong password.');
  }
  const { token, exp } = signToken();
  sendJson(req, res, 200, { token, expiresAt: exp });
}

async function handleModels(req, res) {
  let upstream;
  try {
    upstream = await fetch(cfg.omniUrl + '/v1/models?prefix=alias', { headers: routerHeaders(), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    const e = classifyFetchError(err);
    return sendError(req, res, e.status, e.code, e.message);
  }
  if (!upstream.ok) {
    const e = await upstreamError(upstream);
    return sendError(req, res, e.status, e.code, e.msg, e.extra, e.message);
  }
  let json;
  try {
    json = await upstream.json();
  } catch {
    return sendError(req, res, 502, 'bad_upstream_response', 'OmniRoute returned an unreadable model list.');
  }
  if (!json || !Array.isArray(json.data)) return sendError(req, res, 502, 'bad_upstream_response', 'OmniRoute returned an unexpected model list.');
  const models = json.data
    .filter((m) => m && typeof m.id === 'string' && MODEL_RE.test(m.id))
    .slice(0, 3000)
    .map((m) => ({ id: m.id, owned_by: typeof m.owned_by === 'string' ? m.owned_by.slice(0, 80) : undefined, type: typeof m.type === 'string' ? m.type.slice(0, 40) : undefined }));
  sendJson(req, res, 200, { models, total: models.length });
}

async function handleStatus(req, res, url) {
  const out = { backend: { ok: true }, router: { reachable: false } };
  const t0 = Date.now();
  try {
    const r = await fetch(cfg.omniUrl + '/v1/models?prefix=alias', { headers: routerHeaders(), signal: AbortSignal.timeout(10_000) });
    out.router.httpStatus = r.status;
    out.router.latencyMs = Date.now() - t0;
    if (r.ok) {
      out.router.reachable = true;
      try {
        const j = await r.json();
        out.router.modelCount = Array.isArray(j.data) ? j.data.length : null;
      } catch {
        out.router.modelCount = null;
      }
    } else {
      const e = await upstreamError(r);
      out.router.error = { code: e.code, detail: redact(e.message) };
    }
  } catch (err) {
    const e = classifyFetchError(err);
    out.router.error = { code: e.code };
  }
  const probeModel = url.searchParams.get('probe');
  if (probeModel && out.router.reachable) {
    if (!MODEL_RE.test(probeModel)) return sendError(req, res, 400, 'bad_request', 'Invalid model.');
    const p0 = Date.now();
    try {
      const r = await fetch(cfg.omniUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: routerHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ model: probeModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false }),
        signal: AbortSignal.timeout(60_000),
      });
      const hdr = copyRouterHeaders(r);
      if (r.ok) {
        let reported = null;
        try {
          reported = (await r.json())?.model ?? null;
        } catch {
          /* bỏ qua */
        }
        out.probe = { model: probeModel, ok: true, latencyMs: Date.now() - p0, reportedModel: typeof reported === 'string' ? reported.slice(0, 200) : null, headers: hdr };
      } else {
        const e = await upstreamError(r);
        out.probe = { model: probeModel, ok: false, latencyMs: Date.now() - p0, error: { code: e.code, detail: redact(e.message) } };
      }
    } catch (err) {
      out.probe = { model: probeModel, ok: false, error: { code: classifyFetchError(err).code } };
    }
  }
  sendJson(req, res, 200, out);
}

async function handleChat(req, res, auth) {
  if (chatRate.count(auth.n) >= cfg.chatPerMinute) {
    return sendError(req, res, 429, 'rate_limited', 'Too many requests. Slow down.', { 'Retry-After': String(chatRate.retryAfterSec(auth.n)) });
  }
  if (activeChats >= cfg.maxConcurrentChats) return sendError(req, res, 503, 'server_busy', 'The server is busy. Try again shortly.', { 'Retry-After': '5' });
  const body = await readJson(req);
  const problem = validateChat(body);
  if (problem) return sendError(req, res, 400, 'bad_request', problem);
  chatRate.add(auth.n);

  const stream = body.stream !== false;
  const payload = { model: body.model, messages: body.messages.map((m) => ({ role: m.role, content: m.content })), stream };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;

  const controller = new AbortController();
  const onClientGone = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClientGone);
  const headerTimer = setTimeout(() => controller.abort(), cfg.upstreamTimeoutMs);
  activeChats++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activeChats--;
    }
  };
  res.on('close', release);

  let upstream;
  try {
    upstream = await fetch(cfg.omniUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: routerHeaders({ 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(headerTimer);
    if (res.destroyed) return;
    const e = classifyFetchError(err);
    return sendError(req, res, e.status, e.code, e.message);
  }
  clearTimeout(headerTimer);

  if (!upstream.ok) {
    const e = await upstreamError(upstream);
    return sendError(req, res, e.status, e.code, e.msg, e.extra, e.message);
  }

  const routerHdrs = copyRouterHeaders(upstream);
  const ctype = upstream.headers.get('content-type') || '';
  if (!stream || !ctype.includes('text/event-stream')) {
    // Phản hồi thường (không streaming) hoặc router trả JSON dù yêu cầu stream.
    const text = await upstream.text();
    res.writeHead(200, { ...baseHeaders(req), ...routerHdrs, 'Content-Type': ctype.includes('json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' });
    return res.end(text);
  }

  res.writeHead(200, { ...baseHeaders(req), ...routerHdrs, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.socket?.setNoDelay(true);
  res.flushHeaders();

  const nodeStream = Readable.fromWeb(upstream.body);
  let idle;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), cfg.streamIdleMs);
  };
  armIdle();
  nodeStream.on('data', armIdle);
  nodeStream.on('error', () => {
    clearTimeout(idle);
    // Luồng bị ngắt giữa chừng: kết thúc kết nối đột ngột để trình duyệt nhận biết là chưa hoàn tất.
    res.destroy();
  });
  nodeStream.on('end', () => clearTimeout(idle));
  res.on('close', () => {
    clearTimeout(idle);
    nodeStream.destroy();
  });
  nodeStream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  res.on('finish', () => log(req, res.statusCode, started));
  res.on('close', () => {
    if (!res.writableFinished) log(req, res.statusCode + '(closed)', started);
  });
  try {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return sendError(req, res, 403, 'origin_not_allowed', 'Origin not allowed.');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, baseHeaders(req));
      return res.end();
    }
    if (url.pathname === '/' && req.method === 'GET') return sendJson(req, res, 200, { service: 'TP OmniAI backend', ok: true });
    if (url.pathname === '/api/health' && req.method === 'GET') return sendJson(req, res, 200, { ok: true, service: 'tp-omniai', time: new Date().toISOString() });
    if (url.pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res);

    if (url.pathname.startsWith('/api/')) {
      const auth = authenticate(req);
      if (!auth) return sendError(req, res, 401, 'unauthorized', 'Login required or session expired.');
      if (url.pathname === '/api/models' && req.method === 'GET') return await handleModels(req, res);
      if (url.pathname === '/api/status' && req.method === 'GET') return await handleStatus(req, res, url);
      if (url.pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res, auth);
    }
    return sendError(req, res, 404, 'not_found', 'Not found.');
  } catch (err) {
    if (err?.code === 'payload_too_large') return sendError(req, res, 413, 'payload_too_large', 'Request too large.');
    if (err?.code === 'bad_request') return sendError(req, res, 400, 'bad_request', err.message);
    console.error('[TP OmniAI] Lỗi nội bộ:', err?.name || 'Error'); // không in stack/nội dung
    sendError(req, res, 500, 'internal_error', 'Internal error.');
  }
});
server.headersTimeout = 20_000;
server.requestTimeout = 0; // luồng streaming có thể kéo dài; đã có giới hạn riêng theo từng bước
server.keepAliveTimeout = 5_000;

server.listen(cfg.port, cfg.host, () => {
  console.log(`[TP OmniAI] Backend đang chạy tại http://${cfg.host}:${cfg.port} → OmniRoute ${cfg.omniUrl}`);
  console.log(`[TP OmniAI] Cho phép nguồn truy cập: ${cfg.allowedOrigins.join(', ')}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startMock } from './mock-omniroute.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', 'server.mjs');
const ORIGIN = 'https://friend.github.io';
const PASSWORD = 'mat-khau-thu-123';
const ROUTER_KEY = 'ROUTERKEY_super_secret_value_9876543210abcdef';
const SESSION_SECRET = 'SESSIONSECRET_do_not_leak_0123456789abcdef0123';

let mock;
const procs = [];
let logs = '';

function launch(extraEnv = {}, port) {
  const env = {
    ...process.env,
    PORT: String(port),
    SITE_PASSWORD: PASSWORD,
    ALLOWED_ORIGIN: ORIGIN,
    OMNIROUTE_URL: `http://127.0.0.1:${mock.port}`,
    OMNIROUTE_API_KEY: ROUTER_KEY,
    SESSION_SECRET,
    ...extraEnv,
  };
  const p = spawn(process.execPath, [SERVER], { env });
  p.stdout.on('data', (d) => (logs += d));
  p.stderr.on('data', (d) => (logs += d));
  procs.push(p);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('backend không khởi động')), 5000);
    p.stdout.on('data', (d) => {
      if (String(d).includes('đang chạy')) {
        clearTimeout(t);
        resolve({ base: `http://127.0.0.1:${port}`, proc: p });
      }
    });
    p.on('exit', (c) => {
      clearTimeout(t);
      reject(new Error('backend thoát sớm, mã ' + c));
    });
  });
}

let A; // backend chính
before(async () => {
  mock = await startMock();
  A = await launch({ LOGIN_MAX_FAILURES: '4', CHAT_PER_MINUTE: '1000' }, 18081);
});
after(() => {
  for (const p of procs) p.kill();
  mock.server.close();
});

const call = (base, p, { method = 'GET', token, body, origin = ORIGIN, headers = {}, raw } = {}) =>
  fetch(base + p, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });

async function login(base = A.base) {
  const r = await call(base, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: { 'X-Forwarded-For': '9.9.9.' + Math.floor(Math.random() * 200) } });
  assert.equal(r.status, 200);
  return (await r.json()).token;
}

test('health: công khai, không cần đăng nhập', async () => {
  const r = await call(A.base, '/api/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('CORS: nguồn hợp lệ được phép, nguồn lạ bị từ chối, preflight đúng', async () => {
  const ok = await call(A.base, '/api/health');
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  const bad = await call(A.base, '/api/health', { origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const pre = await call(A.base, '/api/chat', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /ngrok-skip-browser-warning/);
  const preBad = await call(A.base, '/api/chat', { method: 'OPTIONS', origin: 'https://evil.example' });
  assert.equal(preBad.status, 403);
});

test('gọi API khi chưa xác thực bị chặn (401)', async () => {
  for (const [m, p] of [['GET', '/api/models'], ['GET', '/api/status'], ['POST', '/api/chat']]) {
    const r = await call(A.base, p, { method: m, body: m === 'POST' ? { model: 'x', messages: [] } : undefined });
    assert.equal(r.status, 401, p);
    assert.equal((await r.json()).error.code, 'unauthorized');
  }
});

test('token giả, bị sửa, sai chữ ký đều bị từ chối', async () => {
  const good = await login();
  const [payload, sig] = good.split('.');
  const forged = Buffer.from(JSON.stringify({ iat: 1, exp: Date.now() + 1e9, n: 'x' })).toString('base64url');
  for (const t of ['abc', good + 'x', payload + '.' + 'A'.repeat(sig.length), forged + '.' + sig, '']) {
    const r = await call(A.base, '/api/models', { token: t || undefined });
    assert.equal(r.status, 401);
  }
});

test('token hết hạn bị từ chối', async () => {
  const short = await launch({ SESSION_TTL_MINUTES: '0.01' }, 18082); // ~0,6 giây
  const r = await call(short.base, '/api/login', { method: 'POST', body: { password: PASSWORD } });
  const { token } = await r.json();
  assert.equal((await call(short.base, '/api/models', { token })).status, 200);
  await new Promise((r2) => setTimeout(r2, 900));
  const after = await call(short.base, '/api/models', { token });
  assert.equal(after.status, 401);
});

test('đăng nhập: sai mật khẩu → 401; đúng → token; khóa sau nhiều lần sai', async () => {
  const ip = { 'X-Forwarded-For': '7.7.7.7' };
  for (let i = 0; i < 4; i++) {
    const r = await call(A.base, '/api/login', { method: 'POST', body: { password: 'sai-' + i }, headers: ip });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, 'bad_credentials');
  }
  const locked = await call(A.base, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: ip });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error.code, 'too_many_attempts');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  // IP khác vẫn đăng nhập được
  const other = await call(A.base, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: { 'X-Forwarded-For': '8.8.8.8' } });
  assert.equal(other.status, 200);
});

test('danh sách model: lọc ID không hợp lệ, dùng khóa router ở backend', async () => {
  const token = await login();
  const r = await call(A.base, '/api/models', { token });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.models.map((m) => m.id), ['cc/claude-sonnet-4-6', 'gemini/gemini-2.5-pro', 'oc/free-model', 'my-combo']);
  const st = await (await fetch(`http://127.0.0.1:${mock.port}/__state`)).json();
  assert.ok(st.authHeaders.includes('Bearer ' + ROUTER_KEY), 'backend phải gửi khóa tới router');
});

test('chat không streaming: chuyển tiếp, lọc trường lạ, trả header router', async () => {
  const token = await login();
  const r = await call(A.base, '/api/chat', {
    method: 'POST',
    token,
    body: { model: 'cc/claude-sonnet-4-6', stream: false, messages: [{ role: 'user', content: 'hi', evil: 1 }], tools: [{ x: 1 }], url: 'http://evil' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-omniroute-model'), 'claude-sonnet-4-6');
  assert.match(r.headers.get('access-control-expose-headers'), /X-OmniRoute-Model/);
  assert.equal((await r.json()).choices[0].message.content, 'pong');
  const st = await (await fetch(`http://127.0.0.1:${mock.port}/__state`)).json();
  assert.deepEqual(Object.keys(st.last).sort(), ['messages', 'model', 'stream']);
  assert.deepEqual(Object.keys(st.last.messages[0]).sort(), ['content', 'role']);
});

test('streaming thật: dữ liệu đến từng phần, có [DONE]', async () => {
  const token = await login();
  const r = await call(A.base, '/api/chat', { method: 'POST', token, body: { model: 'slow-stream', messages: [{ role: 'user', content: 'đếm' }] } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  const times = [];
  let text = '';
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    times.push(Date.now());
    text += dec.decode(value, { stream: true });
  }
  assert.ok(text.includes('[DONE]'));
  assert.ok(times.length >= 4, 'phải nhận nhiều phần, nhận ' + times.length);
  assert.ok(times[times.length - 1] - times[0] > 400, 'các phần phải đến cách nhau theo thời gian');
});

test('người dùng đóng kết nối giữa chừng → backend hủy yêu cầu tới router', async () => {
  const token = await login();
  const before = (await (await fetch(`http://127.0.0.1:${mock.port}/__state`)).json()).aborted;
  const ctrl = new AbortController();
  const r = await fetch(A.base + '/api/chat', {
    method: 'POST',
    signal: ctrl.signal,
    headers: { Origin: ORIGIN, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'slow-stream', messages: [{ role: 'user', content: 'x' }] }),
  });
  await r.body.getReader().read();
  ctrl.abort();
  await new Promise((r2) => setTimeout(r2, 400));
  const after = (await (await fetch(`http://127.0.0.1:${mock.port}/__state`)).json()).aborted;
  assert.ok(after > before, 'router phải thấy kết nối bị hủy');
});

test('luồng bị router ngắt giữa chừng → client nhận lỗi/kết thúc bất thường, không có [DONE]', async () => {
  const token = await login();
  const r = await call(A.base, '/api/chat', { method: 'POST', token, body: { model: 'cut-stream', messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(r.status, 200);
  let text = '';
  let errored = false;
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  } catch {
    errored = true;
  }
  assert.ok(text.includes('Xin'));
  assert.ok(!text.includes('[DONE]'));
  assert.ok(errored || !text.includes('[DONE]'));
});

test('ánh xạ lỗi từ router: 404/429/hết quota/500/401', async () => {
  const token = await login();
  const send = (model) => call(A.base, '/api/chat', { method: 'POST', token, body: { model, stream: false, messages: [{ role: 'user', content: 'x' }] } });
  let r = await send('fail-404');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'model_not_found');
  r = await send('fail-429');
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '7');
  assert.equal((await r.json()).error.code, 'rate_limited');
  r = await send('quota');
  assert.equal((await r.json()).error.code, 'quota_exhausted');
  r = await send('fail-500');
  const j500 = await r.json();
  assert.equal(r.status, 502);
  assert.equal(j500.error.code, 'provider_error');
  assert.ok(!JSON.stringify(j500).includes('abcdefghijklmnop1234'), 'phải ẩn chuỗi giống khóa API');
  r = await send('fail-401');
  assert.equal((await r.json()).error.code, 'router_auth');
});

test('dữ liệu đầu vào không hợp lệ bị từ chối', async () => {
  const token = await login();
  const bad = [
    { model: '../../etc/passwd', messages: [{ role: 'user', content: 'x' }] },
    { model: 'http://evil.example/v1', messages: [{ role: 'user', content: 'x' }] },
    { model: 'ok', messages: [] },
    { model: 'ok', messages: [{ role: 'hacker', content: 'x' }] },
    { model: 'ok', messages: [{ role: 'user', content: 5 }] },
    { model: 'ok', messages: [{ role: 'user', content: 'x' }], temperature: 9 },
  ];
  for (const body of bad) {
    const r = await call(A.base, '/api/chat', { method: 'POST', token, body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await call(A.base, '/api/chat', { method: 'POST', token, raw: '{not json' })).status, 400);
  assert.equal((await call(A.base, '/api/chat', { method: 'POST', token, headers: { 'Content-Type': 'text/plain' }, raw: 'x' })).status, 400);
});

test('yêu cầu quá lớn bị từ chối (413)', async () => {
  const token = await login();
  const big = 'a'.repeat(1_700_000);
  const r = await call(A.base, '/api/chat', { method: 'POST', token, body: { model: 'ok', messages: [{ role: 'user', content: big }] } });
  assert.equal(r.status, 413);
});

test('giới hạn tần suất chat theo phiên', async () => {
  const lim = await launch({ CHAT_PER_MINUTE: '3' }, 18083);
  const r0 = await call(lim.base, '/api/login', { method: 'POST', body: { password: PASSWORD } });
  const { token } = await r0.json();
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await call(lim.base, '/api/chat', { method: 'POST', token, body: { model: 'x', stream: false, messages: [{ role: 'user', content: 'x' }] } });
    codes.push(r.status);
  }
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
  assert.deepEqual(codes.slice(3), [429, 429]);
});

test('router không chạy → 503 router_unreachable; trạng thái báo đúng từng tầng', async () => {
  const dead = await launch({ OMNIROUTE_URL: 'http://127.0.0.1:1' }, 18084);
  const r0 = await call(dead.base, '/api/login', { method: 'POST', body: { password: PASSWORD } });
  const { token } = await r0.json();
  const chat = await call(dead.base, '/api/chat', { method: 'POST', token, body: { model: 'x', messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(chat.status, 503);
  assert.equal((await chat.json()).error.code, 'router_unreachable');
  const st = await (await call(dead.base, '/api/status', { token })).json();
  assert.equal(st.backend.ok, true);
  assert.equal(st.router.reachable, false);
  assert.equal(st.router.error.code, 'router_unreachable');
});

test('router không phản hồi → 504 router_timeout', async () => {
  const slow = await launch({ UPSTREAM_TIMEOUT_SECONDS: '1' }, 18085);
  const r0 = await call(slow.base, '/api/login', { method: 'POST', body: { password: PASSWORD } });
  const { token } = await r0.json();
  const t0 = Date.now();
  const r = await call(slow.base, '/api/chat', { method: 'POST', token, body: { model: 'hang', messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(r.status, 504);
  assert.equal((await r.json()).error.code, 'router_timeout');
  assert.ok(Date.now() - t0 < 4000);
});

test('trạng thái: router OK + thử model', async () => {
  const token = await login();
  const st = await (await call(A.base, '/api/status?probe=cc/claude-sonnet-4-6', { token })).json();
  assert.equal(st.router.reachable, true);
  assert.equal(st.router.modelCount, 5);
  assert.equal(st.probe.ok, true);
  assert.equal(st.probe.reportedModel, 'claude-sonnet-4-6');
  const bad = await (await call(A.base, '/api/status?probe=fail-404', { token })).json();
  assert.equal(bad.probe.ok, false);
  assert.equal(bad.probe.error.code, 'model_not_found');
});

test('không rò rỉ bí mật: log và phản hồi lỗi không chứa mật khẩu/khóa', async () => {
  const token = await login();
  await call(A.base, '/api/chat', { method: 'POST', token, body: { model: 'fail-500', stream: false, messages: [{ role: 'user', content: 'x' }] } });
  await call(A.base, '/api/login', { method: 'POST', body: { password: PASSWORD + 'x' } });
  for (const secret of [PASSWORD, ROUTER_KEY, SESSION_SECRET, token]) assert.ok(!logs.includes(secret), 'log chứa bí mật');
  const nf = await (await call(A.base, '/khong-co')).text();
  assert.ok(!nf.includes('at ') && !nf.includes('node:'), 'không có stack trace');
});

test('cấu hình sai thì từ chối khởi động', async () => {
  for (const extra of [{ SITE_PASSWORD: 'ngan' }, { ALLOWED_ORIGIN: '' }, { ALLOWED_ORIGIN: 'http://tenmien.com' }, { ALLOWED_ORIGIN: 'https://x.github.io/duongdan' }, { OMNIROUTE_URL: 'http://evil.example:8080' }]) {
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: '18099', SITE_PASSWORD: PASSWORD, ALLOWED_ORIGIN: ORIGIN, OMNIROUTE_URL: `http://127.0.0.1:${mock.port}`, ...extra } });
      p.on('exit', resolve);
      setTimeout(() => {
        p.kill();
        resolve('still-running');
      }, 3000);
    });
    assert.equal(code, 1, JSON.stringify(extra));
  }
});

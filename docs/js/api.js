// Giao tiếp với backend. Không chứa khóa API hay bí mật nào.
import { getAuth, setAuth, clearAuth } from './storage.js';

export class ApiError extends Error {
  constructor(code, { status, detail, retryAfter } = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

// Địa chỉ backend chỉ lấy từ config.js (không cho nhập tùy ý trên giao diện để tránh bị dẫn tới máy chủ giả).
export function backendUrl() {
  const raw = String((window.TP_CONFIG && window.TP_CONFIG.BACKEND_URL) || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return u.origin;
  } catch {
    /* địa chỉ không hợp lệ */
  }
  return '';
}

// Gộp nhiều tín hiệu hủy (AbortSignal.any chưa có trên trình duyệt cũ).
function anySignal(signals) {
  if (signals.length <= 1) return signals[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort();
      break;
    }
    s.addEventListener('abort', () => c.abort(), { once: true });
  }
  return c.signal;
}

async function send(path, { method = 'GET', body, signal, auth = true, timeoutMs } = {}) {
  const base = backendUrl();
  if (!base) throw new ApiError('not_configured');
  const headers = { 'ngrok-skip-browser-warning': '1' }; // bỏ trang cảnh báo của ngrok gói miễn phí
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const a = getAuth();
    if (!a) throw new ApiError('unauthorized', { status: 401 });
    headers.Authorization = 'Bearer ' + a.token;
  }
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
  try {
    return await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: anySignal(signals),
    });
  } catch (e) {
    if (signal?.aborted) throw new ApiError('aborted');
    throw new ApiError('network');
  }
}

async function toError(res) {
  let j = null;
  try {
    j = await res.json();
  } catch {
    /* không phải JSON (ví dụ trang lỗi của ngrok) */
  }
  const code = j?.error?.code || (res.status === 401 ? 'unauthorized' : res.status === 404 ? 'not_found' : 'unknown');
  if (res.status === 401 && code === 'unauthorized') clearAuth();
  const ra = Number(res.headers.get('retry-after'));
  return new ApiError(code, { status: res.status, detail: j?.error?.detail, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined });
}

async function json(path, opts) {
  const res = await send(path, opts);
  if (!res.ok) throw await toError(res);
  try {
    return await res.json();
  } catch {
    throw new ApiError('unknown');
  }
}

export async function health() {
  const t0 = performance.now();
  await json('/api/health', { auth: false, timeoutMs: 10000 });
  return { ms: Math.round(performance.now() - t0) };
}

export async function login(password) {
  const j = await json('/api/login', { method: 'POST', body: { password }, auth: false, timeoutMs: 15000 });
  if (!j?.token) throw new ApiError('unknown');
  setAuth(j.token, j.expiresAt);
}

export const models = () => json('/api/models', { timeoutMs: 20000 });
export const status = (probeModel) => json('/api/status' + (probeModel ? '?probe=' + encodeURIComponent(probeModel) : ''), { timeoutMs: probeModel ? 70000 : 20000 });

// Tách các sự kiện SSE hoàn chỉnh khỏi bộ đệm. Trả về nội dung "data:" của từng sự kiện và phần dư.
export function splitSSE(buffer) {
  const text = buffer.replace(/\r\n?/g, '\n');
  const parts = text.split('\n\n');
  const rest = parts.pop() ?? '';
  const events = [];
  for (const block of parts) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) events.push(data);
  }
  return { events, rest };
}

// Gửi tin nhắn và nhận câu trả lời theo luồng thật (không giả lập).
// onDelta(text) được gọi mỗi khi có thêm nội dung; onInfo(info) khi biết thêm về model/nhà cung cấp.
export async function chatStream({ model, messages, signal, onDelta, onInfo }) {
  const res = await send('/api/chat', { method: 'POST', body: { model, messages, stream: true }, signal });
  if (!res.ok) throw await toError(res);

  const info = {
    requested: model,
    reported: res.headers.get('x-omniroute-model') || null,
    provider: res.headers.get('x-omniroute-provider') || null,
    decision: res.headers.get('x-omniroute-decision') || null,
  };
  onInfo?.({ ...info });

  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream')) {
    // Router trả về JSON thường dù đã yêu cầu stream.
    let j;
    try {
      j = await res.json();
    } catch {
      throw new ApiError('stream_interrupted');
    }
    if (j?.model && !info.reported) info.reported = String(j.model);
    onInfo?.({ ...info });
    const text = j?.choices?.[0]?.message?.content;
    if (typeof text === 'string') onDelta(text);
    return info;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let complete = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = splitSSE(buffer);
      buffer = rest;
      for (const data of events) {
        if (data.trim() === '[DONE]') {
          complete = true;
          continue;
        }
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new ApiError('provider_error', { detail: String(j.error.message || j.error).slice(0, 200) });
        if (j.model && !info.reported) {
          info.reported = String(j.model).slice(0, 200);
          onInfo?.({ ...info });
        }
        const choice = j.choices?.[0];
        if (typeof choice?.delta?.content === 'string' && choice.delta.content) onDelta(choice.delta.content);
        if (choice?.finish_reason) complete = true;
      }
    }
  } catch (e) {
    if (signal?.aborted) throw new ApiError('aborted');
    if (e instanceof ApiError) throw e;
    throw new ApiError('stream_interrupted');
  }
  if (signal?.aborted) throw new ApiError('aborted');
  if (!complete) throw new ApiError('stream_interrupted');
  return info;
}

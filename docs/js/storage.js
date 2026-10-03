// Lưu trữ cục bộ: lịch sử hội thoại, cài đặt, phiên đăng nhập. Chỉ nằm trong trình duyệt này.
const KEYS = {
  conversations: 'tpomniai.v1.conversations',
  settings: 'tpomniai.v1.settings',
  auth: 'tpomniai.v1.auth',
};

// Nếu trình duyệt chặn localStorage (ví dụ chế độ riêng tư), dùng bộ nhớ tạm để ứng dụng vẫn chạy.
const memory = new Map();
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return memory.has(k) ? memory.get(k) : null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
      return true;
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014)) return false;
      memory.set(k, v);
      return true;
    }
  },
  remove(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      memory.delete(k);
    }
  },
};

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const str = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '');

function sanitizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  if (typeof m.content !== 'string') return null;
  const out = {
    id: typeof m.id === 'string' && m.id ? m.id.slice(0, 80) : newId(),
    role: m.role,
    content: m.content,
    ts: isNum(m.ts) ? m.ts : Date.now(),
  };
  if (Array.isArray(m.attachments)) {
    out.attachments = m.attachments
      .filter((a) => a && typeof a.name === 'string' && typeof a.text === 'string')
      .map((a) => ({ name: str(a.name, 200), size: isNum(a.size) ? a.size : a.text.length, text: a.text }));
  }
  if (m.meta && typeof m.meta === 'object') {
    out.meta = {
      requested: str(m.meta.requested, 200),
      reported: str(m.meta.reported, 200) || null,
      provider: str(m.meta.provider, 120) || null,
      decision: str(m.meta.decision, 200) || null,
    };
  }
  if (m.incomplete === true) out.incomplete = true;
  if (m.stopped === true) out.stopped = true;
  return out;
}

// Làm sạch dữ liệu đọc từ localStorage: bỏ phần tử hỏng, giữ nguyên thứ tự tin nhắn.
export function sanitizeConversations(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    const messages = Array.isArray(c.messages) ? c.messages.map(sanitizeMessage).filter(Boolean) : [];
    out.push({
      id: c.id.slice(0, 80),
      title: str(c.title, 120),
      createdAt: isNum(c.createdAt) ? c.createdAt : Date.now(),
      updatedAt: isNum(c.updatedAt) ? c.updatedAt : Date.now(),
      model: str(c.model, 200),
      messages,
    });
  }
  return out;
}

export function loadConversations() {
  const raw = store.get(KEYS.conversations);
  if (raw === null) return { list: [], corrupt: false };
  try {
    const list = sanitizeConversations(JSON.parse(raw));
    if (!list) throw new Error('không phải mảng');
    return { list, corrupt: false };
  } catch {
    // Giữ lại bản gốc bị lỗi để có thể cứu dữ liệu, rồi bắt đầu lại từ danh sách trống.
    store.set(KEYS.conversations + '.corrupt.' + Date.now(), raw);
    store.remove(KEYS.conversations);
    return { list: [], corrupt: true };
  }
}

export function saveConversations(list) {
  return store.set(KEYS.conversations, JSON.stringify(list));
}

export function loadSettings() {
  try {
    const s = JSON.parse(store.get(KEYS.settings) || '{}');
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}
export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  store.set(KEYS.settings, JSON.stringify(next));
  return next;
}

// Chỉ lưu token phiên có hạn do backend cấp. Không bao giờ lưu mật khẩu.
export function getAuth() {
  try {
    const a = JSON.parse(store.get(KEYS.auth) || 'null');
    if (a && typeof a.token === 'string' && isNum(a.exp) && a.exp > Date.now()) return a;
  } catch {
    /* bỏ qua */
  }
  store.remove(KEYS.auth);
  return null;
}
export function setAuth(token, exp) {
  store.set(KEYS.auth, JSON.stringify({ token, exp }));
}
export function clearAuth() {
  store.remove(KEYS.auth);
}

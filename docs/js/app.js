// TP OmniAI — điều phối giao diện, hội thoại, lịch sử, mô hình, trạng thái kết nối.
import { t, setLang, getLang, detectLang, applyI18n, errorText } from './i18n.js';
import { loadConversations, saveConversations, loadSettings, saveSettings, getAuth, clearAuth, newId } from './storage.js';
import * as api from './api.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { readAttachment, FileError, TEXT_EXTENSIONS } from './files.js';
import { conversationToMarkdown, safeFilename, downloadText } from './export.js';

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const MAX_CONTEXT_CHARS = 120000;

const settings = loadSettings();
setLang(settings.lang || detectLang());

const state = {
  convs: [],
  activeId: null,
  models: [],
  modelsState: 'idle', // idle | loading | ok | error
  model: settings.model || '',
  busy: null, // { convId, controller }
  attachments: [],
  search: '',
  stick: true,
  status: { level: 'unknown' },
};

// ---------- Tiện ích ----------
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const activeConv = () => state.convs.find((c) => c.id === state.activeId) || null;
const displayTitle = (c) => c.title || t('untitled');
const currentModel = () => state.model || 'auto';

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6500 : 2600);
}

let lastFullWarn = 0;
function persist() {
  const ok = saveConversations(state.convs.filter((c) => c.messages.length > 0));
  if (!ok && Date.now() - lastFullWarn > 30000) {
    lastFullWarn = Date.now();
    toast(t('storageFull'), 'error');
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// ---------- Giao diện sáng/tối, ngôn ngữ ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f1d29' : '#0b7c86');
  const sym = theme === 'dark' ? 'i-sun' : 'i-moon';
  $('themeIcon').firstElementChild.setAttribute('href', '#' + sym);
  $('gateTheme').querySelector('use').setAttribute('href', '#' + sym);
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  saveSettings({ theme: next });
  applyTheme(next);
}
function applyLanguage() {
  applyI18n();
  const label = getLang().toUpperCase();
  $('langLabel').textContent = label;
  $('gateLangLabel').textContent = label;
  renderAll();
  renderGateMessage();
}
function toggleLang() {
  const next = getLang() === 'vi' ? 'en' : 'vi';
  saveSettings({ lang: next });
  setLang(next);
  applyLanguage();
}

// ---------- Màn hình mật khẩu / khởi động ----------
let gateMode = 'checking';
let gateReason = '';
function showGate(mode, reason = '') {
  gateMode = mode;
  gateReason = reason;
  $('app').hidden = true;
  $('gate').hidden = false;
  $('loginForm').hidden = mode !== 'login';
  $('gateRetry').hidden = mode !== 'down';
  $('gateErr').hidden = true;
  renderGateMessage();
  if (mode === 'login') setTimeout(() => $('pw').focus(), 50);
}
function renderGateMessage() {
  const msg = { setup: 'setupMissing', checking: 'loginChecking', down: 'backendDown', login: gateReason === 'expired' ? 'sessionExpired' : 'loginPrompt' }[gateMode];
  $('gateMsg').textContent = t(msg);
}
function gateError(text) {
  $('gateErr').textContent = text;
  $('gateErr').hidden = false;
}

async function boot() {
  applyTheme(document.documentElement.dataset.theme);
  applyLanguage();
  const { list, corrupt } = loadConversations();
  state.convs = list;
  if (corrupt) setTimeout(() => toast(t('storageCorrupt'), 'error'), 400);

  if (!api.backendUrl()) return showGate('setup');
  showGate('checking');
  try {
    await api.health();
  } catch {
    // Backend không phản hồi: nếu đã có phiên thì vẫn cho xem lịch sử, trạng thái sẽ báo mất kết nối.
    if (getAuth()) {
      enterApp();
      state.status = { level: 'offline' };
      renderStatus();
      return;
    }
    return showGate('down');
  }
  if (getAuth()) enterApp();
  else showGate('login');
}

function enterApp() {
  $('gate').hidden = true;
  $('app').hidden = false;
  const recent = [...state.convs].filter((c) => c.messages.length).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  state.activeId = recent ? recent.id : null;
  if (!state.activeId) startNewConversation();
  renderAll();
  refreshStatus();
}

function sessionExpired() {
  clearAuth();
  showGate('login', 'expired');
}

// ---------- Hội thoại ----------
function startNewConversation() {
  const cur = activeConv();
  if (cur && cur.messages.length === 0) return cur;
  const c = { id: newId(), title: '', createdAt: Date.now(), updatedAt: Date.now(), model: currentModel(), messages: [] };
  state.convs.unshift(c);
  state.activeId = c.id;
  return c;
}

function selectConversation(id) {
  const c = state.convs.find((x) => x.id === id);
  if (!c) return;
  // bỏ cuộc trò chuyện trống đang để dở nếu chuyển sang cuộc khác
  state.convs = state.convs.filter((x) => x.messages.length || x.id === id);
  state.activeId = id;
  if (c.model && (c.model === 'auto' || state.models.includes(c.model))) state.model = c.model;
  closeSidebar();
  renderAll();
}

function makeTitle(text) {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 48 ? one.slice(0, 47).trimEnd() + '…' : one;
}

// ---------- Hiển thị ----------
function renderAll() {
  renderSidebar();
  renderModelSelect();
  renderThread();
  renderComposer();
  renderStatus();
}

function renderSidebar() {
  const q = norm(state.search.trim());
  const list = state.convs
    .filter((c) => c.messages.length)
    .filter((c) => !q || norm(c.title).includes(q) || c.messages.some((m) => norm(m.content).includes(q) || (m.attachments || []).some((a) => norm(a.name).includes(q))))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const ul = $('convList');
  ul.innerHTML = '';
  for (const c of list) {
    const li = document.createElement('li');
    li.className = 'conv' + (c.id === state.activeId ? ' active' : '');
    li.dataset.id = c.id;
    li.innerHTML =
      `<button class="conv-main" type="button" data-action="open"><span class="conv-title">${escapeHtml(displayTitle(c))}</span></button>` +
      `<div class="conv-actions">` +
      `<button class="icon-btn" type="button" data-action="rename" title="${escapeHtml(t('rename'))}" aria-label="${escapeHtml(t('rename'))}">${icon('edit')}</button>` +
      `<button class="icon-btn" type="button" data-action="download" title="${escapeHtml(t('download'))}" aria-label="${escapeHtml(t('download'))}">${icon('download')}</button>` +
      `<button class="icon-btn" type="button" data-action="delete" title="${escapeHtml(t('delete'))}" aria-label="${escapeHtml(t('delete'))}">${icon('trash')}</button>` +
      `</div>`;
    ul.appendChild(li);
  }
  const empty = $('convEmpty');
  const total = state.convs.filter((c) => c.messages.length).length;
  empty.hidden = list.length > 0;
  empty.textContent = total === 0 ? t('noChats') : t('noResults');
}

function modelGroups() {
  const auto = [{ id: 'auto', label: t('modelAuto') }];
  const claude = [];
  const others = new Map();
  for (const id of state.models) {
    if (id === 'auto') continue;
    if (id.startsWith('auto/')) auto.push({ id, label: id });
    else if (/claude/i.test(id)) claude.push({ id, label: id });
    else {
      const key = id.includes('/') ? id.split('/')[0] : t('groupOther');
      if (!others.has(key)) others.set(key, []);
      others.get(key).push({ id, label: id });
    }
  }
  const groups = [{ label: t('groupAuto'), items: auto }];
  if (claude.length) groups.push({ label: t('groupClaude'), items: claude.sort((a, b) => a.id.localeCompare(b.id)) });
  for (const [k, items] of [...others.entries()].sort((a, b) => a[0].localeCompare(b[0]))) groups.push({ label: k, items: items.sort((a, b) => a.id.localeCompare(b.id)) });
  return groups;
}

function chooseModel() {
  const valid = new Set(['auto', ...state.models]);
  if (state.model && (state.modelsState !== 'ok' || valid.has(state.model))) return;
  // Ưu tiên Claude nếu có; nếu không thì dùng chế độ tự động.
  state.model = state.models.find((id) => /claude/i.test(id)) || 'auto';
  saveSettings({ model: state.model });
}

function renderModelSelect() {
  const sel = $('modelSelect');
  if (state.modelsState === 'loading' && !state.models.length) {
    sel.innerHTML = `<option>${escapeHtml(t('modelsLoading'))}</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const current = currentModel();
  sel.innerHTML = '';
  for (const g of modelGroups()) {
    const og = document.createElement('optgroup');
    og.label = g.label;
    for (const it of g.items) og.appendChild(new Option(it.label, it.id));
    sel.appendChild(og);
  }
  if (![...sel.options].some((o) => o.value === current)) sel.insertBefore(new Option(current, current), sel.firstChild);
  sel.value = current;
  sel.title = state.modelsState === 'error' ? t('modelsUnavailable') : '';
}

function badgeText(msg) {
  const m = msg.meta || {};
  let s;
  if (m.reported && m.provider) s = t('modelActualVia', { model: m.reported, provider: m.provider });
  else if (m.reported) s = t('modelActual', { model: m.reported });
  else if (m.provider) s = t('modelProviderOnly', { provider: m.provider });
  else s = t('modelUnknown');
  const same = m.requested && m.reported && (m.requested === m.reported || m.requested.endsWith('/' + m.reported));
  if (m.reported && m.requested && !same) s += ` (${t('requested')}: ${m.requested})`;
  return s;
}

function messageHtml(m, live) {
  if (m.role === 'user') {
    const files = (m.attachments || []).map((a) => `<span class="file-tag">${icon('clip')}${escapeHtml(a.name)}</span>`).join('');
    return `<article class="msg user" data-id="${m.id}"><div class="bubble">${escapeHtml(m.content)}</div>${files ? `<div class="file-tags">${files}</div>` : ''}</article>`;
  }
  const body = m.content ? renderMarkdown(m.content) : live ? '<span class="typing"><i></i><i></i><i></i></span>' : '';
  const showBadge = !live || m.meta?.reported || m.meta?.provider;
  const notices = [];
  if (m.incomplete) notices.push(`<div class="notice warn">${escapeHtml(t('interrupted'))}</div>`);
  if (m.stopped) notices.push(`<div class="notice">${escapeHtml(t('stopped'))}</div>`);
  const copyBtn = m.content && !live ? `<button class="icon-btn" type="button" data-action="copy" title="${escapeHtml(t('copy'))}" aria-label="${escapeHtml(t('copy'))}">${icon('copy')}</button>` : '';
  return (
    `<article class="msg assistant${live ? ' live' : ''}" data-id="${m.id}"><div class="avatar"><svg class="orbit-mark" aria-hidden="true"><use href="#i-orbit"/></svg></div>` +
    `<div class="body"><div class="content">${body}</div><div class="notices">${notices.join('')}</div>` +
    `<div class="meta"><span class="model-badge">${showBadge ? escapeHtml(badgeText(m)) : ''}</span>${copyBtn}</div></div></article>`
  );
}

function renderThread() {
  const c = activeConv();
  const th = $('thread');
  if (!c || c.messages.length === 0) {
    const model = currentModel() === 'auto' ? t('modelAuto') : currentModel();
    th.innerHTML = `<div class="welcome"><svg class="orbit-mark orbit-intro" aria-hidden="true"><use href="#i-orbit"/></svg><h2>${escapeHtml(t('welcomeTitle'))}</h2><p>${escapeHtml(t('welcomeSub', { model }))}</p></div>`;
    return;
  }
  const liveId = state.busy && state.busy.convId === c.id ? c.messages[c.messages.length - 1]?.id : null;
  th.innerHTML = c.messages.map((m) => messageHtml(m, m.id === liveId)).join('');
  scrollToBottom(true);
}

let streamFrame = 0;
function scheduleStreamRender() {
  if (streamFrame) return;
  streamFrame = requestAnimationFrame(() => {
    streamFrame = 0;
    const c = activeConv();
    if (!c || !state.busy || state.busy.convId !== c.id) return;
    const m = c.messages[c.messages.length - 1];
    const node = $('thread').querySelector(`[data-id="${m.id}"]`);
    if (!node) return;
    node.querySelector('.content').innerHTML = m.content ? renderMarkdown(m.content) : '<span class="typing"><i></i><i></i><i></i></span>';
    if (m.meta?.reported || m.meta?.provider) node.querySelector('.model-badge').textContent = badgeText(m);
    scrollToBottom(false);
  });
}

function scrollToBottom(force) {
  const w = $('threadWrap');
  if (force || state.stick) w.scrollTop = w.scrollHeight;
}

function renderComposer() {
  const busy = !!state.busy;
  const send = $('sendBtn');
  send.innerHTML = icon(busy ? 'stop' : 'send');
  send.title = t(busy ? 'stop' : 'send');
  send.setAttribute('aria-label', send.title);
  $('attachBtn').disabled = busy;
  const chips = $('chips');
  chips.hidden = state.attachments.length === 0;
  $('attachNote').hidden = state.attachments.length === 0;
  chips.innerHTML = state.attachments
    .map((a, i) => `<li class="chip">${icon('clip')}<span>${escapeHtml(a.name)}</span><small>${Math.max(1, Math.round(a.size / 1024))} KB</small><button type="button" data-remove="${i}" aria-label="${escapeHtml(t('removeFile', { name: a.name }))}">${icon('x')}</button></li>`)
    .join('');
}

const PILL = { ok: 'pillOk', router_down: 'pillRouterDown', offline: 'pillOffline', unknown: 'pillUnknown', checking: 'pillChecking' };
function renderStatus() {
  const lvl = state.status.level;
  $('statusPill').dataset.state = lvl;
  $('statusPill').querySelector('.dot').dataset.state = lvl;
  $('statusPillText').textContent = t(PILL[lvl]);
  $('statusDot').dataset.state = lvl;
  if ($('dlgStatus').open) renderStatusDialog();
}

// ---------- Trạng thái kết nối ----------
async function refreshStatus({ probe = false } = {}) {
  state.status = { ...state.status, level: 'checking', probing: probe };
  renderStatus();
  const next = { level: 'offline', backend: { ok: false }, router: null, probe: state.status.probe && !probe ? state.status.probe : null };
  try {
    next.backend = { ok: true, ...(await api.health()) };
  } catch {
    state.status = next;
    return renderStatus();
  }
  try {
    const res = await api.status(probe ? currentModel() : undefined);
    next.router = res.router;
    if (res.probe) next.probe = res.probe;
    next.level = res.router.reachable ? 'ok' : 'router_down';
    if (res.router.reachable && state.modelsState !== 'ok') loadModels();
  } catch (e) {
    if (e.code === 'unauthorized') return sessionExpired();
    next.level = e.code === 'network' ? 'offline' : 'router_down';
    next.backend = e.code === 'network' ? { ok: false } : next.backend;
  }
  state.status = next;
  renderStatus();
}

function renderStatusDialog() {
  const s = state.status;
  const checking = s.level === 'checking';
  const rows = [];
  rows.push({ s: 'ok', title: t('stFrontend'), text: t('stFrontendOk') });
  if (checking) rows.push({ s: 'checking', title: t('stBackend'), text: t('stChecking') });
  else rows.push(s.backend?.ok ? { s: 'ok', title: t('stBackend'), text: t('stBackendOk', { ms: s.backend.ms ?? '?' }) } : { s: 'offline', title: t('stBackend'), text: t('stBackendFail') });
  if (checking) rows.push({ s: 'checking', title: t('stRouter'), text: t('stChecking') });
  else if (!s.backend?.ok || !s.router) rows.push({ s: 'unknown', title: t('stRouter'), text: t('stRouterSkipped') });
  else if (s.router.reachable) rows.push({ s: 'ok', title: t('stRouter'), text: t('stRouterOk', { n: s.router.modelCount ?? '?' }) });
  else rows.push({ s: 'router_down', title: t('stRouter'), text: t('stRouterFail') });
  const p = s.probe;
  const label = `${t('stModel')}: ${currentModel() === 'auto' ? t('modelAuto') : currentModel()}`;
  if (s.probing && checking) rows.push({ s: 'checking', title: label, text: t('stChecking') });
  else if (p && p.model === currentModel()) {
    if (p.ok) {
      const reported = p.reportedModel || p.headers?.['X-OmniRoute-Model'];
      rows.push({ s: 'ok', title: label, text: reported ? t('stModelOk', { ms: p.latencyMs, model: reported }) : t('stModelOkNoName', { ms: p.latencyMs }) });
    } else rows.push({ s: 'offline', title: label, text: errorText({ code: p.error?.code, detail: p.error?.detail }) });
  } else rows.push({ s: 'unknown', title: label, text: t('stUnchecked') });
  $('checks').innerHTML = rows.map((r) => `<li><span class="dot" data-state="${r.s}"></span><div><strong>${escapeHtml(r.title)}</strong><span>${escapeHtml(r.text)}</span></div></li>`).join('');
  $('statusProbe').disabled = checking || !s.router?.reachable;
  $('statusRecheck').disabled = checking;
}

async function loadModels() {
  state.modelsState = 'loading';
  renderModelSelect();
  try {
    const j = await api.models();
    state.models = j.models.map((m) => m.id);
    state.modelsState = 'ok';
  } catch (e) {
    state.modelsState = 'error';
    if (e.code === 'unauthorized') return sessionExpired();
  }
  chooseModel();
  renderModelSelect();
  if (!activeConv()?.messages.length) renderThread();
}

// ---------- Gửi tin nhắn ----------
function apiContent(m) {
  if (m.role !== 'user' || !m.attachments?.length) return m.content;
  return m.content + '\n\n' + m.attachments.map((a) => `--- ${a.name} ---\n${a.text}\n--- end of ${a.name} ---`).join('\n\n');
}
function buildContext(msgs) {
  const items = msgs.filter((m) => m.content || m.attachments?.length).map((m) => ({ role: m.role, content: apiContent(m) }));
  const size = (arr) => arr.reduce((s, m) => s + m.content.length, 0);
  const last = items[items.length - 1];
  if (!last || last.content.length > MAX_CONTEXT_CHARS) return null;
  while (items.length > 1 && (size(items) > MAX_CONTEXT_CHARS || items[0].role !== 'user')) items.shift();
  return items;
}

function setBusy(v) {
  state.busy = v;
  renderComposer();
}

async function sendMessage() {
  if (state.busy) return;
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  const conv = activeConv() || startNewConversation();
  const userMsg = { id: newId(), role: 'user', content: text, ts: Date.now() };
  if (state.attachments.length) userMsg.attachments = state.attachments.map((a) => ({ ...a }));
  const context = buildContext([...conv.messages, userMsg]);
  if (!context) return toast(t('contextTooLarge'), 'error');

  const savedAttachments = state.attachments;
  const asst = { id: newId(), role: 'assistant', content: '', ts: Date.now(), meta: { requested: currentModel(), reported: null, provider: null, decision: null } };
  const hadTitle = !!conv.title;
  conv.messages.push(userMsg, asst);
  if (!hadTitle) conv.title = makeTitle(text);
  conv.model = currentModel();
  conv.updatedAt = Date.now();
  input.value = '';
  autosize();
  state.attachments = [];
  state.stick = true;
  const controller = new AbortController();
  setBusy({ convId: conv.id, controller });
  renderAll();
  persist();

  let received = false;
  let failure = null;
  try {
    const info = await api.chatStream({
      model: currentModel(),
      messages: context,
      signal: controller.signal,
      onDelta: (d) => {
        asst.content += d;
        received = true;
        scheduleStreamRender();
      },
      onInfo: (i) => {
        asst.meta = { ...asst.meta, ...i };
        scheduleStreamRender();
      },
    });
    asst.meta = { ...asst.meta, ...info };
  } catch (e) {
    failure = e instanceof api.ApiError ? e : new api.ApiError('unknown');
  }

  if (failure) {
    if (failure.code === 'aborted') {
      if (received) asst.stopped = true;
      else failure = { code: 'aborted-empty' };
    } else if (received) {
      asst.incomplete = true;
    }
    if (!received) {
      // Không nhận được nội dung nào: hoàn tác tin nhắn và trả lại câu hỏi vào ô nhập.
      conv.messages = conv.messages.filter((m) => m.id !== userMsg.id && m.id !== asst.id);
      if (!hadTitle) conv.title = '';
      input.value = text;
      state.attachments = savedAttachments;
      autosize();
      if (failure.code !== 'aborted-empty') {
        toast(errorText(failure), 'error');
        if (failure.code === 'network') state.status = { level: 'offline' };
        if (failure.code === 'router_unreachable') state.status = { level: 'router_down' };
      }
    } else if (failure.code !== 'aborted') {
      toast(errorText(failure), 'error');
    }
  }
  asst.meta = { ...asst.meta };
  conv.updatedAt = Date.now();
  setBusy(null);
  persist();
  renderAll();
  if (failure?.code === 'unauthorized') sessionExpired();
}

function stopGenerating() {
  state.busy?.controller.abort();
}

// ---------- Đính kèm tệp ----------
async function handleFiles(fileList) {
  for (const file of fileList) {
    try {
      state.attachments.push(await readAttachment(file, state.attachments));
    } catch (e) {
      if (e instanceof FileError) toast(t(e.code, e.params), 'error');
      else toast(t('fileReadFail', { name: file.name }), 'error');
    }
  }
  renderComposer();
}

// ---------- Hộp thoại đổi tên / xóa / tải ----------
let dialogTarget = null;
function openRename(id) {
  const c = state.convs.find((x) => x.id === id);
  if (!c) return;
  dialogTarget = id;
  $('renameInput').value = displayTitle(c);
  $('dlgRename').showModal();
  $('renameInput').select();
}
function openDelete(id) {
  const c = state.convs.find((x) => x.id === id);
  if (!c) return;
  dialogTarget = id;
  $('deleteBody').textContent = t('deleteBody', { title: displayTitle(c) });
  $('dlgDelete').showModal();
}
function doDelete(id) {
  if (state.busy?.convId === id) stopGenerating();
  state.convs = state.convs.filter((c) => c.id !== id);
  if (state.activeId === id) {
    const next = [...state.convs].filter((c) => c.messages.length).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    state.activeId = next ? next.id : null;
    if (!state.activeId) startNewConversation();
  }
  persist();
  renderAll();
}
function downloadConversation(id) {
  const c = state.convs.find((x) => x.id === id);
  if (!c || c.messages.length === 0) return toast(t('exportEmpty'));
  const md = conversationToMarkdown(c, {
    untitled: t('untitled'),
    you: t('exportYou'),
    assistant: t('exportAssistant'),
    files: t('exportFiles'),
    exportedOn: t('exportedOn', { date: new Date().toLocaleString(getLang() === 'vi' ? 'vi-VN' : 'en-US') }),
  });
  downloadText(safeFilename(c.title), md);
  toast(t('exportDone'));
}

// ---------- Thanh bên (điện thoại) ----------
const openSidebar = () => $('app').classList.add('nav-open');
const closeSidebar = () => $('app').classList.remove('nav-open');

// ---------- Ô nhập ----------
function autosize() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
}

// ---------- Gắn sự kiện ----------
function bind() {
  $('fileInput').accept = TEXT_EXTENSIONS.map((e) => '.' + e).join(',');

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('pw').value;
    if (!pw) return;
    $('loginBtn').disabled = true;
    $('loginBtn').textContent = t('logging');
    $('gateErr').hidden = true;
    try {
      await api.login(pw);
      $('pw').value = '';
      enterApp();
    } catch (err) {
      gateError(errorText(err));
      if (err.code === 'network') {
        // không kết nối được backend ngay lúc đăng nhập
        gateMode = 'login';
      }
    } finally {
      $('loginBtn').disabled = false;
      $('loginBtn').textContent = t('loginBtn');
    }
  });
  $('gateRetry').addEventListener('click', boot);
  $('gateLang').addEventListener('click', toggleLang);
  $('gateTheme').addEventListener('click', toggleTheme);
  $('langBtn').addEventListener('click', toggleLang);
  $('themeBtn').addEventListener('click', toggleTheme);
  $('logoutBtn').addEventListener('click', () => {
    stopGenerating();
    clearAuth();
    showGate('login');
  });

  $('newChat').addEventListener('click', () => {
    startNewConversation();
    closeSidebar();
    renderAll();
    $('input').focus();
  });
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderSidebar();
  });
  $('convList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    const li = e.target.closest('.conv');
    if (!btn || !li) return;
    const id = li.dataset.id;
    ({ open: selectConversation, rename: openRename, delete: openDelete, download: downloadConversation })[btn.dataset.action]?.(id);
  });
  $('openSidebar').addEventListener('click', openSidebar);
  $('closeSidebar').addEventListener('click', closeSidebar);
  $('scrim').addEventListener('click', closeSidebar);

  $('modelSelect').addEventListener('change', (e) => {
    state.model = e.target.value;
    saveSettings({ model: state.model });
    if (state.status.probe && state.status.probe.model !== currentModel()) state.status = { ...state.status, probe: null };
    if (!activeConv()?.messages.length) renderThread();
  });
  $('downloadBtn').addEventListener('click', () => downloadConversation(state.activeId));

  $('sendBtn').addEventListener('click', () => (state.busy ? stopGenerating() : sendMessage()));
  $('input').addEventListener('input', autosize);
  $('input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    if (matchMedia('(pointer: coarse)').matches) return; // trên điện thoại Enter xuống dòng, dùng nút Gửi
    e.preventDefault();
    if (!state.busy) sendMessage();
  });
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await handleFiles(files);
  });
  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    state.attachments.splice(Number(b.dataset.remove), 1);
    renderComposer();
  });

  $('thread').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="copy"]');
    if (!btn) return;
    const id = btn.closest('.msg').dataset.id;
    const msg = activeConv()?.messages.find((m) => m.id === id);
    if (!msg) return;
    if (await copyText(msg.content)) {
      btn.innerHTML = icon('check');
      toast(t('copied'));
      setTimeout(() => (btn.innerHTML = icon('copy')), 1500);
    } else toast(t('copyFailed'), 'error');
  });
  $('threadWrap').addEventListener('scroll', () => {
    const w = $('threadWrap');
    state.stick = w.scrollHeight - w.scrollTop - w.clientHeight < 80;
  });

  $('renameForm').addEventListener('submit', () => {
    const c = state.convs.find((x) => x.id === dialogTarget);
    const v = $('renameInput').value.trim().slice(0, 120);
    if (c && v) {
      c.title = v;
      persist();
      renderSidebar();
    }
  });
  $('renameCancel').addEventListener('click', () => $('dlgRename').close());
  $('deleteForm').addEventListener('submit', () => doDelete(dialogTarget));
  $('deleteCancel').addEventListener('click', () => $('dlgDelete').close());

  const openStatus = () => {
    $('dlgStatus').showModal();
    renderStatusDialog();
    refreshStatus();
  };
  $('statusBtn').addEventListener('click', openStatus);
  $('statusPill').addEventListener('click', openStatus);
  $('statusRecheck').addEventListener('click', () => refreshStatus());
  $('statusProbe').addEventListener('click', () => refreshStatus({ probe: true }));
  $('statusClose').addEventListener('click', () => $('dlgStatus').close());

  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && persist());
  addEventListener('pagehide', persist);
}

bind();
boot();

// TP OmniAI — điều phối giao diện, hội thoại, lịch sử, mô hình, đính kèm, trạng thái kết nối.
import { t, setLang, getLang, detectLang, applyI18n, errorText, fileErrorText } from './i18n.js';
import { loadConversations, saveConversations, sanitizeConversations, loadSettings, saveSettings, getAuth, clearAuth, newId } from './storage.js';
import * as api from './api.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { readAttachment, ACCEPT } from './files.js';
import { conversationToMarkdown, safeFilename, downloadText } from './export.js';

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const MAX_CONTEXT_CHARS = 120000;
const MAX_CONTEXT_IMAGES = 3;
const MAX_CONTEXT_IMAGE_CHARS = 3_500_000;
const MAX_RENDER_MODELS = 300;

const settings = loadSettings();
setLang(settings.lang || detectLang());

const state = {
  convs: [],
  activeId: null,
  models: [],
  modelsState: 'idle', // idle | loading | ok | error
  model: settings.model || '',
  favorites: new Set(Array.isArray(settings.favorites) ? settings.favorites.filter((x) => typeof x === 'string') : []),
  okModels: new Set(Array.isArray(settings.okModels) ? settings.okModels.filter((x) => typeof x === 'string') : []),
  systemPrompt: typeof settings.systemPrompt === 'string' ? settings.systemPrompt : '',
  busy: null, // { convId, controller }
  attachments: [],
  pending: 0, // số tệp đang được đọc
  images: new Map(), // id tin nhắn -> [{ name, dataUrl }] (ảnh gốc chỉ giữ trong bộ nhớ của phiên)
  search: '',
  stick: true,
  status: { level: 'unknown' },
  filter: 'all',
  query: '',
};

// ---------- Tiện ích ----------
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const activeConv = () => state.convs.find((c) => c.id === state.activeId) || null;
const displayTitle = (c) => c.title || t('untitled');
const currentModel = () => state.model || 'auto';
const modelLabel = (id) => (id === 'auto' ? t('modelAuto') : id);

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 2600);
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

const mdOpts = () => ({ copyLabel: t('copyCode') });

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
  if ($('dlgModels').open) renderPicker();
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
  renderModelBtn();
  renderThread();
  renderComposer();
  renderStatus();
}

function renderSidebar() {
  const q = norm(state.search.trim());
  const list = state.convs
    .filter((c) => c.messages.length)
    .filter((c) => !q || norm(c.title).includes(q) || c.messages.some((m) => norm(m.content).includes(q) || (m.attachments || []).some((a) => norm(a.name).includes(q)) || (m.images || []).some((a) => norm(a.name).includes(q))))
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

// ---------- Chọn model ----------
const PROVIDER_NAMES = {
  kr: 'Kiro AI', cc: 'Claude Code', cx: 'OpenAI Codex', ag: 'Antigravity', gc: 'Gemini CLI', gh: 'GitHub Copilot', cl: 'Cline',
  openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini (AI Studio)', ds: 'DeepSeek', deepseek: 'DeepSeek',
  groq: 'Groq', glm: 'GLM', kimi: 'Kimi', minimax: 'MiniMax', if: 'Qoder', oc: 'OpenCode', bb: 'Blackbox AI',
};
const FAMILY = {
  claude: /claude/i,
  gpt: /(^|[/\-_.])(gpt|chatgpt|codex|o[134](-|$))|openai/i,
  gemini: /gemini/i,
  deepseek: /deepseek|(^|\/)ds\//i,
};
const isAuto = (id) => id === 'auto' || id.startsWith('auto/') || !id.includes('/');
const providerOf = (id) => (id.includes('/') ? id.split('/')[0] : '');
const providerLabel = (id) => (isAuto(id) ? t('groupAuto') : PROVIDER_NAMES[providerOf(id)] || providerOf(id).toUpperCase());
const FILTERS = [
  ['all', 'filterAll'], ['fav', 'filterFav'], ['ok', 'filterOk'], ['auto', 'filterAuto'], ['claude', 'filterClaude'],
  ['gpt', 'filterGpt'], ['gemini', 'filterGemini'], ['deepseek', 'filterDeepseek'], ['other', 'filterOther'],
];

function allModelIds() {
  return ['auto', ...state.models.filter((id) => id !== 'auto')];
}
function matchesFilter(id, f) {
  if (f === 'all') return true;
  if (f === 'fav') return state.favorites.has(id);
  if (f === 'ok') return state.okModels.has(id);
  if (f === 'auto') return isAuto(id);
  if (f === 'other') return !isAuto(id) && !Object.values(FAMILY).some((re) => re.test(id));
  return !isAuto(id) && FAMILY[f].test(id);
}

function chooseModel() {
  // Giữ lựa chọn của người dùng nếu còn hợp lệ; chưa chọn thì dùng chế độ Tự động (OmniRoute tự chọn và dự phòng).
  const valid = new Set(allModelIds());
  if (state.model && (state.modelsState !== 'ok' || valid.has(state.model))) return;
  state.model = 'auto';
  saveSettings({ model: state.model });
}

function renderModelBtn() {
  $('modelBtnLabel').textContent = modelLabel(currentModel());
}

function selectModel(id) {
  state.model = id;
  saveSettings({ model: id });
  if (state.status.probe && state.status.probe.model !== id) state.status = { ...state.status, probe: null };
  $('dlgModels').close();
  renderModelBtn();
  if (!activeConv()?.messages.length) renderThread();
}

// Ghi nhớ model đã trả lời thành công để đánh dấu ✓ trong bộ chọn (danh mục có hàng trăm model nhưng chỉ một phần dùng được).
function markOk(id) {
  if (!id || state.okModels.has(id)) return;
  state.okModels.add(id);
  saveSettings({ okModels: [...state.okModels].slice(-80) });
  if ($('dlgModels').open) renderPicker();
}

function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  saveSettings({ favorites: [...state.favorites] });
  renderPicker();
}

function renderPicker() {
  const q = norm(state.query.trim());
  $('modelFilters').innerHTML = FILTERS.map(([key, label]) => `<button type="button" class="filter${state.filter === key ? ' active' : ''}" data-filter="${key}" role="tab" aria-selected="${state.filter === key}">${escapeHtml(t(label))}</button>`).join('');
  const ids = allModelIds().filter((id) => matchesFilter(id, state.filter) && (!q || norm(id).includes(q) || norm(modelLabel(id)).includes(q)));
  const groups = new Map();
  const add = (label, id) => {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(id);
  };
  if (state.filter === 'all' && !q) {
    for (const id of ids.filter((x) => state.favorites.has(x))) add(t('filterFav'), id);
    for (const id of ids.filter((x) => state.okModels.has(x) && !state.favorites.has(x))) add(t('filterOk'), id);
  }
  for (const id of ids) add(providerLabel(id), id);
  const order = [...groups.keys()].sort((a, b) => {
    const rank = (k) => (k === t('filterFav') ? 0 : k === t('filterOk') ? 1 : k === t('groupAuto') ? 2 : 3);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  let shown = 0;
  let html = '';
  for (const key of order) {
    if (shown >= MAX_RENDER_MODELS) break;
    html += `<div class="model-group">${escapeHtml(key)}</div>`;
    for (const id of groups.get(key)) {
      if (shown >= MAX_RENDER_MODELS) break;
      shown++;
      const fav = state.favorites.has(id);
      html +=
        `<div class="model-item${id === currentModel() ? ' selected' : ''}" role="option" aria-selected="${id === currentModel()}">` +
        `<button type="button" class="model-pick-btn" data-model="${escapeHtml(id)}" title="${escapeHtml(id)}">${escapeHtml(modelLabel(id))}</button>` +
        (state.okModels.has(id) ? `<span class="ok-mark" title="${escapeHtml(t('okMarkTitle'))}" aria-label="${escapeHtml(t('okMarkTitle'))}">✓</span>` : '') +
        `<button type="button" class="star${fav ? ' on' : ''}" data-fav="${escapeHtml(id)}" title="${escapeHtml(t(fav ? 'favRemove' : 'favAdd'))}" aria-label="${escapeHtml(t(fav ? 'favRemove' : 'favAdd'))}" aria-pressed="${fav}">${icon('star')}</button></div>`;
    }
  }
  $('modelList').innerHTML = html || `<p class="conv-empty">${escapeHtml(t('noModels'))}</p>`;
  const rest = ids.length - shown;
  $('modelCount').textContent = state.modelsState === 'loading' ? t('modelsLoading') : state.modelsState === 'error' ? t('modelsUnavailable') : rest > 0 ? t('moreModels', { n: rest }) : t('modelsCount', { n: ids.length });
}

function openPicker() {
  state.query = '';
  $('modelSearch').value = '';
  $('dlgModels').showModal();
  renderPicker();
  if (state.modelsState === 'idle' || state.modelsState === 'error') loadModels();
}

// ---------- Tin nhắn ----------
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

const typingHtml = '<span class="typing"><i></i><i></i><i></i></span>';
function thinkHtml(m, live) {
  if (!m.reasoning) return '';
  return `<details class="think"${live && !m.content ? ' open' : ''}><summary>${escapeHtml(t('thinking'))}</summary><div class="think-body">${escapeHtml(m.reasoning)}</div></details>`;
}

function messageHtml(m, live, isLast) {
  if (m.role === 'user') {
    const files = (m.attachments || []).map((a) => `<span class="file-tag">${icon('file')}${escapeHtml(a.name)}</span>`).join('');
    const imgs = (m.images || []).map((im, i) => `<img src="${im.thumb}" alt="${escapeHtml(im.name)}" title="${escapeHtml(im.name)}" data-msg="${m.id}" data-idx="${i}">`).join('');
    return `<article class="msg user" data-id="${m.id}"><div class="bubble">${escapeHtml(m.content)}</div>${imgs ? `<div class="img-tags">${imgs}</div>` : ''}${files ? `<div class="file-tags">${files}</div>` : ''}</article>`;
  }
  const body = m.content ? renderMarkdown(m.content, mdOpts()) : live && !m.reasoning ? typingHtml : '';
  const showBadge = !live || m.meta?.reported || m.meta?.provider;
  const notices = [];
  if (m.incomplete) notices.push(`<div class="notice warn">${escapeHtml(t('interrupted'))}</div>`);
  if (m.stopped) notices.push(`<div class="notice">${escapeHtml(t('stopped'))}</div>`);
  const btn = (action, ic, label) => `<button class="icon-btn" type="button" data-action="${action}" title="${escapeHtml(t(label))}" aria-label="${escapeHtml(t(label))}">${icon(ic)}</button>`;
  const actions = !live && m.content ? (isLast ? btn('regen', 'refresh', 'regenerate') : '') + btn('copy', 'copy', 'copy') : '';
  return (
    `<article class="msg assistant${live ? ' live' : ''}" data-id="${m.id}"><div class="avatar"><svg class="orbit-mark" aria-hidden="true"><use href="#i-orbit"/></svg></div>` +
    `<div class="body"><div class="think-wrap">${thinkHtml(m, live)}</div><div class="content">${body}</div><div class="notices">${notices.join('')}</div>` +
    `<div class="meta"><span class="model-badge">${showBadge ? escapeHtml(badgeText(m)) : ''}</span>${actions}</div></div></article>`
  );
}

function renderThread() {
  const c = activeConv();
  const th = $('thread');
  if (!c || c.messages.length === 0) {
    th.innerHTML = `<div class="welcome"><svg class="orbit-mark orbit-intro" aria-hidden="true"><use href="#i-orbit"/></svg><h2>${escapeHtml(t('welcomeTitle'))}</h2><p>${escapeHtml(t('welcomeSub', { model: modelLabel(currentModel()) }))}</p><p class="drop-hint">${escapeHtml(t('welcomeDrop'))}</p></div>`;
    return;
  }
  const liveId = state.busy && state.busy.convId === c.id ? c.messages[c.messages.length - 1]?.id : null;
  const lastId = c.messages[c.messages.length - 1]?.id;
  th.innerHTML = c.messages.map((m) => messageHtml(m, m.id === liveId, m.id === lastId)).join('');
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
    node.querySelector('.think-wrap').innerHTML = thinkHtml(m, true);
    node.querySelector('.content').innerHTML = m.content ? renderMarkdown(m.content, mdOpts()) : m.reasoning ? '' : typingHtml;
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
  send.disabled = !busy && state.pending > 0;
  $('attachBtn').disabled = busy;
  const chips = $('chips');
  const has = state.attachments.length > 0 || state.pending > 0;
  chips.hidden = !has;
  $('attachNote').hidden = !has;
  const items = state.attachments.map((a, i) => {
    const lead = a.kind === 'image' ? `<img src="${a.thumb}" alt="">` : icon('file');
    return `<li class="chip${a.kind === 'image' ? ' has-thumb' : ''}">${lead}<span>${escapeHtml(a.name)}</span><small>${Math.max(1, Math.round(a.size / 1024))} KB</small><button type="button" data-remove="${i}" aria-label="${escapeHtml(t('removeFile', { name: a.name }))}">${icon('x')}</button></li>`;
  });
  for (let i = 0; i < state.pending; i++) items.push(`<li class="chip warn"><span>${escapeHtml(t('reading'))}</span></li>`);
  chips.innerHTML = items.join('');
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
    if (res.probe) {
      next.probe = res.probe;
      if (res.probe.ok) markOk(res.probe.model);
    }
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
  else rows.push({ s: 'router_down', title: t('stRouter'), text: t('stRouterFail') + ` [HTTP ${s.router.httpStatus ?? '–'}${s.router.error?.code ? ', ' + s.router.error.code : ''}]${s.router.error?.detail ? ' ' + s.router.error.detail : ''}` });
  const p = s.probe;
  const label = `${t('stModel')}: ${modelLabel(currentModel())}`;
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
  if ($('dlgModels').open) renderPicker();
  try {
    const j = await api.models();
    state.models = j.models.map((m) => m.id);
    state.modelsState = 'ok';
  } catch (e) {
    state.modelsState = 'error';
    if (e.code === 'unauthorized') return sessionExpired();
  }
  chooseModel();
  renderModelBtn();
  if ($('dlgModels').open) renderPicker();
  if (!activeConv()?.messages.length) renderThread();
}

// ---------- Gửi tin nhắn ----------
function userText(m) {
  let s = m.content;
  for (const a of m.attachments || []) s += `\n\n--- ${a.name} ---\n${a.text}\n--- end of ${a.name} ---`;
  return s;
}

// Dựng nội dung gửi đi: hướng dẫn hệ thống + hội thoại. Ảnh gốc chỉ có trong bộ nhớ phiên; ưu tiên ảnh mới nhất, giới hạn số lượng và dung lượng.
function buildContext(msgs) {
  const items = [];
  for (const m of msgs) {
    if (m.role === 'assistant') {
      if (m.content) items.push({ role: 'assistant', text: m.content });
    } else items.push({ role: 'user', text: userText(m), msg: m, picks: [] });
  }
  if (!items.length || items[items.length - 1].role !== 'user') return null;
  let imgLeft = MAX_CONTEXT_IMAGES;
  let charLeft = MAX_CONTEXT_IMAGE_CHARS;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role !== 'user') continue;
    const data = state.images.get(it.msg.id) || [];
    for (const [idx, meta] of (it.msg.images || []).entries()) {
      const full = data[idx];
      if (full && imgLeft > 0 && full.dataUrl.length <= charLeft) {
        it.picks.push(full);
        imgLeft--;
        charLeft -= full.dataUrl.length;
      } else it.text += `\n[Earlier attached image: ${meta.name}]`;
    }
  }
  const sys = state.systemPrompt.trim();
  let total = (sys ? sys.length : 0) + items.reduce((s, it) => s + it.text.length, 0);
  if (items[items.length - 1].text.length > MAX_CONTEXT_CHARS) return null;
  while (items.length > 1 && (total > MAX_CONTEXT_CHARS || items[0].role !== 'user')) total -= items.shift().text.length;
  const messages = [];
  if (sys) messages.push({ role: 'system', content: sys });
  let imageCount = 0;
  for (const it of items) {
    if (it.role === 'user' && it.picks.length) {
      imageCount += it.picks.length;
      messages.push({ role: 'user', content: [{ type: 'text', text: it.text }, ...it.picks.map((p) => ({ type: 'image_url', image_url: { url: p.dataUrl } }))] });
    } else messages.push({ role: it.role, content: it.text });
  }
  return { messages, imageCount };
}

function setBusy(v) {
  state.busy = v;
  renderComposer();
}

const VISION_HINT_CODES = ['bad_request', 'provider_error', 'model_not_found', 'model_unavailable'];

async function runCompletion({ conv, asst, context, restore }) {
  const controller = new AbortController();
  state.stick = true;
  setBusy({ convId: conv.id, controller });
  renderAll();
  persist();

  let received = false;
  let failure = null;
  try {
    const info = await api.chatStream({
      model: asst.meta.requested,
      messages: context.messages,
      signal: controller.signal,
      onDelta: (d) => {
        asst.content += d;
        received = true;
        scheduleStreamRender();
      },
      onReasoning: (d) => {
        asst.reasoning = ((asst.reasoning || '') + d).slice(0, 30000);
        scheduleStreamRender();
      },
      onInfo: (i) => {
        asst.meta = { ...asst.meta, ...i };
        scheduleStreamRender();
      },
    });
    asst.meta = { ...asst.meta, ...info };
    markOk(asst.meta.requested);
  } catch (e) {
    failure = e instanceof api.ApiError ? e : new api.ApiError('unknown');
  }

  if (failure) {
    if (failure.code === 'aborted') {
      if (received) asst.stopped = true;
      else failure = { code: 'aborted-empty' };
    } else if (received) asst.incomplete = true;

    if (!received) {
      restore(); // không nhận được nội dung nào: hoàn tác để người dùng không mất câu hỏi/câu trả lời cũ
      if (failure.code !== 'aborted-empty') {
        let msg = errorText(failure);
        if (context.imageCount > 0 && VISION_HINT_CODES.includes(failure.code)) msg += ' ' + t('hintVision');
        toast(msg, 'error');
        if (failure.code === 'network') state.status = { level: 'offline' };
        if (failure.code === 'router_unreachable') state.status = { level: 'router_down' };
      }
    } else if (failure.code !== 'aborted') {
      toast(errorText(failure), 'error');
    }
  }
  conv.updatedAt = Date.now();
  setBusy(null);
  persist();
  renderAll();
  if (failure?.code === 'unauthorized') sessionExpired();
}

const newAssistant = () => ({ id: newId(), role: 'assistant', content: '', ts: Date.now(), meta: { requested: currentModel(), reported: null, provider: null, decision: null } });

async function sendMessage() {
  if (state.busy || state.pending > 0) return;
  const input = $('input');
  let text = input.value.trim();
  if (!text && state.attachments.length) text = t('defaultPrompt');
  if (!text) return;
  const conv = activeConv() || startNewConversation();
  const userMsg = { id: newId(), role: 'user', content: text, ts: Date.now() };
  const files = state.attachments.filter((a) => a.kind !== 'image');
  const images = state.attachments.filter((a) => a.kind === 'image');
  if (files.length) userMsg.attachments = files.map((a) => ({ name: a.name, size: a.size, text: a.text, kind: a.kind }));
  if (images.length) {
    userMsg.images = images.map((a) => ({ name: a.name, thumb: a.thumb }));
    state.images.set(userMsg.id, images.map((a) => ({ name: a.name, dataUrl: a.dataUrl })));
  }
  const context = buildContext([...conv.messages, userMsg]);
  if (!context) {
    state.images.delete(userMsg.id);
    return toast(t('contextTooLarge'), 'error');
  }

  const savedAttachments = state.attachments;
  const hadTitle = !!conv.title;
  const asst = newAssistant();
  conv.messages.push(userMsg, asst);
  if (!hadTitle) conv.title = makeTitle(text);
  conv.model = currentModel();
  conv.updatedAt = Date.now();
  input.value = '';
  autosize();
  state.attachments = [];

  await runCompletion({
    conv,
    asst,
    context,
    restore: () => {
      conv.messages = conv.messages.filter((m) => m.id !== userMsg.id && m.id !== asst.id);
      state.images.delete(userMsg.id);
      if (!hadTitle) conv.title = '';
      input.value = text === t('defaultPrompt') && savedAttachments.length ? '' : text;
      state.attachments = savedAttachments;
      autosize();
    },
  });
}

async function regenerate() {
  if (state.busy) return;
  const conv = activeConv();
  if (!conv) return;
  const prev = conv.messages[conv.messages.length - 1];
  const user = conv.messages[conv.messages.length - 2];
  if (!prev || prev.role !== 'assistant' || !user || user.role !== 'user') return;
  const context = buildContext(conv.messages.slice(0, -1));
  if (!context) return toast(t('contextTooLarge'), 'error');
  const asst = newAssistant();
  conv.messages[conv.messages.length - 1] = asst;
  await runCompletion({
    conv,
    asst,
    context,
    restore: () => {
      conv.messages[conv.messages.length - 1] = prev; // giữ lại câu trả lời cũ nếu tạo lại thất bại
    },
  });
}

function stopGenerating() {
  state.busy?.controller.abort();
}

// ---------- Đính kèm ảnh/tệp ----------
async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  for (const file of files) {
    state.pending++;
    renderComposer();
    try {
      const att = await readAttachment(file, state.attachments);
      state.attachments.push(att);
      if (att.truncated) toast(t('docTruncated', { name: att.name }));
    } catch (e) {
      toast(e && e.code ? fileErrorText(e) : t('fileReadFail', { name: file.name }), 'error');
    } finally {
      state.pending--;
      renderComposer();
    }
  }
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
  const c = state.convs.find((x) => x.id === id);
  for (const m of c?.messages || []) state.images.delete(m.id);
  state.convs = state.convs.filter((x) => x.id !== id);
  if (state.activeId === id) {
    const next = [...state.convs].filter((x) => x.messages.length).sort((a, b) => b.updatedAt - a.updatedAt)[0];
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

// ---------- Cài đặt, sao lưu/khôi phục lịch sử ----------
function openSettings() {
  $('systemPrompt').value = state.systemPrompt;
  const mb = (new Blob([JSON.stringify(state.convs)]).size / 1048576).toFixed(1);
  $('storageInfo').textContent = t('storageUsage', { mb });
  $('dlgSettings').showModal();
}
function saveSettingsDialog() {
  state.systemPrompt = $('systemPrompt').value.trim().slice(0, 4000);
  saveSettings({ systemPrompt: state.systemPrompt });
  $('dlgSettings').close();
}
function exportHistory() {
  const data = { app: 'TP OmniAI', version: 1, exportedAt: new Date().toISOString(), conversations: state.convs.filter((c) => c.messages.length) };
  downloadText('tp-omniai-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(data), 'application/json');
  toast(t('exportDone'));
}
async function importHistory(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const list = sanitizeConversations(Array.isArray(parsed) ? parsed : parsed?.conversations);
    if (!list) throw new Error('format');
    const have = new Set(state.convs.map((c) => c.id));
    const fresh = list.filter((c) => c.messages.length && !have.has(c.id));
    if (!fresh.length) return toast(t('importNone'));
    state.convs.push(...fresh);
    persist();
    renderAll();
    toast(t('importDone', { n: fresh.length }));
  } catch {
    toast(t('importFail'), 'error');
  }
}

// ---------- Xem ảnh lớn ----------
function openLightbox(msgId, idx) {
  const msg = activeConv()?.messages.find((m) => m.id === msgId);
  const meta = msg?.images?.[idx];
  if (!meta) return;
  const full = state.images.get(msgId)?.[idx];
  $('lightboxImg').src = full ? full.dataUrl : meta.thumb;
  $('lightboxImg').alt = meta.name;
  $('dlgImage').showModal();
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
  $('fileInput').accept = ACCEPT;

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
    ({ open: selectConversation, rename: openRename, delete: openDelete, download: downloadConversation })[btn.dataset.action]?.(li.dataset.id);
  });
  $('openSidebar').addEventListener('click', openSidebar);
  $('closeSidebar').addEventListener('click', closeSidebar);
  $('scrim').addEventListener('click', closeSidebar);

  // Chọn model
  $('modelBtn').addEventListener('click', openPicker);
  $('modelsClose').addEventListener('click', () => $('dlgModels').close());
  $('modelSearch').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderPicker();
  });
  $('modelFilters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    renderPicker();
  });
  $('modelList').addEventListener('click', (e) => {
    const star = e.target.closest('[data-fav]');
    if (star) return toggleFavorite(star.dataset.fav);
    const pick = e.target.closest('[data-model]');
    if (pick) selectModel(pick.dataset.model);
  });
  $('downloadBtn').addEventListener('click', () => downloadConversation(state.activeId));

  // Soạn tin
  $('sendBtn').addEventListener('click', () => (state.busy ? stopGenerating() : sendMessage()));
  $('input').addEventListener('input', autosize);
  $('input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    if (matchMedia('(pointer: coarse)').matches) return; // trên điện thoại Enter xuống dòng, dùng nút Gửi
    e.preventDefault();
    if (!state.busy) sendMessage();
  });
  $('input').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      handleFiles(files);
    }
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

  // Kéo thả tệp vào bất cứ đâu trong trang
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const appVisible = () => !$('app').hidden;
  addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    if (appVisible() && !state.busy) $('dropOverlay').hidden = false;
  });
  addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropOverlay').hidden = true;
  });
  addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // tránh trình duyệt mở tệp thay cho trang
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    if (appVisible() && !state.busy) handleFiles(e.dataTransfer.files);
  });

  // Thao tác trong khung chat
  $('thread').addEventListener('click', async (e) => {
    const img = e.target.closest('.img-tags img');
    if (img) return openLightbox(img.dataset.msg, Number(img.dataset.idx));
    const codeBtn = e.target.closest('[data-code-copy]');
    if (codeBtn) {
      const code = codeBtn.closest('.code-block')?.querySelector('code')?.textContent || '';
      if (await copyText(code)) {
        codeBtn.textContent = t('codeCopied');
        setTimeout(() => (codeBtn.textContent = t('copyCode')), 1500);
      } else toast(t('copyFailed'), 'error');
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'regen') return regenerate();
    if (btn.dataset.action === 'copy') {
      const id = btn.closest('.msg').dataset.id;
      const msg = activeConv()?.messages.find((m) => m.id === id);
      if (!msg) return;
      if (await copyText(msg.content)) {
        btn.innerHTML = icon('check');
        toast(t('copied'));
        setTimeout(() => (btn.innerHTML = icon('copy')), 1500);
      } else toast(t('copyFailed'), 'error');
    }
  });
  $('threadWrap').addEventListener('scroll', () => {
    const w = $('threadWrap');
    state.stick = w.scrollHeight - w.scrollTop - w.clientHeight < 80;
  });
  $('lightboxClose').addEventListener('click', () => $('dlgImage').close());

  // Đổi tên / xóa
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

  // Cài đặt
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsCancel').addEventListener('click', () => $('dlgSettings').close());
  $('settingsSave').addEventListener('click', saveSettingsDialog);
  $('exportBtn').addEventListener('click', exportHistory);
  $('importBtn').addEventListener('click', () => $('importInput').click());
  $('importInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importHistory(f);
  });

  // Trạng thái kết nối
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

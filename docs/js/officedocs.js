// Đọc văn bản từ DOCX, XLSX, PPTX (giải nén ZIP bằng DecompressionStream có sẵn trong trình duyệt)
// và PDF (thư viện pdf.js, chỉ tải khi người dùng đính kèm PDF). Mọi xử lý diễn ra trong trình duyệt.
export class DocError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

export const MAX_DOC_BYTES = 10 * 1024 * 1024; // tệp gốc
export const MAX_ENTRY_BYTES = 30 * 1024 * 1024; // dung lượng sau giải nén của từng phần (chống "bom nén")
export const MAX_DOC_CHARS = 150_000; // văn bản trích ra tối đa cho mỗi tệp
export const OFFICE_EXTENSIONS = ['docx', 'xlsx', 'pptx'];
export const LEGACY_EXTENSIONS = ['doc', 'xls', 'ppt'];
export const DOC_EXTENSIONS = [...OFFICE_EXTENSIONS, 'pdf'];

const td = new TextDecoder('utf-8');
const u16 = (v, o) => v[o] | (v[o + 1] << 8);
const u32 = (v, o) => (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0;

// ---------- ZIP ----------
export function readZipDirectory(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocError('docBadZip');
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) throw new DocError('docBadZip');
    const flags = u16(bytes, p + 8);
    if (flags & 1) throw new DocError('docEncrypted');
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method: u16(bytes, p + 10), csize: u32(bytes, p + 20), usize: u32(bytes, p + 24), lho: u32(bytes, p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function extractEntry(bytes, entry) {
  if (entry.usize > MAX_ENTRY_BYTES) throw new DocError('docTooLarge');
  const p = entry.lho;
  if (p + 30 > bytes.length || u32(bytes, p) !== 0x04034b50) throw new DocError('docBadZip');
  const start = p + 30 + u16(bytes, p + 26) + u16(bytes, p + 28);
  const data = bytes.subarray(start, start + entry.csize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new DocError('docBadZip');
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ENTRY_BYTES) {
      await reader.cancel();
      throw new DocError('docTooLarge');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const readText = async (bytes, entries, name) => (entries.has(name) ? td.decode(await extractEntry(bytes, entries.get(name))) : null);

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const attrs = (tag) => {
  const o = {};
  for (const m of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) o[m[1]] = decodeXml(m[2]);
  return o;
};

// ---------- DOCX ----------
export function docxToText(xml) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;
  for (let m; (m = re.exec(xml)); ) {
    const tok = m[0];
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (tok.startsWith('<w:tab')) out += '\t';
    else if (tok.startsWith('<w:br')) out += '\n';
    else if (tok === '</w:p>') out += '\n';
    else if (tok === '</w:tc>') out = out.replace(/\n$/, '') + ' | ';
    else if (tok === '</w:tr>') out = out.replace(/ \| $/, '') + '\n';
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- XLSX ----------
const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/[^A-Za-z]/g, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};
const csvCell = (v) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);

export async function xlsxToText(bytes, entries, { maxRows = 1000, maxCols = 60, maxChars = MAX_DOC_CHARS } = {}) {
  const shared = [];
  const ss = await readText(bytes, entries, 'xl/sharedStrings.xml');
  if (ss) {
    for (const si of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      let t = '';
      for (const x of si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) t += decodeXml(x[1]);
      shared.push(t);
    }
  }
  const wb = await readText(bytes, entries, 'xl/workbook.xml');
  if (!wb) throw new DocError('docBadZip');
  const rels = (await readText(bytes, entries, 'xl/_rels/workbook.xml.rels')) || '';
  const target = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.Id && a.Target) target[a.Id] = a.Target.startsWith('/') ? a.Target.slice(1) : 'xl/' + a.Target;
  }
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => attrs(m[0]));
  const parts = [];
  let chars = 0;
  let truncated = false;
  for (const [i, sh] of sheets.entries()) {
    const path = target[sh['r:id']] || `xl/worksheets/sheet${i + 1}.xml`;
    const xml = await readText(bytes, entries, path);
    if (xml === null) continue;
    const lines = [];
    let rowCount = 0;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rowCount >= maxRows) {
        truncated = true;
        break;
      }
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = attrs(c[1]);
        const idx = a.r ? colIndex(a.r) : cells.length;
        if (idx >= maxCols) {
          truncated = true;
          continue;
        }
        const body = c[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        let val = '';
        if (a.t === 's') val = shared[Number(v?.[1])] ?? '';
        else if (a.t === 'inlineStr') val = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join('');
        else if (a.t === 'b') val = v?.[1] === '1' ? 'TRUE' : 'FALSE';
        else if (v) val = decodeXml(v[1]);
        while (cells.length < idx) cells.push('');
        cells[idx] = val;
      }
      if (cells.some((x) => x !== '')) {
        lines.push(cells.map(csvCell).join(','));
        rowCount++;
      }
    }
    const block = `## ${sh.name || 'Sheet' + (i + 1)}\n${lines.join('\n')}`;
    chars += block.length;
    parts.push(block);
    if (chars > maxChars) break;
  }
  return { text: parts.join('\n\n').trim(), truncated };
}

// ---------- PPTX ----------
export async function pptxToText(bytes, entries) {
  const slides = [...entries.keys()]
    .map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const out = [];
  for (const m of slides) {
    const xml = await readText(bytes, entries, m[0]);
    const paras = [];
    for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
      const t = [...p[1].matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map((x) => decodeXml(x[1])).join('');
      if (t.trim()) paras.push(t);
    }
    if (paras.length) out.push(`## Slide ${m[1]}\n${paras.join('\n')}`);
  }
  return out.join('\n\n').trim();
}

// ---------- PDF (pdf.js tải khi cần) ----------
const PDFJS_VERSION = '4.10.38';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/`;
let pdfjsPromise = null;
async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      try {
        const mod = await import(PDFJS_BASE + 'pdf.min.mjs');
        // Worker ở tên miền khác không khởi tạo trực tiếp được, nên tải về rồi tạo từ Blob.
        const code = await (await fetch(PDFJS_BASE + 'pdf.worker.min.mjs')).text();
        mod.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        return mod;
      } catch (e) {
        pdfjsPromise = null;
        throw new DocError('docPdfLoad');
      }
    })();
  }
  return pdfjsPromise;
}

export async function pdfToText(bytes, { maxPages = 80, maxChars = MAX_DOC_CHARS } = {}) {
  const pdfjs = await loadPdfJs();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new DocError('docEncrypted');
    throw new DocError('docBadZip');
  }
  const out = [];
  let chars = 0;
  let truncated = doc.numPages > maxPages;
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) text += item.str + (item.hasEOL ? '\n' : ' ');
    text = text.replace(/[ \t]+\n/g, '\n').trim();
    if (text) out.push(`## Trang ${i}\n${text}`);
    chars += text.length;
    if (chars > maxChars) {
      truncated = true;
      break;
    }
  }
  return { text: out.join('\n\n').trim(), truncated };
}

// ---------- Hàm chính ----------
export const extensionOf = (name) => (/\.([A-Za-z0-9]+)$/.exec(name || '') || [])[1]?.toLowerCase() || '';

export async function extractDocumentText(file) {
  const ext = extensionOf(file.name);
  if (LEGACY_EXTENSIONS.includes(ext)) throw new DocError('docLegacy', { name: file.name, ext: '.' + ext });
  if (!DOC_EXTENSIONS.includes(ext)) throw new DocError('docBadZip');
  if (file.size === 0) throw new DocError('docEmpty', { name: file.name });
  if (file.size > MAX_DOC_BYTES) throw new DocError('docTooLarge', { name: file.name, mb: MAX_DOC_BYTES / 1048576 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  let truncated = false;
  if (ext === 'pdf') {
    ({ text, truncated } = await pdfToText(bytes));
    if (text.replace(/## Trang \d+/g, '').trim().length < 20) throw new DocError('docPdfScanned', { name: file.name });
  } else {
    const entries = readZipDirectory(bytes);
    if (ext === 'docx') {
      const xml = await readText(bytes, entries, 'word/document.xml');
      if (xml === null) throw new DocError('docBadZip');
      text = docxToText(xml);
    } else if (ext === 'xlsx') {
      ({ text, truncated } = await xlsxToText(bytes, entries));
    } else {
      text = await pptxToText(bytes, entries);
    }
  }
  if (!text.trim()) throw new DocError('docEmpty', { name: file.name });
  if (text.length > MAX_DOC_CHARS) {
    text = text.slice(0, MAX_DOC_CHARS) + '\n[… đã cắt bớt …]';
    truncated = true;
  }
  return { text, truncated };
}

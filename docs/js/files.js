// Đính kèm: ảnh, tài liệu (Word/Excel/PowerPoint/PDF) và tệp văn bản/mã nguồn UTF-8. Mỗi loại có bộ đọc riêng,
// định dạng chưa có bộ đọc sẽ bị từ chối rõ ràng thay vì gửi nội dung rỗng.
import { readImage, isImageFile, looksLikeUnsupportedImage, MAX_IMAGES, ImageError } from './images.js';
import { extractDocumentText, DOC_EXTENSIONS, LEGACY_EXTENSIONS, DocError } from './officedocs.js';

export const MAX_ATTACHMENTS = 6;
export const MAX_FILE_BYTES = 200 * 1024; // tệp văn bản thường
export const MAX_TOTAL_CHARS = 400 * 1024; // tổng văn bản đính kèm trong một tin nhắn
export const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb',
  'php', 'sh', 'sql', 'tex', 'srt', 'vtt',
];
export { DocError, ImageError, MAX_IMAGES };

export class FileError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

export const extensionOf = (name) => (/\.([A-Za-z0-9]+)$/.exec(name || '') || [])[1]?.toLowerCase() || '';
export const ACCEPT = [...TEXT_EXTENSIONS, ...DOC_EXTENSIONS, 'png', 'jpg', 'jpeg', 'webp', 'gif'].map((e) => '.' + e).join(',');

export function classify(file) {
  const ext = extensionOf(file.name);
  if (isImageFile(file)) return 'image';
  if (looksLikeUnsupportedImage(file)) return 'badimage';
  if (DOC_EXTENSIONS.includes(ext)) return 'doc';
  if (LEGACY_EXTENSIONS.includes(ext)) return 'legacy';
  if (TEXT_EXTENSIONS.includes(ext)) return 'text';
  return 'unsupported';
}

// Kiểm tra trước khi đọc (không cần nội dung).
export function precheck(file, existing = []) {
  const kind = classify(file);
  const ext = extensionOf(file.name);
  if (kind === 'badimage') throw new FileError('imgBadType', { name: file.name });
  if (kind === 'legacy') throw new FileError('docLegacy', { name: file.name, ext: '.' + ext });
  if (kind === 'unsupported') throw new FileError('fileBadType', { ext: ext ? '.' + ext : '(không có đuôi)', name: file.name, list: '.docx, .xlsx, .pptx, .pdf, ảnh, .' + TEXT_EXTENSIONS.slice(0, 6).join(', .') + '…' });
  if (file.size === 0) throw new FileError('fileEmpty', { name: file.name });
  if (existing.length >= MAX_ATTACHMENTS) throw new FileError('fileTooMany', { n: MAX_ATTACHMENTS });
  if (existing.some((f) => f.name === file.name && f.size === file.size)) throw new FileError('fileDuplicate', { name: file.name });
  if (kind === 'image' && existing.filter((f) => f.kind === 'image').length >= MAX_IMAGES) throw new FileError('imgTooMany', { n: MAX_IMAGES });
  if (kind === 'text' && file.size > MAX_FILE_BYTES) throw new FileError('fileTooBig', { name: file.name, kb: MAX_FILE_BYTES / 1024 });
  return kind;
}

// Giải mã byte thành văn bản UTF-8 nghiêm ngặt.
export function decodeText(bytes, name) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.includes(0)) throw new FileError('fileBinary', { name });
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(view);
  } catch {
    throw new FileError('fileDecode', { name });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

let seq = 0;
const nextId = () => 'att' + Date.now().toString(36) + (seq++).toString(36);

export async function readAttachment(file, existing = []) {
  const kind = precheck(file, existing);
  if (kind === 'image') return { id: nextId(), ...(await readImage(file)) };
  let text;
  let truncated = false;
  if (kind === 'doc') {
    ({ text, truncated } = await extractDocumentText(file));
  } else {
    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch {
      throw new FileError('fileReadFail', { name: file.name });
    }
    text = decodeText(buf, file.name);
  }
  const used = existing.filter((f) => f.kind !== 'image').reduce((s, f) => s + (f.text || '').length, 0);
  if (used + text.length > MAX_TOTAL_CHARS) throw new FileError('fileTotalTooBig', { kb: MAX_TOTAL_CHARS / 1024 });
  return { id: nextId(), kind: kind === 'doc' ? 'doc' : 'text', name: file.name, size: file.size, text, truncated };
}

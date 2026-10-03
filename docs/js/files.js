// Đính kèm tệp: chỉ đọc được tệp văn bản/mã nguồn (UTF-8). PDF, Word, ảnh... chưa có bộ đọc nên bị từ chối rõ ràng.
export const MAX_FILES = 3;
export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_TOTAL_BYTES = 400 * 1024;
export const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb',
  'php', 'sh', 'sql', 'tex', 'srt', 'vtt',
];

export class FileError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

export const extensionOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
};

// Kiểm tra trước khi đọc (không cần nội dung).
export function precheck(file, existing = []) {
  const ext = extensionOf(file.name);
  if (!TEXT_EXTENSIONS.includes(ext)) throw new FileError('fileBadType', { ext: ext ? '.' + ext : '(không có đuôi)', name: file.name, list: '.' + TEXT_EXTENSIONS.slice(0, 8).join(', .') + '…' });
  if (file.size === 0) throw new FileError('fileEmpty', { name: file.name });
  if (file.size > MAX_FILE_BYTES) throw new FileError('fileTooBig', { name: file.name, kb: MAX_FILE_BYTES / 1024 });
  if (existing.length >= MAX_FILES) throw new FileError('fileTooMany', { n: MAX_FILES });
  if (existing.some((f) => f.name === file.name && f.size === file.size)) throw new FileError('fileDuplicate', { name: file.name });
  const total = existing.reduce((s, f) => s + f.size, 0) + file.size;
  if (total > MAX_TOTAL_BYTES) throw new FileError('fileTotalTooBig', { kb: MAX_TOTAL_BYTES / 1024 });
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

export async function readAttachment(file, existing = []) {
  precheck(file, existing);
  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch {
    throw new FileError('fileReadFail', { name: file.name });
  }
  const text = decodeText(buf, file.name);
  return { name: file.name, size: file.size, text };
}

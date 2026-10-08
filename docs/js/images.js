// Xử lý ảnh trong trình duyệt: thu nhỏ + nén JPEG trước khi gửi (tiết kiệm băng thông ngrok), tạo ảnh thu nhỏ để lưu lịch sử.
export class ImageError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_IMAGE_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGES = 4;
const MAX_EDGE = 1280;
const MAX_DATAURL_CHARS = 1_200_000;

export const isImageFile = (file) => IMAGE_MIME.includes(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name || '');
export const looksLikeUnsupportedImage = (file) => /^image\//.test(file.type || '') || /\.(svg|heic|heif|bmp|tiff?|avif)$/i.test(file.name || '');

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* thử cách khác */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function render(source, w, h, quality) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // nền trắng cho ảnh PNG/WebP trong suốt
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}

export async function readImage(file) {
  if (!isImageFile(file)) throw new ImageError('imgBadType', { name: file.name });
  if (file.size > MAX_IMAGE_FILE_BYTES) throw new ImageError('imgTooBig', { name: file.name, mb: MAX_IMAGE_FILE_BYTES / 1048576 });
  let src;
  try {
    src = await decode(file);
  } catch {
    throw new ImageError('imgReadFail', { name: file.name });
  }
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) throw new ImageError('imgReadFail', { name: file.name });
  let scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  let quality = 0.82;
  let dataUrl = '';
  for (let i = 0; i < 6; i++) {
    dataUrl = render(src, Math.max(1, Math.round(w0 * scale)), Math.max(1, Math.round(h0 * scale)), quality);
    if (dataUrl.length <= MAX_DATAURL_CHARS) break;
    if (quality > 0.5) quality -= 0.12;
    else scale *= 0.75;
  }
  if (dataUrl.length > MAX_DATAURL_CHARS) throw new ImageError('imgTooBig', { name: file.name, mb: MAX_IMAGE_FILE_BYTES / 1048576 });
  const ts = Math.min(1, 96 / Math.max(w0, h0));
  const thumb = render(src, Math.max(1, Math.round(w0 * ts)), Math.max(1, Math.round(h0 * ts)), 0.7);
  if (src.close) src.close();
  return { kind: 'image', name: file.name || 'image', mime: 'image/jpeg', size: Math.round(dataUrl.length * 0.75), dataUrl, thumb };
}

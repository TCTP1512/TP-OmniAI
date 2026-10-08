// Trình hiển thị Markdown nhỏ gọn và an toàn: mọi văn bản đều được thoát HTML trước,
// chỉ liên kết http(s)/mailto được tạo thẻ <a>. Không cho phép HTML thô từ AI.
export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(text) {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return '<code>' + escapeHtml(part.slice(1, -1)) + '</code>';
      let s = escapeHtml(part);
      s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>');
      s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');
      s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
      return s;
    })
    .join('');
}

const isFence = (l) => /^\s{0,3}```/.test(l);
const isHr = (l) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
const isUl = (l) => /^\s{0,3}[-*+]\s+/.test(l);
const isOl = (l) => /^\s{0,3}\d{1,9}[.)]\s+/.test(l);
const isQuote = (l) => /^\s{0,3}>/.test(l);
const isHeading = (l) => /^\s{0,3}#{1,6}\s+/.test(l);
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function renderMarkdown(src, opts = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (isFence(line)) {
      const lang = line.replace(/^\s*```/, '').trim().split(/\s+/)[0].replace(/[^\w+#.-]/g, '');
      const buf = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) buf.push(lines[i++]);
      i++; // bỏ dòng đóng; nếu đang stream mà chưa có dòng đóng thì vẫn hiển thị phần đã có
      html.push(
        `<div class="code-block"><div class="code-head"><span>${escapeHtml(lang)}</span><button type="button" class="code-copy" data-code-copy>${escapeHtml(opts.copyLabel || 'Copy')}</button></div>` +
          `<pre><code${lang ? ` class="lang-${lang}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre></div>`,
      );
      continue;
    }
    if (isHeading(line)) {
      const m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      const lvl = Math.min(m[1].length + 1, 4); // h1 trong câu trả lời hiển thị nhỏ hơn tiêu đề trang
      html.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (isHr(line)) {
      html.push('<hr>');
      i++;
      continue;
    }
    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      html.push('<blockquote>' + renderMarkdown(buf.join('\n'), opts) + '</blockquote>');
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      html.push(
        '<div class="table-wrap"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>',
      );
      continue;
    }
    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const test = ordered ? isOl : isUl;
      const items = [];
      while (i < lines.length && test(lines[i])) {
        let item = lines[i++].replace(ordered ? /^\s{0,3}\d{1,9}[.)]\s+/ : /^\s{0,3}[-*+]\s+/, '');
        // dòng tiếp nối thụt lề thuộc cùng mục
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(item);
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>` + items.map((it) => `<li>${inline(it)}</li>`).join('') + `</${tag}>`);
      continue;
    }
    // đoạn văn: gom các dòng liên tiếp
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isFence(lines[i]) && !isHeading(lines[i]) && !isHr(lines[i]) && !isQuote(lines[i]) && !isUl(lines[i]) && !isOl(lines[i])) {
      if (lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
      buf.push(lines[i++]);
    }
    html.push('<p>' + buf.map(inline).join('<br>') + '</p>');
  }
  return html.join('\n');
}

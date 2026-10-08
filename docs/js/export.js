// Xuất hội thoại ra tệp Markdown (.md), đúng thứ tự tin nhắn.
export function safeFilename(title, fallback = 'tp-omniai') {
  const base = String(title || '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return (base || fallback) + '.md';
}

export function conversationToMarkdown(conv, labels) {
  const out = [`# ${conv.title || labels.untitled}`, '', `_${labels.exportedOn}_`, ''];
  for (const m of conv.messages) {
    const who = m.role === 'user' ? labels.you : labels.assistant;
    const model = m.role === 'assistant' && (m.meta?.reported || m.meta?.requested) ? ` (${m.meta.reported || m.meta.requested})` : '';
    out.push(`## ${who}${model}`, '');
    if (m.attachments?.length) out.push(`${labels.files}: ${m.attachments.map((a) => a.name).join(', ')}`, '');
    out.push(m.content, '');
  }
  return out.join('\n');
}

export function downloadText(filename, text, mime = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

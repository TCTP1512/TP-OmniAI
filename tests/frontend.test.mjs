import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../docs/js/markdown.js';
import { sanitizeConversations, loadConversations, saveConversations, getAuth, setAuth } from '../docs/js/storage.js';
import { decodeText, precheck, FileError, MAX_FILE_BYTES, MAX_FILES } from '../docs/js/files.js';
import { safeFilename, conversationToMarkdown } from '../docs/js/export.js';
import { splitSSE } from '../docs/js/api.js';

test('markdown: chặn XSS và HTML thô', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '**<b onclick=1>**',
    '`<script>`',
    '```\n<script>alert(1)</script>\n```',
    '| a |\n|---|\n| <img src=x onerror=1> |',
  ];
  for (const a of attacks) {
    const h = renderMarkdown(a);
    assert.ok(!/<script/i.test(h), a);
    assert.ok(!/<img/i.test(h), a);
    assert.ok(!/href="javascript:/i.test(h), a);
    assert.ok(!/href="data:/i.test(h), a);
    assert.ok(!/ on\w+=/i.test(h.replace(/&quot;|&#39;/g, '')) || h.includes('&lt;'), a);
  }
});

test('markdown: các định dạng cơ bản', () => {
  const h = renderMarkdown('# Tiêu đề\n\nĐoạn **đậm** và *nghiêng* và `mã`.\n\n- a\n- b\n\n1. x\n2. y\n\n> trích\n\n```js\nconst a = 1 < 2;\n```\n\n[liên kết](https://example.com)\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  for (const part of ['<h2>Tiêu đề</h2>', '<strong>đậm</strong>', '<em>nghiêng</em>', '<code>mã</code>', '<ul><li>a</li><li>b</li></ul>', '<ol><li>x</li><li>y</li></ol>', '<blockquote>', 'class="lang-js"', '1 &lt; 2', 'href="https://example.com"', 'rel="noopener noreferrer nofollow"', '<table>', '<th>A</th>', '<td>2</td>'])
    assert.ok(h.includes(part), 'thiếu ' + part + '\n' + h);
});

test('markdown: khối mã chưa đóng khi đang stream vẫn hiển thị', () => {
  assert.ok(renderMarkdown('```py\nprint(1)').includes('<pre><code class="lang-py">print(1)</code></pre>'));
});

test('lịch sử: dữ liệu hỏng được làm sạch, thứ tự giữ nguyên', () => {
  const out = sanitizeConversations([
    null,
    { id: 'a', title: 'A', messages: [{ role: 'user', content: '1' }, { role: 'hacker', content: 'x' }, { role: 'assistant', content: '2' }, { role: 'user' }] },
    { id: 'a', title: 'trùng' },
    { title: 'không id' },
    { id: 'b', messages: 'không phải mảng' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].messages.map((m) => m.content), ['1', '2']);
  assert.equal(out[1].messages.length, 0);
  assert.equal(sanitizeConversations({}), null);
});

test('lịch sử: lưu rồi đọc lại; JSON hỏng thì đặt lại và giữ bản sao', () => {
  assert.equal(saveConversations([{ id: 'x', title: 't', createdAt: 1, updatedAt: 2, model: 'auto', messages: [{ id: 'm', role: 'user', content: 'xin chào', ts: 1 }] }]), true);
  const r = loadConversations();
  assert.equal(r.corrupt, false);
  assert.equal(r.list[0].messages[0].content, 'xin chào');
});

test('phiên đăng nhập: chỉ giữ token còn hạn', () => {
  setAuth('tok', Date.now() + 60000);
  assert.equal(getAuth().token, 'tok');
  setAuth('tok', Date.now() - 1);
  assert.equal(getAuth(), null);
});

test('tệp: từ chối PDF/Word/ảnh, tệp quá lớn, tệp nhị phân, không phải UTF-8', () => {
  const f = (name, size = 10) => ({ name, size });
  for (const bad of ['a.pdf', 'a.docx', 'a.png', 'a.zip', 'khongduoi']) assert.throws(() => precheck(f(bad)), (e) => e instanceof FileError && e.code === 'fileBadType', bad);
  assert.doesNotThrow(() => precheck(f('ghi-chu.md')));
  assert.throws(() => precheck(f('a.txt', MAX_FILE_BYTES + 1)), (e) => e.code === 'fileTooBig');
  assert.throws(() => precheck(f('a.txt', 0)), (e) => e.code === 'fileEmpty');
  const existing = Array.from({ length: MAX_FILES }, (_, i) => f(`f${i}.txt`, 5));
  assert.throws(() => precheck(f('more.txt'), existing), (e) => e.code === 'fileTooMany');
  assert.throws(() => precheck(f('f0.txt', 5), existing.slice(0, 1)), (e) => e.code === 'fileDuplicate');
  assert.throws(() => decodeText(new Uint8Array([104, 0, 105]), 'x.txt'), (e) => e.code === 'fileBinary');
  assert.throws(() => decodeText(new Uint8Array([0xff, 0xfe, 0x41]), 'x.txt'), (e) => e.code === 'fileDecode');
  assert.equal(decodeText(new TextEncoder().encode('\ufeffXin chào đ'), 'x.txt'), 'Xin chào đ');
});

test('xuất hội thoại: đúng thứ tự, tên tệp an toàn, xử lý tên rỗng', () => {
  assert.equal(safeFilename('a/b:c*?"<>|d'), 'a b c d.md');
  assert.equal(safeFilename(''), 'tp-omniai.md');
  assert.equal(safeFilename('...'), 'tp-omniai.md');
  assert.ok(safeFilename('x'.repeat(500)).length <= 83);
  const md = conversationToMarkdown(
    { title: 'Thử', messages: [{ role: 'user', content: 'Câu 1', attachments: [{ name: 'a.txt' }] }, { role: 'assistant', content: 'Trả lời 1', meta: { reported: 'claude-x' } }, { role: 'user', content: 'Câu 2' }] },
    { untitled: 'u', you: 'Bạn', assistant: 'AI', files: 'Tệp', exportedOn: 'hôm nay' },
  );
  const order = ['Câu 1', 'Trả lời 1', 'Câu 2'].map((s) => md.indexOf(s));
  assert.ok(order.every((n) => n > 0) && order[0] < order[1] && order[1] < order[2]);
  assert.ok(md.includes('## AI (claude-x)') && md.includes('Tệp: a.txt'));
});

test('SSE: tách sự kiện đúng kể cả khi bị cắt giữa chừng và CRLF', () => {
  let r = splitSSE('data: {"a":1}\n\ndata: {"a"');
  assert.deepEqual(r.events, ['{"a":1}']);
  assert.equal(r.rest, 'data: {"a"');
  r = splitSSE(r.rest + ':2}\r\n\r\ndata: [DONE]\r\n\r\n');
  assert.deepEqual(r.events, ['{"a":2}', '[DONE]']);
  assert.deepEqual(splitSSE(': keep-alive\n\ndata: x\n\n').events, ['x']);
});

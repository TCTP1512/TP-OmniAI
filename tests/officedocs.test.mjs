import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocumentText, DocError, readZipDirectory, extractEntry, docxToText } from '../docs/js/officedocs.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const file = (name) => new File([fs.readFileSync(path.join(dir, name))], name);

test('DOCX thật: trích đoạn văn, bảng, ký tự đặc biệt', async () => {
  const { text } = await extractDocumentText(file('mau.docx'));
  for (const s of ['Báo cáo thử nghiệm', '1.250 triệu đồng', 'chữ đậm', '& ký tự đặc biệt <tag>.', 'Khu vực | Doanh thu', 'Miền Nam | 700']) assert.ok(text.includes(s), 'thiếu: ' + s + '\n' + text);
});

test('XLSX thật: nhiều sheet, số, chuỗi có dấu phẩy/trích dẫn, boolean, ô trống', async () => {
  const { text } = await extractDocumentText(file('mau.xlsx'));
  for (const s of ['## Doanh thu', 'Tháng,Doanh thu,Ghi chú', 'Một,100,"ổn, tốt"', 'Hai,150.5,"có ""trích dẫn"""', 'Ba,TRUE', '## Chi phí', 'Thuê,30']) assert.ok(text.includes(s), 'thiếu: ' + s + '\n' + text);
});

test('PPTX thật: trích chữ theo từng slide, đúng thứ tự', async () => {
  const { text } = await extractDocumentText(file('mau.pptx'));
  assert.ok(text.includes('## Slide 1') && text.includes('Giới thiệu') && text.includes('Mục tiêu năm nay'));
  assert.ok(text.indexOf('Slide 1') < text.indexOf('Slide 2') && text.includes('Tăng trưởng 12%'));
});

test('định dạng cũ (.doc/.xls/.ppt) và tệp hỏng/trống bị từ chối rõ ràng', async () => {
  for (const n of ['a.doc', 'a.xls', 'a.ppt']) await assert.rejects(extractDocumentText(new File([new Uint8Array([1, 2, 3])], n)), (e) => e instanceof DocError && e.code === 'docLegacy');
  await assert.rejects(extractDocumentText(new File([], 'a.docx')), (e) => e.code === 'docEmpty');
  await assert.rejects(extractDocumentText(new File([new Uint8Array(500).fill(7)], 'a.docx')), (e) => e.code === 'docBadZip');
  // DOCX thiếu word/document.xml (ví dụ một tệp xlsx đổi đuôi)
  await assert.rejects(extractDocumentText(new File([fs.readFileSync(path.join(dir, 'mau.xlsx'))], 'gia.docx')), (e) => e.code === 'docBadZip');
});

test('chống bom nén: phần có kích thước khai báo quá lớn bị từ chối', async () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(dir, 'mau.docx')));
  const entries = readZipDirectory(bytes);
  const e = entries.get('word/document.xml');
  await assert.rejects(extractEntry(bytes, { ...e, usize: 31 * 1024 * 1024 }), (x) => x.code === 'docTooLarge');
});

test('XML: giải mã thực thể và bỏ qua văn bản đã xóa', () => {
  assert.equal(docxToText('<w:p><w:r><w:t>A &amp; B &lt;c&gt; &#233;</w:t></w:r><w:r><w:delText>đã xóa</w:delText></w:r></w:p>'), 'A & B <c> é');
});

# TP OmniAI

Website chat AI chạy trên **GitHub Pages**; bộ điều phối model **OmniRoute** chạy trên **Google Colab** khi bạn chủ động bật. Chỉ bạn và bạn bè có mật khẩu mới dùng được. **Không dùng Cloudflare ở bất kỳ phần nào.**

```
Bạn bè ──▶ Website (GitHub Pages) ──HTTPS──▶ ngrok ──▶ [Colab] Backend bảo mật ──▶ OmniRoute ──▶ Claude / GPT / Gemini / DeepSeek...
                                                          (kiểm tra mật khẩu,        (chỉ nội bộ,
                                                           giới hạn, giấu khóa)       không công khai)
```

## Tính năng

- **Nhiều AI trong một nơi:** bộ chọn model có tìm kiếm, lọc theo họ (Claude, GPT, Gemini, DeepSeek...), đánh dấu yêu thích, **dấu ✓ cho model đã từng trả lời thành công**, chế độ **Tự động** và **combo** có dự phòng.
- **Gửi ảnh:** kéo thả vào khung chat, dán bằng Ctrl/Cmd+V, hoặc bấm nút đính kèm. Ảnh tự được thu nhỏ trước khi gửi.
- **Đọc tài liệu:** Word (.docx), Excel (.xlsx), PowerPoint (.pptx), PDF có chữ, và tệp văn bản/mã nguồn.
- **Trò chuyện:** trả lời hiện dần theo thời gian thực, nút Dừng, **Tạo lại câu trả lời**, hiển thị phần "suy nghĩ" của model suy luận, khối mã có nút sao chép, sao chép câu trả lời.
- **Lịch sử** trong trình duyệt: tìm kiếm (không phân biệt dấu), đổi tên, xóa, tải hội thoại (.md), **sao lưu/khôi phục toàn bộ** (.json).
- **Hướng dẫn cho AI** (ví dụ "luôn trả lời bằng tiếng Việt") áp dụng cho mọi cuộc trò chuyện.
- Tiếng Việt/Anh, giao diện sáng/tối, dùng tốt trên điện thoại.
- Màn hình **mật khẩu** (kiểm tra ở backend), nút **kiểm tra trạng thái** 4 tầng.

---

## Chi phí và giới hạn (nói thẳng)

| Thành phần | Chi phí | Giới hạn bạn cần biết |
|---|---|---|
| GitHub Pages | Miễn phí | Tài khoản miễn phí cần để repository ở chế độ **Public** |
| Google Colab | Miễn phí | Phiên có thể bị ngắt bất cứ lúc nào, không chạy 24/7. **Google cấm chạy "dịch vụ web không liên quan đến tính toán tương tác" trên Colab** và có thể ngắt phiên miễn phí không báo trước. Chỉ phù hợp quy mô nhỏ (bạn bè) |
| ngrok (gói Free) | Miễn phí | Theo tài liệu ngrok: 1 GB băng thông/tháng, 20.000 request/tháng, 1 tên miền cố định do ngrok cấp. **Gửi ảnh tốn băng thông hơn chat chữ** (mỗi ảnh sau nén thường vài trăm KB) |
| **Claude và GPT chính hãng** | **Tính phí** | Khóa API của Anthropic (Claude) và OpenAI (GPT) tính tiền theo mức dùng. OmniRoute chỉ điều phối, **không làm cho chúng miễn phí** |
| OpenRouter | Có gói miễn phí và trả phí | Một khóa dùng được rất nhiều model, trong đó có Claude, GPT (trả phí) và một số model miễn phí có giới hạn |
| Gemini (AI Studio) | Có gói miễn phí | Có giới hạn lượt dùng. Model cũ có thể bị Google đóng với tài khoản mới |
| Kiro, Antigravity... | Theo từng nhà cung cấp | Đăng nhập bằng tài khoản qua bảng điều khiển. Hạn mức, điều kiện sử dụng và việc có còn miễn phí hay không do nhà cung cấp quyết định và có thể thay đổi. Chưa được kiểm chứng ở đây |
| Google Fonts, jsDelivr | Miễn phí | Website tải phông từ Google Fonts; bộ đọc PDF (pdf.js) chỉ tải từ jsDelivr khi bạn đính kèm PDF |

---

## Cấu trúc thư mục

```
tp-omniai/
├── docs/                  Website (đưa lên GitHub Pages). Sửa địa chỉ dịch vụ ở docs/config.js
│   ├── index.html, favicon.svg, config.js, css/styles.css
│   └── js/                app.js (điều phối), api.js, storage.js, markdown.js, i18n.js, export.js,
│                          files.js (đính kèm), images.js (ảnh), officedocs.js (Word/Excel/PowerPoint/PDF)
├── backend/               Backend bảo mật (Node.js, không cần cài thư viện): server.mjs, .env.example
├── colab/                 TP_OmniAI_Colab.ipynb (notebook), tp_omniai.py (mã hỗ trợ, đã nhúng trong notebook)
├── tests/                 Kiểm thử tự động (+ tests/fixtures: tệp Word/Excel/PowerPoint/PDF/ảnh mẫu)
└── tools/                 build_notebook.py, e2e.py (kiểm thử trình duyệt), test_colab.py, make_fixtures.py
```

---

## Hướng dẫn triển khai (làm một lần)

### Bước 1. Đưa website lên GitHub Pages
1. Vào [github.com](https://github.com), tạo repository mới, chọn **Public**.
2. Bấm **uploading an existing file**, kéo thả **cả thư mục `docs`** (nên kéo cả các thư mục còn lại để lưu mã nguồn), bấm **Commit changes**. Nếu đã có sẵn repository từ trước, chỉ cần tải đè các tệp trong `docs` lên (giữ nguyên `docs/config.js` đã điền địa chỉ của bạn).
3. **Settings → Pages**: *Deploy from a branch*, nhánh **main**, thư mục **/docs**, Save.
4. Ghi lại tên miền gốc, ví dụ `https://TENBAN.github.io` (không có phần `/tenrepo`).

### Bước 2. Tạo tài khoản ngrok (miễn phí)
Đăng ký tại [dashboard.ngrok.com/signup](https://dashboard.ngrok.com/signup), chọn **Share Localhost**, rồi vào [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) và sao chép token. Đừng gửi token cho ai.

### Bước 3. Chạy trên Google Colab
1. Mở [colab.research.google.com](https://colab.research.google.com), **Upload** `colab/TP_OmniAI_Colab.ipynb`.
2. Bấm ▶ ô **Bước 1 - Cài đặt**, đợi xong (vài phút).
3. Ô **Bước 2 - Khởi động**: điền `ALLOWED_ORIGIN` = tên miền gốc ở Bước 1, bấm ▶, đồng ý quyền Drive, rồi nhập 3 thông tin bí mật: **mật khẩu cho bạn bè**, **mật khẩu bảng điều khiển OmniRoute** (bạn tự đặt, ≥ 8 ký tự), **ngrok authtoken**. Có thể lưu sẵn trong **Colab Secrets** với tên `SITE_PASSWORD`, `OMNIROUTE_ADMIN_PASSWORD`, `NGROK_AUTHTOKEN` để khỏi gõ lại.
4. Sao chép dòng `ĐỊA CHỈ DỊCH VỤ: https://...` notebook in ra.

### Bước 4. Nối website với dịch vụ
Trên GitHub mở `docs/config.js`, bấm Edit, điền `BACKEND_URL: "https://địa-chỉ-ngrok-của-bạn"`, Commit. Gói ngrok miễn phí cho **một địa chỉ cố định** nên chỉ làm một lần.

### Bước 5. Thêm AI vào OmniRoute
Chưa nối nhà cung cấp nào thì chưa có model để trả lời. Trong notebook:

- **Dán khóa API (dễ nhất):** ô *Thêm nhà cung cấp bằng khóa API*. Chọn `openrouter` (một khóa dùng được nhiều model, gồm Claude và GPT), `gemini` (khóa miễn phí tại aistudio.google.com/apikey), `anthropic` (Claude chính hãng, tính phí), `openai` (GPT chính hãng, tính phí), hoặc `deepseek`, `groq`, `glm`, `kimi`, `minimax`. Bấm ▶ và dán khóa khi được hỏi. Chạy lại ô này để thêm nhiều nhà cung cấp. Ô cho phép tự gõ tên nhà cung cấp khác; nếu OmniRoute không biết tên đó, nó báo lỗi rõ ràng.
- **Biết model nào dùng được:** danh mục của OmniRoute có hàng trăm model, nhưng chỉ một phần chạy được với tài khoản của bạn. Dùng lần lượt ô *1. Tìm model theo từ khóa* (xem ID) và ô *2. Thử xem model nào dùng được* (gửi một tin nhắn rất ngắn tới từng model khớp, tốn một ít hạn mức, và báo model nào chạy được kèm lý do nếu lỗi).
- **Tự tạo combo có dự phòng (khuyên dùng):** ô *3. Tự tạo combo từ các model dùng được*. Notebook thử các họ model theo thứ tự ưu tiên (mặc định `claude,gpt,gemini,deepseek`), lấy model chạy được đầu tiên của mỗi họ rồi tạo combo `tp-auto`. **Fallback do chính OmniRoute xử lý**: model đầu lỗi hoặc hết hạn mức thì chuyển sang model kế tiếp. Backend của TP OmniAI không tự đổi model. Combo hiện trong nhóm *Tự động* của website. Muốn tự chọn từng model thì dùng ô *Tạo combo thủ công* (điền ID cách nhau bằng dấu phẩy, copy từ ô tìm model).
- **Nhà cung cấp đăng nhập tài khoản (Kiro, Antigravity, Claude Code, Codex...):** chạy ô *Mở bảng điều khiển OmniRoute (tạm thời)*. Ô này mở bảng điều khiển qua đường hầm `localhost.run` (miễn phí, không cần tài khoản) và tự đóng sau 30 phút. Chạy ô *Đóng đường hầm* ngay khi xong. Trong lúc mở, địa chỉ đó công khai và chỉ có mật khẩu bảo vệ.

Sau khi thêm, tải lại website, bấm nút chọn model ở đầu trang, chọn model hoặc combo, rồi bấm nhãn trạng thái → **Test selected model** để kiểm tra model đó có chạy không. Model nào trả lời thành công sẽ được đánh dấu ✓ và có bộ lọc riêng *✓ Dùng được* trong bộ chọn.

---

## Dùng hằng ngày
1. Mở notebook, chạy ▶ **Bước 1** rồi ▶ **Bước 2**.
2. Gửi bạn bè địa chỉ website và mật khẩu.
3. Xong việc, chạy ▶ **Tắt dịch vụ** (tự sao lưu cấu hình OmniRoute vào Google Drive của bạn).

Khi Colab ngắt, website vẫn mở được nhưng báo "Mất kết nối"; chạy lại Bước 1 và 2 là dùng tiếp. Lịch sử trò chuyện không mất.

## Cách website hoạt động

- **Chọn model:** nút ở đầu trang mở bộ chọn có tìm kiếm. Danh sách lấy từ OmniRoute và là *danh mục*, không đảm bảo model nào cũng dùng được (ví dụ model Google đã đóng). Mặc định là **Tự động (auto)**. Chọn một model cụ thể thì **không** bị âm thầm đổi sang model khác; muốn có dự phòng hãy dùng combo hoặc auto.
- **Ảnh:** tối đa 4 ảnh mỗi tin nhắn, nguồn tối đa 15 MB, định dạng PNG/JPEG/WebP/GIF (SVG, HEIC chưa hỗ trợ). Ảnh được thu nhỏ về tối đa 1280 px và nén JPEG trước khi gửi. Model phải **hỗ trợ nhìn ảnh**; nếu không, website báo lỗi và gợi ý đổi model. AI chỉ nhìn thấy tối đa 3 ảnh gần nhất trong phiên; **sau khi tải lại trang chỉ còn ảnh thu nhỏ trong lịch sử**, nên hỏi tiếp về một ảnh cũ thì nên gửi lại ảnh.
- **Tài liệu:** Word/Excel/PowerPoint/PDF tối đa 10 MB mỗi tệp, văn bản trích ra tối đa 150.000 ký tự mỗi tệp (dài hơn thì cắt bớt và có báo), tổng văn bản đính kèm một tin nhắn tối đa 400 KB. Excel đọc tối đa 1.000 hàng × 60 cột mỗi sheet, công thức hiện giá trị đã tính, ngày tháng có thể hiện dưới dạng số. **PDF dạng ảnh quét không đọc được chữ** (chưa có OCR): hãy chụp từng trang và gửi dạng ảnh. Định dạng cũ `.doc`, `.xls`, `.ppt` chưa hỗ trợ; hãy lưu lại thành `.docx`, `.xlsx`, `.pptx`. Tệp văn bản/mã nguồn UTF-8: tối đa 200 KB mỗi tệp. Tất cả được đọc ngay trong trình duyệt của bạn, nội dung trích ra mới được gửi tới dịch vụ AI cùng câu hỏi (website có ghi chú này).
- **Lịch sử** lưu bằng `localStorage` trong *trình duyệt đang dùng*: không tự đồng bộ giữa thiết bị, và mất nếu xóa dữ liệu trình duyệt. Dùng **Cài đặt → Sao lưu lịch sử** để lưu ra tệp và khôi phục sang trình duyệt khác. Bộ nhớ trình duyệt thường chỉ khoảng 5 MB (Cài đặt hiển thị dung lượng đang dùng). Chỉ cuộc trò chuyện hiện tại được gửi đi.
- **Dòng "Model: ..." dưới mỗi câu trả lời** là model do OmniRoute báo về; nếu không báo, website ghi "chưa xác định".

## Bảo mật

Đã làm:
- Mật khẩu chỉ kiểm tra ở backend, không lưu trong trình duyệt; trình duyệt chỉ giữ token có hạn 12 giờ do backend ký.
- Chưa đăng nhập thì mọi API (chat, danh sách model, trạng thái) đều bị chặn.
- Giới hạn đăng nhập sai (5 lần/15 phút mỗi IP, kèm giới hạn chung), 20 tin nhắn/phút mỗi phiên, giới hạn kích thước yêu cầu; kiểm tra tên model, vai trò tin nhắn và nội dung ảnh. **Backend chỉ nhận ảnh dạng dữ liệu nhúng (`data:image/...`)**, không nhận đường dẫn ảnh ngoài, nên không thể bị lợi dụng để truy cập địa chỉ tùy ý. Không cho nhập URL tùy ý.
- CORS chỉ cho phép đúng tên miền GitHub Pages của bạn.
- Không ghi mật khẩu/khóa vào log; lỗi trả về không kèm stack trace; chuỗi giống khóa API trong lỗi của nhà cung cấp được che.
- OmniRoute và bảng điều khiển không bị đưa ra Internet, trừ khoảng thời gian ngắn bạn tự bật *đường hầm bảng điều khiển*.

Giới hạn cần hiểu:
- Đây là **mật khẩu dùng chung**, không phải tài khoản cá nhân. Đổi mật khẩu bằng cách chạy lại Bước 2 với mật khẩu mới.
- Ai có địa chỉ ngrok và mật khẩu thì dùng được, và tiêu hao hạn mức/tiền khóa API của bạn. Với khóa API trả phí (Claude, GPT), hãy đặt hạn mức chi tiêu ở phía nhà cung cấp.
- Dữ liệu câu hỏi, ảnh và nội dung tệp đi qua ngrok (HTTPS) tới nhà cung cấp AI bạn cấu hình. Đừng gửi thông tin nhạy cảm nếu chưa tin các bên đó.
- Khóa nhà cung cấp nằm trong cơ sở dữ liệu của OmniRoute, được sao lưu vào **Google Drive của bạn**. Giữ Drive riêng tư.
- Bộ đọc PDF là một thư viện bên thứ ba tải từ jsDelivr khi cần; nếu không muốn, đừng đính kèm PDF.

## Khắc phục lỗi thường gặp

| Hiện tượng | Nguyên nhân có thể xác định | Cách xử lý |
|---|---|---|
| "Dịch vụ AI chưa bật hoặc đã ngắt" | Backend không phản hồi (Colab chưa chạy/đã ngắt, hoặc `BACKEND_URL` sai) | Chạy lại Bước 1-2; kiểm tra `docs/config.js` |
| "chưa được cấu hình địa chỉ dịch vụ" | `BACKEND_URL` đang trống | Làm Bước 4 |
| "chưa được phép truy cập dịch vụ" | `ALLOWED_ORIGIN` không khớp tên miền website | Chạy lại Bước 2 với đúng `https://TENBAN.github.io` |
| "Nhập sai quá nhiều lần" | Bị khóa tạm 15 phút | Đợi hoặc chạy lại Bước 2 |
| "Phiên đã hết hạn" | Token hết hạn hoặc backend khởi động lại | Nhập lại mật khẩu |
| "OmniRoute chưa kết nối" | Backend chạy nhưng OmniRoute không phản hồi | Chạy ô *Chẩn đoán* và *Kiểm tra trạng thái* trong notebook |
| "Model này không tồn tại" | Model chưa có trong OmniRoute | Tìm lại bằng ô *Tìm model* hoặc chọn model khác |
| "Nhà cung cấp đã ngừng cung cấp model này" | Model đã bị đóng (ví dụ Gemini 2.5 với tài khoản mới) | Chọn model mới hơn |
| "Chưa có thông tin đăng nhập đang hoạt động" | Chưa thêm khóa, khóa sai, hoặc OmniRoute tạm ngưng kết nối sau lỗi | Thêm lại khóa bằng ô *Thêm nhà cung cấp*; đợi vài phút |
| "Hết hạn mức (quota)" / "Giới hạn tốc độ" | Nhà cung cấp từ chối | Dùng combo có dự phòng, hoặc đợi |
| Gửi ảnh báo lỗi | Model không hỗ trợ ảnh | Chọn model có khả năng nhìn ảnh (các dòng Claude, GPT-4o trở lên, Gemini...) |
| "Không tải được bộ đọc PDF" | Trình duyệt không truy cập được jsDelivr | Kiểm tra mạng/trình chặn quảng cáo rồi thử lại |
| "PDF có vẻ là ảnh quét" | PDF không chứa lớp chữ | Chụp từng trang và gửi dạng ảnh |
| Bảng điều khiển qua đường hầm Colab báo 404 | Lỗi của đường hầm Colab (chưa rõ nguyên nhân) | Dùng ô *Mở bảng điều khiển (tạm thời)* của notebook |
| ngrok báo `ERR_NGROK_108` / `105` | Đang chạy phiên ngrok khác / token sai | Tắt phiên cũ tại dashboard.ngrok.com/agents / sao chép lại token |

## Những gì chưa được kiểm thử trên dịch vụ thật

Mọi kiểm thử tự động chạy với **OmniRoute giả lập** (mô phỏng theo tài liệu), không phải dịch vụ thật. Đã kiểm chứng trên Colab thật trong quá trình triển khai: cài OmniRoute và Node, khởi động, tạo khóa cho backend, thêm nhà cung cấp Gemini bằng khóa API, và chat chạy được. **Chưa kiểm chứng:**

- Gửi ảnh tới các model thật (tùy từng model có hỗ trợ ảnh hay không) và việc OmniRoute chuyển tiếp ảnh dạng `image_url`.
- Hiển thị "suy nghĩ" của model suy luận thật (trường `reasoning_content` theo tài liệu OmniRoute).
- Đọc PDF bằng pdf.js (cần Internet tới jsDelivr; môi trường kiểm thử không có Internet nên chỉ kiểm tra đường báo lỗi). Đọc Word/Excel/PowerPoint đã kiểm thử với tệp mẫu tạo bằng thư viện, tệp từ Microsoft Office thật có thể khác biệt nhỏ.
- Tên nhà cung cấp (`openrouter`, `anthropic`, `openai`, `deepseek`...) và cấu trúc API tạo combo/nhà cung cấp của OmniRoute (lấy từ tài liệu); sai thì ô trong notebook báo mã lỗi HTTP và phản hồi của OmniRoute.
- Ô *Thử model* và *Tự tạo combo* mới chạy với OmniRoute giả lập; trên dịch vụ thật, thời gian thử mỗi model có thể lên tới 40 giây (đặt giới hạn chờ), và mỗi lần thử tốn một ít hạn mức của nhà cung cấp.
- Kiro, Antigravity và các nhà cung cấp đăng nhập OAuth qua đường hầm `localhost.run` (OAuth có thể chuyển hướng về `localhost` trên máy bạn).
- Hiển thị trên các trình duyệt/điện thoại thật (đã kiểm tra bằng Chromium giả lập desktop và điện thoại).

## Chạy kiểm thử

```bash
cd backend && npm test                                     # backend: xác thực, CORS, streaming, ảnh, lỗi, rò rỉ bí mật
node --test tests/frontend.test.mjs tests/officedocs.test.mjs   # markdown/XSS, lịch sử, tệp, Word/Excel/PowerPoint
python3 tools/make_fixtures.py                             # tạo lại tệp mẫu (cần python-docx, openpyxl, python-pptx, reportlab, pillow)
python3 tools/e2e.py                                       # trình duyệt Chromium: toàn bộ luồng người dùng (cần playwright)
python3 tools/test_colab.py                                # mô-đun Colab với omniroute/ngrok/ssh giả
python3 tools/build_notebook.py                            # dựng lại notebook sau khi sửa server.mjs hoặc tp_omniai.py
```

## Xác nhận không dùng Cloudflare

Mã nguồn do dự án này viết (website, backend, notebook, tài liệu) không gọi, không cài và không phụ thuộc bất kỳ dịch vụ Cloudflare nào. Các dịch vụ ngoài được dùng: ngrok (đường hầm chính), localhost.run (chỉ cho bảng điều khiển, tạm thời), Google Fonts, jsDelivr (chỉ cho PDF). Lưu ý: bản thân OmniRoute (phần mềm bên thứ ba) có tính năng Cloudflare tunnel riêng; dự án này không bật và không dùng tính năng đó.

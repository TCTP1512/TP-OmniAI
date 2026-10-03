# TP OmniAI

Website chat AI giao diện giống ChatGPT, chạy trên **GitHub Pages**; bộ điều phối model **OmniRoute** chạy trên **Google Colab** khi bạn chủ động bật. Chỉ có bạn và bạn bè có mật khẩu mới dùng được. **Không dùng Cloudflare ở bất kỳ phần nào.**

```
Bạn bè ──▶ Website (GitHub Pages) ──HTTPS──▶ ngrok ──▶ [Colab] Backend bảo mật ──▶ OmniRoute ──▶ Claude / Gemini / GPT...
                                                          (kiểm tra mật khẩu,        (chỉ nội bộ,
                                                           giới hạn, giấu khóa)       không công khai)
```

- **Website** chỉ là giao diện tĩnh, không chứa mật khẩu hay khóa API nào.
- **Backend** (tệp `backend/server.mjs`) kiểm tra mật khẩu, cấp phiên có hạn dùng, giới hạn tốc độ, rồi mới chuyển câu hỏi tới OmniRoute.
- **OmniRoute** và bảng điều khiển của nó chỉ chạy bên trong Colab, **không** bị đưa ra Internet. Chỉ backend được ngrok công khai.

---

## Chi phí và giới hạn (nói thẳng)

| Thành phần | Chi phí | Giới hạn bạn cần biết |
|---|---|---|
| GitHub Pages | Miễn phí | Tài khoản miễn phí cần để repository ở chế độ **Public** |
| Google Colab | Miễn phí | Phiên có thể bị ngắt bất cứ lúc nào, không chạy 24/7. **Google cấm chạy "dịch vụ web không liên quan đến tính toán tương tác" trên Colab** và có thể ngắt phiên miễn phí không báo trước. Chỉ phù hợp quy mô nhỏ (bạn bè) |
| ngrok (gói Free) | Miễn phí | Theo tài liệu ngrok: 1 GB băng thông/tháng, 20.000 request/tháng, 1 tên miền cố định do ngrok cấp (bạn không tự chọn tên). Chat văn bản dùng rất ít, đủ cho nhóm nhỏ |
| Claude và các model khác | **Tùy bạn** | OmniRoute chỉ *điều phối*. Bạn phải tự kết nối tài khoản/khóa của Claude, Gemini... Model "miễn phí" nào có hay không, hạn mức bao nhiêu là do nhà cung cấp quyết định |
| Google Fonts | Miễn phí | Website tải phông Be Vietnam Pro từ Google Fonts; nếu không tải được sẽ dùng phông hệ thống |

---

## Cấu trúc thư mục

```
tp-omniai/
├── docs/                  Website (đưa lên GitHub Pages). Sửa địa chỉ dịch vụ ở docs/config.js
│   ├── index.html, favicon.svg, config.js
│   ├── css/styles.css
│   └── js/                app.js (điều phối), api.js (gọi backend), storage.js (lịch sử),
│                          markdown.js, files.js (đính kèm), export.js (tải hội thoại), i18n.js (Việt/Anh)
├── backend/               Backend bảo mật (Node.js, không cần cài thư viện)
│   ├── server.mjs, package.json, .env.example
├── colab/
│   ├── TP_OmniAI_Colab.ipynb   Notebook bật mọi thứ trên Colab
│   └── tp_omniai.py            Mã hỗ trợ (đã nhúng sẵn trong notebook)
├── tests/                 Kiểm thử tự động (backend, giao diện)
└── tools/                 build_notebook.py, e2e.py (kiểm thử trình duyệt), test_colab.py
```

---

## Hướng dẫn triển khai (làm một lần)

### Bước 1. Đưa website lên GitHub Pages

1. Vào [github.com](https://github.com), đăng nhập, bấm **New repository**. Đặt tên (ví dụ `tp-omniai`), chọn **Public**, bấm **Create repository**.
2. Trong repository mới, bấm **uploading an existing file**. Giải nén ZIP này trên máy, kéo thả **cả thư mục `docs`** vào trang, bấm **Commit changes**.
   (Nên tải lên cả các thư mục còn lại để lưu mã nguồn. Hoàn toàn không có bí mật trong đó.)
3. Vào **Settings → Pages**. Ở *Build and deployment*, chọn **Deploy from a branch**, nhánh **main**, thư mục **/docs**, bấm **Save**.
4. Đợi 1-2 phút, tải lại trang Settings → Pages để thấy địa chỉ website, dạng `https://TENBAN.github.io/tp-omniai/`.
   Ghi lại **tên miền gốc**: `https://TENBAN.github.io` (không có `/tp-omniai`). Bạn sẽ cần nó ở Bước 3.

Website dùng đường dẫn tương đối nên chạy được dưới `/tp-omniai/` mà không cần chỉnh gì.

### Bước 2. Tạo tài khoản ngrok (miễn phí)

1. Đăng ký tại [dashboard.ngrok.com/signup](https://dashboard.ngrok.com/signup).
2. Vào [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) và bấm sao chép **Authtoken**. Bạn sẽ dán nó vào Colab ở bước sau. Đừng gửi cho ai.

### Bước 3. Chạy trên Google Colab

1. Mở [colab.research.google.com](https://colab.research.google.com), chọn **Upload**, tải lên `colab/TP_OmniAI_Colab.ipynb`.
2. Bấm ▶ ở ô **Bước 1 - Cài đặt**, đợi xong (vài phút).
3. Ở ô **Bước 2 - Khởi động**, điền `ALLOWED_ORIGIN` = tên miền gốc ở Bước 1 (ví dụ `https://tenban.github.io`), rồi bấm ▶.
   - Google sẽ hỏi quyền truy cập Drive (để lưu cấu hình OmniRoute), hãy đồng ý.
   - Notebook hỏi 3 thông tin bí mật (gõ vào sẽ không hiện lại):
     1. **Mật khẩu cho bạn bè**: bạn tự đặt (≥ 8 ký tự), gửi cho bạn bè để họ vào website.
     2. **Mật khẩu bảng điều khiển OmniRoute**: bạn tự đặt, chỉ bạn dùng.
     3. **ngrok authtoken**: dán token ở Bước 2.
   - *Mẹo:* lưu 3 giá trị này trong **Colab Secrets** (biểu tượng chìa khóa bên trái) với tên `SITE_PASSWORD`, `OMNIROUTE_ADMIN_PASSWORD`, `NGROK_AUTHTOKEN` thì lần sau khỏi gõ lại.
4. Khi xong, notebook in ra `ĐỊA CHỈ DỊCH VỤ: https://....ngrok-free....`. **Sao chép địa chỉ này.**

### Bước 4. Nối website với dịch vụ

1. Trên GitHub, mở `docs/config.js`, bấm biểu tượng bút chì (Edit).
2. Điền địa chỉ ngrok vào, ví dụ `BACKEND_URL: "https://ten-cua-ban.ngrok-free.dev"` rồi **Commit changes**.
3. Đợi ~1 phút, mở website. Bạn sẽ thấy màn hình mật khẩu. Nhập mật khẩu ở Bước 3 để vào.

Gói ngrok miễn phí gán cho bạn **một địa chỉ cố định**, nên bước này chỉ làm một lần. Nếu về sau notebook in ra địa chỉ khác, hãy cập nhật lại `config.js`.

### Bước 5. Thêm Claude và model dự phòng vào OmniRoute (lần đầu)

1. Trong Colab, bấm ▶ ô **Mở bảng điều khiển OmniRoute**, đăng nhập bằng *mật khẩu bảng điều khiển*.
2. Thêm nhà cung cấp **Claude** (cần tài khoản/khóa Claude của bạn), cùng Gemini, GPT, DeepSeek hoặc model miễn phí khác nếu bạn muốn dự phòng. Tên menu có thể khác tùy phiên bản, xem tài liệu của OmniRoute nếu cần.
3. Tạo một **Combo** ưu tiên Claude, tiếp theo là các model dự phòng. **Fallback (tự chuyển model khi lỗi/hết hạn mức) do chính OmniRoute xử lý** theo cấu hình combo này. Backend của TP OmniAI không tự đổi model.
4. Tải lại website: combo và model xuất hiện trong ô chọn model. Chọn combo hoặc **Tự động (auto)** để dùng chế độ dự phòng; chọn một model cụ thể thì sẽ **không** bị âm thầm đổi sang model khác.

Sau đó chạy ▶ **Sao lưu cấu hình** một lần cho chắc (notebook cũng tự sao lưu mỗi 10 phút).

---

## Dùng hằng ngày

1. Mở notebook trong Colab, chạy ▶ **Bước 1** rồi ▶ **Bước 2**. Nhập lại 3 bí mật nếu chưa lưu trong Colab Secrets.
2. Gửi cho bạn bè địa chỉ website và mật khẩu.
3. Xong việc, chạy ▶ **Tắt dịch vụ**.

Nếu Colab bị ngắt, website vẫn mở được nhưng sẽ báo "Mất kết nối"; chạy lại Bước 1 và 2 là dùng tiếp. Phiên đăng nhập của bạn bè sẽ hết hạn sau mỗi lần khởi động lại, họ chỉ cần nhập lại mật khẩu. Lịch sử trò chuyện **không** mất.

## Cách website hoạt động

- **Lịch sử hội thoại** lưu bằng `localStorage` trong *trình duyệt đang dùng*: không tự đồng bộ giữa điện thoại và máy tính, và mất nếu xóa dữ liệu trình duyệt. Chỉ cuộc trò chuyện hiện tại được gửi đi, không gửi toàn bộ lịch sử.
- **Nút trạng thái** (biểu tượng nhịp tim) kiểm tra 4 tầng riêng biệt: giao diện, backend, OmniRoute, và (khi bấm "Thử model đang chọn") model đang chọn.
- **Dòng "Model: ..." dưới mỗi câu trả lời** là model do OmniRoute báo về. Nếu OmniRoute không báo, website ghi "chưa xác định" thay vì đoán.
- **Đính kèm tệp** chỉ hỗ trợ tệp văn bản/mã nguồn UTF-8 (`.txt .md .csv .json .py .js .html ...`), tối đa 3 tệp, mỗi tệp ≤ 200 KB, tổng ≤ 400 KB. **PDF, Word, ảnh chưa được hỗ trợ** và sẽ bị từ chối với thông báo rõ. Nội dung tệp được gửi tới dịch vụ AI cùng câu hỏi (website có ghi chú này).
- **Tải hội thoại** xuất ra tệp Markdown (`.md`), đúng thứ tự tin nhắn.

## Bảo mật

Đã làm:
- Mật khẩu chỉ được kiểm tra ở backend (so sánh an toàn thời gian), không bao giờ lưu trong trình duyệt. Trình duyệt chỉ giữ token có hạn 12 giờ, ký bằng khóa chỉ backend biết.
- Chưa đăng nhập thì mọi API (chat, danh sách model, trạng thái) đều bị chặn.
- Giới hạn đăng nhập sai (5 lần/15 phút mỗi địa chỉ IP, kèm giới hạn chung), giới hạn 20 tin nhắn/phút mỗi phiên, giới hạn kích thước yêu cầu, kiểm tra tên model và vai trò tin nhắn; backend chỉ chuyển tiếp các trường đã biết và không cho nhập URL tùy ý.
- CORS chỉ cho phép đúng tên miền GitHub Pages của bạn (`ALLOWED_ORIGIN`).
- Không ghi mật khẩu/khóa vào log; lỗi trả về không kèm stack trace; chuỗi giống khóa API trong thông báo lỗi của nhà cung cấp được che.
- OmniRoute và bảng điều khiển của nó không bị đưa ra Internet.

Giới hạn cần hiểu:
- Đây là **mật khẩu dùng chung**, không phải tài khoản cá nhân: ai biết mật khẩu đều dùng được, bạn không phân biệt được ai với ai. Đổi mật khẩu bằng cách chạy lại Bước 2 với mật khẩu mới.
- Ai có địa chỉ ngrok và mật khẩu thì dùng được dịch vụ, và sẽ tiêu hao hạn mức Claude/ngrok của bạn.
- Dữ liệu câu hỏi đi qua ngrok (kết nối HTTPS) và đến nhà cung cấp AI mà bạn cấu hình. Đừng gửi thông tin nhạy cảm nếu bạn chưa tin các bên đó.
- Thông tin đăng nhập nhà cung cấp (Claude...) nằm trong cơ sở dữ liệu của OmniRoute, được sao lưu vào **Google Drive của bạn**. Hãy giữ Drive riêng tư.

## Khắc phục lỗi thường gặp

| Hiện tượng | Nguyên nhân có thể xác định | Cách xử lý |
|---|---|---|
| Website báo "Dịch vụ AI chưa bật hoặc đã ngắt" | Backend không phản hồi (Colab chưa chạy/đã ngắt, hoặc `BACKEND_URL` sai) | Chạy lại Bước 1-2; kiểm tra `docs/config.js` khớp địa chỉ notebook in ra |
| Website báo "chưa được cấu hình địa chỉ dịch vụ" | `BACKEND_URL` trong `config.js` đang trống | Làm Bước 4 |
| Báo "chưa được phép truy cập dịch vụ" | `ALLOWED_ORIGIN` ở Bước 2 không khớp tên miền website | Chạy lại Bước 2 với đúng `https://TENBAN.github.io` |
| "Nhập sai quá nhiều lần" | Bị khóa tạm 15 phút | Đợi hoặc chạy lại Bước 2 (khởi động lại sẽ xóa bộ đếm) |
| "Phiên đã hết hạn" | Token hết hạn hoặc backend đã khởi động lại | Nhập lại mật khẩu |
| Trạng thái "OmniRoute chưa kết nối" | Backend chạy nhưng OmniRoute không phản hồi | Chạy ô **Kiểm tra trạng thái** để xem log; chạy lại Bước 2 |
| "Model không tồn tại" | Model chưa được cấu hình trong OmniRoute | Thêm model trong bảng điều khiển hoặc chọn model khác |
| "Hết hạn mức (quota)" / "Giới hạn tốc độ" | Nhà cung cấp từ chối | Chọn combo/`auto` có dự phòng, hoặc đợi |
| ngrok báo `ERR_NGROK_108` | Tài khoản đang chạy một phiên ngrok khác | Chạy ô **Tắt dịch vụ** ở notebook cũ, hoặc tắt phiên tại dashboard.ngrok.com/agents |
| ngrok báo `ERR_NGROK_105` | Authtoken sai | Sao chép lại token ở Bước 2 |

Nếu Colab báo lỗi khi cài đặt, bản log 30 dòng cuối sẽ được in ra ngay dưới ô.

## Những gì chưa được kiểm thử trên dịch vụ thật

Mọi kiểm thử tự động đều chạy với **OmniRoute giả lập** (mô phỏng theo tài liệu), **không** phải dịch vụ thật. Các điểm sau chỉ kiểm chứng được khi bạn chạy lần đầu trên Colab:

- Cài OmniRoute 3.8.52 và Node.js trên Colab (mã cài đặt và lệnh khởi động `omniroute`, tên biến môi trường `DATA_DIR`/`INITIAL_PASSWORD`/`JWT_SECRET`/`API_KEY_SECRET` lấy từ tài liệu/wiki của OmniRoute, chưa chạy thật).
- Mở bảng điều khiển OmniRoute qua Colab, thêm Claude, tạo combo, và việc fallback trong OmniRoute.
- Việc OmniRoute báo model/nhà cung cấp thực tế qua header `X-OmniRoute-*` khi streaming (website hiển thị "chưa xác định" nếu không có).
- Việc `auto` có sẵn trong danh sách model của bạn; nếu không, website báo lỗi "model không tồn tại" rõ ràng.
- Tải ngrok và tạo đường hầm trên Colab với tài khoản ngrok thật.
- Hiển thị trên các trình duyệt/điện thoại thật (đã kiểm tra bằng Chromium giả lập desktop và điện thoại).

## Chạy kiểm thử (dành cho người muốn kiểm tra lại)

```bash
cd backend && npm test                  # backend: xác thực, CORS, streaming, lỗi, rò rỉ bí mật
node --test tests/frontend.test.mjs     # markdown/XSS, lịch sử, tệp, xuất hội thoại, SSE
python3 tools/e2e.py                    # trình duyệt Chromium: toàn bộ luồng người dùng (cần playwright)
python3 tools/test_colab.py             # mô-đun Colab với omniroute/ngrok giả
python3 tools/build_notebook.py         # dựng lại notebook sau khi sửa server.mjs hoặc tp_omniai.py
```

## Xác nhận không dùng Cloudflare

Mã nguồn do dự án này viết (website, backend, notebook, tài liệu) không gọi, không cài và không phụ thuộc bất kỳ dịch vụ Cloudflare nào; đường hầm duy nhất là ngrok. Lưu ý: bản thân OmniRoute (phần mềm bên thứ ba) có tính năng Cloudflare tunnel riêng; dự án này không bật và không dùng tính năng đó.

"""Kiểm thử đầu-cuối bằng Chromium: backend thật + OmniRoute giả lập + giao diện thật."""
import base64, json, os, subprocess, sys, threading, time, http.server, socketserver, functools, pathlib, signal, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
SHOTS = pathlib.Path(os.environ.get("SHOTS", "/tmp/shots")); SHOTS.mkdir(exist_ok=True, parents=True)
WEB_PORT, BACK_PORT, MOCK_PORT = 18090, 18091, 18092
PASSWORD = "mat-khau-thu-123"
WEB = f"http://127.0.0.1:{WEB_PORT}"
BACK = f"http://127.0.0.1:{BACK_PORT}"

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=str(DOCS), **k)
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.split("?")[0] == "/config.js":
            body = f'window.TP_CONFIG={{BACKEND_URL:"{BACK}"}};'.encode()
            self.send_response(200); self.send_header("Content-Type","application/javascript"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body); return
        super().do_GET()

class TS(socketserver.ThreadingTCPServer): allow_reuse_address = True; daemon_threads = True
web = TS(("127.0.0.1", WEB_PORT), H); threading.Thread(target=web.serve_forever, daemon=True).start()

env = {**os.environ, "MOCK_PORT": str(MOCK_PORT), "MOCK_EXTRA_MODELS": "slow-stream,cut-stream,code-reply"}
mock = subprocess.Popen(["node", str(ROOT/"tests/backend/mock-omniroute.mjs")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
def start_backend():
    e = {**os.environ, "PORT": str(BACK_PORT), "SITE_PASSWORD": PASSWORD, "ALLOWED_ORIGIN": WEB, "OMNIROUTE_URL": f"http://127.0.0.1:{MOCK_PORT}", "SESSION_SECRET": "x"*40}
    return subprocess.Popen(["node", str(ROOT/"backend/server.mjs")], env=e, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
backend = start_backend()
time.sleep(1.2)

results = []
def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))

FIX = ROOT / "tests/fixtures"
def mock_state():
    return json.loads(urllib.request.urlopen(f"http://127.0.0.1:{MOCK_PORT}/__state", timeout=5).read())

def pick_model(page, model_id):
    page.click("#modelBtn"); page.wait_for_selector("#dlgModels[open]")
    page.fill("#modelSearch", model_id)
    page.click(f'.model-pick-btn[data-model="{model_id}"]')
    page.wait_for_selector("#dlgModels:not([open])", state="attached")

def drop_files(page, names, event_target="#thread"):
    payload = []
    for n in names:
        mime = "image/png" if n.endswith(".png") else "image/jpeg" if n.endswith(".jpg") else "application/octet-stream"
        payload.append({"name": n if isinstance(n, str) else n[0], "type": mime, "b64": base64.b64encode((FIX / n).read_bytes()).decode()})
    page.evaluate("""(payload) => { const dt = new DataTransfer();
        for (const f of payload) { const bin = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0)); dt.items.add(new File([bin], f.name, {type: f.type})); }
        const target = document.querySelector('%s');
        for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: dt})); }""" % event_target, payload)

def login(page):
    page.fill("#pw", PASSWORD); page.click("#loginBtn")
    page.wait_for_selector("#app:not([hidden])")

def ask(page, text, wait_done=True):
    page.fill("#input", text); page.click("#sendBtn")
    if wait_done:
        page.wait_for_function("() => !document.querySelector('.msg.assistant.live')", timeout=15000)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, locale="vi-VN", accept_downloads=True)
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=WEB)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "fonts.g" not in m.text and "cdn.jsdelivr.net" not in m.text and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)

        page.goto(WEB)
        page.wait_for_selector("#loginForm:not([hidden])")
        check("màn hình mật khẩu hiện ra trước khi dùng", page.is_visible("#gate") and page.is_hidden("#app"))
        page.screenshot(path=str(SHOTS/"01-login.png"))

        page.fill("#pw", "sai-mat-khau"); page.click("#loginBtn")
        page.wait_for_selector("#gateErr:not([hidden])")
        check("mật khẩu sai → báo lỗi, vẫn ở màn hình mật khẩu", "không đúng" in page.inner_text("#gateErr") and page.is_hidden("#app"))
        tok = page.evaluate("() => localStorage.getItem('tpomniai.v1.auth')")
        check("không lưu token/mật khẩu khi sai", tok is None)

        login(page)
        check("mật khẩu đúng → vào ứng dụng", page.is_visible("#app"))
        stored = page.evaluate("() => JSON.stringify(localStorage)")
        check("mật khẩu không nằm trong localStorage", PASSWORD not in stored)
        page.wait_for_function("() => document.querySelector('#statusPill').dataset.state === 'ok'", timeout=8000)
        check("trạng thái kết nối chuyển sang 'Sẵn sàng' sau khi kiểm tra thật", True)
        check("mặc định là chế độ Tự động (OmniRoute tự chọn và dự phòng)", "Tự động" in page.inner_text("#modelBtnLabel"), page.inner_text("#modelBtnLabel"))
        page.click("#modelBtn"); page.wait_for_selector("#dlgModels[open]")
        page.wait_for_function("() => document.querySelectorAll('#modelList .model-item').length >= 5", timeout=8000)
        page.screenshot(path=str(SHOTS/"02b-picker.png"))
        all_ids = page.eval_on_selector_all("#modelList [data-model]", "els => els.map(e => e.dataset.model)")
        check("bộ chọn model lấy danh sách từ API, lọc ID không hợp lệ", "cc/claude-sonnet-4-6" in all_ids and "bad id with spaces" not in all_ids, str(all_ids))
        page.fill("#modelSearch", "claude")
        found = page.eval_on_selector_all("#modelList [data-model]", "els => els.map(e => e.dataset.model)")
        check("tìm model theo từ khóa", found == ["cc/claude-sonnet-4-6"], str(found))
        page.fill("#modelSearch", ""); page.click('.filter[data-filter="gemini"]')
        found = page.eval_on_selector_all("#modelList [data-model]", "els => els.map(e => e.dataset.model)")
        check("lọc theo họ model (Gemini)", found == ["gemini/gemini-2.5-pro"], str(found))
        page.click('.filter[data-filter="all"]')
        page.click('[data-fav="oc/free-model"]')
        check("đánh dấu yêu thích hiện ở nhóm đầu", page.locator("#modelList .model-group").first.inner_text().startswith("★") or "Yêu thích" in page.locator("#modelList .model-group").first.inner_text())
        page.click("#modelsClose")
        page.screenshot(path=str(SHOTS/"02-empty.png"))

        ask(page, "Xin chào, bạn là ai?")
        txt = page.inner_text(".msg.assistant .content")
        check("nhận câu trả lời streaming", "trả lời thử" in txt, txt)
        check("markdown được hiển thị (in đậm)", page.locator(".msg.assistant .content strong").count() == 1)
        badge = page.inner_text(".msg.assistant .model-badge")
        check("hiển thị model thực tế do router báo", "claude-sonnet-4-6" in badge and "claude" in badge, badge)
        check("tiêu đề tự đặt từ câu hỏi đầu", page.inner_text(".conv.active .conv-title").startswith("Xin chào"))
        page.screenshot(path=str(SHOTS/"03-chat.png"))

        page.click(".msg.assistant [data-action=copy]")
        clip = page.evaluate("() => navigator.clipboard.readText()")
        check("sao chép câu trả lời vào clipboard", "trả lời thử" in clip, clip)

        # tải hội thoại
        with page.expect_download() as dl:
            page.click("#downloadBtn")
        path = dl.value.path(); content = pathlib.Path(path).read_text(encoding="utf-8")
        check("tải hội thoại: tên tệp .md và thứ tự đúng", dl.value.suggested_filename.endswith(".md") and content.index("Xin chào, bạn là ai?") < content.index("trả lời thử"), dl.value.suggested_filename)

        # lịch sử sau khi tải lại
        page.reload(); page.wait_for_selector("#app:not([hidden])")
        check("tải lại trang: vẫn đăng nhập và còn lịch sử", page.locator(".conv").count() == 1 and "trả lời thử" in page.inner_text("#thread"))

        # cuộc trò chuyện thứ hai + tìm kiếm + đổi tên + xóa
        page.click("#newChat")
        check("trò chuyện mới: màn hình chào", page.is_visible(".welcome"))
        ask(page, "Câu hỏi về món phở")
        check("có 2 cuộc trò chuyện", page.locator(".conv").count() == 2)
        page.fill("#search", "pho")
        check("tìm kiếm không dấu ('pho' khớp 'phở')", page.locator(".conv").count() == 1 and "phở" in page.inner_text(".conv"))
        page.fill("#search", "khong-ton-tai-xyz")
        check("tìm kiếm không có kết quả → thông báo", page.locator(".conv").count() == 0 and page.is_visible("#convEmpty"))
        page.fill("#search", "")
        page.hover(".conv.active"); page.click(".conv.active [data-action=rename]")
        page.fill("#renameInput", "Món ăn Việt"); page.click("#renameForm button[type=submit]")
        check("đổi tên cuộc trò chuyện", "Món ăn Việt" in page.inner_text("#convList"))
        page.reload(); page.wait_for_selector("#app:not([hidden])")
        check("tên mới được lưu sau khi tải lại", "Món ăn Việt" in page.inner_text("#convList"))
        page.hover(".conv.active"); page.click(".conv.active [data-action=delete]")
        check("hộp thoại xác nhận xóa hiện ra", page.is_visible("#dlgDelete"))
        page.click("#deleteForm button[type=submit]")
        check("xóa cuộc trò chuyện", page.locator(".conv").count() == 1 and "Món ăn Việt" not in page.inner_text("#convList"))
        page.click(".conv .conv-main")
        check("mở lại cuộc trò chuyện đã lưu", "Xin chào, bạn là ai?" in page.inner_text("#thread"))

        # đính kèm tệp
        tmp = pathlib.Path("/tmp/e2e-files"); tmp.mkdir(exist_ok=True)
        (tmp/"ghi-chu.txt").write_text("Nội dung tệp thử: số bí mật là 42.", encoding="utf-8")
        (tmp/"tai-lieu.pdf").write_bytes(b"%PDF-1.4 fake")
        (tmp/"nhi-phan.txt").write_bytes(b"ab\x00cd")
        (tmp/"lon.txt").write_text("a" * (201*1024), encoding="utf-8")
        page.click("#newChat")
        page.set_input_files("#fileInput", str(tmp/"tai-lieu.pdf"))
        page.wait_for_selector(".toast.error")
        check("PDF: khi không tải được bộ đọc (môi trường thử không có Internet) thì báo rõ, không gửi nội dung rỗng", "bộ đọc PDF" in page.inner_text(".toast.error") and page.locator(".chip").count() == 0)
        page.set_input_files("#fileInput", str(tmp/"nhi-phan.txt")); page.wait_for_timeout(300)
        page.set_input_files("#fileInput", str(tmp/"lon.txt")); page.wait_for_timeout(300)
        check("tệp nhị phân / quá lớn không được đính kèm", page.locator(".chip").count() == 0)
        page.set_input_files("#fileInput", str(tmp/"ghi-chu.txt"))
        page.wait_for_selector(".chip")
        check("tệp văn bản hợp lệ được đính kèm + có thông báo gửi tệp", page.is_visible("#attachNote"))
        sent = {}
        def on_req(r):
            if r.url.endswith("/api/chat"): sent["body"] = r.post_data
        page.on("request", on_req)
        ask(page, "Tóm tắt tệp")
        check("nội dung tệp được đưa vào yêu cầu gửi đi", "số bí mật là 42" in sent.get("body", ""))
        check("tên tệp hiển thị trong tin nhắn", "ghi-chu.txt" in page.inner_text(".msg.user"))
        page.remove_listener("request", on_req)

        # dừng giữa chừng
        pick_model(page, "slow-stream")
        page.fill("#input", "đếm"); page.click("#sendBtn")
        page.wait_for_function("() => document.querySelector('.msg.assistant.live .content')?.textContent.includes('hai')", timeout=8000)
        check("khi đang trả lời, nút Gửi thành nút Dừng", page.get_attribute("#sendBtn", "title") == "Dừng")
        page.click("#sendBtn")
        page.wait_for_function("() => !document.querySelector('.msg.assistant.live')", timeout=5000)
        check("dừng giữa chừng: giữ phần đã nhận + ghi chú", "Một" in page.inner_text(".msg.assistant:last-child .content") and "dừng" in page.inner_text(".msg.assistant:last-child .notices"))

        # luồng bị ngắt
        pick_model(page, "cut-stream")
        ask(page, "thử ngắt")
        last = page.locator(".msg.assistant").last
        check("luồng bị ngắt giữa chừng: có cảnh báo chưa đầy đủ", "ngắt" in last.locator(".notices").inner_text() and "Xin" in last.locator(".content").inner_text())

        # ===== Ảnh, tài liệu, tạo lại, mã, hướng dẫn hệ thống, sao lưu =====
        page.click("#newChat")
        pick_model(page, "cc/claude-sonnet-4-6")
        drop_files(page, ["anh-lon.png"])
        page.wait_for_selector("#chips .chip.has-thumb", timeout=8000)
        check("kéo thả ảnh vào khung chat → hiện ảnh thu nhỏ trong khay đính kèm", page.locator("#chips .chip.has-thumb").count() == 1 and page.is_hidden("#dropOverlay"))
        sent2 = {}
        page.on("request", lambda r: sent2.__setitem__("body", r.post_data) if r.url.endswith("/api/chat") else None)
        page.fill("#input", "Ảnh gì đây?"); page.click("#sendBtn")
        page.wait_for_function("() => !document.querySelector('.msg.assistant.live')", timeout=15000)
        body = json.loads(sent2["body"]); parts = body["messages"][-1]["content"]
        img_part = [p for p in parts if p["type"] == "image_url"]
        check("ảnh được gửi dạng image_url (JPEG đã nén, dưới 1,2 MB)", len(img_part) == 1 and img_part[0]["image_url"]["url"].startswith("data:image/jpeg;base64,") and len(img_part[0]["image_url"]["url"]) < 1_200_000)
        check("router nhận đúng 1 ảnh và AI trả lời về ảnh", mock_state()["lastImages"] == 1 and "Tôi thấy 1 ảnh" in page.inner_text(".msg.assistant .content"))
        check("hiển thị phần suy nghĩ của model (reasoning) trong mục thu gọn", page.locator(".msg.assistant details.think").count() == 1 and "Đang xem ảnh" in page.locator(".msg.assistant details.think").text_content())
        check("tin nhắn người dùng có ảnh thu nhỏ", page.locator(".msg.user .img-tags img").count() == 1)
        page.click(".msg.user .img-tags img"); page.wait_for_selector("#dlgImage[open]")
        check("bấm ảnh để xem lớn", page.eval_on_selector("#lightboxImg", "e => e.naturalWidth") > 100)
        page.click("#lightboxClose")
        page.screenshot(path=str(SHOTS/"10-image-chat.png"))

        # Tạo lại câu trả lời
        n_before = mock_state()["requests"]; n_asst = page.locator(".msg.assistant").count()
        page.click(".msg.assistant [data-action=regen]")
        page.wait_for_function("() => !document.querySelector('.msg.assistant.live')", timeout=15000)
        check("tạo lại câu trả lời: gửi lại 1 yêu cầu, số câu trả lời không đổi", mock_state()["requests"] == n_before + 1 and page.locator(".msg.assistant").count() == n_asst)

        # Tải lại trang: ảnh gốc không còn trong bộ nhớ, ảnh thu nhỏ vẫn hiển thị
        page.reload(); page.wait_for_selector("#app:not([hidden])")
        check("tải lại trang: ảnh thu nhỏ vẫn còn trong lịch sử", page.locator(".msg.user .img-tags img").count() == 1)
        sent3 = {}
        page.on("request", lambda r: sent3.__setitem__("body", r.post_data) if r.url.endswith("/api/chat") else None)
        ask(page, "Còn gì nữa không?")
        check("hỏi tiếp sau khi tải lại: không gửi lại ảnh gốc, chỉ ghi chú tên ảnh", mock_state()["lastImages"] == 0 and "[Earlier attached image: anh-lon.png]" in sent3["body"])

        # Dán ảnh từ clipboard
        page.evaluate("""async (b64) => { const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const dt = new DataTransfer();
            dt.items.add(new File([bin], 'pasted.jpg', {type: 'image/jpeg'}));
            document.querySelector('#input').dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); }""", base64.b64encode((FIX/"anh-nho.jpg").read_bytes()).decode())
        page.wait_for_selector("#chips .chip.has-thumb", timeout=8000)
        check("dán ảnh từ clipboard (Ctrl/Cmd+V) vào ô nhập", page.locator("#chips .chip.has-thumb").count() == 1)
        page.click("#chips [data-remove]")
        check("bỏ ảnh khỏi khay đính kèm", page.locator("#chips .chip").count() == 0)

        # Giới hạn số ảnh
        page.click("#newChat")
        for i in range(5):
            payload = [{"name": f"a{i}.png", "type": "image/png", "b64": base64.b64encode((FIX/"anh-nho.jpg").read_bytes()).decode()}]
            page.evaluate("""(payload) => { const dt = new DataTransfer(); for (const f of payload) { const bin = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0)); dt.items.add(new File([bin], f.name, {type: 'image/jpeg'})); }
                document.querySelector('#thread').dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt})); }""", payload)
            page.wait_for_timeout(250)
        page.wait_for_function("() => document.querySelectorAll('#chips .chip.has-thumb').length === 4", timeout=8000)
        check("tối đa 4 ảnh mỗi tin nhắn, ảnh thứ 5 bị từ chối kèm thông báo", page.locator("#chips .chip.has-thumb").count() == 4 and "Tối đa 4 ảnh" in page.inner_text("#toasts"))
        page.evaluate("() => document.querySelectorAll('#chips [data-remove]').forEach(b => b.click())")
        page.evaluate("() => { for (let i = 0; i < 4; i++) document.querySelector('#chips [data-remove]')?.click(); }")

        # Tài liệu Word / Excel / PowerPoint
        page.set_input_files("#fileInput", [str(FIX/"mau.docx"), str(FIX/"mau.xlsx"), str(FIX/"mau.pptx")])
        page.wait_for_function("() => document.querySelectorAll('#chips .chip:not(.warn)').length >= 3", timeout=8000)
        check("đính kèm Word, Excel, PowerPoint cùng lúc", page.locator("#chips .chip:not(.warn)").count() >= 3)
        sent4 = {}
        page.on("request", lambda r: sent4.__setitem__("body", r.post_data) if r.url.endswith("/api/chat") else None)
        page.fill("#input", "Tóm tắt các tệp"); page.click("#sendBtn")
        page.wait_for_function("() => !document.querySelector('.msg.assistant.live')", timeout=15000)
        b4 = json.loads(sent4["body"])["messages"][-1]["content"]
        b4 = b4 if isinstance(b4, str) else " ".join(p.get("text", "") for p in b4)
        check("nội dung Word/Excel/PowerPoint được trích và gửi cho AI", all(x in b4 for x in ["1.250 triệu đồng", "Tháng,Doanh thu,Ghi chú", "## Slide 2", "Tăng trưởng 12%"]))
        check("tên tệp tài liệu hiện trong tin nhắn", all(n in page.inner_text(".msg.user .file-tags") for n in ["mau.docx", "mau.xlsx", "mau.pptx"]))
        page.screenshot(path=str(SHOTS/"11-docs-chat.png"))

        # Khối mã + nút sao chép
        pick_model(page, "code-reply")
        ask(page, "Viết lệnh in hi")
        page.wait_for_selector(".code-block .code-copy")
        page.click(".code-block .code-copy")
        check("khối mã có nút sao chép", 'print("hi")' in page.evaluate("() => navigator.clipboard.readText()"))

        # Hướng dẫn hệ thống (cài đặt)
        page.click("#settingsBtn"); page.wait_for_selector("#dlgSettings[open]")
        page.fill("#systemPrompt", "Luôn trả lời ngắn gọn.")
        page.click("#settingsSave")
        pick_model(page, "cc/claude-sonnet-4-6")
        ask(page, "Chào bạn")
        first = mock_state()["last"]["messages"][0]
        check("hướng dẫn hệ thống được gửi kèm ở đầu hội thoại", first == {"role": "system", "content": "Luôn trả lời ngắn gọn."}, str(first))

        # Sao lưu / khôi phục lịch sử
        page.click("#settingsBtn"); page.wait_for_selector("#dlgSettings[open]")
        check("cài đặt hiển thị dung lượng lịch sử", "MB" in page.inner_text("#storageInfo"))
        with page.expect_download() as dl2:
            page.click("#exportBtn")
        data = json.loads(pathlib.Path(dl2.value.path()).read_text(encoding="utf-8"))
        n_conv = len(data["conversations"])
        check("sao lưu lịch sử ra tệp JSON", n_conv >= 3 and data["app"] == "TP OmniAI")
        page.click("#settingsCancel")
        while page.locator(".conv").count():
            page.evaluate("() => document.querySelector('.conv [data-action=delete]').click()")
            page.wait_for_selector("#dlgDelete[open]"); page.click("#deleteForm button[type=submit]"); page.wait_for_timeout(100)
        check("xóa hết lịch sử", page.locator(".conv").count() == 0)
        page.click("#settingsBtn"); page.wait_for_selector("#dlgSettings[open]")
        page.set_input_files("#importInput", str(pathlib.Path(dl2.value.path())))
        page.wait_for_function("() => document.querySelectorAll('.conv').length > 0", timeout=5000)
        check("khôi phục lịch sử từ tệp sao lưu", page.locator(".conv").count() == n_conv)
        page.click("#settingsCancel")
        page.set_input_files("#fileInput", []) if False else None
        # tệp sao lưu hỏng
        bad = pathlib.Path("/tmp/e2e-files/hong.json"); bad.write_text("{không phải json", encoding="utf-8")
        page.click("#settingsBtn"); page.wait_for_selector("#dlgSettings[open]")
        page.set_input_files("#importInput", str(bad)); page.wait_for_timeout(300)
        check("tệp sao lưu hỏng bị từ chối, dữ liệu hiện tại không đổi", "không hợp lệ" in page.inner_text("#toasts") and page.locator(".conv").count() == n_conv)
        page.click("#settingsCancel")

        # yêu thích được lưu qua lần tải lại
        page.reload(); page.wait_for_selector("#app:not([hidden])")
        page.click("#modelBtn"); page.wait_for_selector("#dlgModels[open]")
        page.wait_for_function("() => document.querySelectorAll('#modelList .model-item').length >= 5", timeout=8000)
        page.click('.filter[data-filter="ok"]')
        ok_ids = page.eval_on_selector_all("#modelList [data-model]", "els => els.map(e => e.dataset.model)")
        check("model đã trả lời thành công được đánh dấu ✓ và lưu qua lần tải lại; model bị ngắt/dừng thì không", "cc/claude-sonnet-4-6" in ok_ids and "cut-stream" not in ok_ids and "slow-stream" not in ok_ids, str(ok_ids))
        check("dấu ✓ hiện cạnh model", page.locator("#modelList .ok-mark").count() >= 1)
        page.click('.filter[data-filter="fav"]')
        check("model yêu thích được lưu qua lần tải lại trang", page.eval_on_selector_all("#modelList [data-model]", "els => els.map(e => e.dataset.model)") == ["oc/free-model"])
        page.click("#modelsClose")

        # giao diện sáng/tối, ngôn ngữ
        before = page.evaluate("() => document.documentElement.dataset.theme")
        page.click("#themeBtn")
        after = page.evaluate("() => document.documentElement.dataset.theme")
        check("chuyển giao diện sáng/tối", before != after)
        page.screenshot(path=str(SHOTS/f"04-{after}.png"))
        page.click("#langBtn")
        check("chuyển sang tiếng Anh", page.get_attribute("#input", "placeholder") == "Type your question…" and page.inner_text("#newChat") == "New chat")
        page.click("#langBtn")
        check("chuyển lại tiếng Việt", page.inner_text("#newChat") == "Cuộc trò chuyện mới")

        # hộp thoại trạng thái
        page.click("#statusBtn")
        page.wait_for_function("() => document.querySelectorAll('#checks li').length === 4 && !document.querySelector('#checks .dot[data-state=checking]')", timeout=8000)
        page.screenshot(path=str(SHOTS/"05-status.png"))
        page.click("#statusProbe")
        page.wait_for_function("() => document.querySelector('#checks li:last-child span:last-child')?.textContent.includes('Model báo về') || document.querySelector('#checks li:last-child span:last-child')?.textContent.includes('Phản hồi')", timeout=15000)
        check("kiểm tra 4 tầng: giao diện / backend / router / model", "Đã tải" in page.inner_text("#checks") and "OmniRoute" in page.inner_text("#checks"))
        page.click("#statusClose")

        # điện thoại (chạy khi router còn hoạt động)
        m = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="vi-VN")
        mp = m.new_page(); mp.goto(WEB)
        mp.wait_for_selector("#loginForm:not([hidden])")
        mp.screenshot(path=str(SHOTS/"07-mobile-login.png"))
        login(mp)
        check("điện thoại: thanh bên ẩn, có nút menu", mp.is_visible("#openSidebar") and not mp.evaluate("() => document.getElementById('app').classList.contains('nav-open')"))
        long_text = "Đoạn rất dài " + "supercalifragilisticexpialidocious_" * 12
        mp.fill("#input", long_text); mp.click("#sendBtn")
        mp.wait_for_function("() => !document.querySelector('.msg.assistant.live')", timeout=15000)
        overflow = mp.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1")
        check("điện thoại: nội dung dài không làm vỡ bố cục (không tràn ngang)", not overflow)
        mp.screenshot(path=str(SHOTS/"08-mobile-chat.png"))
        mp.click("#openSidebar"); mp.wait_for_timeout(350)
        check("điện thoại: mở thanh bên lịch sử", mp.evaluate("() => document.getElementById('app').classList.contains('nav-open')") and mp.is_visible(".conv"))
        mp.screenshot(path=str(SHOTS/"09-mobile-drawer.png"))
        mp.click(".conv .conv-main"); mp.wait_for_timeout(350)
        check("điện thoại: chọn hội thoại thì thanh bên tự đóng", not mp.evaluate("() => document.getElementById('app').classList.contains('nav-open')"))
        m.close()

        # dữ liệu lịch sử hỏng
        # Mô phỏng dữ liệu hỏng có sẵn trước khi trang tải (đặt sau lần lưu khi rời trang)
        ctx.add_init_script("if(!sessionStorage.getItem('__c')){sessionStorage.setItem('__c','1');localStorage.setItem('tpomniai.v1.conversations','{không phải json');}")
        page.reload(); page.wait_for_selector("#app:not([hidden])")
        page.wait_for_selector(".toast.error", timeout=4000)
        check("lịch sử bị hỏng: ứng dụng vẫn chạy và báo người dùng", page.is_visible(".welcome") and page.locator(".toast.error").count() >= 1)
        keys = page.evaluate("() => Object.keys(localStorage)")
        check("giữ lại bản sao dữ liệu hỏng", any(".corrupt." in k for k in keys))

        # token hết hạn / sai
        page.evaluate("() => { const a = JSON.parse(localStorage.getItem('tpomniai.v1.auth')); a.token = 'gia-mao.gia-mao'; localStorage.setItem('tpomniai.v1.auth', JSON.stringify(a)); }")
        page.reload()
        page.wait_for_selector("#gate:not([hidden])", timeout=8000)
        page.wait_for_function("() => !document.querySelector('#loginForm').hidden", timeout=8000)
        check("token không hợp lệ/hết hạn → quay về màn hình mật khẩu kèm thông báo phiên hết hạn", "hết hạn" in page.inner_text("#gateMsg"))
        login(page)

        # backend ngừng hoạt động
        backend.send_signal(signal.SIGTERM); backend.wait(timeout=5)
        page.reload(); page.wait_for_selector("#app:not([hidden])")
        page.wait_for_function("() => document.querySelector('#statusPill').dataset.state === 'offline'", timeout=8000)
        check("backend tắt: giao diện vẫn mở được, trạng thái báo mất kết nối", True)
        page.fill("#input", "khi mất kết nối"); page.click("#sendBtn")
        page.wait_for_selector(".toast.error")
        check("gửi khi mất kết nối: báo lỗi dễ hiểu, giữ lại câu hỏi trong ô nhập", "Không kết nối được" in page.inner_text(".toast.error") and page.input_value("#input") == "khi mất kết nối")
        page.screenshot(path=str(SHOTS/"06-offline.png"))

        # OmniRoute (mock) tắt trong khi backend chạy
        backend = start_backend(); time.sleep(1)
        mock.send_signal(signal.SIGTERM); mock.wait(timeout=5)
        page.click("#statusBtn")
        page.wait_for_function("() => document.querySelector('#statusPill').dataset.state === 'router_down'", timeout=10000)
        check("OmniRoute tắt nhưng backend chạy: báo đúng tầng 'OmniRoute chưa kết nối'", "không kết nối được OmniRoute" in page.inner_text("#checks"))
        page.click("#statusClose")

        browser.close()
        print("Lỗi console/JS:", errors if errors else "không có")
        check("không có lỗi JavaScript trong khi chạy", not errors, str(errors)[:300])
finally:
    for pr in (backend, mock):
        try: pr.kill()
        except Exception: pass
    web.shutdown()

failed = [n for n, ok in results if not ok]
print(f"\nTỔNG: {len(results)-len(failed)}/{len(results)} đạt")
sys.exit(1 if failed else 0)

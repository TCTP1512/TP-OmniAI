"""Kiểm thử đầu-cuối bằng Chromium: backend thật + OmniRoute giả lập + giao diện thật."""
import json, os, subprocess, sys, threading, time, http.server, socketserver, functools, pathlib, signal
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

env = {**os.environ, "MOCK_PORT": str(MOCK_PORT), "MOCK_EXTRA_MODELS": "slow-stream,cut-stream"}
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
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "fonts.g" not in m.text and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)

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
        page.wait_for_function("() => document.querySelectorAll('#modelSelect optgroup').length >= 2", timeout=8000)
        groups = page.eval_on_selector_all("#modelSelect optgroup", "els => els.map(e => e.label)")
        check("danh sách model lấy từ API, có nhóm Claude", "Claude" in groups and "Tự động" in groups, str(groups))
        check("mặc định ưu tiên Claude", page.input_value("#modelSelect") == "cc/claude-sonnet-4-6", page.input_value("#modelSelect"))
        opts = page.eval_on_selector_all("#modelSelect option", "els => els.map(e => e.value)")
        check("model ID không hợp lệ bị lọc", "bad id with spaces" not in opts)
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
        check("PDF bị từ chối rõ ràng, không gửi nội dung rỗng", "chưa được hỗ trợ" in page.inner_text(".toast.error") and page.locator(".chip").count() == 0)
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
        page.select_option("#modelSelect", "slow-stream")
        page.fill("#input", "đếm"); page.click("#sendBtn")
        page.wait_for_function("() => document.querySelector('.msg.assistant.live .content')?.textContent.includes('hai')", timeout=8000)
        check("khi đang trả lời, nút Gửi thành nút Dừng", page.get_attribute("#sendBtn", "title") == "Dừng")
        page.click("#sendBtn")
        page.wait_for_function("() => !document.querySelector('.msg.assistant.live')", timeout=5000)
        check("dừng giữa chừng: giữ phần đã nhận + ghi chú", "Một" in page.inner_text(".msg.assistant:last-child .content") and "dừng" in page.inner_text(".msg.assistant:last-child .notices"))

        # luồng bị ngắt
        page.select_option("#modelSelect", "cut-stream")
        ask(page, "thử ngắt")
        last = page.locator(".msg.assistant").last
        check("luồng bị ngắt giữa chừng: có cảnh báo chưa đầy đủ", "ngắt" in last.locator(".notices").inner_text() and "Xin" in last.locator(".content").inner_text())

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
        page.select_option("#modelSelect", "cc/claude-sonnet-4-6", force=True) if False else None
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

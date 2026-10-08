"""Kiểm thử tp_omniai.py với omniroute/ngrok giả lập (chạy tiến trình thật, cổng thật)."""
import io, json, os, pathlib, shutil, sqlite3, stat, sys, time, urllib.request, urllib.error, contextlib, subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
T = pathlib.Path("/tmp/tp-colab-test"); shutil.rmtree(T, ignore_errors=True)
(T/"fakebin").mkdir(parents=True); (T/"drive/MyDrive").mkdir(parents=True)
OMNI, BACK, NGAPI = 18120, 18121, 14040
SITE, ADMIN, NGTOK = "mat-khau-ban-be-1", "mat-khau-admin-2", "ngrok-token-bi-mat-123456"

# omniroute giả: chạy mock theo cổng PORT
(T/"fakebin/omniroute").write_text(f"#!/bin/sh\necho \"omniroute fake khoi dong, DATA_DIR=$DATA_DIR\"\nMOCK_EXTRA_MODELS=fail-500,no-creds MOCK_REQUIRE_KEY=1 MOCK_ADMIN=\"$INITIAL_PASSWORD\" MOCK_PORT=$PORT exec node {ROOT}/tests/backend/mock-omniroute.mjs\n")
# ngrok giả: phục vụ /api/tunnels; nếu token chứa 'bad' thì báo lỗi như ngrok thật
(T/"fakebin/ngrok").write_text(f'''#!/usr/bin/env python3
import os, sys, json, http.server
if sys.argv[1:2] == ["version"]: print("ngrok version fake"); sys.exit(0)
tok = os.environ.get("NGROK_AUTHTOKEN", "")
if "bad" in tok:
    print('{{"err":"authentication failed: ERR_NGROK_105 invalid authtoken"}}', flush=True); sys.exit(1)
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        b = json.dumps({{"tunnels":[{{"public_url":"http://127.0.0.1:{BACK}"}}]}}).encode()
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(b)
print("ngrok fake, token da nhan (" + str(len(tok)) + " ky tu)", flush=True)
http.server.HTTPServer(("127.0.0.1", {NGAPI}), H).serve_forever()
''')
(T/"fakebin/ssh").write_text("""#!/bin/sh
echo "** Welcome to localhost.run **"
echo "Create a free account at https://admin.localhost.run/ to get a stable domain"
echo "abc123xyz.lhr.life tunneled with tls termination, https://abc123xyz.lhr.life"
exec sleep 600
""")
for f in ("omniroute", "ngrok", "ssh"): os.chmod(T/"fakebin"/f, 0o755)

os.environ.update(TP_BASE=str(T/"base"), TP_DRIVE_DIR=str(T/"drive/MyDrive/TP_OmniAI"), TP_OMNI_PORT=str(OMNI), TP_BACK_PORT=str(BACK),
                  TP_NGROK_API=f"http://127.0.0.1:{NGAPI}", PATH=f"{T/'fakebin'}:" + os.environ["PATH"],
                  SITE_PASSWORD=SITE, OMNIROUTE_ADMIN_PASSWORD=ADMIN, NGROK_AUTHTOKEN=NGTOK)
(T/"base/backend").mkdir(parents=True); shutil.copy(ROOT/"backend/server.mjs", T/"base/backend/server.mjs")
sys.path.insert(0, str(ROOT/"colab")); import tp_omniai as tp

res = []
def check(name, ok, extra=""):
    res.append(ok); print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if (extra and not ok) else ""))

def call(path, method="GET", body=None, token=None, port=BACK, origin="https://tenban.github.io"):
    h = {"Origin": origin}
    if body is not None: h["Content-Type"] = "application/json"
    if token: h["Authorization"] = "Bearer " + token
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(r, timeout=10) as x: return x.status, json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")

# --- chuẩn hóa nguồn truy cập
for good, want in [("https://tenban.github.io", "https://tenban.github.io"), ("tenban.github.io", "https://tenban.github.io"), ("https://tenban.github.io/tp-omniai/", "https://tenban.github.io")]:
    check(f"normalize_origin({good!r})", tp.normalize_origin(good) == want)
for bad in ["", "http://tenban.github.io", "https://localhost"]:
    try: tp.normalize_origin(bad); check(f"normalize_origin từ chối {bad!r}", False)
    except tp.SetupError: check(f"normalize_origin từ chối {bad!r}", True)
check("node_ok: đúng dải phiên bản của OmniRoute", tp.node_ok((22,22,2)) and tp.node_ok((24,1,0)) and not tp.node_ok((22,22,1)) and not tp.node_ok((20,0,0)) and not tp.node_ok((23,5,0)) and not tp.node_ok((27,0,0)))

# --- khởi động toàn bộ
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        tp.start_all("https://tenban.github.io", persist=False)
    out = buf.getvalue()
    check("start_all chạy xong, in địa chỉ dịch vụ", "ĐỊA CHỈ DỊCH VỤ: http://127.0.0.1:%d" % BACK in out, out[-400:])
    check("đã kiểm tra backend qua địa chỉ công khai", "Đã kiểm tra: backend phản hồi" in out)
    for s in (SITE, ADMIN, NGTOK): check(f"màn hình không in bí mật '{s[:6]}…'", s not in out)
    logs = "".join(p.read_text(errors="replace") for p in (T/"base/logs").glob("*.log"))
    for s in (SITE, ADMIN): check(f"log không chứa bí mật '{s[:6]}…'", s not in logs)
    check("ngrok chỉ nhận token qua biến môi trường (không in token)", NGTOK not in logs and "token da nhan" in logs)
    check("OmniRoute nhận DATA_DIR", "DATA_DIR=" + str(T/"base/omniroute-data") in logs)
    check("~/.omniroute được liên kết sang DATA_DIR", (pathlib.Path.home()/".omniroute").resolve() == (T/"base/omniroute-data").resolve())

    st, j = call("/api/login", "POST", {"password": SITE}); check("backend nhận mật khẩu SITE_PASSWORD", st == 200 and "token" in j)
    st2, _ = call("/api/login", "POST", {"password": ADMIN}); check("mật khẩu bảng điều khiển KHÔNG dùng để vào website", st2 == 401)
    st, m = call("/api/models", token=j["token"]); check("OmniRoute đòi khóa cho /v1/models → notebook tự tạo khóa, backend lấy được model", st == 200 and m["total"] >= 4, str(m))
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{OMNI}/v1/models?prefix=alias", timeout=5); check("xác nhận mock thật sự đòi khóa", False)
    except urllib.error.HTTPError as e: check("xác nhận mock thật sự đòi khóa (401 khi không có khóa)", e.code == 401)
    check("khóa router được lưu riêng tư (600) và không in ra màn hình", "sk-mockkey" not in out and stat.S_IMODE(os.stat(T/"base/secrets.json").st_mode) == 0o600 and "sk-mockkey" in (T/"base/secrets.json").read_text())
    # thêm nhà cung cấp bằng khóa API
    os.environ["GEMINI_API_KEY"] = "AIzaFAKE-provider-key-0000111122223333"
    b4 = io.StringIO()
    with contextlib.redirect_stdout(b4): tp.add_provider("gemini")
    stm = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{OMNI}/__state").read())
    check("add_provider gửi đúng nhà cung cấp và khóa tới OmniRoute", stm.get("providerAdded", {}).get("provider") == "gemini" and stm["providerAdded"].get("apiKey") == os.environ["GEMINI_API_KEY"], str(stm.get("providerAdded")))
    check("add_provider không in khóa của nhà cung cấp ra màn hình", os.environ["GEMINI_API_KEY"] not in b4.getvalue() and "Đã thêm nhà cung cấp" in b4.getvalue())
    try: tp.add_provider("../etc"); check("add_provider từ chối tên lạ", False)
    except tp.SetupError: check("add_provider từ chối tên lạ", True)
    st, _ = call("/api/models", port=OMNI) if False else (0, 0)
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{BACK}/api/models", timeout=5)
    except urllib.error.HTTPError as e: check("API chat/models cần đăng nhập", e.code == 401 or e.code == 403)

    # --- trạng thái
    buf2 = io.StringIO()
    with contextlib.redirect_stdout(buf2): tp.status()
    s = buf2.getvalue()
    check("status(): báo 3 tiến trình đang chạy và địa chỉ phản hồi OK", s.count(": đang chạy") == 3 and "phản hồi OK" in s, s)

    # --- tìm model, tạo combo, đường hầm tạm thời tới bảng điều khiển
    b5 = io.StringIO()
    with contextlib.redirect_stdout(b5): hits = tp.find_models("claude")
    check("find_models liệt kê đúng model theo từ khóa", hits == ["cc/claude-sonnet-4-6"] and "cc/claude-sonnet-4-6" in b5.getvalue(), b5.getvalue())
    b5b = io.StringIO()
    with contextlib.redirect_stdout(b5b): ok_models = tp.probe_models("", limit=20, timeout=15)
    check("probe_models phân biệt model dùng được và model lỗi", "cc/claude-sonnet-4-6" in ok_models and "fail-500" not in ok_models and "no-creds" not in ok_models and "LỖI fail-500" in b5b.getvalue() and "No active credentials" in b5b.getvalue(), b5b.getvalue())
    check("probe_models che chuỗi giống khóa API trong lỗi", "abcdefghijklmnop1234" not in b5b.getvalue())
    b5c = io.StringIO()
    with contextlib.redirect_stdout(b5c): chosen = tp.auto_combo("tp-auto", "claude,gemini,fail", per_family=1, candidates=4, timeout=15)
    stc0 = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{OMNI}/__state").read())
    check("auto_combo chọn model dùng được mỗi họ theo thứ tự ưu tiên, bỏ qua họ không có model chạy được", chosen == ["cc/claude-sonnet-4-6", "gemini/gemini-2.5-pro"] and [x["model"] for x in stc0["comboCreated"]["models"]] == chosen, str(chosen) + b5c.getvalue()[-300:])
    try:
        tp.auto_combo("x", "fail,no-creds", candidates=2, timeout=15); check("auto_combo báo lỗi khi không model nào chạy được", False)
    except tp.SetupError: check("auto_combo báo lỗi khi không model nào chạy được", True)
    b6 = io.StringIO()
    with contextlib.redirect_stdout(b6): tp.create_combo("tp-claude-first", "cc/claude-sonnet-4-6, gemini/gemini-2.5-pro")
    stc = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{OMNI}/__state").read())
    check("create_combo gửi đúng cấu trúc (tên, chiến lược priority, danh sách model theo thứ tự)", stc["comboCreated"] == {"name": "tp-claude-first", "strategy": "priority", "models": [{"model": "cc/claude-sonnet-4-6"}, {"model": "gemini/gemini-2.5-pro"}]}, str(stc.get("comboCreated")))
    for bad_args in [("tp", ""), ("tên có dấu cách", "a/b"), ("ok", "http://evil.example/x"), ("ok", "a/../b"), ("ok", "a/b", "Priority;DROP")]:
        try: tp.create_combo(*bad_args); check(f"create_combo từ chối {bad_args!r}", False)
        except tp.SetupError: check(f"create_combo từ chối {bad_args!r}", True)
    b7 = io.StringIO()
    with contextlib.redirect_stdout(b7): url_admin = tp.open_admin_tunnel(minutes=1)
    check("open_admin_tunnel lấy đúng địa chỉ .lhr.life và bỏ qua liên kết admin.localhost.run", url_admin == "https://abc123xyz.lhr.life" and "CẢNH BÁO" in b7.getvalue(), b7.getvalue())
    check("đường hầm bảng điều khiển đang chạy", tp._procs["admin_tunnel"].poll() is None)
    with contextlib.redirect_stdout(io.StringIO()): tp.close_admin_tunnel()
    time.sleep(0.5)
    check("close_admin_tunnel dừng tiến trình ssh", "admin_tunnel" not in tp._procs)

    # --- sao lưu / khôi phục SQLite
    db = T/"base/omniroute-data/omniroute.db"
    c = sqlite3.connect(db); c.execute("create table providers(id integer primary key, name text)"); c.execute("insert into providers(name) values ('claude-cua-toi')"); c.commit()
    (T/"base/omniroute-data/note.txt").write_text("xin chao")
    buf3 = io.StringIO()
    with contextlib.redirect_stdout(buf3): n = tp.backup_config()
    check("backup_config sao lưu DB (khi DB đang mở) và tệp khác", n == 2 and (T/"drive/MyDrive/TP_OmniAI/omniroute-data/omniroute.db").exists(), buf3.getvalue())
    d = sqlite3.connect(T/"drive/MyDrive/TP_OmniAI/omniroute-data/omniroute.db")
    check("bản sao lưu đọc được và đúng dữ liệu", d.execute("select name from providers").fetchone()[0] == "claude-cua-toi")
    c.close(); d.close()
    tp.stop()
    time.sleep(1)
    check("stop(): các cổng đã đóng", not tp._port_open(OMNI) and not tp._port_open(BACK))
    shutil.rmtree(T/"base/omniroute-data"); (T/"base/omniroute-data").mkdir()
    with contextlib.redirect_stdout(io.StringIO()): restored = tp.restore_config()
    r = sqlite3.connect(T/"base/omniroute-data/omniroute.db")
    check("restore_config khôi phục cấu hình sau khi Colab bị reset", restored and r.execute("select name from providers").fetchone()[0] == "claude-cua-toi"); r.close()
    sec = json.loads((T/"base/secrets.json").read_text())
    check("khóa ngẫu nhiên của OmniRoute được tạo và giữ nguyên quyền 600", len(sec["JWT_SECRET"]) == 64 and stat.S_IMODE(os.stat(T/"base/secrets.json").st_mode) == 0o600)

    # --- mất danh sách tiến trình (kernel khởi động lại) vẫn tắt được
    os.environ["NGROK_AUTHTOKEN"] = NGTOK
    with contextlib.redirect_stdout(io.StringIO()):
        tp.start_omniroute(ADMIN, False); tp.start_backend(SITE, "https://tenban.github.io")
    tp._procs.clear()
    with contextlib.redirect_stdout(io.StringIO()): tp.stop()
    check("stop() dọn được tiến trình mồ côi khi mất trạng thái Python", not tp._port_open(OMNI) and not tp._port_open(BACK))

    # --- lỗi ngrok được giải thích
    os.environ["NGROK_AUTHTOKEN"] = "bad-token-123456"
    tp._state["persist"] = False
    with contextlib.redirect_stdout(io.StringIO()):
        tp.start_omniroute(ADMIN, False); tp.start_backend(SITE, "https://tenban.github.io")
    try:
        tp.start_tunnel("bad-token-123456", "", "https://tenban.github.io"); check("ngrok token sai → báo lỗi", False)
    except tp.SetupError as e:
        msg = str(e)
        check("ngrok token sai → thông báo tiếng Việt kèm gợi ý, không lộ token", "Authtoken ngrok không đúng" in msg and "bad-token-123456" not in msg, msg)
finally:
    tp.stop()
    subprocess.run("pkill -f mock-omniroute.mjs; pkill -f backend/server.mjs", shell=True)

print(f"\nTỔNG: {sum(res)}/{len(res)} đạt"); sys.exit(0 if all(res) else 1)

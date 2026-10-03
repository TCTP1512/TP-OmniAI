"""Kiểm thử tp_omniai.py với omniroute/ngrok giả lập (chạy tiến trình thật, cổng thật)."""
import io, json, os, pathlib, shutil, sqlite3, stat, sys, time, urllib.request, urllib.error, contextlib, subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
T = pathlib.Path("/tmp/tp-colab-test"); shutil.rmtree(T, ignore_errors=True)
(T/"fakebin").mkdir(parents=True); (T/"drive/MyDrive").mkdir(parents=True)
OMNI, BACK, NGAPI = 18120, 18121, 14040
SITE, ADMIN, NGTOK = "mat-khau-ban-be-1", "mat-khau-admin-2", "ngrok-token-bi-mat-123456"

# omniroute giả: chạy mock theo cổng PORT
(T/"fakebin/omniroute").write_text(f"#!/bin/sh\necho \"omniroute fake khoi dong, DATA_DIR=$DATA_DIR\"\nMOCK_PORT=$PORT exec node {ROOT}/tests/backend/mock-omniroute.mjs\n")
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
for f in ("omniroute", "ngrok"): os.chmod(T/"fakebin"/f, 0o755)

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
    st, m = call("/api/models", token=j["token"]); check("backend lấy được model từ OmniRoute (qua tiến trình thật)", st == 200 and m["total"] >= 4, str(m))
    st, _ = call("/api/models", port=OMNI) if False else (0, 0)
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{BACK}/api/models", timeout=5)
    except urllib.error.HTTPError as e: check("API chat/models cần đăng nhập", e.code == 401 or e.code == 403)

    # --- trạng thái
    buf2 = io.StringIO()
    with contextlib.redirect_stdout(buf2): tp.status()
    s = buf2.getvalue()
    check("status(): báo 3 tiến trình đang chạy và địa chỉ phản hồi OK", s.count(": đang chạy") == 3 and "phản hồi OK" in s, s)

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

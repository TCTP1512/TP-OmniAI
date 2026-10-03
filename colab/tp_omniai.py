"""TP OmniAI - tiện ích chạy trong Google Colab: cài đặt, khởi động OmniRoute + backend + ngrok.

Được notebook gọi; người dùng không cần sửa tệp này.
Không in mật khẩu/token ra màn hình; mọi nội dung log đều được ẩn bí mật trước khi hiển thị.
"""
import getpass
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = pathlib.Path(os.environ.get("TP_BASE", "/content/tp-omniai"))
DATA_DIR = BASE / "omniroute-data"
BACKEND_DIR = BASE / "backend"
LOG_DIR = BASE / "logs"
DRIVE_DIR = pathlib.Path(os.environ.get("TP_DRIVE_DIR", "/content/drive/MyDrive/TP_OmniAI"))
OMNI_PORT = int(os.environ.get("TP_OMNI_PORT", "20128"))
BACK_PORT = int(os.environ.get("TP_BACK_PORT", "8080"))
NGROK_API = os.environ.get("TP_NGROK_API", "http://127.0.0.1:4040")
NGROK_URL = "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz"

_procs = {}
_secrets = set()
_state = {"persist": False, "origin": "", "url": ""}


class SetupError(RuntimeError):
    """Lỗi đã được giải thích bằng tiếng Việt; notebook chỉ cần hiển thị thông điệp."""


def say(msg=""):
    print(msg, flush=True)


def _register_secret(value):
    if value and len(value) >= 6:
        _secrets.add(value)


def redact(text):
    for s in sorted(_secrets, key=len, reverse=True):
        text = text.replace(s, "[đã ẩn]")
    return text


def _tail(path, n=30):
    try:
        lines = pathlib.Path(path).read_text(errors="replace").splitlines()[-n:]
    except OSError:
        return "(chưa có log)"
    return redact("\n".join(lines))


def _sh(cmd, log_name, what):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = LOG_DIR / log_name
    with open(log, "ab") as f:
        r = subprocess.run(cmd, shell=True, stdout=f, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        raise SetupError(f"{what} thất bại (mã {r.returncode}). 30 dòng log cuối:\n{_tail(log)}")


# ---------------------------------------------------------------- Cài đặt
def node_version():
    try:
        out = subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip()
    except FileNotFoundError:
        return None
    m = re.match(r"v(\d+)\.(\d+)\.(\d+)", out)
    return tuple(int(x) for x in m.groups()) if m else None


def node_ok(v):
    # Theo package.json của OmniRoute 3.8.52: >=22.22.2 <23 hoặc >=24.0.0 <27
    return bool(v) and ((v >= (22, 22, 2) and v < (23, 0, 0)) or (v >= (24, 0, 0) and v < (27, 0, 0)))


def install_runtime(omniroute_version="3.8.52"):
    BASE.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if not (BACKEND_DIR / "server.mjs").exists():
        raise SetupError("Thiếu tệp backend/server.mjs. Hãy chạy lại ô cài đặt từ đầu.")

    v = node_version()
    if not node_ok(v):
        for major in (22, 24):
            say(f"Đang cài Node.js {major} (OmniRoute yêu cầu Node 22.22.2+ hoặc 24+)...")
            _sh(f"curl -fsSL https://deb.nodesource.com/setup_{major}.x | bash - && apt-get install -y nodejs", "node.log", f"Cài Node.js {major}")
            v = node_version()
            if node_ok(v):
                break
        if not node_ok(v):
            raise SetupError(f"Không cài được phiên bản Node.js phù hợp (hiện có: {v}).")
    say("Node.js: v" + ".".join(map(str, v)) + " (đạt yêu cầu)")

    say(f"Đang cài OmniRoute {omniroute_version} (có thể mất vài phút)...")
    try:
        _sh(f"npm install -g omniroute@{omniroute_version}", "npm-omniroute.log", f"Cài OmniRoute {omniroute_version}")
    except SetupError as first:
        say(f"Không cài được đúng phiên bản {omniroute_version}. Thử bản mới nhất (có thể khác bản đã được khảo sát)...")
        try:
            _sh("npm install -g omniroute@latest", "npm-omniroute.log", "Cài OmniRoute (bản mới nhất)")
        except SetupError:
            raise first
    prefix = subprocess.run(["npm", "prefix", "-g"], capture_output=True, text=True).stdout.strip()
    os.environ["PATH"] = f"{prefix}/bin:" + os.environ["PATH"]
    if not shutil.which("omniroute"):
        raise SetupError("Đã cài xong nhưng không tìm thấy lệnh 'omniroute'.")
    ver = subprocess.run(["npm", "ls", "-g", "omniroute", "--depth=0"], capture_output=True, text=True).stdout.strip().splitlines()
    say("OmniRoute đã cài: " + (ver[-1].strip() if ver else "?"))

    if not shutil.which("ngrok"):
        say("Đang tải ngrok...")
        try:
            tgz = BASE / "ngrok.tgz"
            urllib.request.urlretrieve(NGROK_URL, tgz)
            with tarfile.open(tgz) as t:
                t.extract("ngrok", "/usr/local/bin")
            os.chmod("/usr/local/bin/ngrok", 0o755)
        except Exception as e:  # noqa: BLE001
            raise SetupError(f"Không tải được ngrok ({type(e).__name__}). Kiểm tra kết nối mạng của Colab rồi chạy lại.")
    say("ngrok: " + subprocess.run(["ngrok", "version"], capture_output=True, text=True).stdout.strip())
    say("\nCài đặt xong. Chạy tiếp ô 'Khởi động'.")


# ---------------------------------------------------------------- Bí mật & lưu trữ
def _ask(name, prompt, min_len=0):
    for _ in range(3):
        value = None
        try:
            from google.colab import userdata  # Colab Secrets (biểu tượng chìa khóa bên trái)

            value = userdata.get(name)
        except Exception:  # noqa: BLE001 - chưa có secret hoặc không chạy trên Colab
            value = None
        value = value or os.environ.get(name) or getpass.getpass(prompt + ": ")
        value = value.strip()
        if len(value) >= max(min_len, 1):
            _register_secret(value)
            return value
        say(f"  Cần ít nhất {min_len} ký tự, nhập lại.")
    raise SetupError(f"Chưa nhập {name} hợp lệ.")


def mount_drive():
    from google.colab import drive  # type: ignore

    drive.mount("/content/drive")
    DRIVE_DIR.mkdir(parents=True, exist_ok=True)


def _persistent_secrets(persist):
    folder = DRIVE_DIR if persist else BASE
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "secrets.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        data = {}
    import secrets as _s

    changed = False
    for k in ("JWT_SECRET", "API_KEY_SECRET"):
        if not data.get(k):
            data[k] = _s.token_hex(32)
            changed = True
    if changed:
        path.write_text(json.dumps(data))
        os.chmod(path, 0o600)
    for v in data.values():
        _register_secret(v)
    return data


def _link_home_dir():
    """Nếu OmniRoute dùng ~/.omniroute thay vì DATA_DIR, liên kết sang DATA_DIR để dữ liệu vẫn nằm đúng chỗ."""
    home = pathlib.Path.home() / ".omniroute"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if home.is_symlink():
        home.unlink()
    if not home.exists():
        home.symlink_to(DATA_DIR, target_is_directory=True)
    elif home.is_dir() and not any(home.iterdir()):
        home.rmdir()
        home.symlink_to(DATA_DIR, target_is_directory=True)


def restore_config():
    src = DRIVE_DIR / "omniroute-data"
    if not src.exists() or not any(src.rglob("*")):
        return False
    if any(DATA_DIR.rglob("*.db")):
        return False
    shutil.copytree(src, DATA_DIR, dirs_exist_ok=True)
    say("Đã khôi phục cấu hình OmniRoute từ Google Drive.")
    return True


def backup_config():
    """Sao lưu dữ liệu OmniRoute sang Google Drive. Cơ sở dữ liệu SQLite được sao lưu bằng API sao lưu an toàn (không chép tệp đang mở)."""
    if not DRIVE_DIR.parent.exists():
        say("Chưa gắn Google Drive (đặt PERSIST_TO_DRIVE = True ở ô Khởi động).")
        return 0
    target = DRIVE_DIR / "omniroute-data"
    count = 0
    for p in DATA_DIR.rglob("*"):
        if not p.is_file() or p.name.endswith(("-wal", "-shm", "-journal")):
            continue
        dest = target / p.relative_to(DATA_DIR)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if p.suffix in (".db", ".sqlite", ".sqlite3"):
            src = sqlite3.connect(str(p))
            dst = sqlite3.connect(str(dest))
            try:
                src.backup(dst)
            finally:
                dst.close()
                src.close()
        elif p.stat().st_size < 20_000_000:
            shutil.copy2(p, dest)
        else:
            continue
        count += 1
    say(f"Đã sao lưu {count} tệp cấu hình vào Google Drive ({target}).")
    return count


def _auto_backup_loop():
    while _state.get("persist"):
        time.sleep(600)
        try:
            backup_config()
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------- Tiến trình
def _port_open(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _pids_listening(port):
    """Các PID đang lắng nghe cổng TCP `port` (đọc /proc, không cần công cụ ngoài)."""
    inodes = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = pathlib.Path(table).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            cols = line.split()
            if len(cols) > 9 and cols[3] == "0A" and int(cols[1].split(":")[1], 16) == port:
                inodes.add(cols[9])
    pids = set()
    if not inodes:
        return pids
    for proc in pathlib.Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            for fd in (proc / "fd").iterdir():
                if os.readlink(fd).startswith("socket:[") and os.readlink(fd)[8:-1] in inodes:
                    pids.add(int(proc.name))
                    break
        except OSError:
            continue
    pids.discard(os.getpid())
    return pids


def _wait_port(port, proc, name, log, timeout=150):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if proc.poll() is not None:
            raise SetupError(f"{name} dừng đột ngột (mã {proc.returncode}). Log cuối:\n{_tail(log)}")
        if _port_open(port):
            return
        time.sleep(1)
    raise SetupError(f"{name} không mở cổng {port} sau {timeout}s. Log cuối:\n{_tail(log)}")


def _spawn(name, cmd, env, log_name):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = LOG_DIR / log_name
    f = open(log, "wb")
    p = subprocess.Popen(cmd, env=env, cwd=str(BASE), stdout=f, stderr=subprocess.STDOUT, start_new_session=True)
    _procs[name] = p
    return p, log


def _kill(name):
    p = _procs.pop(name, None)
    if p and p.poll() is None:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGTERM)
            p.wait(timeout=8)
        except Exception:  # noqa: BLE001
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except Exception:  # noqa: BLE001
                pass


def start_omniroute(admin_password, persist):
    if "omniroute" in _procs and _procs["omniroute"].poll() is None and _port_open(OMNI_PORT):
        say("OmniRoute đã chạy sẵn.")
        return
    _kill("omniroute")
    if _port_open(OMNI_PORT):
        raise SetupError(f"Cổng {OMNI_PORT} đang bị chiếm bởi một tiến trình khác. Chạy ô 'Tắt dịch vụ' rồi thử lại.")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _link_home_dir()
    if persist:
        restore_config()
    sec = _persistent_secrets(persist)
    env = {
        **os.environ,
        "PORT": str(OMNI_PORT),
        "DATA_DIR": str(DATA_DIR),
        "INITIAL_PASSWORD": admin_password,
        "JWT_SECRET": sec["JWT_SECRET"],
        "API_KEY_SECRET": sec["API_KEY_SECRET"],
        "REQUIRE_API_KEY": "false",  # OmniRoute chỉ nhận kết nối nội bộ; chỉ backend được đưa ra Internet
        "NEXT_TELEMETRY_DISABLED": "1",
    }
    say("Đang khởi động OmniRoute (lần đầu có thể mất 1-2 phút)...")
    p, log = _spawn("omniroute", ["omniroute"], env, "omniroute.log")
    _wait_port(OMNI_PORT, p, "OmniRoute", log)
    say(f"OmniRoute đã chạy ở cổng {OMNI_PORT} (chỉ nội bộ, không công khai).")


def start_backend(site_password, allowed_origin):
    _kill("backend")
    if _port_open(BACK_PORT):
        raise SetupError(f"Cổng {BACK_PORT} đang bị chiếm. Chạy ô 'Tắt dịch vụ' rồi thử lại.")
    import secrets as _s

    env = {
        **os.environ,
        "HOST": "127.0.0.1",
        "PORT": str(BACK_PORT),
        "OMNIROUTE_URL": f"http://127.0.0.1:{OMNI_PORT}",
        "SITE_PASSWORD": site_password,
        "ALLOWED_ORIGIN": allowed_origin,
        "SESSION_SECRET": _s.token_hex(32),
    }
    p, log = _spawn("backend", ["node", str(BACKEND_DIR / "server.mjs")], env, "backend.log")
    _wait_port(BACK_PORT, p, "Backend", log, timeout=30)
    say(f"Backend đã chạy ở cổng {BACK_PORT} (đã bật mật khẩu và giới hạn nguồn truy cập).")


def _http_json(url, headers=None, timeout=10):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


NGROK_HINTS = {
    "ERR_NGROK_105": "Authtoken ngrok không đúng. Lấy lại token tại dashboard.ngrok.com/get-started/your-authtoken.",
    "ERR_NGROK_107": "Authtoken ngrok không đúng hoặc đã bị thu hồi.",
    "ERR_NGROK_108": "Tài khoản ngrok đang chạy một phiên khác. Tắt phiên cũ tại dashboard.ngrok.com/agents (hoặc chạy ô 'Tắt dịch vụ' ở notebook cũ).",
    "ERR_NGROK_4018": "Cần đăng ký tài khoản ngrok và dùng authtoken.",
}


def start_tunnel(authtoken, domain="", allowed_origin=""):
    _kill("ngrok")
    env = {**os.environ, "NGROK_AUTHTOKEN": authtoken}
    cmd = ["ngrok", "http", str(BACK_PORT), "--log=stdout", "--log-format=json"]
    if domain:
        cmd += ["--url", "https://" + domain.replace("https://", "").strip("/")]
    p, log = _spawn("ngrok", cmd, env, "ngrok.log")
    url = None
    t0 = time.time()
    while time.time() - t0 < 40 and not url:
        if p.poll() is not None:
            break
        try:
            tunnels = _http_json(NGROK_API + "/api/tunnels", timeout=2).get("tunnels", [])
            https = [t["public_url"] for t in tunnels if t.get("public_url", "").startswith("https://")]
            url = (https or [t["public_url"] for t in tunnels] or [None])[0]
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)
    if not url:
        text = _tail(log, 40)
        hint = next((h for code, h in NGROK_HINTS.items() if code in text), "")
        raise SetupError("Không tạo được đường hầm ngrok." + (f"\nGợi ý: {hint}" if hint else "") + f"\nLog cuối:\n{text}")
    # Kiểm tra từ bên ngoài qua đúng địa chỉ công khai
    try:
        h = _http_json(url + "/api/health", headers={"ngrok-skip-browser-warning": "1", "Origin": allowed_origin} if allowed_origin else {"ngrok-skip-browser-warning": "1"}, timeout=15)
        ok = bool(h.get("ok"))
    except Exception:  # noqa: BLE001
        ok = False
    _state["url"] = url
    return url, ok


# ---------------------------------------------------------------- Lệnh cho notebook
def normalize_origin(text):
    text = (text or "").strip()
    if not text:
        raise SetupError("Chưa nhập ALLOWED_ORIGIN. Ví dụ: https://tenban.github.io (tên GitHub của bạn).")
    if "://" not in text:
        text = "https://" + text
    u = urllib.parse.urlparse(text)
    if u.scheme != "https" or not u.hostname or "." not in u.hostname:
        raise SetupError("ALLOWED_ORIGIN phải có dạng https://tenban.github.io")
    return f"https://{u.netloc}"


def start_all(allowed_origin, persist=True, ngrok_domain=""):
    origin = normalize_origin(allowed_origin)
    _state.update(persist=bool(persist), origin=origin)
    if not shutil.which("omniroute") or not shutil.which("ngrok") or not (BACKEND_DIR / "server.mjs").exists():
        raise SetupError("Chưa cài đặt xong. Hãy chạy ô 'Bước 1 - Cài đặt' trước.")
    if persist:
        say("Gắn Google Drive để lưu cấu hình OmniRoute qua các phiên (Google sẽ hỏi quyền một lần)...")
        mount_drive()
    say("\nNhập thông tin bí mật (không hiển thị lại). Có thể lưu sẵn trong Colab Secrets (biểu tượng chìa khóa) để khỏi nhập mỗi lần:")
    site_pw = _ask("SITE_PASSWORD", "1/3 Mật khẩu chia sẻ cho bạn bè vào website (>= 8 ký tự)", 8)
    admin_pw = _ask("OMNIROUTE_ADMIN_PASSWORD", "2/3 Mật khẩu bảng điều khiển OmniRoute (chỉ bạn dùng, >= 8 ký tự)", 8)
    ngrok_token = _ask("NGROK_AUTHTOKEN", "3/3 ngrok authtoken", 10)
    say()
    start_omniroute(admin_pw, bool(persist))
    start_backend(site_pw, origin)
    url, ok = start_tunnel(ngrok_token, ngrok_domain, origin)
    if persist:
        threading.Thread(target=_auto_backup_loop, daemon=True).start()
        try:
            (DRIVE_DIR / "last_url.txt").write_text(url)
        except OSError:
            pass
    say("\n" + "=" * 62)
    say("ĐỊA CHỈ DỊCH VỤ: " + url)
    say("=" * 62)
    if ok:
        say("Đã kiểm tra: backend phản hồi qua địa chỉ công khai.")
    else:
        say("CẢNH BÁO: chưa xác nhận được backend qua địa chỉ công khai. Chạy ô 'Kiểm tra trạng thái' sau ít giây.")
    say("\nViệc cần làm:")
    say(f"  1. Mở file docs/config.js trên GitHub, đặt BACKEND_URL: \"{url}\" (chỉ cần làm khi địa chỉ này thay đổi).")
    say("  2. Lần đầu: chạy ô 'Mở bảng điều khiển OmniRoute' để thêm Claude/các nhà cung cấp.")
    say("  3. Gửi cho bạn bè địa chỉ website GitHub Pages và mật khẩu ở bước 1/3.")


def open_dashboard():
    try:
        from google.colab import output  # type: ignore

        say("Đang mở bảng điều khiển OmniRoute (đăng nhập bằng mật khẩu 2/3 bạn đã đặt)...")
        output.serve_kernel_port_as_window(OMNI_PORT)
    except Exception as e:  # noqa: BLE001
        say(f"Không mở tự động được ({type(e).__name__}). Trong Colab, chạy:\n  from google.colab import output; output.serve_kernel_port_as_iframe({OMNI_PORT})")


def status():
    say("Tiến trình:")
    for name in ("omniroute", "backend", "ngrok"):
        p = _procs.get(name)
        alive = bool(p) and p.poll() is None
        say(f"  {name:10s}: {'đang chạy' if alive else 'KHÔNG chạy'}")
    say(f"Cổng nội bộ: OmniRoute {OMNI_PORT}={'mở' if _port_open(OMNI_PORT) else 'đóng'}, backend {BACK_PORT}={'mở' if _port_open(BACK_PORT) else 'đóng'}")
    url = _state.get("url")
    if url:
        try:
            hdr = {"ngrok-skip-browser-warning": "1"}
            if _state.get("origin"):
                hdr["Origin"] = _state["origin"]
            _http_json(url + "/api/health", headers=hdr, timeout=15)
            say(f"Địa chỉ công khai {url}: phản hồi OK")
        except Exception as e:  # noqa: BLE001
            say(f"Địa chỉ công khai {url}: KHÔNG phản hồi ({type(e).__name__})")
    else:
        say("Chưa có địa chỉ công khai (chưa chạy ô Khởi động).")
    for name in ("backend", "omniroute"):
        say(f"\n--- log {name} (10 dòng cuối) ---\n{_tail(LOG_DIR / (name + '.log'), 10)}")


def stop():
    if _state.get("persist"):
        try:
            backup_config()
        except Exception as e:  # noqa: BLE001
            say(f"Không sao lưu được cấu hình ({type(e).__name__}).")
    _state["persist"] = False
    for name in ("ngrok", "backend", "omniroute"):
        _kill(name)
    # Dọn cả tiến trình mồ côi (ví dụ sau khi khởi động lại kernel Colab làm mất danh sách tiến trình):
    # tìm theo cổng đang lắng nghe, không theo tên, để không tắt nhầm tiến trình khác.
    for port in (BACK_PORT, OMNI_PORT):
        for pid in _pids_listening(port):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
    subprocess.run(["pkill", "-x", "ngrok"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    say("Đã tắt toàn bộ dịch vụ.")

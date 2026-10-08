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
BACK_PORT = int(os.environ.get("TP_BACK_PORT", "8787"))  # không dùng 8080: Colab tự dùng cổng này
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


_KEY_LIKE = [re.compile(r"sk-[A-Za-z0-9_\-]{8,}"), re.compile(r"AIza[0-9A-Za-z_\-]{20,}"), re.compile(r"Bearer\s+[A-Za-z0-9._\-]{8,}", re.I)]


def redact(text):
    """Che bí mật đã biết và cả các chuỗi có dạng khóa API (ví dụ do nhà cung cấp tự in trong thông báo lỗi)."""
    for s in sorted(_secrets, key=len, reverse=True):
        text = text.replace(s, "[đã ẩn]")
    for pat in _KEY_LIKE:
        text = pat.sub("[đã ẩn]", text)
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


def install_runtime(omniroute_version="latest"):
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
        reason = [l for l in str(first).splitlines() if l.strip()][-3:]
        say(f"Không cài được phiên bản {omniroute_version} (có thể phiên bản này chưa được phát hành). Lý do:\n  " + "\n  ".join(reason))
        say("Thử bản mới nhất (có thể khác bản đã được khảo sát)...")
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


def _is_ours(pid):
    """Chỉ coi là tiến trình của dự án nếu là node/omniroute/ngrok (tránh tắt nhầm tiến trình hệ thống của Colab)."""
    try:
        cmd = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").lower()
    except OSError:
        return False
    return any(k in cmd for k in ("node", "omniroute", "server.mjs", "ngrok"))


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


def _omni_request(method, path, body=None, cookie=None, bearer=None):
    """Gọi API của OmniRoute từ bên trong Colab. Trả về (mã HTTP, nội dung, tiêu đề phản hồi)."""
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{OMNI_PORT}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace"), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), e.headers


def _omni_login(admin_password):
    """Đăng nhập quản trị OmniRoute, trả về chuỗi Cookie. Tự lấy cookie từ phản hồi (không phụ thuộc cờ Secure)."""
    status, body, headers = _omni_request("POST", "/api/auth/login", {"password": admin_password})
    if status >= 400:
        raise SetupError(f"Đăng nhập quản trị OmniRoute thất bại (HTTP {status}): {redact(body[:200])}")
    cookies = []
    for line in headers.get_all("Set-Cookie") or []:
        cookies.append(line.split(";", 1)[0])
    if not cookies:
        raise SetupError("OmniRoute đăng nhập được nhưng không trả cookie phiên.")
    return "; ".join(cookies)


def _find_key(obj):
    """Tìm chuỗi khóa API trong phản hồi JSON (dạng sk-...), kể cả khi lồng nhau."""
    if isinstance(obj, str):
        return obj if obj.startswith("sk-") and len(obj) > 12 else None
    if isinstance(obj, dict):
        for k in ("key", "apiKey", "api_key", "token"):
            v = obj.get(k)
            if isinstance(v, str) and len(v) > 8:
                return v
        for v in obj.values():
            f = _find_key(v)
            if f:
                return f
    if isinstance(obj, list):
        for v in obj:
            f = _find_key(v)
            if f:
                return f
    return None


def _models_ok(key):
    status, _, _ = _omni_request("GET", "/v1/models?prefix=alias", bearer=key or None)
    return status == 200


def ensure_router_key(admin_password, persist):
    """Đảm bảo backend có khóa để lấy danh sách model: dùng khóa đã lưu, hoặc tạo khóa mới trong OmniRoute."""
    if _models_ok(None):
        say("OmniRoute cho phép lấy danh sách model không cần khóa.")
        return ""
    folder = DRIVE_DIR if persist else BASE
    path = folder / "secrets.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        data = {}
    saved = data.get("ROUTER_KEY", "")
    if saved:
        _register_secret(saved)
        if _models_ok(saved):
            say("Dùng lại khóa API đã lưu cho backend.")
            return saved
    say("OmniRoute yêu cầu khóa API cho danh sách model. Đang tạo khóa riêng cho backend...")
    cookie = _omni_login(admin_password)
    status, body, _ = _omni_request("POST", "/api/keys", {"name": "tp-omniai-backend"}, cookie=cookie)
    if status >= 400:
        raise SetupError(f"Không tạo được khóa API (HTTP {status}): {redact(body[:300])}")
    try:
        key = _find_key(json.loads(body))
    except ValueError:
        key = None
    if not key:
        raise SetupError("OmniRoute tạo khóa nhưng định dạng phản hồi không như dự kiến, nên không lấy được khóa. Hãy báo lại cho người hỗ trợ.")
    _register_secret(key)
    if not _models_ok(key):
        raise SetupError("Khóa API mới tạo vẫn không lấy được danh sách model.")
    data["ROUTER_KEY"] = key
    folder.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
    os.chmod(path, 0o600)
    say("Đã tạo khóa API cho backend (lưu riêng tư, không hiển thị).")
    return key


def add_provider(provider="gemini", name=None):
    """Thêm một nhà cung cấp dùng khóa API vào OmniRoute (ví dụ gemini, openai, anthropic, deepseek, groq)."""
    provider = (provider or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,40}", provider):
        raise SetupError("Tên nhà cung cấp không hợp lệ (chỉ chữ thường, số, dấu - . _).")
    admin = _state.get("admin_pw") or _ask("OMNIROUTE_ADMIN_PASSWORD", "Mật khẩu bảng điều khiển OmniRoute", 8)
    api_key = _ask(provider.upper().replace("-", "_") + "_API_KEY", f"Khóa API của {provider} (không hiển thị lại)", 8)
    cookie = _omni_login(admin)
    status, body, _ = _omni_request("POST", "/api/providers", {"provider": provider, "apiKey": api_key, "name": name or f"{provider}-tp-omniai"}, cookie=cookie)
    if status >= 400:
        raise SetupError(f"Không thêm được nhà cung cấp '{provider}' (HTTP {status}): {redact(body[:300])}")
    say(f"Đã thêm nhà cung cấp '{provider}' vào OmniRoute.")
    say("Tải lại website rồi chọn 'Tự động (auto)' hoặc một model của nhà cung cấp này để thử.")
    try:
        if persist_now():
            backup_config()
    except Exception:  # noqa: BLE001
        pass


def persist_now():
    return bool(_state.get("persist"))


def start_backend(site_password, allowed_origin, router_key=""):
    _kill("backend")
    if _port_open(BACK_PORT):
        raise SetupError(f"Cổng {BACK_PORT} đang bị một tiến trình khác chiếm. Nếu là backend cũ của TP OmniAI, chạy ô 'Tắt dịch vụ' rồi thử lại.")
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
    if router_key:
        env["OMNIROUTE_API_KEY"] = router_key
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
    _state["admin_pw"] = admin_pw
    start_omniroute(admin_pw, bool(persist))
    try:
        router_key = ensure_router_key(admin_pw, bool(persist))
    except SetupError as e:
        router_key = ""
        say(f"CẢNH BÁO: {e}\nBackend vẫn khởi động, nhưng website có thể chưa lấy được danh sách model.")
    _state["router_key"] = router_key
    start_backend(site_pw, origin, router_key)
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
    """In đường link bảng điều khiển OmniRoute để mở trong tab mới (khung nhúng iframe có thể bị chặn)."""
    try:
        from google.colab.output import eval_js  # type: ignore

        url = eval_js(f"google.colab.kernel.proxyPort({OMNI_PORT})")
        say("Bấm vào đường link dưới đây để mở bảng điều khiển OmniRoute trong TAB MỚI,")
        say("rồi đăng nhập bằng mật khẩu 2/3 bạn đã đặt ở Bước 2:\n")
        say(url)
        say("\nLưu ý: bỏ qua mọi đường link 'localhost', chúng chỉ trỏ về máy của bạn chứ không phải Colab.")
    except Exception as e:  # noqa: BLE001
        say(f"Không lấy được đường link bảng điều khiển ({type(e).__name__}). Hãy gửi thông báo này cho người hỗ trợ.")


def diagnose():
    """Kiểm tra trực tiếp OmniRoute và backend từ bên trong Colab, in mã trạng thái thật (không in bí mật)."""
    def probe(label, url):
        try:
            with urllib.request.urlopen(url, timeout=15) as r:
                body = r.read(500).decode("utf-8", "replace")
                say(f"{label}: HTTP {r.status}\n  {redact(body)}")
        except urllib.error.HTTPError as e:
            say(f"{label}: HTTP {e.code}\n  {redact(e.read(500).decode('utf-8', 'replace'))}")
        except Exception as e:  # noqa: BLE001
            say(f"{label}: LỖI {type(e).__name__}: {e}")

    probe("OmniRoute /v1/models", f"http://127.0.0.1:{OMNI_PORT}/v1/models?prefix=alias")
    probe("Backend /api/health", f"http://127.0.0.1:{BACK_PORT}/api/health")



def _list_model_ids():
    status, body, _ = _omni_request("GET", "/v1/models?prefix=alias", bearer=_state.get("router_key") or None)
    if status != 200:
        raise SetupError(f"Không lấy được danh sách model (HTTP {status}): {redact(body[:200])}")
    try:
        return sorted({m["id"] for m in json.loads(body).get("data", []) if isinstance(m, dict) and isinstance(m.get("id"), str)})
    except ValueError:
        raise SetupError("Danh sách model trả về không đọc được.")


def find_models(keyword="", limit=60):
    """Liệt kê ID model hiện có trong OmniRoute (lọc theo từ khóa) để dùng khi tạo combo."""
    ids = _list_model_ids()
    kw = (keyword or "").strip().lower()
    hits = [i for i in ids if kw in i.lower()]
    say(f"Có {len(ids)} model trong OmniRoute; {len(hits)} model khớp '{keyword}'." + (f" Hiển thị {limit} đầu:" if len(hits) > limit else ""))
    for i in hits[:limit]:
        say("  " + i)
    return hits


def _short_error(raw):
    try:
        j = json.loads(raw)
        msg = (j.get("error") or {}).get("message") if isinstance(j.get("error"), dict) else j.get("error") or j.get("message")
        raw = msg if isinstance(msg, str) else raw
    except (ValueError, AttributeError):
        pass
    return " ".join(redact(str(raw)).split())[:140]


def _probe_one(model, timeout):
    """Gửi một tin nhắn rất ngắn tới model để biết nó có trả lời được không."""
    key = _state.get("router_key") or None
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    data = json.dumps({"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 8, "stream": False}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{OMNI_PORT}/v1/chat/completions", data=data, method="POST", headers=headers)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read(2000)
        return model, True, round(time.time() - t0, 1), ""
    except urllib.error.HTTPError as e:
        return model, False, round(time.time() - t0, 1), f"HTTP {e.code}: " + _short_error(e.read(600).decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        return model, False, round(time.time() - t0, 1), "hết thời gian chờ" if "timed out" in str(e).lower() else type(e).__name__


def _probe_many(ids, timeout, workers=4):
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(lambda m: _probe_one(m, timeout), ids))
    for model, ok, secs, why in results:
        say(f"  {'OK ' if ok else 'LỖI'} {model}  ({secs}s)" + ("" if ok else f"  {why}"))
    return results


def probe_models(keyword="", limit=12, timeout=40):
    """Thử từng model khớp từ khóa bằng một tin nhắn rất ngắn, cho biết model nào dùng được. Mỗi lần thử tốn một chút hạn mức."""
    kw = (keyword or "").strip().lower()
    ids = [i for i in _list_model_ids() if kw in i.lower()]
    hits = sorted(ids, reverse=True)[: max(1, int(limit))]  # ưu tiên phiên bản mới (số lớn hơn)
    if not hits:
        say(f"Không có model nào khớp '{keyword}'.")
        return []
    say(f"Thử {len(hits)}/{len(ids)} model khớp '{keyword}' (mỗi model một tin nhắn rất ngắn, tốn một ít hạn mức):")
    res = _probe_many(hits, timeout)
    ok = [m for m, good, *_ in res if good]
    say(f"\nDùng được: {len(ok)}/{len(hits)}." + ("" if ok else " Chưa có model nào chạy; kiểm tra khóa nhà cung cấp hoặc thử từ khóa khác."))
    return ok


def auto_combo(name="tp-auto", prefer="claude,gpt,gemini,deepseek", per_family=1, candidates=8, timeout=40):
    """Tự thử các model theo từng họ (theo thứ tự ưu tiên), lấy model dùng được đầu tiên của mỗi họ rồi tạo combo có dự phòng."""
    fams = [x.strip().lower() for x in str(prefer or "").split(",") if x.strip()]
    if not fams:
        raise SetupError("Chưa chọn họ model ưu tiên (ví dụ: claude,gpt,gemini,deepseek).")
    ids = _list_model_ids()
    chosen = []
    for fam in fams:
        pool = sorted([i for i in ids if fam in i.lower() and i not in chosen and "/" in i], reverse=True)[: max(1, int(candidates))]
        if not pool:
            say(f"\n== {fam}: không có model nào trong danh mục ==")
            continue
        say(f"\n== {fam}: thử {len(pool)} model, lấy {per_family} model dùng được đầu tiên ==")
        res = _probe_many(pool, timeout)
        chosen += [m for m, good, *_ in res if good][: max(1, int(per_family))]
    if not chosen:
        raise SetupError("Không có model nào trả lời được. Hãy kiểm tra đã thêm nhà cung cấp và khóa còn hiệu lực (ô 'Thêm nhà cung cấp').")
    say(f"\nCác model dùng được, theo thứ tự ưu tiên: {', '.join(chosen)}")
    create_combo(name, chosen)
    return chosen


_COMBO_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,60}")
_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}")


def create_combo(name="tp-claude-first", models="", strategy="priority"):
    """Tạo combo: OmniRoute thử lần lượt các model theo thứ tự ưu tiên, tự chuyển sang model sau khi model trước lỗi/hết hạn mức."""
    items = [m.strip() for m in (models if isinstance(models, (list, tuple)) else str(models or "").replace("\n", ",").split(",")) if m.strip()]
    if not _COMBO_NAME.fullmatch(name or ""):
        raise SetupError("Tên combo chỉ gồm chữ, số, dấu - . _ (tối đa 61 ký tự).")
    if not items:
        raise SetupError("Chưa có model nào. Điền danh sách model (cách nhau bằng dấu phẩy). Dùng ô 'Tìm model' để xem ID có sẵn.")
    for m in items:
        if "://" in m or ".." in m or not _MODEL_ID.fullmatch(m):
            raise SetupError(f"ID model không hợp lệ: {m!r}")
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", strategy or ""):
        raise SetupError("Chiến lược không hợp lệ (ví dụ: priority).")
    admin = _state.get("admin_pw") or _ask("OMNIROUTE_ADMIN_PASSWORD", "Mật khẩu bảng điều khiển OmniRoute", 8)
    cookie = _omni_login(admin)
    status, body, _ = _omni_request("POST", "/api/combos", {"name": name, "strategy": strategy, "models": [{"model": m} for m in items]}, cookie=cookie)
    if status >= 400:
        raise SetupError(f"Không tạo được combo (HTTP {status}): {redact(body[:300])}")
    say(f"Đã tạo combo '{name}' ({strategy}) gồm {len(items)} model: {', '.join(items)}")
    say("Tải lại website, mở ô chọn model và chọn combo này (nằm trong nhóm 'Tự động').")
    if len(items) == 1:
        say("Lưu ý: combo chỉ có 1 model nên chưa có dự phòng. Thêm model khác để có fallback.")
    try:
        if persist_now():
            backup_config()
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- Đường hầm tạm thời tới bảng điều khiển
_ADMIN_HOST_SKIP = ("admin.", "www.", "docs.", "localhost.run")


def _pick_admin_url(text):
    urls = re.findall(r"https://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:lhr\.life|localhost\.run)", text)
    good = [u for u in urls if not any(u[len("https://"):].startswith(x) for x in _ADMIN_HOST_SKIP)]
    lhr = [u for u in good if u.endswith(".lhr.life")]
    return (lhr or good or [None])[0]


def open_admin_tunnel(minutes=30):
    """Mở bảng điều khiển OmniRoute ra một địa chỉ công khai TẠM THỜI (localhost.run, miễn phí, không cần tài khoản) và tự đóng sau `minutes` phút."""
    p = _procs.get("admin_tunnel")
    if p and p.poll() is None and _state.get("admin_url"):
        say("Đường hầm bảng điều khiển đang mở: " + _state["admin_url"])
        return _state["admin_url"]
    if not _port_open(OMNI_PORT):
        raise SetupError("OmniRoute chưa chạy. Hãy chạy ô 'Bước 2 - Khởi động' trước.")
    if not shutil.which("ssh"):
        _sh("apt-get install -y openssh-client", "ssh.log", "Cài ssh")
    _kill("admin_tunnel")
    cmd = ["ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null", "-o", "ServerAliveInterval=30",
           "-o", "ExitOnForwardFailure=yes", "-R", f"80:localhost:{OMNI_PORT}", "nokey@localhost.run"]
    p, log = _spawn("admin_tunnel", cmd, dict(os.environ), "admin_tunnel.log")
    url = None
    t0 = time.time()
    while time.time() - t0 < 45 and not url:
        url = _pick_admin_url(_tail(log, 60))
        if url or p.poll() is not None:
            break
        time.sleep(1)
    if not url:
        _kill("admin_tunnel")
        raise SetupError("Không mở được đường hầm bảng điều khiển. Log cuối:\n" + _tail(log, 25))
    _state["admin_url"] = url
    threading.Timer(max(1, int(minutes)) * 60, close_admin_tunnel).start()
    say("=" * 62)
    say("BẢNG ĐIỀU KHIỂN OMNIROUTE (tạm thời): " + url)
    say("=" * 62)
    say("Mở địa chỉ trên trong tab mới, đăng nhập bằng mật khẩu bảng điều khiển (mật khẩu 2/3).")
    say(f"CẢNH BÁO: địa chỉ này công khai, chỉ có mật khẩu bảo vệ. Nó tự đóng sau {int(minutes)} phút; hãy chạy ô 'Đóng đường hầm' ngay khi xong việc.")
    say("Lưu ý: nhà cung cấp đăng nhập OAuth (Antigravity, Claude Code...) có thể chuyển hướng về 'localhost' trên máy bạn; nếu gặp lỗi đó, hãy báo lại để được hỗ trợ.")
    return url


def close_admin_tunnel():
    was = bool(_state.pop("admin_url", None))
    _kill("admin_tunnel")
    if was:
        say("Đã đóng đường hầm bảng điều khiển.")


def status():
    say("Tiến trình:")
    for name in ("omniroute", "backend", "ngrok", "admin_tunnel"):
        p = _procs.get(name)
        if name == "admin_tunnel" and not p:
            continue
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
    _state.pop("admin_url", None)
    for name in ("admin_tunnel", "ngrok", "backend", "omniroute"):
        _kill(name)
    # Dọn cả tiến trình mồ côi (ví dụ sau khi khởi động lại kernel Colab làm mất danh sách tiến trình):
    # tìm theo cổng đang lắng nghe, không theo tên, để không tắt nhầm tiến trình khác.
    for port in (BACK_PORT, OMNI_PORT):
        for pid in _pids_listening(port):
            if not _is_ours(pid):
                continue
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
    subprocess.run(["pkill", "-x", "ngrok"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    say("Đã tắt toàn bộ dịch vụ.")

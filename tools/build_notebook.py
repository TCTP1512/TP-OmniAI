"""Dựng notebook Colab từ backend/server.mjs và colab/tp_omniai.py (nhúng nguyên văn, không bị lệch phiên bản)."""
import json, pathlib, base64
ROOT = pathlib.Path(__file__).resolve().parent.parent
server = (ROOT/"backend/server.mjs").read_text(encoding="utf-8")
helper = (ROOT/"colab/tp_omniai.py").read_text(encoding="utf-8")

def embed(var, text):
    if "'''" in text or text.rstrip().endswith("\\"):
        return f"{var} = __import__('base64').b64decode('{base64.b64encode(text.encode()).decode()}').decode('utf-8')\n"
    return f"{var} = r'''{text}'''\n"

def src(s): return s.strip("\n").splitlines(keepends=True)
def md(s): return {"cell_type": "markdown", "metadata": {}, "source": src(s)}
def code(s, title=None):
    meta = {"cellView": "form"} if title else {}
    return {"cell_type": "code", "metadata": meta, "execution_count": None, "outputs": [], "source": src(s)}

install_cell = f'''#@title Bước 1 - Cài đặt (chạy 1 lần mỗi phiên Colab, mất vài phút) {{display-mode: "form"}}
OMNIROUTE_VERSION = "3.8.52"  #@param {{type:"string"}}
import pathlib, sys
BASE = pathlib.Path("/content/tp-omniai"); (BASE/"backend").mkdir(parents=True, exist_ok=True)
{embed("SERVER_MJS", server)}
{embed("TP_HELPER", helper)}
(BASE/"backend"/"server.mjs").write_text(SERVER_MJS, encoding="utf-8")
pathlib.Path("/content/tp_omniai.py").write_text(TP_HELPER, encoding="utf-8")
sys.path.insert(0, "/content")
import importlib, tp_omniai; importlib.reload(tp_omniai)
try:
    tp_omniai.install_runtime(OMNIROUTE_VERSION)
except tp_omniai.SetupError as e:
    print("LỖI:", e)
'''

start_cell = '''#@title Bước 2 - Khởi động TP OmniAI {display-mode: "form"}
#@markdown Địa chỉ GitHub Pages của bạn, chỉ cần phần tên miền (ví dụ `https://tenban.github.io`):
ALLOWED_ORIGIN = ""  #@param {type:"string"}
#@markdown Lưu cấu hình OmniRoute (tài khoản Claude, combo...) vào Google Drive để lần sau khỏi nhập lại:
PERSIST_TO_DRIVE = True  #@param {type:"boolean"}
#@markdown Tên miền ngrok cố định của bạn (để trống nếu dùng tên miền mặc định ngrok cấp):
NGROK_DOMAIN = ""  #@param {type:"string"}
import tp_omniai
try:
    tp_omniai.start_all(ALLOWED_ORIGIN, PERSIST_TO_DRIVE, NGROK_DOMAIN)
except tp_omniai.SetupError as e:
    print("\\nLỖI:", e)
'''

cells = [
 md("""# TP OmniAI - máy chủ AI chạy trên Colab
Notebook này bật **OmniRoute** và **backend bảo mật** trong phiên Colab của bạn, rồi mở đường hầm **ngrok** để website trên GitHub Pages kết nối vào.

**Mỗi lần muốn dùng:** chạy lần lượt *Bước 1* rồi *Bước 2* (bấm nút ▶ ở mỗi ô). Khi xong việc, chạy ô *Tắt dịch vụ*.

**Cần biết:**
- Colab không chạy 24/7: phiên có thể bị ngắt khi nhàn rỗi hoặc hết thời gian. Khi đó website vẫn mở được nhưng AI sẽ báo mất kết nối; bạn chỉ cần chạy lại Bước 1 và 2.
- Colab hạn chế chạy "dịch vụ web không liên quan đến tính toán tương tác" và có thể ngắt phiên miễn phí không báo trước. Hãy dùng ở quy mô nhỏ (bạn bè)."""),
 code(install_cell, "Bước 1"),
 code(start_cell, "Bước 2"),
 md("### Lần đầu: thêm Claude vào OmniRoute\nChạy ô dưới để mở bảng điều khiển OmniRoute (đăng nhập bằng *mật khẩu bảng điều khiển* bạn đã nhập ở Bước 2). Thêm nhà cung cấp Claude (và Gemini/GPT/DeepSeek nếu muốn), rồi tạo một **Combo** ưu tiên Claude, dự phòng các model còn lại. Combo/`auto` sẽ tự xuất hiện trong danh sách model của website."),
 code('#@title Mở bảng điều khiển OmniRoute {display-mode: "form"}\nimport tp_omniai\ntp_omniai.open_dashboard()', "dash"),
 code('#@title Kiểm tra trạng thái {display-mode: "form"}\nimport tp_omniai\ntp_omniai.status()', "status"),
 code('#@title Sao lưu cấu hình OmniRoute vào Google Drive (tự động mỗi 10 phút nếu đã bật lưu) {display-mode: "form"}\nimport tp_omniai\ntp_omniai.backup_config()', "backup"),
 code('#@title Tắt dịch vụ {display-mode: "form"}\nimport tp_omniai\ntp_omniai.stop()', "stop"),
]
nb = {"cells": cells, "metadata": {"colab": {"name": "TP_OmniAI_Colab.ipynb", "provenance": []}, "kernelspec": {"name": "python3", "display_name": "Python 3"}, "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 0}
out = ROOT/"colab/TP_OmniAI_Colab.ipynb"
out.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
print("Đã tạo", out, f"({out.stat().st_size//1024} KB)")

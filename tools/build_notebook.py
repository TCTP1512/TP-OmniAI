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
#@markdown Phiên bản OmniRoute ("latest" = bản mới nhất; có thể điền số cụ thể nếu muốn cố định):\nOMNIROUTE_VERSION = "latest"  #@param {{type:"string"}}
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
 md("""### Thêm AI vào OmniRoute (làm lần đầu, và mỗi khi muốn thêm model mới)
OmniRoute chỉ *điều phối*, bạn cần nối ít nhất một nhà cung cấp AI. Có hai cách:

**Cách 1 (dễ nhất): dán khóa API.** Chọn nhà cung cấp ở ô bên dưới, bấm ▶, dán khóa khi được hỏi (chữ gõ vào không hiện lại). Gợi ý:
- `openrouter`: một khóa dùng được rất nhiều model (có cả Claude, GPT; một số model miễn phí). Lấy khóa tại openrouter.ai/keys.
- `gemini`: khóa miễn phí tại aistudio.google.com/apikey.
- `anthropic` (Claude) và `openai` (GPT): khóa chính hãng, **tính phí theo mức dùng**.
- Ngoài ra: `deepseek`, `groq`, `glm`, `kimi`, `minimax`.

**Cách 2: nhà cung cấp đăng nhập tài khoản** (ví dụ Kiro, Antigravity, Claude Code, Codex): cần bảng điều khiển OmniRoute, xem ô *Mở bảng điều khiển* ở cuối."""),
 code('''#@title Thêm nhà cung cấp bằng khóa API {display-mode: "form"}
PROVIDER = "openrouter"  #@param ["openrouter", "gemini", "openai", "anthropic", "deepseek", "groq", "glm", "kimi", "minimax"] {allow-input: true}
import tp_omniai
try:
    tp_omniai.add_provider(PROVIDER)
except tp_omniai.SetupError as e:
    print("LỖI:", e)''', "provider"),
 md("""### Tìm model, thử model nào dùng được, và tạo combo có dự phòng
Danh mục của OmniRoute có hàng trăm model nhưng **chỉ một phần dùng được với tài khoản của bạn**. Cách nhanh nhất:
1. **Tìm model:** xem ID model theo từ khóa (ví dụ `claude`, `gpt`).
2. **Thử model:** gửi một tin nhắn rất ngắn tới từng model khớp để biết model nào chạy được (tốn một ít hạn mức).
3. **Tự tạo combo:** notebook tự thử các họ model theo thứ tự ưu tiên (mặc định Claude, GPT, Gemini, DeepSeek), lấy model chạy được đầu tiên của mỗi họ rồi gom thành một combo có dự phòng: model đầu lỗi hoặc hết hạn mức thì OmniRoute tự chuyển sang model kế tiếp. Combo hiện trong nhóm *Tự động* của website.

Muốn tự chọn từng model thì dùng ô *Tạo combo thủ công*."""),
 code('''#@title 1. Tìm model theo từ khóa {display-mode: "form"}
KEYWORD = "claude"  #@param {type:"string"}
import tp_omniai
try:
    tp_omniai.find_models(KEYWORD)
except tp_omniai.SetupError as e:
    print("LỖI:", e)''', "find"),
 code('''#@title 2. Thử xem model nào dùng được {display-mode: "form"}
KEYWORD = "claude"  #@param {type:"string"}
LIMIT = 12  #@param {type:"integer"}
import tp_omniai
try:
    tp_omniai.probe_models(KEYWORD, LIMIT)
except tp_omniai.SetupError as e:
    print("LỖI:", e)''', "probe"),
 code('''#@title 3. Tự tạo combo từ các model dùng được {display-mode: "form"}
COMBO_NAME = "tp-auto"  #@param {type:"string"}
#@markdown Các họ model theo thứ tự ưu tiên, cách nhau bằng dấu phẩy:
PREFER = "claude,gpt,gemini,deepseek"  #@param {type:"string"}
import tp_omniai
try:
    tp_omniai.auto_combo(COMBO_NAME, PREFER)
except tp_omniai.SetupError as e:
    print("LỖI:", e)''', "autocombo"),
 code('''#@title Tạo combo thủ công (tùy chọn) {display-mode: "form"}
COMBO_NAME = "tp-claude-first"  #@param {type:"string"}
#@markdown Danh sách model theo thứ tự ưu tiên, cách nhau bằng dấu phẩy (copy ID từ ô tìm model):
MODELS = ""  #@param {type:"string"}
import tp_omniai
try:
    tp_omniai.create_combo(COMBO_NAME, MODELS)
except tp_omniai.SetupError as e:
    print("LỖI:", e)''', "combo"),
 md("""### Bảng điều khiển OmniRoute (cho nhà cung cấp đăng nhập tài khoản)
Đường hầm của Colab cho bảng điều khiển đã bị lỗi 404 nên notebook dùng một đường hầm tạm thời khác (localhost.run, miễn phí, không cần tài khoản). **Địa chỉ này công khai trong lúc mở, chỉ có mật khẩu bảo vệ**, nên nó tự đóng sau 30 phút và bạn nên đóng ngay khi xong."""),
 code('''#@title Mở bảng điều khiển OmniRoute (tạm thời) {display-mode: "form"}
MINUTES = 30  #@param {type:"integer"}
import tp_omniai
try:
    tp_omniai.open_admin_tunnel(MINUTES)
except tp_omniai.SetupError as e:
    print("LỖI:", e)''', "admin"),
 code('#@title Đóng đường hầm bảng điều khiển {display-mode: "form"}\nimport tp_omniai\ntp_omniai.close_admin_tunnel()', "admin_close"),
 code('#@title Kiểm tra trạng thái {display-mode: "form"}\nimport tp_omniai\ntp_omniai.status()', "status"),
 code('#@title Chẩn đoán (khi website báo "OmniRoute chưa kết nối") {display-mode: "form"}\nimport tp_omniai\ntp_omniai.diagnose()', "diag"),
 code('#@title Sao lưu cấu hình OmniRoute vào Google Drive (tự động mỗi 10 phút nếu đã bật lưu) {display-mode: "form"}\nimport tp_omniai\ntp_omniai.backup_config()', "backup"),
 code('#@title Tắt dịch vụ {display-mode: "form"}\nimport tp_omniai\ntp_omniai.stop()', "stop"),
]
nb = {"cells": cells, "metadata": {"colab": {"name": "TP_OmniAI_Colab.ipynb", "provenance": []}, "kernelspec": {"name": "python3", "display_name": "Python 3"}, "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 0}
out = ROOT/"colab/TP_OmniAI_Colab.ipynb"
out.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
print("Đã tạo", out, f"({out.stat().st_size//1024} KB)")

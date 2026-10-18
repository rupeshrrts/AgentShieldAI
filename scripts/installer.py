#!/usr/bin/env python3
"""AgentShield Enterprise Client Setup (.exe Installer)

Installs and activates the AgentShield AI browser governance & DLP extension
across Google Chrome and Microsoft Edge on Windows.
"""
import os
import sys
import shutil
import winreg
import subprocess
import tkinter as tk
from tkinter import ttk, messagebox
from pathlib import Path

APP_NAME = "AgentShield"
DEFAULT_BACKEND_URL = "http://localhost:8000"
DEFAULT_ORG = "Acme Corp"


def get_resource_path(relative_path: str) -> str:
    """Get absolute path to resource, works for dev and for PyInstaller bundle."""
    try:
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    return os.path.join(base_path, relative_path)


def get_target_install_dir() -> Path:
    """Target installation folder in LocalAppData."""
    local_app_data = os.environ.get("LOCALAPPDATA", os.path.expanduser("~\\AppData\\Local"))
    target = Path(local_app_data) / APP_NAME / "extension"
    return target


def copy_extension_files(dest_dir: Path):
    """Extract bundled extension artifacts into destination directory."""
    src_ext = Path(get_resource_path("extension"))
    if not src_ext.exists():
        raise FileNotFoundError(f"Bundled extension directory not found at: {src_ext}")

    dest_dir.mkdir(parents=True, exist_ok=True)

    # Folders & files to copy
    items_to_copy = [
        "manifest.json",
        "managed_schema.json",
        "blocked.html",
        "blocked.js",
        "test-bench.html",
        "test-bench.js",
        "dist",
        "icons",
        "src",
    ]

    for item in items_to_copy:
        src_item = src_ext / item
        dest_item = dest_dir / item
        if src_item.is_dir():
            shutil.copytree(src_item, dest_item, dirs_exist_ok=True)
        elif src_item.is_file():
            shutil.copy2(src_item, dest_item)



def clean_server_url(server_url: str) -> str:
    """Normalises the optional server address; raises ValueError if it is not a web address."""
    url = (server_url or "").strip().strip('"').strip("'").replace(" ", "").rstrip("/")
    if url and not url.lower().startswith(("https://", "http://")):
        raise ValueError("The server address must start with https:// (or leave it empty).")
    return url


def configure_extension_storage(dest_dir: Path, server_url: str):
    """Write client-config.json, which the extension reads on startup.

    It holds only the server address (apiUrl); no key. Access is granted per user by signing in
    and pasting an activation code. A file left by an older version (with an enrollment code) is
    removed; with no server address no file is written.
    """
    import json
    config_file = dest_dir / "client-config.json"
    if config_file.exists():
        config_file.unlink()
    if not server_url:
        return
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump({"apiUrl": server_url}, f, indent=2)


def create_desktop_shortcut(ext_dir: Path):
    """Create a desktop shortcut to launch protected Chrome browser."""
    try:
        desktop = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / "Desktop"
        chrome_exe = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        if not os.path.exists(chrome_exe):
            chrome_exe = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

        edge_exe = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
        if not os.path.exists(edge_exe):
            edge_exe = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"

        target_browser = chrome_exe if os.path.exists(chrome_exe) else edge_exe
        if not os.path.exists(target_browser):
            return

        batch_launcher = desktop / "AgentShield AI Browser.bat"
        ext_escaped = str(ext_dir.resolve())
        bat_content = f"""@echo off
start "" "{target_browser}" --load-extension="{ext_escaped}" "https://chatgpt.com"
"""
        with open(batch_launcher, "w", encoding="utf-8") as f:
            f.write(bat_content)
    except Exception:
        pass


def run_install(server_url: str = "", log_callback=None):
    """Perform the complete installation sequence."""
    def log(msg):
        if log_callback:
            log_callback(msg)
        else:
            print(msg)

    server_url = clean_server_url(server_url)

    log("Preparing AgentShield installation directory...")
    target_dir = get_target_install_dir()

    log(f"Installing extension files into:\n{target_dir}...")
    copy_extension_files(target_dir)

    if server_url:
        log(f"Saving the server address ({server_url})...")
    else:
        log("No server address set; it comes from the activation code.")
    configure_extension_storage(target_dir, server_url)

    log("[OK] Files installed. Load the folder once from the browser's Extensions page,")
    log("then generate an activation code in the dashboard (My activation) and paste it in the AgentShield icon.")
    return target_dir


# --- GUI Installer Window ---
class AgentShieldInstallerApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("AgentShield — Enterprise AI Security Setup")
        self.root.geometry("560x590")
        self.root.resizable(False, False)
        self.root.configure(bg="#0b1120")

        self.installed_dir = None
        self.setup_ui()

    def setup_ui(self):
        # Header Frame
        header = tk.Frame(self.root, bg="#0f172a", padx=24, pady=18)
        header.pack(fill="x")

        title_lbl = tk.Label(
            header,
            text="AgentShield Client Protection Setup",
            font=("Segoe UI", 16, "bold"),
            fg="#38bdf8",
            bg="#0f172a",
        )
        title_lbl.pack(anchor="w")

        subtitle = tk.Label(
            header,
            text="Autonomous AI Browser Governance, DLP Inspection & Domain Traffic Control",
            font=("Segoe UI", 9),
            fg="#94a3b8",
            bg="#0f172a",
        )
        subtitle.pack(anchor="w", pady=(2, 0))

        # Main Body
        body = tk.Frame(self.root, bg="#0b1120", padx=24, pady=20)
        body.pack(fill="both", expand=True)

        # Server address (optional; access is granted per user with an activation code)
        tk.Label(body, text="AgentShield server address from IT (optional):", font=("Segoe UI", 9, "bold"), fg="#e2e8f0", bg="#0b1120").pack(anchor="w")
        self.server_entry = tk.Entry(body, font=("Consolas", 10), bg="#1e293b", fg="#fff", insertbackground="#fff", relief="flat")
        self.server_entry.pack(fill="x", pady=(4, 6), ipady=5)
        tk.Label(
            body,
            text="After installing: generate an activation code in the AgentShield dashboard (My activation),\n"
                 "click the AgentShield icon, paste the code and click \"Connect and verify\".",
            font=("Segoe UI", 8), fg="#94a3b8", bg="#0b1120", justify="left",
        ).pack(anchor="w", pady=(0, 14))

        # Status / Log Box
        tk.Label(body, text="Installation Progress:", font=("Segoe UI", 8, "bold"), fg="#94a3b8", bg="#0b1120").pack(anchor="w")
        self.log_box = tk.Text(body, height=4, font=("Consolas", 8), bg="#070b14", fg="#38bdf8", relief="flat", padx=8, pady=6)
        self.log_box.pack(fill="x", pady=(4, 16))
        self.log_box.insert("end", "Ready to install and activate AgentShield protection.\n")
        self.log_box.configure(state="disabled")

        # Action Buttons Frame
        btn_frame = tk.Frame(body, bg="#0b1120")
        btn_frame.pack(fill="x", side="bottom")

        self.install_btn = tk.Button(
            btn_frame,
            text="Install & Activate Protection",
            font=("Segoe UI", 10, "bold"),
            bg="#0284c7",
            fg="#ffffff",
            activebackground="#0369a1",
            activeforeground="#ffffff",
            relief="flat",
            cursor="hand2",
            padx=18,
            pady=8,
            command=self.start_install,
        )
        self.install_btn.pack(side="right")

        self.launch_btn = tk.Button(
            btn_frame,
            text="Open Extensions Page",
            font=("Segoe UI", 10, "bold"),
            bg="#10b981",
            fg="#ffffff",
            activebackground="#059669",
            activeforeground="#ffffff",
            relief="flat",
            cursor="hand2",
            padx=16,
            pady=8,
            command=self.launch_browser,
            state="disabled",
        )
        self.launch_btn.pack(side="left")

    def append_log(self, text: str):
        self.log_box.configure(state="normal")
        self.log_box.insert("end", text + "\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")
        self.root.update_idletasks()

    def start_install(self):
        server_url = self.server_entry.get().strip()

        self.install_btn.configure(state="disabled", text="Installing...")

        try:
            target_dir = run_install(server_url, log_callback=self.append_log)
            self.installed_dir = target_dir
            self.install_btn.configure(text="Installed [OK]", bg="#334155")
            self.launch_btn.configure(state="normal")

            messagebox.showinfo(
                "AgentShield installed",
                "AgentShield is installed.\n\n"
                f"Last steps (one time): in Chrome or Edge open the Extensions page, turn on Developer mode, "
                f"click 'Load unpacked' and select:\n{target_dir}\n\n"
                "Then sign in to the AgentShield dashboard (or create an account), open My activation and "
                "click 'Generate activation code'. Click the AgentShield toolbar icon, paste the code and "
                "click 'Connect and verify'. "
                "AI sites stay blocked until then."
            )
        except Exception as exc:
            self.append_log(f"ERROR: {str(exc)}")
            messagebox.showerror("Installation Error", f"Failed to install AgentShield:\n{str(exc)}")
            self.install_btn.configure(state="normal", text="Retry Install")

    def launch_browser(self):
        if not self.installed_dir:
            return

        chrome_exe = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        if not os.path.exists(chrome_exe):
            chrome_exe = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

        edge_exe = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
        if not os.path.exists(edge_exe):
            edge_exe = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"

        browser_exe = chrome_exe if os.path.exists(chrome_exe) else edge_exe
        if os.path.exists(browser_exe):
            # Recent Chrome versions ignore --load-extension, so open the Extensions page for "Load unpacked"
            ext_page = "edge://extensions" if browser_exe.lower().endswith("msedge.exe") else "chrome://extensions"
            subprocess.Popen([browser_exe, ext_page])
            os.startfile(str(self.installed_dir))
            self.root.destroy()
        else:
            messagebox.showwarning("Browser Not Found", "Could not locate Chrome or Edge executable.")


def _arg(name: str, default: str = "") -> str:
    """Reads /name=value from the command line."""
    prefix = f"/{name}="
    for a in sys.argv[1:]:
        if a.lower().startswith(prefix):
            return a[len(prefix):]
    return default


def main():
    if "/silent" in sys.argv:
        # Automated headless installation for IT deployments:
        #   AgentShield-Setup.exe /silent [/server=https://agentshield.company.com]
        # Each user still activates their own browser (activation code from the dashboard).
        run_install(_arg("server"))
        sys.exit(0)

    root = tk.Tk()
    app = AgentShieldInstallerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()

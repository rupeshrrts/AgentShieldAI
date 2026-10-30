"""Self-installer built into agentshield-agent.exe.

Double-clicking the exe (no arguments) runs `install`: it asks Windows for administrator rights, sets
everything up, and asks for the activation code — one exe, no scripts, no Developer mode. The same
machine steps are also available through GPO/Intune for a managed fleet (see agent/README.md); this
installer is the per-PC path for pilots and unmanaged computers.

What install does (administrator):
  1. copies the exe to Program Files and locks the data folder to SYSTEM + Administrators;
  2. generates this PC's inspection certificate (AI domains only) and adds it to Trusted Root;
  3. writes a PAC proxy that sends ONLY the AI domains to the local agent, everything else direct;
  4. registers a SYSTEM scheduled task that runs the agent at startup (and starts it now);
  5. asks for the portal activation code and connects the PC.

uninstall reverses all of it.
"""
import ctypes
import os
import subprocess
import sys
import winreg
from pathlib import Path

from . import ca, config, state
from .client import ApiError, ServerClient, connect_pc
from . import keys

INSTALL_DIR = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "AgentShield" / "Agent"
INSTALLED_EXE = INSTALL_DIR / "agentshield-agent.exe"
PAC_PATH = config.DATA_DIR / "agentshield.pac"
TASK_NAME = "AgentShieldAgent"
CERT_SUBJECT_MATCH = ca.CA_NAME_PREFIX


def is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def _is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _relaunch_as_admin(args) -> int:
    """Re-launches this exe elevated with the given args. Returns an exit code for the current process."""
    params = " ".join(f'"{a}"' if " " in a else a for a in args)
    rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, params, None, 1)
    if rc <= 32:
        print("AgentShield needs administrator rights to install. Please allow the prompt and try again.")
        return 1
    return 0


def _run(cmd) -> int:
    return subprocess.run(cmd, capture_output=True, text=True).returncode


def _pac_contents() -> str:
    conds = "\n".join(
        f'    if (dnsDomainIs(host, "{d}") || shExpMatch(host, "*.{d}")) return proxy;'
        for d in config.INTERCEPT_DOMAINS
    )
    return (
        "// AgentShield: only AI domains go to the local inspector; everything else is direct.\n"
        "function FindProxyForURL(url, host) {\n"
        f'    var proxy = "PROXY 127.0.0.1:{config.LISTEN_PORT}";\n'
        f"{conds}\n"
        '    return "DIRECT";\n'
        "}\n"
    )


def _set_proxy(enable: bool) -> None:
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                         r"Software\Microsoft\Windows\CurrentVersion\Internet Settings", 0, winreg.KEY_SET_VALUE)
    try:
        if enable:
            pac_url = "file:///" + str(PAC_PATH).replace("\\", "/")
            winreg.SetValueEx(key, "AutoConfigURL", 0, winreg.REG_SZ, pac_url)
        else:
            try:
                winreg.DeleteValue(key, "AutoConfigURL")
            except FileNotFoundError:
                pass
    finally:
        winreg.CloseKey(key)


def _trust_cert() -> None:
    cer = config.DATA_DIR / ca.CA_DIR / ca.CA_CERT_FILE
    _run(["certutil", "-f", "-addstore", "Root", str(cer)])


def _untrust_certs() -> None:
    # Remove any AgentShield inspection CA from the machine Root store (there may be more than one).
    out = subprocess.run(["certutil", "-store", "Root"], capture_output=True, text=True).stdout
    for block in out.split("================"):
        if CERT_SUBJECT_MATCH in block:
            for line in block.splitlines():
                line = line.strip()
                if line.lower().startswith("cert hash") and ":" in line:
                    thumb = line.split(":", 1)[1].strip().replace(" ", "")
                    _run(["certutil", "-delstore", "Root", thumb])


def _install_service() -> None:
    subprocess.run(["schtasks", "/Create", "/TN", TASK_NAME, "/TR", f'"{INSTALLED_EXE}" run',
                    "/SC", "ONSTART", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F"], capture_output=True, text=True)
    subprocess.run(["schtasks", "/Run", "/TN", TASK_NAME], capture_output=True, text=True)


def _remove_service() -> None:
    subprocess.run(["schtasks", "/End", "/TN", TASK_NAME], capture_output=True, text=True)
    subprocess.run(["schtasks", "/Delete", "/TN", TASK_NAME, "/F"], capture_output=True, text=True)


def _prompt(text: str) -> str:
    try:
        return input(text).strip()
    except (EOFError, KeyboardInterrupt):
        return ""


def install(code: str = None, firefox: bool = True, interactive: bool = True) -> int:
    if sys.platform != "win32":
        print("The installer runs on Windows only. On other systems use `connect` + `run`.")
        return 2
    if not _is_admin():
        argv = ["install"] + (["--code", code] if code else [])
        return _relaunch_as_admin(argv)

    print("Installing AgentShield Network Agent...")
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Copy the running exe into Program Files (unless we are already it)
    src = Path(sys.executable) if is_frozen() else None
    if src and src.resolve() != INSTALLED_EXE.resolve():
        import shutil
        shutil.copy2(src, INSTALLED_EXE)
    _run(["icacls", str(config.DATA_DIR), "/inheritance:r",
          "/grant:r", "SYSTEM:(OI)(CI)F", "/grant:r", "Administrators:(OI)(CI)F"])

    # 2. Certificate (AI domains only) -> Trusted Root
    if ca.load_ca() is None:
        ca.create_ca()
    _trust_cert()
    if firefox:
        _firefox_trust()

    # 3. PAC proxy (AI domains only) + turn it on
    PAC_PATH.write_text(_pac_contents(), encoding="utf-8")
    _set_proxy(True)

    # 4. Service
    _install_service()

    # 5. Connect
    conn = state.read_json(state.STATE)
    if not conn:
        if not code and interactive:
            print("\nPaste the activation code from the portal (Connect browser -> Generate activation code).")
            code = _prompt("Activation code (ASA1...): ")
        if code:
            try:
                conn = connect_pc(code)
                state.write_json(state.STATE, conn)
                print(f"Connected as {conn.get('user_email')} ({conn.get('organization_name')}).")
            except (ValueError, ApiError) as e:
                print(f"Could not connect yet: {getattr(e, 'message', e)}")
                print(f'You can connect later:  "{INSTALLED_EXE}" connect ASA1....')
        else:
            print(f'No code entered. Connect later:  "{INSTALLED_EXE}" connect ASA1....')

    print("\nDone. AgentShield now protects AI sites in every browser on this PC - no extension, no Developer mode.")
    print("Restart open browsers so they use the proxy.")
    if interactive:
        _prompt("\nPress Enter to close...")
    return 0


def uninstall(interactive: bool = True) -> int:
    if sys.platform != "win32":
        print("Nothing to uninstall on this system.")
        return 0
    if not _is_admin():
        return _relaunch_as_admin(["uninstall"])
    print("Removing AgentShield Network Agent...")
    conn = state.read_json(state.STATE)
    if conn:
        try:
            ServerClient(conn["api_url"]).pc_deactivate(conn["computer_id"], keys.load_protected(conn["computer_key"]))
        except Exception:
            pass
    _remove_service()
    subprocess.run(["taskkill", "/IM", "agentshield-agent.exe", "/F"], capture_output=True, text=True)
    _set_proxy(False)
    _untrust_certs()
    _firefox_untrust()
    state.remove(state.STATE)
    state.remove(state.QUEUE)
    import shutil
    shutil.rmtree(INSTALL_DIR, ignore_errors=True)
    shutil.rmtree(config.DATA_DIR, ignore_errors=True)
    print("Removed. Restart open browsers to drop the proxy.")
    if interactive:
        _prompt("\nPress Enter to close...")
    return 0


def _firefox_dirs():
    for base in (os.environ.get("ProgramFiles", r"C:\Program Files"),
                 os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")):
        d = Path(base) / "Mozilla Firefox"
        if d.is_dir():
            yield d / "distribution"


def _firefox_trust() -> None:
    for dist in _firefox_dirs():
        dist.mkdir(parents=True, exist_ok=True)
        (dist / "policies.json").write_text(
            '{ "policies": { "Certificates": { "ImportEnterpriseRoots": true } } }', encoding="utf-8")


def _firefox_untrust() -> None:
    for dist in _firefox_dirs():
        try:
            (dist / "policies.json").unlink()
        except FileNotFoundError:
            pass

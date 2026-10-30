# PyInstaller spec for agentshield-agent.exe
#
# Build (from the project root, using the backend venv which has cryptography + pyinstaller):
#   backend\.venv\Scripts\python.exe -m PyInstaller agent\packaging\agentshield-agent.spec ^
#       --distpath agent\packaging\dist --workpath agent\packaging\build --noconfirm
#
# One self-contained console exe. It bundles the agent package and the backend's detector/policy
# evaluator (the "twins"), so the same rules as the server are enforced with no extra files.
import os

ROOT = os.path.abspath(os.path.join(SPECPATH, "..", ".."))
AGENT = os.path.join(ROOT, "agent")
BACKEND = os.path.join(ROOT, "backend")

a = Analysis(
    [os.path.join(AGENT, "packaging", "agentshield_agent_main.py")],
    pathex=[AGENT, BACKEND],
    binaries=[],
    datas=[],
    hiddenimports=[
        "agentshield_agent.cli",
        "agentshield_agent.agent",
        "agentshield_agent.proxy",
        # the shared backend twins, imported at runtime by engine.py
        "app",
        "app.detection",
        "app.detection.detector",
        "app.policies",
        "app.policies.evaluator",
        "app.core",
        "app.core.catalog",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["fastapi", "starlette", "uvicorn", "sqlalchemy", "pydantic", "tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name="agentshield-agent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

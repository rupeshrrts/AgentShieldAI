"""Frozen entry point for agentshield-agent.exe (PyInstaller).

Just hands control to the normal CLI. The backend's detector and policy evaluator (the twins) are
bundled read-only by the spec so the exe needs no separate backend checkout at runtime.
"""
import sys

from agentshield_agent.cli import main

if __name__ == "__main__":
    sys.exit(main())

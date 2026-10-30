"""Command line of the AgentShield Network Agent.

    python -m agentshield_agent connect <ASA1 code> [--server URL] [--name PC-NAME]
    python -m agentshield_agent status
    python -m agentshield_agent disconnect
    python -m agentshield_agent new-ca
    python -m agentshield_agent run [--host 127.0.0.1] [--port 8080]   # built-in proxy (dev)

For the mitmproxy-based setup use `connect` here, then run mitmdump with agent/mitm/agentshield_addon.py
(see agent/README.md). Trusting the certificate and locking the proxy for every user is an IT step
done through GPO / Intune, not by this tool.
"""
import argparse
import json
import logging
import sys

from . import ca as ca_mod
from . import config, state
from .client import ApiError, ServerClient, connect_pc
from . import keys


def cmd_connect(args) -> int:
    if state.read_json(state.STATE):
        print("This PC is already connected. Run `disconnect` first.", file=sys.stderr)
        return 2
    try:
        conn = connect_pc(args.code, server_url=args.server, pc_name=args.name)
    except (ValueError, ApiError) as e:
        print(f"Could not connect: {getattr(e, 'message', e)}", file=sys.stderr)
        return 1
    state.write_json(state.STATE, conn)
    if ca_mod.load_ca() is None:
        ca_mod.create_ca()
    print(f"Connected to {conn.get('organization_name') or conn['api_url']} as {conn.get('user_email')}.")
    print("Next: trust the AgentShield certificate and point browsers at the proxy (see agent/README.md).")
    return 0


def cmd_disconnect(args) -> int:
    conn = state.read_json(state.STATE)
    if not conn:
        print("This PC is not connected.")
        return 0
    try:
        client = ServerClient(conn["api_url"])
        client.pc_deactivate(conn["computer_id"], keys.load_protected(conn["computer_key"]))
        print("Disconnected on the server.")
    except (ApiError, KeyError, ValueError) as e:
        # Still clear local state even if the server could not be reached
        print(f"Server not updated ({getattr(e, 'message', e)}); clearing this PC anyway.", file=sys.stderr)
    state.remove(state.STATE)
    state.remove(state.QUEUE)
    ca_mod.delete_ca()
    print("Local connection and certificate removed.")
    return 0


def cmd_status(args) -> int:
    status = state.read_json(state.STATUS) or {}
    conn = state.read_json(state.STATE)
    if not status:
        status = {"connected": bool(conn), "authorized": False,
                  "reason": "The agent service has not reported yet." if conn else "This PC is not connected."}
    print(json.dumps(status, indent=2))
    return 0 if status.get("authorized") else 1


def cmd_new_ca(args) -> int:
    cert = ca_mod.create_ca()
    print(f"New certificate written to {ca_mod.ca_cert_path()}")
    print(f"Valid for: {', '.join(config.INTERCEPT_DOMAINS)}")
    print(f"Serial: {cert.serial_number:x}")
    return 0


def cmd_run(args) -> int:
    from .agent import Agent
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    agent = Agent()
    try:
        agent.run(host=args.host, port=args.port)
    except KeyboardInterrupt:
        agent.stop()
    return 0


def cmd_install(args) -> int:
    from . import installer
    return installer.install(code=args.code, firefox=not args.no_firefox)


def cmd_uninstall(args) -> int:
    from . import installer
    return installer.uninstall()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="agentshield_agent", description="AgentShield Network Agent")
    sub = p.add_subparsers(dest="command", required=False)

    i = sub.add_parser("install", help="install on this PC (asks for admin + your code); the default when double-clicked")
    i.add_argument("--code", help="activation code to connect during install (otherwise it asks)")
    i.add_argument("--no-firefox", action="store_true", help="do not set Firefox to trust the certificate")
    i.set_defaults(func=cmd_install)

    sub.add_parser("uninstall", help="remove AgentShield from this PC").set_defaults(func=cmd_uninstall)

    c = sub.add_parser("connect", help="connect this PC with a portal code")
    c.add_argument("code", help="ASA1.… code from the portal, or a bare asa_… token with --server")
    c.add_argument("--server", help="server URL (only with a bare asa_… token)")
    c.add_argument("--name", help="name shown in the portal (default: this PC's hostname)")
    c.set_defaults(func=cmd_connect)

    sub.add_parser("disconnect", help="remove this PC from the account").set_defaults(func=cmd_disconnect)
    sub.add_parser("status", help="show the current connection state").set_defaults(func=cmd_status)
    sub.add_parser("new-ca", help="(re)create this PC's local certificate").set_defaults(func=cmd_new_ca)

    r = sub.add_parser("run", help="run the built-in proxy in the foreground (development)")
    r.add_argument("--host", default=config.LISTEN_HOST)
    r.add_argument("--port", type=int, default=config.LISTEN_PORT)
    r.set_defaults(func=cmd_run)
    return p


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    # Double-clicking the exe (no arguments) runs the installer.
    if not getattr(args, "func", None):
        from . import installer
        return installer.install()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

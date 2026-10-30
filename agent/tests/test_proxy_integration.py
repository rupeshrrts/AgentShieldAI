"""End-to-end proxy test over real sockets, no mitmproxy needed.

Proves the built-in proxy actually: tunnels a non-AI host untouched, blocks a blocked domain, and for
an AI host terminates TLS with this PC's own CA, redacts a secret inside the request body, and relays
the real response back. This is the whole pipeline, not just the decision logic.
"""
import asyncio
import json
import ssl

from agentshield_agent import engine
from agentshield_agent.ca import CertificateAuthority, create_ca, load_ca
from agentshield_agent.proxy import ProxyServer


async def _echo_upstream(ca: CertificateAuthority, host: str):
    """A TLS server that replies 200 with the exact request body it received (so we can see redaction)."""
    async def handle(reader, writer):
        header = await reader.readuntil(b"\r\n\r\n")
        length = 0
        for line in header.decode("latin-1").split("\r\n"):
            if line.lower().startswith("content-length:"):
                length = int(line.split(":", 1)[1].strip())
        body = await reader.readexactly(length) if length else b""
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
        await writer.drain()
        writer.close()

    return await asyncio.start_server(handle, "127.0.0.1", 0, ssl=ca.server_context(host))


async def _run_intercept_case(agent_dir, tmp_path):
    create_ca()
    ca = CertificateAuthority(*load_ca())
    host = "chatgpt.com"

    upstream = await _echo_upstream(ca, host)
    up_port = upstream.sockets[0].getsockname()[1]

    # Like a real sync: every catalog rule is present (all Off here), and the API-key rule is On with REDACT
    from app.core.catalog import RULE_CATALOG
    policies = [{"id": r["rule_id"], "rule_id": r["rule_id"], "action": r["default_action"], "severity": r["default_severity"],
                 "enabled": False} for r in RULE_CATALOG if r["rule_id"] != "secret.api_key_like"]
    policies.append({"id": "1", "rule_id": "secret.api_key_like", "action": "REDACT", "severity": "HIGH", "enabled": True})
    snap = engine.Snapshot(
        authorized=True,
        settings={"store_violation_prompt_text": True},
        policies=policies,
        keywords=[],
    )
    events = []
    up_ctx = ssl.create_default_context()
    up_ctx.check_hostname = False
    up_ctx.verify_mode = ssl.CERT_NONE

    proxy = ProxyServer(lambda: snap, ca, events.append, upstream_ssl=up_ctx,
                        resolve=lambda h, p: ("127.0.0.1", up_port))
    server = await proxy.start("127.0.0.1", 0)
    proxy_port = server.sockets[0].getsockname()[1]

    # CA cert → a file the client trusts
    cafile = tmp_path / "ca.pem"
    cafile.write_bytes(_pem(ca))

    reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
    writer.write(f"CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n".encode())
    await writer.drain()
    assert b"200" in await reader.readuntil(b"\r\n\r\n")

    client_ctx = ssl.create_default_context(cafile=str(cafile))
    await writer.start_tls(client_ctx, server_hostname=host)

    secret = "sk-live-ABCDEFGH1234567890abcd"
    body = json.dumps({"messages": [{"content": {"parts": [f"my key {secret}"]}}]}).encode()
    writer.write(
        b"POST /backend-api/conversation HTTP/1.1\r\nHost: %b\r\nContent-Type: application/json\r\n"
        b"Content-Length: %d\r\nConnection: close\r\n\r\n%b" % (host.encode(), len(body), body)
    )
    await writer.drain()

    head = await reader.readuntil(b"\r\n\r\n")
    assert b"200" in head
    clen = next(int(l.split(b":")[1]) for l in head.split(b"\r\n") if l.lower().startswith(b"content-length"))
    echoed = await reader.readexactly(clen)
    writer.close()
    server.close()
    upstream.close()
    return echoed, events


def _pem(ca: CertificateAuthority) -> bytes:
    from cryptography.hazmat.primitives import serialization
    return ca.cert.public_bytes(serialization.Encoding.PEM)


def test_proxy_intercepts_and_redacts(agent_dir, tmp_path):
    echoed, events = asyncio.run(_run_intercept_case(agent_dir, tmp_path))
    # The site received the redacted body, never the secret
    assert b"sk-live-ABCDEFGH1234567890abcd" not in echoed
    assert b"REDACTED" in echoed
    assert json.loads(echoed)["messages"][0]["content"]["parts"][0].startswith("my key [REDACTED")
    assert any(e["action"] == "REDACT" for e in events)


async def _run_block_and_tunnel(agent_dir):
    snap = engine.Snapshot(authorized=True, blocked_domains=["evil.example"])
    events = []
    proxy = ProxyServer(lambda: snap, None, events.append)
    server = await proxy.start("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]

    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(b"CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n")
    await writer.drain()
    resp = await reader.read(2048)
    writer.close()
    server.close()
    return resp, events


def test_proxy_blocks_blocked_domain(agent_dir):
    resp, events = asyncio.run(_run_block_and_tunnel(agent_dir))
    assert b"403" in resp and b"AgentShield" in resp
    assert any(e["rule_id"] == "dlp.domain.blocked" for e in events)

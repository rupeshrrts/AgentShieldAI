"""The local proxy (127.0.0.1:8080) that every browser on the PC uses through the Windows proxy setting.

* Non-AI HTTPS: CONNECT tunnel, bytes copied untouched (never decrypted). Blocked websites get 403.
* AI sites (config.INTERCEPT_DOMAINS): TLS is terminated with a certificate from this PC's own
  name-constrained CA, each request is read, prompts are checked (engine.check_prompt) and then sent
  to the real site over a normal, verified TLS connection. Responses (including streamed answers and
  WebSockets) are relayed as they arrive.
* Fail closed: until the server has issued a session, AI sites get the "Activation required" page.
"""
import asyncio
import gzip
import html
import json
import logging
import ssl
import zlib
from typing import Callable, Dict, List, Optional, Tuple

from . import config, engine
from .ca import CertificateAuthority

log = logging.getLogger("agentshield.proxy")

MAX_HEADER_BYTES = 64 * 1024
INSPECT_METHODS = {"POST", "PUT", "PATCH"}
NO_BODY_STATUSES = {204, 304}
HOP_HEADERS = {"proxy-connection", "proxy-authorization", "keep-alive"}

Headers = List[Tuple[str, str]]


class BadRequest(Exception):
    pass


def _get(headers: Headers, name: str) -> Optional[str]:
    name = name.lower()
    for k, v in headers:
        if k.lower() == name:
            return v
    return None


def _without(headers: Headers, *names: str) -> Headers:
    drop = {n.lower() for n in names}
    return [(k, v) for k, v in headers if k.lower() not in drop]


def _serialize(start_line: str, headers: Headers) -> bytes:
    return (start_line + "\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers) + "\r\n").encode("latin-1")


async def _read_head(reader: asyncio.StreamReader) -> Optional[Tuple[str, Headers]]:
    try:
        raw = await reader.readuntil(b"\r\n\r\n")
    except asyncio.IncompleteReadError as e:
        if not e.partial.strip():
            return None
        raise BadRequest("incomplete header")
    except asyncio.LimitOverrunError:
        raise BadRequest("header too large")
    if len(raw) > MAX_HEADER_BYTES:
        raise BadRequest("header too large")
    lines = raw.decode("latin-1").split("\r\n")
    headers: Headers = []
    for line in lines[1:]:
        if not line:
            continue
        if ":" not in line:
            raise BadRequest("bad header line")
        k, v = line.split(":", 1)
        headers.append((k.strip(), v.strip()))
    return lines[0], headers


async def _read_chunked(reader: asyncio.StreamReader, limit: Optional[int]) -> bytes:
    body = bytearray()
    while True:
        size_line = await reader.readuntil(b"\r\n")
        size = int(size_line.split(b";")[0].strip() or b"0", 16)
        if size == 0:
            # trailers
            while (await reader.readuntil(b"\r\n")) != b"\r\n":
                pass
            return bytes(body)
        body += await reader.readexactly(size)
        await reader.readexactly(2)
        if limit is not None and len(body) > limit:
            raise BadRequest("body too large")


async def _relay_chunked(reader, writer):
    while True:
        size_line = await reader.readuntil(b"\r\n")
        writer.write(size_line)
        size = int(size_line.split(b";")[0].strip() or b"0", 16)
        if size == 0:
            while True:
                line = await reader.readuntil(b"\r\n")
                writer.write(line)
                if line == b"\r\n":
                    break
            await writer.drain()
            return
        remaining = size + 2
        while remaining:
            data = await reader.read(min(remaining, 65536))
            if not data:
                raise ConnectionError("upstream closed mid-chunk")
            writer.write(data)
            remaining -= len(data)
        await writer.drain()


async def _relay_exact(reader, writer, n: int):
    while n > 0:
        data = await reader.read(min(n, 65536))
        if not data:
            raise ConnectionError("connection closed early")
        writer.write(data)
        n -= len(data)
        await writer.drain()


async def _relay_until_eof(reader, writer):
    while True:
        data = await reader.read(65536)
        if not data:
            return
        writer.write(data)
        await writer.drain()


async def _pipe(reader, writer):
    try:
        await _relay_until_eof(reader, writer)
    except (ConnectionError, OSError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


def _decode_body(body: bytes, encoding: Optional[str]) -> Optional[bytes]:
    enc = (encoding or "identity").lower().strip()
    if enc in ("", "identity"):
        return body
    try:
        if enc == "gzip":
            return gzip.decompress(body)
        if enc == "deflate":
            return zlib.decompress(body)
    except (OSError, zlib.error):
        return None
    return None


def block_response(rule_id: str, reason: str, html_page: bool, host: str, status: int = 403) -> bytes:
    message = f"AgentShield: {reason}"
    if html_page:
        body = (
            "<!doctype html><html><head><meta charset='utf-8'><title>Blocked by AgentShield</title>"
            "<style>body{font-family:Segoe UI,system-ui,sans-serif;background:#f6f7f9;color:#1f2933;margin:0}"
            "main{max-width:560px;margin:12vh auto;padding:32px;background:#fff;border-radius:12px;"
            "box-shadow:0 2px 12px rgba(0,0,0,.08)}h1{font-size:22px;margin:0 0 12px}code{color:#52606d}</style>"
            f"</head><body><main><h1>Blocked by AgentShield</h1><p>{html.escape(reason)}</p>"
            f"<p><code>{html.escape(host)} &middot; {html.escape(rule_id)}</code></p></main></body></html>"
        ).encode("utf-8")
        ctype = "text/html; charset=utf-8"
    else:
        # Chat sites show "detail" / "error.message" of a failed request in their own error banner
        body = json.dumps({"detail": message, "error": {"message": message, "type": "agentshield_blocked", "code": rule_id}}).encode("utf-8")
        ctype = "application/json"
    head = _serialize(f"HTTP/1.1 {status} {'Forbidden' if status == 403 else 'Blocked'}", [
        ("Content-Type", ctype), ("Content-Length", str(len(body))), ("Cache-Control", "no-store"),
        ("X-AgentShield", rule_id or "blocked"), ("Connection", "close"),
    ])
    return head + body


def _wants_html(method: str, headers: Headers) -> bool:
    accept = (_get(headers, "accept") or "").lower()
    return method == "GET" and "text/html" in accept


class ProxyServer:
    def __init__(self, snapshot: Callable[[], engine.Snapshot], ca: Optional[CertificateAuthority],
                 on_event: Callable[[dict], None], warn: Optional[engine.WarnMemory] = None,
                 upstream_ssl: Optional[ssl.SSLContext] = None,
                 resolve: Optional[Callable[[str, int], Tuple[str, int]]] = None):
        self.snapshot = snapshot
        self.ca = ca
        self.on_event = on_event
        self.warn = warn or engine.WarnMemory()
        self.upstream_ssl = upstream_ssl or ssl.create_default_context()
        self.resolve = resolve or (lambda h, p: (h, p))
        self.server: Optional[asyncio.AbstractServer] = None

    async def start(self, host: str = config.LISTEN_HOST, port: int = config.LISTEN_PORT):
        self.server = await asyncio.start_server(self._handle, host, port, limit=MAX_HEADER_BYTES * 2)
        return self.server

    async def _open(self, host: str, port: int, tls: bool):
        rhost, rport = self.resolve(host, port)
        if tls:
            return await asyncio.wait_for(
                asyncio.open_connection(rhost, rport, ssl=self.upstream_ssl, server_hostname=host, limit=MAX_HEADER_BYTES * 2), 30)
        return await asyncio.wait_for(asyncio.open_connection(rhost, rport, limit=MAX_HEADER_BYTES * 2), 30)

    # ------------------------------------------------------------ client connections

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            head = await _read_head(reader)
            if head is None:
                return
            start, headers = head
            parts = start.split(" ")
            if len(parts) != 3:
                raise BadRequest("bad request line")
            method, target, _version = parts
            if method.upper() == "CONNECT":
                await self._connect(reader, writer, target)
            else:
                await self._plain_http(reader, writer, method.upper(), target, headers)
        except BadRequest as e:
            try:
                writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await writer.drain()
            except Exception:
                pass
            log.debug("bad request: %s", e)
        except (ConnectionError, OSError, asyncio.IncompleteReadError, asyncio.TimeoutError, ssl.SSLError) as e:
            log.debug("connection ended: %s", e)
        except Exception:
            log.exception("proxy error")
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def _connect(self, reader, writer, target: str):
        host, _, port_s = target.rpartition(":")
        host = host.strip("[]").lower()
        try:
            port = int(port_s)
        except ValueError:
            raise BadRequest("bad CONNECT target")
        snap = self.snapshot()
        if config.is_intercepted(host) and self.ca is not None:
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            await writer.start_tls(self.ca.server_context(host))
            await self._intercepted(reader, writer, host, port)
            return
        verdict = engine.host_verdict(snap, host)
        if verdict.blocked:
            self._record_block(host, verdict.rule_id, verdict.reason)
            writer.write(block_response(verdict.rule_id, verdict.reason, False, host))
            await writer.drain()
            return
        if config.is_intercepted(host):
            # No CA on this PC (installation incomplete): fail closed for AI sites
            writer.write(block_response("access.inspection_unavailable", "AgentShield cannot inspect this AI site on this PC. Reinstall AgentShield.", False, host))
            await writer.drain()
            return
        up_reader, up_writer = await self._open(host, port, tls=False)
        writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await writer.drain()
        await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer))

    async def _plain_http(self, reader, writer, method: str, target: str, headers: Headers):
        if not target.lower().startswith("http://"):
            # Someone opened the proxy port directly in a browser
            body = b"AgentShield Network Agent is running.\n"
            writer.write(_serialize("HTTP/1.1 200 OK", [("Content-Type", "text/plain"), ("Content-Length", str(len(body))), ("Connection", "close")]) + body)
            await writer.drain()
            return
        rest = target[7:]
        authority, slash, path = rest.partition("/")
        path = slash + path or "/"
        host, _, port_s = authority.rpartition(":") if ":" in authority else (authority, "", "80")
        host = host.lower()
        port = int(port_s or 80)
        await self._exchange(reader, writer, method, path, headers, host, port, tls=False)

    async def _intercepted(self, reader, writer, host: str, port: int):
        upstream = None
        try:
            while True:
                head = await _read_head(reader)
                if head is None:
                    return
                start, headers = head
                parts = start.split(" ")
                if len(parts) != 3:
                    raise BadRequest("bad request line")
                keep, upstream = await self._exchange(reader, writer, parts[0].upper(), parts[1], headers, host, port,
                                                      tls=True, upstream=upstream)
                if not keep:
                    return
        finally:
            if upstream:
                try:
                    upstream[1].close()
                except Exception:
                    pass

    # ------------------------------------------------------------ one request / response

    async def _exchange(self, reader, writer, method, path, headers: Headers, host, port, tls: bool,
                        upstream=None):
        """Handles one request. Returns (keep_client_connection, upstream_connection)."""
        snap = self.snapshot()
        verdict = engine.host_verdict(snap, host)
        body: Optional[bytes] = None
        te = (_get(headers, "transfer-encoding") or "").lower()
        length = int(_get(headers, "content-length") or 0) if not te else None
        stream_body = False

        if te and "chunked" in te:
            body = await _read_chunked(reader, config.MAX_INSPECT_BYTES)
            headers = _without(headers, "transfer-encoding") + [("Content-Length", str(len(body)))]
        elif length:
            if length <= config.MAX_INSPECT_BYTES:
                body = await reader.readexactly(length)
            else:
                stream_body = True
        if verdict.blocked:
            if stream_body:
                await _relay_exact(reader, _Discard(), length)
            self._record_block(host, verdict.rule_id, verdict.reason)
            writer.write(block_response(verdict.rule_id, verdict.reason, _wants_html(method, headers), host))
            await writer.drain()
            return False, upstream

        if tls and method in INSPECT_METHODS:
            ctype = _get(headers, "content-type") or ""
            textual = any(t in ctype.lower() for t in ("json", "text/", "x-www-form-urlencoded")) or not ctype
            if stream_body and textual:
                await _relay_exact(reader, _Discard(), length)
                writer.write(block_response("dlp.too_large", "This request is too large to be checked, so it was not sent.", False, host, 413))
                await writer.drain()
                return False, upstream
            if body:
                plain = _decode_body(body, _get(headers, "content-encoding"))
                if plain is None and textual:
                    writer.write(block_response("dlp.uninspectable", "This request could not be checked, so it was not sent.", False, host))
                    await writer.drain()
                    return False, upstream
                if plain is not None:
                    pv = engine.check_prompt(snap, host, ctype, plain, self.warn)
                    if pv.event:
                        self.on_event(pv.event)
                    if not pv.forward:
                        writer.write(block_response(pv.rule_id, pv.reason, False, host))
                        await writer.drain()
                        return False, upstream
                    if pv.body is not None:
                        body = pv.body
                        headers = _without(headers, "content-length", "content-encoding") + [("Content-Length", str(len(body)))]

        # Send to the real site
        out_headers = [(k, v) for k, v in headers if k.lower() not in HOP_HEADERS]
        if not tls:
            out_headers = _without(out_headers, "connection") + [("Connection", "close")]
        for attempt in (0, 1):
            if upstream is None:
                upstream = await self._open(host, port, tls)
            up_reader, up_writer = upstream
            try:
                up_writer.write(_serialize(f"{method} {path} HTTP/1.1", out_headers))
                if body:
                    up_writer.write(body)
                await up_writer.drain()
                if stream_body:
                    await _relay_exact(reader, up_writer, length)
                resp = await _read_head(up_reader)
                if resp is None:
                    raise ConnectionError("upstream closed")
                break
            except (ConnectionError, OSError, asyncio.IncompleteReadError):
                # A kept-alive upstream connection may have been closed by the site: retry once on a new one
                try:
                    up_writer.close()
                except Exception:
                    pass
                upstream = None
                if attempt or stream_body:
                    raise
        status_line, resp_headers = resp
        try:
            status = int(status_line.split(" ")[1])
        except (IndexError, ValueError):
            raise ConnectionError("bad upstream status line")
        writer.write(_serialize(status_line, resp_headers))
        await writer.drain()

        if status == 101:
            # WebSocket / upgrade: from here on the connection is a two-way byte stream (not inspected)
            await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer))
            return False, None
        rte = (_get(resp_headers, "transfer-encoding") or "").lower()
        rlen = _get(resp_headers, "content-length")
        if method == "HEAD" or status in NO_BODY_STATUSES or 100 <= status < 200:
            pass
        elif "chunked" in rte:
            await _relay_chunked(up_reader, writer)
        elif rlen is not None:
            await _relay_exact(up_reader, writer, int(rlen))
        else:
            await _relay_until_eof(up_reader, writer)
            return False, None
        conn = (_get(resp_headers, "connection") or "").lower()
        req_conn = (_get(headers, "connection") or "").lower()
        if not tls or "close" in conn or "close" in req_conn:
            return False, None
        return True, upstream

    def _record_block(self, host: str, rule_id: str, reason: str):
        if rule_id == "access.activation_required":
            return  # not connected: there is no session to report with
        self.on_event({"site": host[:120], "rule_id": rule_id, "category": "WEB_FILTER", "severity": "MEDIUM",
                       "action": "BLOCK", "outcome": "navigation_blocked", "prompt": reason})


class _Discard:
    def write(self, data):
        pass

    async def drain(self):
        pass

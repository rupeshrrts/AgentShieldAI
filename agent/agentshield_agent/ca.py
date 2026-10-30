"""The local root certificate that lets the agent open HTTPS to AI sites.

* Generated on each PC at install time; the key never leaves the PC (DPAPI-protected, folder ACL)
  and is never shipped in the installer, so no two PCs share a CA.
* Name-constrained (RFC 5280) to config.INTERCEPT_DOMAINS: browsers reject any certificate it signs
  for another domain, so even a stolen key cannot impersonate a bank, mail or any non-AI site.
* Path length 0: it can only sign site certificates, not other CAs.
"""
import datetime
import os
import secrets
import socket
import ssl
import tempfile
import threading
from typing import Dict, Optional

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from . import config, keys, state

CA_DIR = "ca"
CA_CERT_FILE = "agentshield-root.cer"   # DER, public: installed into Trusted Root Certification Authorities
CA_KEY_FILE = "agentshield-root.key"    # DPAPI-protected PKCS#8
CA_NAME_PREFIX = "AgentShield Local AI Inspection CA"


def _dir():
    d = state.data_dir() / CA_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def ca_cert_path():
    return _dir() / CA_CERT_FILE


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def create_ca(domains=None) -> x509.Certificate:
    """Creates (or replaces) this PC's root certificate and key. Returns the certificate."""
    domains = list(domains or config.INTERCEPT_DOMAINS)
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, f"{CA_NAME_PREFIX} ({socket.gethostname()[:30]} {secrets.token_hex(3)})"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "AgentShield (this PC only)"),
    ])
    now = _now()
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=False, content_commitment=False, key_encipherment=False, data_encipherment=False,
            key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False,
        ), critical=True)
        .add_extension(x509.NameConstraints(permitted_subtrees=[x509.DNSName(d) for d in domains], excluded_subtrees=None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    (_dir() / CA_KEY_FILE).write_text(keys.dump_protected(key), encoding="ascii")
    ca_cert_path().write_bytes(cert.public_bytes(serialization.Encoding.DER))
    return cert


def load_ca():
    """(certificate, key) or None if this PC has no CA yet."""
    try:
        cert = x509.load_der_x509_certificate(ca_cert_path().read_bytes())
        key = keys.load_protected((_dir() / CA_KEY_FILE).read_text(encoding="ascii"))
        return cert, key
    except (OSError, ValueError):
        return None


def delete_ca() -> None:
    for name in (CA_CERT_FILE, CA_KEY_FILE):
        try:
            (_dir() / name).unlink()
        except FileNotFoundError:
            pass


class CertificateAuthority:
    """Issues short-lived site certificates for intercepted AI hosts and caches a TLS context per host."""

    def __init__(self, cert: x509.Certificate, key):
        self.cert, self.key = cert, key
        self.leaf_key = ec.generate_private_key(ec.SECP256R1())
        self._contexts: Dict[str, ssl.SSLContext] = {}
        self._lock = threading.Lock()

    @classmethod
    def load(cls) -> Optional["CertificateAuthority"]:
        loaded = load_ca()
        return cls(*loaded) if loaded else None

    def issue(self, host: str) -> x509.Certificate:
        now = _now()
        return (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]))
            .issuer_name(self.cert.subject)
            .public_key(self.leaf_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(hours=1))
            .not_valid_after(now + datetime.timedelta(days=30))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(self.key.public_key()), critical=False)
            .sign(self.key, hashes.SHA256())
        )

    def server_context(self, host: str) -> ssl.SSLContext:
        host = host.lower()
        with self._lock:
            ctx = self._contexts.get(host)
            if ctx:
                return ctx
            leaf = self.issue(host)
            pem = (leaf.public_bytes(serialization.Encoding.PEM) + self.cert.public_bytes(serialization.Encoding.PEM)
                   + self.leaf_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                 serialization.NoEncryption()))
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            # HTTP/1.1 only towards the browser, so each request is a separate, inspectable message
            ctx.set_alpn_protocols(["http/1.1"])
            # ssl can only load a chain from a file: write it briefly inside the protected data folder
            fd, path = tempfile.mkstemp(dir=str(_dir()), suffix=".pem")
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(pem)
                ctx.load_cert_chain(path)
            finally:
                os.unlink(path)
            self._contexts[host] = ctx
            return ctx

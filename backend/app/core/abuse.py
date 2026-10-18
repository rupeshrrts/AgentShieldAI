"""Free-trial abuse controls.

These raise the cost of claiming the trial repeatedly; they cannot stop someone who keeps
creating new mailboxes, domains and networks. IP addresses are stored only as keyed hashes.
"""
import difflib
import hashlib
import hmac
import time
from typing import Dict, Optional, Tuple

from app.core.config import settings

# Public webmail: one trial per mailbox. Any other domain is treated as a company domain:
# one trial per domain (the platform admin can grant more).
PUBLIC_EMAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.co.in",
    "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "zoho.com",
    "zohomail.in", "rediffmail.com", "gmx.com", "gmx.net", "mail.com", "yandex.com", "tutanota.com", "fastmail.com",
}

# Common throw-away mailbox providers (trial claims refused)
DISPOSABLE_EMAIL_DOMAINS = {
    "mailinator.com", "guerrillamail.com", "guerrillamail.net", "10minutemail.com", "tempmail.com", "temp-mail.org",
    "yopmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "trashmail.com", "maildrop.cc",
    "throwawaymail.com", "fakeinbox.com", "mintemail.com", "mohmal.com", "emailondeck.com", "tempail.com",
}


def email_domain(email: str) -> str:
    return email.strip().lower().rsplit("@", 1)[-1]


def normalize_email(email: str) -> str:
    """Lower-cases, drops "+tag" suffixes, and drops dots for Gmail (all deliver to the same mailbox)."""
    local, _, domain = email.strip().lower().rpartition("@")
    local = local.split("+", 1)[0]
    if domain in ("gmail.com", "googlemail.com"):
        local = local.replace(".", "")
        domain = "gmail.com"
    return f"{local}@{domain}"


def is_public_domain(domain: str) -> bool:
    return domain in PUBLIC_EMAIL_DOMAINS


def is_disposable_domain(domain: str) -> bool:
    return domain in DISPOSABLE_EMAIL_DOMAINS


# Typos of big providers that exist in DNS (often parked or typo-squatted) but are not someone's mailbox
COMMON_TYPO_DOMAINS = {
    "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gnail.com": "gmail.com",
    "gmail.co": "gmail.com", "gmail.con": "gmail.com", "gmail.cm": "gmail.com", "gmail.in": "gmail.com",
    "gmaill.com": "gmail.com", "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com", "outlok.com": "outlook.com",
    "outllok.com": "outlook.com", "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.con": "yahoo.com",
    "rediffmal.com": "rediffmail.com", "icloud.co": "icloud.com",
}


def _extra_letters_after_provider(domain: str) -> Optional[str]:
    """gmail.comrre -> gmail.com (a known provider followed by stray letters, no further dot), and the
    common typo domains above."""
    if domain in COMMON_TYPO_DOMAINS:
        return COMMON_TYPO_DOMAINS[domain]
    if domain in PUBLIC_EMAIL_DOMAINS:
        return None
    for known in sorted(PUBLIC_EMAIL_DOMAINS, key=len, reverse=True):
        rest = domain[len(known):]
        if domain.startswith(known) and rest.isalpha():
            return known
    return None


def _close_provider(domain: str) -> Optional[str]:
    """gmial.com -> gmail.com. Only used for domains that cannot receive email, so real look-alikes
    (yahoo.co.uk) are never second-guessed."""
    close = difflib.get_close_matches(domain, PUBLIC_EMAIL_DOMAINS, n=1, cutoff=0.8)
    return close[0] if close else None


_DNS_CACHE: Dict[str, Tuple[float, bool]] = {}


def domain_receives_email(domain: str) -> bool:
    """True when DNS says the domain can receive email: an MX record (not the RFC 7505 "null MX"), or,
    without MX, an A/AAAA record. A DNS outage or timeout counts as True, so sign-ups never depend on it."""
    now = time.time()
    cached = _DNS_CACHE.get(domain)
    if cached and now - cached[0] < 3600:
        return cached[1]
    try:
        import dns.exception
        import dns.resolver

        resolver = dns.resolver.Resolver()
        resolver.lifetime = 4.0
        try:
            answers = resolver.resolve(domain, "MX")
            ok = any(str(r.exchange).rstrip(".") for r in answers)
        except dns.resolver.NoAnswer:
            ok = False
            for rtype in ("A", "AAAA"):
                try:
                    resolver.resolve(domain, rtype)
                    ok = True
                    break
                except dns.resolver.NoAnswer:
                    continue
        except dns.resolver.NXDOMAIN:
            ok = False
    except ImportError:
        return True
    except Exception:  # timeouts, no nameservers, network problems: never block on DNS trouble
        return True
    _DNS_CACHE[domain] = (now, ok)
    return ok


def email_address_problem(email: str) -> Optional[str]:
    """A message for the person when the address cannot be right; None when it looks real."""
    try:
        from email_validator import EmailNotValidError, validate_email

        validate_email(email, check_deliverability=False)
    except ImportError:
        pass
    except EmailNotValidError:
        return "Enter a valid email address."
    local, domain = email.rsplit("@", 1)[0], email_domain(email)
    typo = _extra_letters_after_provider(domain)
    if typo:
        return f"Check your email address: did you mean {local}@{typo}?"
    if not domain_receives_email(domain):
        close = _close_provider(domain)
        if close:
            return f"Check your email address: did you mean {local}@{close}?"
        return f"The email domain {domain} does not exist or cannot receive email. Check your email address."
    return None


def hash_ip(ip: str) -> str:
    return hmac.new(settings.SECRET_KEY.encode(), ip.encode(), hashlib.sha256).hexdigest()

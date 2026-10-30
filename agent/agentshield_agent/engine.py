"""Decisions for the proxy: which hosts are blocked, and what happens to a prompt.

Detection and policy precedence are NOT re-implemented here: the agent imports the backend's
app/detection/detector.py and app/policies/evaluator.py (the Python twins of the extension's detector.ts
and policy.ts), so all three enforcement points give the same answer for the same text. Only the
employee status (SUSPENDED / RESTRICTED), applied by the extension's policy.ts, is added on top.
"""
import hashlib
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import config, inspect_body

if str(config.backend_dir()) not in sys.path:
    sys.path.insert(0, str(config.backend_dir()))

from app.core.catalog import RULE_CATALOG  # noqa: E402
from app.detection.detector import DetectorEngine  # noqa: E402  (shared with the backend)
from app.policies.evaluator import PolicyEvaluator, PolicyRule  # noqa: E402


@dataclass
class Snapshot:
    """Everything the proxy enforces. Replaced as a whole after each sync or session change."""
    authorized: bool = False
    reason: str = "AgentShield is not connected on this PC yet."
    checks_paused: bool = False
    user_email: str = ""
    user_status: str = "ACTIVE"
    policy_version: int = 0
    policies: List[dict] = field(default_factory=list)
    keywords: Optional[List[str]] = None       # None until the first sync: built-in defaults apply
    settings: Dict = field(default_factory=dict)
    ai_domains: List[str] = field(default_factory=list)
    blocked_domains: List[str] = field(default_factory=list)
    allowed_domains: List[str] = field(default_factory=list)

    def detector(self) -> DetectorEngine:
        if self.keywords is None:
            return DetectorEngine()
        return DetectorEngine(custom_keywords=self.keywords, include_defaults=False)

    def rules(self) -> List[PolicyRule]:
        return [
            PolicyRule(id=str(p.get("id", "")), rule_id=str(p.get("rule_id", "")), action=str(p.get("action", "WARN")),
                       severity=str(p.get("severity", "MEDIUM")), enabled=bool(p.get("enabled", True)),
                       site_scope=p.get("site_scope"))
            for p in self.policies
        ]

    def policies_complete(self) -> bool:
        """Only an enabled rule is enforced (no built-in defaults), so nothing is judged until the synced
        rules contain every catalog rule, the same fail-closed check as the extension's policiesComplete()."""
        present = {str(p.get("rule_id", "")) for p in self.policies}
        return all(rule["rule_id"] in present for rule in RULE_CATALOG)


@dataclass
class HostVerdict:
    blocked: bool
    rule_id: str = ""
    reason: str = ""


def host_verdict(snap: Snapshot, host: str) -> HostVerdict:
    """Website rules, in the extension's order: explicit block > activation lock > allow > unapproved AI."""
    if config.host_matches(host, snap.blocked_domains):
        return HostVerdict(True, "dlp.domain.blocked", "This website is blocked by your organization.")
    ai_site = config.is_intercepted(host) or config.host_matches(host, snap.ai_domains)
    if not snap.authorized and config.is_intercepted(host):
        return HostVerdict(True, "access.activation_required", snap.reason)
    if config.host_matches(host, snap.allowed_domains):
        return HostVerdict(False)
    if snap.authorized and snap.settings.get("block_unapproved_ai") and ai_site:
        return HostVerdict(True, "dlp.domain.unapproved_ai", "This AI tool is not approved by your organization.")
    return HostVerdict(False)


@dataclass
class PromptVerdict:
    forward: bool
    body: Optional[bytes] = None          # replacement body (redaction) or None to send the original
    rule_id: str = ""
    reason: str = ""
    event: Optional[dict] = None          # audit event for /api/v1/events (text already masked)


class WarnMemory:
    """A WARN prompt is held once; the same text sent again within WARN_CONFIRM_SECONDS goes through
    (the proxy cannot show the extension's confirm dialog, so re-sending is the confirmation)."""

    def __init__(self):
        self._held: Dict[str, float] = {}
        self._lock = threading.Lock()

    def confirm_or_hold(self, host: str, text: str) -> bool:
        key = hashlib.sha256(f"{host}\n{' '.join(text.split())}".encode("utf-8")).hexdigest()
        now = time.time()
        with self._lock:
            for k, t in list(self._held.items()):
                if now - t > config.WARN_CONFIRM_SECONDS:
                    self._held.pop(k, None)
            if key in self._held:
                self._held.pop(key, None)
                return True
            self._held[key] = now
            return False


def _event(host: str, result, action: str, outcome: str, prompt: Optional[str]) -> dict:
    rule_id = result.primary_rule_id or "unknown.rule"
    finding = next((f for f in result.findings if f.get("rule_id") == rule_id), result.findings[0] if result.findings else None)
    return {
        "site": host[:120], "rule_id": rule_id, "category": finding["category"] if finding else "SECRET",
        "severity": result.highest_severity or "HIGH", "action": action, "outcome": outcome, "prompt": prompt,
    }


def check_prompt(snap: Snapshot, host: str, content_type: str, body: bytes, warn: WarnMemory) -> PromptVerdict:
    parsed = inspect_body.parse(host, content_type, body)
    if not parsed.leaves:
        return PromptVerdict(True)            # not a prompt (telemetry, settings, empty body)
    if snap.checks_paused:
        return PromptVerdict(True)            # Free plan paused: unchecked and unmetered, like the extension
    if not snap.policies_complete():
        return PromptVerdict(False, rule_id="access.rules_loading",
                             reason="AgentShield has not received your organization's protection rules yet, so this was "
                                    "not sent. Try again in a moment.")
    text = parsed.text
    detector = snap.detector()
    masked = lambda t: detector.redact(t)     # noqa: E731  only masked text ever leaves the PC
    store_violation = bool(snap.settings.get("store_violation_prompt_text", True))

    if snap.user_status == "SUSPENDED":
        return PromptVerdict(False, rule_id="enterprise.user_suspended",
                             reason="Your access to AI tools is suspended by your organization.",
                             event={"site": host[:120], "rule_id": "enterprise.user_suspended", "category": "SECRET",
                                    "severity": "CRITICAL", "action": "BLOCK", "outcome": "blocked",
                                    "prompt": masked(text) if store_violation else None})

    result = PolicyEvaluator.evaluate(detector.detect(text), snap.rules(), site=host)
    action = result.action
    if snap.user_status == "RESTRICTED" and action == "WARN":
        action = "BLOCK"

    if action == "ALLOW":
        clean = {"site": host[:120], "rule_id": "general.clean_prompt", "category": "PROMPT_LOG", "severity": "LOW",
                 "action": "ALLOW", "outcome": "allowed",
                 "prompt": masked(text) if snap.settings.get("store_clean_prompt_text") else None}
        return PromptVerdict(True, event=clean)
    if action == "MONITOR":
        return PromptVerdict(True, event=_event(host, result, "MONITOR", "monitored", masked(text) if store_violation else None))
    if action == "WARN":
        if warn.confirm_or_hold(host, text):
            return PromptVerdict(True, event=_event(host, result, "WARN", "warned_and_confirmed", masked(text) if store_violation else None))
        return PromptVerdict(False, rule_id=result.primary_rule_id or "", reason=(
            f"This prompt contains sensitive data ({result.primary_rule_id}). Check it; if it is fine to share, "
            f"send exactly the same prompt again within {config.WARN_CONFIRM_SECONDS // 60} minutes and it will go through."))
    if action == "REDACT":
        new_body = inspect_body.rewrite(parsed, masked)
        if new_body is None:
            return PromptVerdict(False, rule_id=result.primary_rule_id or "", reason="AgentShield could not mask the text, so it was not sent.",
                                 event=_event(host, result, "BLOCK", "redaction_failed_blocked", masked(text) if store_violation else None))
        return PromptVerdict(True, body=new_body,
                             event=_event(host, result, "REDACT", "redacted_and_submitted", masked(text) if store_violation else None))
    return PromptVerdict(False, rule_id=result.primary_rule_id or "", reason=result.reason,
                         event=_event(host, result, "BLOCK", "blocked", masked(text) if store_violation else None))

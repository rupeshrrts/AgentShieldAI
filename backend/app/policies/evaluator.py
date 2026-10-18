"""AgentShield Policy Evaluation Engine.

Resolves conflicts when a user's prompt triggers multiple policies.
The evaluation rules follow a strict security precedence:
  1. Action Priority: BLOCK > REDACT > WARN > MONITOR > ALLOW
  2. Severity Weight: CRITICAL > HIGH > MEDIUM > LOW (used for tie-breaking)

MONITOR lets the prompt through but records the violation for review.
This guarantees that high-risk violations (e.g. leaking an API key) are never
bypassed just because a lower-risk policy (e.g. email warning) was also matched.

IMPORTANT: evaluateText() in extension/src/content/content.ts mirrors this logic.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional
from app.core.catalog import ACTION_PRIORITY, CATEGORY_DEFAULT_ACTION
from app.detection.detector import Finding


@dataclass
class PolicyRule:
    """Represents an active organization rule for evaluation."""
    id: str
    rule_id: str
    action: str          # ALLOW, WARN, BLOCK, REDACT
    severity: str        # LOW, MEDIUM, HIGH, CRITICAL
    enabled: bool = True
    site_scope: Optional[str] = None  # Specific domain or '*' for all sites


@dataclass
class PolicyEvaluationResult:
    """The final verdict after evaluating all findings against active policies."""
    action: str                       # Final winning action (e.g. BLOCK, WARN)
    primary_rule_id: Optional[str]    # Rule ID of the highest priority match
    highest_severity: Optional[str]   # Severity level of the winning match
    reason: str                       # User-friendly explanation for the UI modal
    findings: List[dict]              # Sanitized summary of detected items
    needs_confirmation: bool = False  # True if the user must confirm or review redaction
    redacted_preview: Optional[str] = None


class PolicyEvaluator:
    """Evaluates findings against active policies and determines the final enforcement action."""

    # Weights used to break ties between policies with the same action
    SEVERITY_WEIGHTS = {
        "CRITICAL": 4,
        "HIGH": 3,
        "MEDIUM": 2,
        "LOW": 1,
    }

    # Strict security hierarchy: BLOCK always takes precedence
    ACTION_PRIORITY = ACTION_PRIORITY

    @classmethod
    def evaluate(
        cls,
        findings: List[Finding],
        policies: List[PolicyRule],
        site: Optional[str] = None,
        original_text: Optional[str] = None,
    ) -> PolicyEvaluationResult:
        """Determines the single governing action for a set of findings."""

        # 1. If nothing was detected, allow immediately
        if not findings:
            return PolicyEvaluationResult(
                action="ALLOW",
                primary_rule_id=None,
                highest_severity=None,
                reason="No sensitive data patterns detected in prompt.",
                findings=[],
                needs_confirmation=False,
            )

        # 2. Filter active policies for the current site scope
        active_policies: Dict[str, PolicyRule] = {}
        disabled_rule_ids = set()

        for policy in policies:
            if not policy.enabled:
                disabled_rule_ids.add(policy.rule_id)
                continue

            # Check if policy is restricted to a specific website (exact host or subdomain)
            if policy.site_scope and policy.site_scope != "*" and site:
                scope, host = policy.site_scope.lower().strip(), site.lower()
                if host != scope and not host.endswith("." + scope):
                    continue

            active_policies[policy.rule_id] = policy

        # 3. Map each finding to its configured policy action
        matched_evaluations: List[dict] = []
        for finding in findings:
            if finding.rule_id in disabled_rule_ids:
                continue

            policy = active_policies.get(finding.rule_id)
            if policy:
                action = policy.action.upper()
                severity = policy.severity.upper()
            else:
                # Safe defaults if no explicit policy rule is configured in the database
                action = CATEGORY_DEFAULT_ACTION.get(finding.category, "WARN")
                severity = finding.severity

            matched_evaluations.append({
                "finding": finding,
                "action": action,
                "severity": severity,
                "rule_id": finding.rule_id,
                "action_priority": cls.ACTION_PRIORITY.get(action, 1),
                "severity_weight": cls.SEVERITY_WEIGHTS.get(severity, 1),
            })

        # If all findings were disabled by policy, allow submission
        if not matched_evaluations:
            return PolicyEvaluationResult(
                action="ALLOW",
                primary_rule_id=None,
                highest_severity=None,
                reason="All findings matched disabled or out-of-scope policies.",
                findings=[f.to_dict(include_matched_value=False) for f in findings],
                needs_confirmation=False,
            )

        # 4. Sort to pick the winning verdict: highest action priority, then highest severity
        matched_evaluations.sort(
            key=lambda x: (x["action_priority"], x["severity_weight"]),
            reverse=True,
        )

        winning = matched_evaluations[0]
        final_action = winning["action"]
        primary_rule = winning["rule_id"]
        highest_sev = winning["severity"]

        # 5. Build user-friendly feedback text
        if final_action == "BLOCK":
            reason = f"Prompt submission blocked: triggered rule '{primary_rule}' ({highest_sev} severity)."
        elif final_action == "REDACT":
            reason = f"Sensitive content requires redaction under rule '{primary_rule}'."
        elif final_action == "WARN":
            reason = f"Prompt contains sensitive data matching '{primary_rule}'. Explicit confirmation required."
        elif final_action == "MONITOR":
            reason = f"Prompt allowed; '{primary_rule}' match recorded for review (monitor mode)."
        else:
            reason = "Prompt evaluated and permitted by policy."

        # Compute safe redacted preview if redaction is required and prompt text was supplied
        redacted_preview = None
        if final_action == "REDACT" and original_text:
            from app.detection.detector import DetectorEngine
            engine = DetectorEngine()
            redacted_preview = engine.redact(original_text, findings)

        findings_summary = [f.to_dict(include_matched_value=False) for f in findings]

        return PolicyEvaluationResult(
            action=final_action,
            primary_rule_id=primary_rule,
            highest_severity=highest_sev,
            reason=reason,
            findings=findings_summary,
            needs_confirmation=(final_action in ("WARN", "REDACT")),
            redacted_preview=redacted_preview,
        )

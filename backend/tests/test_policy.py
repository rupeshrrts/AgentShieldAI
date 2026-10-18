"""Unit tests for Policy Evaluator conflict resolution."""
import pytest
from app.detection.detector import DetectorEngine, Finding
from app.policies.evaluator import PolicyEvaluator, PolicyRule


@pytest.fixture
def standard_policies():
    return [
        PolicyRule(
            id="pol-1",
            rule_id="secret.api_key_like",
            action="BLOCK",
            severity="HIGH",
            enabled=True,
        ),
        PolicyRule(
            id="pol-2",
            rule_id="pii.email",
            action="WARN",
            severity="MEDIUM",
            enabled=True,
        ),
        PolicyRule(
            id="pol-3",
            rule_id="restricted.keyword",
            action="REDACT",
            severity="MEDIUM",
            enabled=True,
        ),
    ]


def test_clean_prompt_allows(standard_policies):
    res = PolicyEvaluator.evaluate([], standard_policies)
    assert res.action == "ALLOW"
    assert res.primary_rule_id is None
    assert not res.needs_confirmation


def test_single_block_rule(standard_policies):
    detector = DetectorEngine()
    prompt = "sk-demo-EXAMPLE123456789"
    findings = detector.detect(prompt)
    res = PolicyEvaluator.evaluate(findings, standard_policies)
    assert res.action == "BLOCK"
    assert res.primary_rule_id == "secret.api_key_like"
    assert res.highest_severity == "HIGH"


def test_block_wins_over_warn_and_redact(standard_policies):
    """BLOCK wins over WARN and ALLOW and REDACT when multiple rules match."""
    detector = DetectorEngine()
    prompt = "sk-demo-EXAMPLE123456789 and demo.user@example.com and PROJECT-ALPHA-CONFIDENTIAL"
    findings = detector.detect(prompt)
    assert len(findings) == 3

    res = PolicyEvaluator.evaluate(findings, standard_policies, original_text=prompt)
    assert res.action == "BLOCK"
    assert res.primary_rule_id == "secret.api_key_like"


def test_redact_wins_over_warn(standard_policies):
    detector = DetectorEngine()
    prompt = "Contact demo.user@example.com about PROJECT-ALPHA-CONFIDENTIAL"
    findings = detector.detect(prompt)
    assert len(findings) == 2

    res = PolicyEvaluator.evaluate(findings, standard_policies, original_text=prompt)
    assert res.action == "REDACT"
    assert res.primary_rule_id == "restricted.keyword"
    assert res.redacted_preview is not None
    assert "[REDACTED:RESTRICTED]" in res.redacted_preview


def test_warn_action_requires_confirmation(standard_policies):
    detector = DetectorEngine()
    prompt = "Email me at demo.user@example.com"
    findings = detector.detect(prompt)

    res = PolicyEvaluator.evaluate(findings, standard_policies)
    assert res.action == "WARN"
    assert res.primary_rule_id == "pii.email"
    assert res.needs_confirmation is True


def test_disabled_policy_is_ignored():
    detector = DetectorEngine()
    prompt = "sk-demo-EXAMPLE123456789"
    findings = detector.detect(prompt)

    policies = [
        PolicyRule(
            id="pol-1",
            rule_id="secret.api_key_like",
            action="BLOCK",
            severity="HIGH",
            enabled=False,  # Disabled!
        )
    ]
    res = PolicyEvaluator.evaluate(findings, policies)
    # Since explicitly defined policy is disabled, it is skipped
    assert res.action == "ALLOW"

"""Unit tests for AgentShield Detection Engine."""
import json
from pathlib import Path

import pytest
from app.core.privacy import mask_secrets
from app.detection.detector import DetectorEngine

CASES = json.loads((Path(__file__).parent / "detection_cases.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["text"][:40] for c in CASES])
def test_shared_detection_cases(case):
    """Same cases are run against the extension's detector.ts (extension/tests/run-tests.js)."""
    found = {f.rule_id for f in DetectorEngine().detect(case["text"])}
    assert found == set(case["rules"]), f"{case['text']!r}: expected {case['rules']}, got {sorted(found)}"


def test_card_and_aadhaar_are_masked_for_storage():
    masked = mask_secrets("Card 4111 1111 1111 1111 and Aadhaar 4987 1234 5679")
    assert "4111 1111 1111 1111" not in masked
    assert "4987 1234 5679" not in masked
    assert "[MASKED]" in masked


@pytest.fixture
def detector():
    return DetectorEngine()


def test_clean_benign_prompt(detector):
    prompt = "Explain Python list comprehensions and how to use them with generator expressions."
    findings = detector.detect(prompt)
    assert len(findings) == 0


def test_api_key_openai_synthetic(detector):
    prompt = "Here is my secret token: sk-demo-EXAMPLE123456789 please analyze my database."
    findings = detector.detect(prompt)
    assert len(findings) >= 1
    assert any(f.rule_id == "secret.api_key_like" for f in findings)
    secret_finding = next(f for f in findings if f.rule_id == "secret.api_key_like")
    assert secret_finding.category == "SECRET"
    assert secret_finding.severity == "HIGH"
    assert secret_finding.start == 25
    assert secret_finding.end == 49


def test_api_key_aws_synthetic(detector):
    prompt = "Check AWS credentials AKIAIOSFODNN7EXAMPLE for our S3 bucket."
    findings = detector.detect(prompt)
    assert any(f.rule_id == "secret.api_key_like" for f in findings)


def test_email_pii_detection(detector):
    prompt = "Contact our lead engineer at demo.user@example.com for access credentials."
    findings = detector.detect(prompt)
    assert len(findings) == 1
    assert findings[0].rule_id == "pii.email"
    assert findings[0].category == "PII"
    assert findings[0].severity == "MEDIUM"


def test_phone_pii_detection(detector):
    prompt = "Call our hotline at (555) 234-5678 regarding the security incident."
    findings = detector.detect(prompt)
    assert len(findings) >= 1
    phone_finding = next(f for f in findings if f.rule_id == "pii.phone")
    assert phone_finding.category == "PII"


def test_restricted_keyword_detection(detector):
    prompt = "We are preparing confidential launch slides for PROJECT-ALPHA-CONFIDENTIAL."
    findings = detector.detect(prompt)
    assert len(findings) == 1
    assert findings[0].rule_id == "restricted.keyword"
    assert findings[0].category == "RESTRICTED"


def test_safe_redaction(detector):
    prompt = "Send email to demo.user@example.com regarding PROJECT-ALPHA-CONFIDENTIAL."
    findings = detector.detect(prompt)
    redacted = detector.redact(prompt, findings)
    assert "demo.user@example.com" not in redacted
    assert "PROJECT-ALPHA-CONFIDENTIAL" not in redacted
    assert "[REDACTED:PII]" in redacted
    assert "[REDACTED:RESTRICTED]" in redacted


def test_ten_sample_benchmark_matrix(detector):
    """Test matrix of 10 positive prompts and 10 benign negative prompts as per POC specs."""
    positive_cases = [
        "sk-demo-EXAMPLE123456789",
        "My key is sk-proj-1234567890123456789012345678",
        "AKIAEXAMPLE12345678",
        "ghp_123456789012345678901234567890123456",
        "api_key = 'abcdef1234567890abcdef'",
        "demo.user@example.com",
        "support@mycompany.org",
        "(555) 123-4567",
        "PROJECT-ALPHA-CONFIDENTIAL",
        "CONFIDENTIAL_FINANCIALS report",
    ]
    for prompt in positive_cases:
        findings = detector.detect(prompt)
        assert len(findings) > 0, f"Expected detection for: {prompt}"

    benign_cases = [
        "Explain Python list comprehensions",
        "How do I write a binary search algorithm in TypeScript?",
        "What is the difference between TCP and UDP?",
        "Can you suggest a recipe for sourdough bread?",
        "Summarize the plot of Hamlet in two paragraphs.",
        "How does React useEffect dependency array work?",
        "Write a SQL query to select all active users grouped by country.",
        "What are the best practices for Docker Compose in development?",
        "Can you help draft a congratulatory message for a colleague?",
        "Explain the CAP theorem for distributed databases.",
    ]
    for prompt in benign_cases:
        findings = detector.detect(prompt)
        assert len(findings) == 0, f"False positive on benign prompt: {prompt}"

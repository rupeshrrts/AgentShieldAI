"""2.6 data-protection rules: every catalog rule is covered by the shared cases, and new secrets are never stored readable."""
import json
from pathlib import Path

from app.core.catalog import PRESETS, RULE_CATALOG
from app.core.privacy import ALWAYS_MASKED_RULES, mask_secrets
from app.detection.detector import gstin_valid, iban_valid

CASES = json.loads((Path(__file__).parent / "detection_cases.json").read_text(encoding="utf-8"))["cases"]


def test_every_detector_rule_has_a_positive_shared_case():
    covered = {rule for case in CASES for rule in case["rules"]}
    for rule in RULE_CATALOG:
        if rule["rule_id"] == "file.upload":  # not a text pattern
            continue
        assert rule["rule_id"] in covered, rule["rule_id"]


def test_presets_cover_the_new_rules():
    ids = {r["rule_id"] for r in RULE_CATALOG}
    for name, actions in PRESETS.items():
        assert set(actions) == ids, name
    assert PRESETS["strict"]["pii.upi"] == "BLOCK" and PRESETS["monitor"]["secret.crypto_key"] == "MONITOR"


def test_checksums():
    assert gstin_valid("27AAPFU0939F1ZV") and not gstin_valid("27AAPFU0939F1ZX")
    assert iban_valid("GB82 WEST 1234 5698 7654 32") and not iban_valid("GB82 WEST 1234 5698 7654 33")


def test_new_secrets_and_ids_are_masked_before_storage():
    text = ("db postgres://admin:S3cr3tPass@db.internal:5432/app wallet 5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ "
            "iban GB82 WEST 1234 5698 7654 32 my passport number is J8369854 voter id ABC1234567 account no. 123456789012")
    stored = mask_secrets(text)
    for secret in ("S3cr3tPass", "MjxEXxiPuD5BDku4MkFq", "WEST 1234 5698", "J8369854", "ABC1234567", "123456789012"):
        assert secret not in stored, secret
    assert {"secret.crypto_key", "secret.connection_string", "pii.iban", "pii.passport"} <= ALWAYS_MASKED_RULES

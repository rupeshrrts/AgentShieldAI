"""The extension's policy logic must agree with the backend (AGENTS.md rule 6: keep the twins identical).

The browser only enforces once its synced rules contain every catalog rule, so the two lists must match exactly.
"""
import re
from pathlib import Path

from app.core.catalog import KNOWN_AI_DOMAINS, RULE_CATALOG

ROOT = Path(__file__).resolve().parents[2]
POLICY_TS = ROOT / "extension" / "src" / "shared" / "policy.ts"
EVALUATOR_PY = ROOT / "backend" / "app" / "policies" / "evaluator.py"


def test_extension_catalog_rule_ids_match_backend_catalog():
    source = POLICY_TS.read_text(encoding="utf-8")
    block = re.search(r"CATALOG_RULE_IDS: string\[\] = \[(.*?)\];", source, re.S)
    assert block, "CATALOG_RULE_IDS not found in policy.ts"
    ids = re.findall(r"'([^']+)'", block.group(1))
    assert ids == [rule["rule_id"] for rule in RULE_CATALOG]


def test_evaluators_do_not_fall_back_to_category_defaults():
    """A rule is enforced only by an enabled policy row: no default action may be applied in either twin."""
    assert "CATEGORY_DEFAULT_ACTION" not in POLICY_TS.read_text(encoding="utf-8")
    assert "CATEGORY_DEFAULT_ACTION" not in EVALUATOR_PY.read_text(encoding="utf-8")


def test_known_ai_destinations_have_a_browser_adapter():
    source = (ROOT / "extension" / "src" / "shared" / "domains.ts").read_text(encoding="utf-8")
    block = re.search(r"SUPPORTED_AI_HOSTS = \[(.*?)\];", source, re.S)
    assert block
    browser = re.findall(r"'([^']+)'", block.group(1))
    assert all(host in browser or any(host.endswith("." + base) for base in browser) for host in KNOWN_AI_DOMAINS)

import json
import subprocess
import sys

from app.detection.cursor_hook import decide


def test_cursor_hook_checks_prompt_attachments_and_context(tmp_path):
    policy = {"block_passwords_and_secrets": True, "credential_prefixes": ["fixture_key_"]}
    attachment = tmp_path / ".env"
    attachment.write_text("passphrase: fixture value", encoding="utf-8")
    assert decide("beforeSubmitPrompt", {"prompt": "passcode: 7"}, policy)
    assert decide("beforeSubmitPrompt", {
        "prompt": "Explain this file",
        "attachments": [{"type": "file", "file_path": str(attachment)}],
    }, policy)
    assert decide("beforeReadFile", {"content": "fixture_key_synthetic12345"}, policy)
    assert decide("beforeTabFileRead", {"content": "passcode: 7"}, policy)
    assert decide("beforeReadFile", {"content": "Explain TCP"}, policy) is None
    policy["block_passwords_and_secrets"] = False
    assert decide("beforeSubmitPrompt", {"prompt": "passcode: 7"}, policy) is None
    policy["block_uninspectable_files"] = True
    assert decide("beforeReadFile", {}, policy)


def test_cursor_hook_stdout_contains_only_decision(tmp_path):
    policy = tmp_path / "policy.json"
    policy.write_text('{"block_passwords_and_secrets": true}', encoding="utf-8")
    command = [
        sys.executable, "-m", "app.detection.cursor_hook",
        "--event", "beforeSubmitPrompt", "--policy-file", str(policy),
    ]
    sample = "my password is synthetic-only phrase"
    result = subprocess.run(command, input=json.dumps({"prompt": sample}), capture_output=True, text=True, check=True)
    assert json.loads(result.stdout)["continue"] is False
    assert sample not in result.stdout
    assert not result.stderr
    policy.unlink()
    result = subprocess.run(command, input=json.dumps({"prompt": "Ordinary prompt"}), capture_output=True, text=True, check=True)
    assert json.loads(result.stdout)["continue"] is False
    assert not result.stderr

"""Local Cursor hook. Input is read once from stdin and is never logged."""

import argparse
import json
import sys
from pathlib import Path

from app.detection.detector import DetectorEngine
from app.policies.evaluator import SECRET_BLOCK_MESSAGE

MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_INPUT_BYTES = 8 * 1024 * 1024
EVENTS = ("beforeSubmitPrompt", "beforeReadFile", "beforeTabFileRead")


def _file_text(raw_path):
    if not isinstance(raw_path, str) or raw_path.startswith(("\\\\", "//")):
        return None
    path = Path(raw_path)
    try:
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            return None
        with path.open("rb") as stream:
            contents = stream.read(MAX_FILE_BYTES + 1)
        if len(contents) <= MAX_FILE_BYTES and b"\0" not in contents:
            return contents.decode("utf-8-sig")
    except (OSError, ValueError):
        return None
    return None


def decide(event, payload, settings):
    enabled = settings["block_passwords_and_secrets"]
    prefixes = settings.get("credential_prefixes", [])
    block_uninspectable = settings.get("block_uninspectable_files", False)
    if (type(enabled) is not bool or type(block_uninspectable) is not bool
            or not isinstance(prefixes, list) or not all(isinstance(p, str) for p in prefixes)):
        raise ValueError("Invalid credential policy")

    detector = DetectorEngine(include_defaults=False)

    def contains_secret(text):
        return enabled and any(
            finding.category == "SECRET" and finding.severity == "HIGH"
            for finding in detector.detect(text, prefixes)
        )

    def check_file(text):
        if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_FILE_BYTES or "\0" in text:
            return "This file could not be inspected." if block_uninspectable else None
        return SECRET_BLOCK_MESSAGE if contains_secret(text) else None

    if event != "beforeSubmitPrompt":
        return check_file(payload.get("content"))

    prompt = payload["prompt"]
    if not isinstance(prompt, str):
        raise ValueError("Invalid prompt")
    if contains_secret(prompt):
        return SECRET_BLOCK_MESSAGE
    for attachment in payload.get("attachments", []):
        if enabled or block_uninspectable:
            reason = check_file(_file_text(attachment.get("file_path")))
            if reason:
                return reason
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", required=True, choices=EVENTS)
    parser.add_argument("--policy-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        settings = json.loads(args.policy_file.read_text(encoding="utf-8-sig"))
        data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(data) > MAX_INPUT_BYTES:
            if args.event == "beforeSubmitPrompt":
                raise ValueError("Hook input too large")
            payload = {}
        else:
            payload = json.loads(data.decode("utf-8-sig"))
        reason = decide(args.event, payload, settings)
    except (OSError, AttributeError, KeyError, TypeError, ValueError):
        reason = "AgentShield could not apply the managed credential policy."
    if args.event == "beforeSubmitPrompt":
        response = {"continue": reason is None}
        if reason:
            response["user_message"] = reason
    else:
        response = {"permission": "deny" if reason else "allow"}
        if reason and args.event == "beforeReadFile":
            response["user_message"] = reason
    print(json.dumps(response))


if __name__ == "__main__":
    main()

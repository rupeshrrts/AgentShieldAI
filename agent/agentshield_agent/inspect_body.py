"""Finds the prompt text inside an AI site's request body, and rewrites it for redaction.

The extension reads the text box on the page; the agent only sees the site's own API requests, so it
looks for user text in the body:
  * JSON: string values under prompt-like keys (prompt, content, parts, text, message, query, input …),
    e.g. ChatGPT messages[].content.parts[], Claude {"prompt": …}.
  * Form bodies (Gemini's f.req=…): JSON nested inside strings is decoded; on hosts in
    ALL_STRINGS_HOSTS every string counts, because their payloads have no key names.
  * text/plain: the whole body.
Multipart (file uploads) and binary bodies are not read (README: Known limitations).
"""
import json
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode

from . import config

PROMPT_KEYS = {
    "prompt", "content", "contents", "parts", "text", "message", "messages", "query", "q", "input", "inputs",
    "question", "user_input", "userinput", "body", "instructions", "system_prompt",
}
ALL_STRINGS_HOSTS = ["gemini.google.com", "aistudio.google.com"]
MAX_LEAF_CHARS = 200_000


@dataclass
class Leaf:
    path: Tuple
    text: str


@dataclass
class ParsedBody:
    kind: str                     # json | form | text | none
    tree: object = None
    leaves: List[Leaf] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n".join(leaf.text for leaf in self.leaves)


class _Nested:
    """A JSON document that was stored inside a string (re-encoded when the body is rebuilt)."""

    def __init__(self, value):
        self.value = value


def _maybe_json(s: str):
    t = s.strip()
    if len(t) < 2 or t[0] not in "[{":
        return None
    try:
        return json.loads(t)
    except ValueError:
        return None


def _decode(value):
    if isinstance(value, dict):
        return {k: _decode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_decode(v) for v in value]
    if isinstance(value, str):
        inner = _maybe_json(value)
        if isinstance(inner, (dict, list)):
            return _Nested(_decode(inner))
    return value


def _encode(value):
    if isinstance(value, _Nested):
        return json.dumps(_encode(value.value), ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, dict):
        return {k: _encode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_encode(v) for v in value]
    return value


def _walk(value, path: Tuple, in_prompt: bool, all_strings: bool, out: List[Leaf]):
    if isinstance(value, _Nested):
        _walk(value.value, path + ("<json>",), in_prompt, all_strings, out)
    elif isinstance(value, dict):
        for k, v in value.items():
            _walk(v, path + (k,), in_prompt or str(k).lower() in PROMPT_KEYS, all_strings, out)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _walk(v, path + (i,), in_prompt, all_strings, out)
    elif isinstance(value, str) and (in_prompt or all_strings) and value.strip() and len(value) <= MAX_LEAF_CHARS:
        out.append(Leaf(path, value))


def _resolve(tree, path: Tuple):
    """Container holding path[-1] (stepping through nested-JSON markers)."""
    node = tree
    for step in path[:-1]:
        if step == "<json>":
            node = node.value
        else:
            node = node[step]
    return node


def parse(host: str, content_type: str, body: bytes) -> ParsedBody:
    ctype = (content_type or "").split(";")[0].strip().lower()
    all_strings = config.host_matches(host, ALL_STRINGS_HOSTS)
    if not body:
        return ParsedBody("none")
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return ParsedBody("none")
    leaves: List[Leaf] = []
    if ctype.endswith("json") or (not ctype and _maybe_json(text) is not None):
        try:
            tree = _decode(json.loads(text))
        except ValueError:
            return ParsedBody("none")
        _walk(tree, (), False, all_strings, leaves)
        return ParsedBody("json", tree, leaves)
    if ctype == "application/x-www-form-urlencoded":
        pairs = [[k, _decode(v)] for k, v in parse_qsl(text, keep_blank_values=True)]
        for i, (k, v) in enumerate(pairs):
            _walk(v, (i, 1), str(k).lower() in PROMPT_KEYS, all_strings, leaves)
        return ParsedBody("form", pairs, leaves)
    if ctype.startswith("text/"):
        return ParsedBody("text", text, [Leaf((), text)])
    return ParsedBody("none")


def rewrite(parsed: ParsedBody, replace: Callable[[str], str]) -> Optional[bytes]:
    """Body with every prompt string replaced by replace(text). None if it cannot be rebuilt."""
    if parsed.kind == "text":
        return replace(parsed.tree).encode("utf-8")
    if parsed.kind not in ("json", "form"):
        return None
    for leaf in parsed.leaves:
        container = _resolve(parsed.tree, leaf.path)
        container[leaf.path[-1]] = replace(leaf.text)
    if parsed.kind == "json":
        return json.dumps(_encode(parsed.tree), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return urlencode([(k, _encode(v)) for k, v in parsed.tree]).encode("utf-8")

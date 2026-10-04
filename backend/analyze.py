"""
Tells - LLM analysis layer.

One job: take a message (plus any deterministic signals already found) and
return the structured analysis. No scoring, no verdict arbitration - that
lives in scoring.py.

Why plain JSON instead of tool use: with the analysis passed as a tool, the
model intermittently leaked its own tool-call syntax into field values -
`"tactics": "<parameter name=\"0\">{...}"` with the remaining array elements
hoisted to top-level keys. The content was always right; only the serialisation
broke, and resampling did not help because the fault is in that layer rather
than in the sample. Asking for a JSON object in a text block avoids the whole
class of failure. The schema file is still the contract - it drives the
instruction below and every validation enum.

This model supports neither forced tool choice nor assistant prefill, so the
output contract is carried entirely by the prompt and enforced entirely by
validate() on the way back.
"""

import json
import os
from pathlib import Path

import anthropic
from dotenv import load_dotenv

# Verify the exact string against the current model list before relying on it.
MODEL = "claude-sonnet-5-5"
MAX_TOKENS = 3000
RETRIES = 2

PROMPTS_DIR = Path(__file__).parent / "prompts"

load_dotenv(PROMPTS_DIR.parent / ".env")

_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
if not _API_KEY:
    # Everyone who clones this repo hits this line first, including a judge.
    # A KeyError tells them nothing they can act on.
    raise RuntimeError(
        "ANTHROPIC_API_KEY is not set. Copy backend/.env.example to "
        "backend/.env and put your key in it."
    )

_client = anthropic.Anthropic(api_key=_API_KEY)

_BASE_PROMPT = (PROMPTS_DIR / "system_prompt.md").read_text(encoding="utf-8")
_schema_file = json.loads((PROMPTS_DIR / "analysis_schema.json").read_text(encoding="utf-8"))
SCHEMA = _schema_file["schema"]

_props = SCHEMA["properties"]
VALID_TACTICS = set(_props["tactics"]["items"]["properties"]["id"]["enum"])
VALID_SEVERITY = set(_props["tactics"]["items"]["properties"]["severity"]["enum"])
VALID_VERDICTS = set(_props["verdict"]["enum"])
VALID_CONFIDENCE = set(_props["confidence"]["enum"])
VALID_ACTIONS = set(_props["recommended_action"]["properties"]["type"]["enum"])


def _output_contract() -> str:
    """Build the output instruction from the schema, so the two cannot drift."""
    return f"""
---

## Output format

Reply with a single JSON object and nothing else. No prose before or after, no
markdown fences, no commentary.

Fill the keys in exactly this order: {", ".join(f"`{k}`" for k in _props)}.

- `tactics` is a JSON array of objects, each with `id`, `severity`, `evidence`
  and `explanation`. An empty array is written `[]`.
- `recommended_action` is a JSON object with `type` and `detail`.
- `id` must be one of: {", ".join(sorted(VALID_TACTICS))}.
- `severity` must be one of: {", ".join(sorted(VALID_SEVERITY))}.
- `verdict` must be one of: {", ".join(sorted(VALID_VERDICTS))}.
- `confidence` must be one of: {", ".join(sorted(VALID_CONFIDENCE))}.
- `recommended_action.type` must be one of: {", ".join(sorted(VALID_ACTIONS))}.

Every key is required. Write ordinary JSON - never XML tags, never
`<parameter>` markers, never keys that are not listed above.
"""


SYSTEM_PROMPT = _BASE_PROMPT + _output_contract()

SIGNAL_LABELS = {
    "link_text_mismatch": "A link's visible text does not match where it actually goes.",
    "lookalike_domain": "The sender's domain imitates a well-known organisation without being it.",
    "punycode_domain": "The domain uses non-Latin characters disguised as Latin ones.",
    "display_name_mismatch": "The display name does not match the actual email address.",
    "reply_to_mismatch": "Replies would go to a different address than the sender's.",
}


class MalformedAnalysis(Exception):
    """The model returned something the schema does not allow."""

    def __init__(self, problems: list[str], raw: object = None):
        super().__init__("; ".join(problems))
        self.problems = problems
        self.raw = raw


def build_message_block(
    msg: dict,
    signals: list[str] | None = None,
    reader_language: str | None = None,
) -> str:
    """
    Render the message for the model. Signals and the reader's language go
    OUTSIDE the untrusted block - inside it, an attacker could set either.
    """
    signals = signals or []
    parts = []

    if reader_language:
        parts.append(f"The reader's language is {reader_language}. Write to them in it.")
        parts.append("")

    if signals:
        parts.append("Deterministic checks already established the following facts:")
        for s in signals:
            parts.append(f"- {s}: {SIGNAL_LABELS.get(s, s)}")
        parts.append("")

    parts.append("<message>")
    parts.append(f"From (display name): {msg.get('from_display') or '(none)'}")
    parts.append(f"From (address): {msg.get('from_address') or '(unknown)'}")
    if msg.get("reply_to"):
        parts.append(f"Reply-To: {msg['reply_to']}")
    parts.append(f"Subject: {msg.get('subject') or '(none)'}")

    links = msg.get("links") or []
    if links:
        parts.append("Links:")
        for ln in links:
            parts.append(f'  - text "{ln.get("anchor_text")}" -> {ln.get("href")}')
    else:
        parts.append("Links: (none)")

    parts.append("")
    parts.append("Body:")
    parts.append(msg.get("body", ""))
    parts.append("</message>")

    return "\n".join(parts)


def extract_json(text: str) -> dict:
    """
    Pull the first complete JSON object out of the model's reply.

    Brace-matching rather than a strict parse, so the object is still found if
    the model wraps it in a markdown fence or adds a sentence either side.
    """
    start = text.find("{")
    if start == -1:
        raise ValueError("no '{' in reply")

    depth, in_string, escaped = 0, False, False
    for i, ch in enumerate(text[start:], start):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start:i + 1])

    raise ValueError("unbalanced braces - reply was probably truncated")


def validate(analysis: object) -> tuple[dict, list[str]]:
    """
    Check the model's output against the schema's own enums.

    Returns the cleaned analysis plus a list of problems. Unknown tactics are
    dropped rather than passed through - the UI has no icon or wording for a
    tactic that does not exist. Anything wrong with a top-level field is
    reported, because there is no safe way to guess what the model meant.
    """
    problems: list[str] = []

    if not isinstance(analysis, dict):
        return {}, [f"top level is {type(analysis).__name__}, not an object"]

    clean = dict(analysis)

    for field, allowed in (
        ("verdict", VALID_VERDICTS),
        ("confidence", VALID_CONFIDENCE),
    ):
        value = clean.get(field)
        if value not in allowed:
            problems.append(f"{field}={value!r} not in {sorted(allowed)}")

    action = clean.get("recommended_action")
    if not isinstance(action, dict):
        problems.append(f"recommended_action is {type(action).__name__}, not an object")
        action = {}
        clean["recommended_action"] = {"type": "none", "detail": ""}
    elif action.get("type") not in VALID_ACTIONS:
        problems.append(f"recommended_action.type={action.get('type')!r} invalid")

    for field in ("benign_reading", "headline", "explain_simple", "language"):
        if not isinstance(clean.get(field), str) or not clean[field].strip():
            problems.append(f"{field} missing or empty")

    tactics = clean.get("tactics")
    if tactics is None:
        problems.append("tactics missing")
        tactics = []
    elif not isinstance(tactics, list):
        problems.append(f"tactics is {type(tactics).__name__}, not a list")
        tactics = []

    unexpected = set(clean) - set(_props) - {"_problems", "_attempts"}
    if unexpected:
        problems.append(f"unexpected top-level keys: {sorted(unexpected)}")

    kept, dropped = [], []
    for t in tactics:
        if not isinstance(t, dict):
            dropped.append(f"<{type(t).__name__}>")
        elif t.get("id") not in VALID_TACTICS:
            dropped.append(str(t.get("id")))
        elif t.get("severity") not in VALID_SEVERITY:
            dropped.append(f"{t.get('id')}(bad severity)")
        elif not isinstance(t.get("evidence"), str) or not t["evidence"].strip():
            dropped.append(f"{t.get('id')}(no evidence)")
        else:
            kept.append(t)

    if dropped:
        problems.append(f"dropped invalid tactics: {dropped}")
    clean["tactics"] = kept

    # suspicious is only honest if it hands the reader something to do
    detail = action.get("detail") if isinstance(action.get("detail"), str) else ""
    if clean.get("verdict") == "suspicious" and len(detail) < 25:
        problems.append("suspicious verdict without a concrete verification step")

    return clean, problems


def _attempt(
    msg: dict, signals: list[str] | None, reader_language: str | None
) -> tuple[dict, list[str]]:
    """One API call, parsed and validated."""
    response = _client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": build_message_block(msg, signals, reader_language),
            }
        ],
    )

    text = "".join(b.text for b in response.content if b.type == "text")

    if response.stop_reason == "max_tokens":
        return {}, [f"reply truncated at {MAX_TOKENS} tokens"]

    try:
        return validate(extract_json(text))
    except (ValueError, json.JSONDecodeError) as exc:
        return {}, [f"unparseable reply: {exc}", f"started: {text[:160]!r}"]


def analyze(
    msg: dict,
    signals: list[str] | None = None,
    strict: bool = True,
    reader_language: str | None = None,
) -> dict:
    """
    Return the validated analysis for one message.

    Nothing in the API enforces the schema, so a sample occasionally comes back
    with a field missing or an invented tactic id. Resampling fixes almost all
    of these, so a failed validation is retried before it is treated as an error.

    strict=True raises MalformedAnalysis if every attempt fails - use this in
    the eval so regressions are loud. strict=False returns the best attempt
    with its problems under '_problems' - use this in the API, where a degraded
    answer beats no answer.

    reader_language is who the explanation is for, not what the message is in.
    A scam written in a language the reader barely speaks is exactly the case
    this tool exists for, so the two are kept apart.
    """
    attempts: list[tuple[dict, list[str]]] = []

    for _ in range(RETRIES + 1):
        clean, problems = _attempt(msg, signals, reader_language)
        if not problems:
            clean["_problems"] = []
            clean["_attempts"] = len(attempts) + 1
            return clean
        attempts.append((clean, problems))

    best, problems = min(attempts, key=lambda a: len(a[1]))

    if strict:
        raise MalformedAnalysis(problems, raw=best)

    best["_problems"] = problems
    best["_attempts"] = len(attempts)
    return best


def _normalise(s: str) -> str:
    """
    Fold the differences that break a literal substring match but not meaning:
    collapsed whitespace, and the typographic punctuation a model tends to
    produce where the source has the plain ASCII form.

    The UI must normalise identically before it highlights, or a quote that
    passes here will still fail to find its text in the page.
    """
    for fancy, plain in (
        ("‘", "'"), ("’", "'"), ("‚", "'"), ("‛", "'"),
        ("“", '"'), ("”", '"'), ("„", '"'),
        ("‐", "-"), ("‑", "-"), ("‒", "-"),
        ("–", "-"), ("—", "-"), ("−", "-"),
        (" ", " "), ("…", "..."),
    ):
        s = s.replace(fancy, plain)
    return " ".join(s.split())


def verify_evidence(msg: dict, analysis: dict) -> list[str]:
    """
    Every tactic must quote the message verbatim - the UI highlights these.
    Returns quotes NOT found in the source.

    The haystack covers the headers as well as the body: a display name or a
    sender address is part of the message the model was shown, and quoting it
    is often the clearest evidence of impersonation.
    """
    haystack = _normalise(
        " ".join(
            str(part)
            for part in (
                msg.get("from_display"),
                msg.get("from_address"),
                msg.get("reply_to"),
                msg.get("subject"),
                msg.get("body"),
            )
            if part
        )
    )

    return [
        t["evidence"]
        for t in analysis.get("tactics", [])
        if t.get("evidence") and _normalise(t["evidence"]) not in haystack
    ]
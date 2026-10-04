"""
Tells - deterministic verdict floor.

The model decides the verdict, but it cannot decide it is nothing. This module
states combinations that must never come back as harmless, and raises the
verdict when the model's answer sits below that floor.

It only ever raises. The model may be more cautious than these rules; it may
not be less. Nothing here is tuned on the fixture - every rule is a claim that
stands on its own, which is the point. A weighted score fitted to fifteen
examples would mostly be measuring those fifteen examples.

Signals are not equally trustworthy, and the rules treat them accordingly:

  MECHANICAL  link_text_mismatch, punycode_domain, reply_to_mismatch
              Either the strings differ or they do not. No judgement, so these
              can raise a verdict on their own.

  HEURISTIC   lookalike_domain, display_name_mismatch
              A guess about intent behind a name. These will misfire on real
              senders, so on their own they raise nothing - they only count
              alongside an actual ask.
"""

ORDER = {"safe": 0, "suspicious": 1, "dangerous": 2}
BY_RANK = {v: k for k, v in ORDER.items()}

MECHANICAL_DECEPTION = {"link_text_mismatch", "punycode_domain", "reply_to_mismatch"}
HEURISTIC_DECEPTION = {"lookalike_domain", "display_name_mismatch"}

ASKS = {"credential_request", "payment_request"}


def _rule_hits(tactics: set[str], signals: set[str], high: set[str]) -> list[tuple[str, str]]:
    """Return (floor, reason) for every rule that fires."""
    hits: list[tuple[str, str]] = []

    mechanical = signals & MECHANICAL_DECEPTION
    heuristic = signals & HEURISTIC_DECEPTION
    asks = tactics & ASKS

    # A mechanical mismatch is proof the reader is being misled about who is
    # writing or where a link goes. Combined with an ask, there is nothing left
    # to verify.
    if mechanical and asks:
        hits.append((
            "dangerous",
            f"{', '.join(sorted(mechanical))} alongside {', '.join(sorted(asks))}",
        ))
    elif mechanical:
        hits.append((
            "suspicious",
            f"{', '.join(sorted(mechanical))} - the message misrepresents itself",
        ))

    # These are judgement calls, so they need an ask behind them.
    if heuristic and asks:
        hits.append((
            "suspicious",
            f"{', '.join(sorted(heuristic))} alongside {', '.join(sorted(asks))}",
        ))

    # Being steered away from anyone who could check, plus a request for money.
    # No legitimate sender needs both.
    if "isolation" in tactics and "payment_request" in tactics:
        hits.append(("dangerous", "isolation alongside a request for money"))

    if "secrecy" in tactics and "payment_request" in tactics:
        hits.append(("dangerous", "secrecy alongside a request for money"))

    # Posing as a specific identity while asking for credentials.
    if "impersonation" in tactics and "credential_request" in tactics:
        hits.append(("dangerous", "impersonation alongside a request for credentials"))

    # Several serious tactics at once is not an ordinary message, whatever the
    # model concluded about any one of them.
    if len(high) >= 3:
        hits.append((
            "suspicious",
            f"{len(high)} high-severity tactics: {', '.join(sorted(high))}",
        ))

    return hits


def apply_floor(analysis: dict, signals: list[str] | None = None) -> dict:
    """
    Raise the verdict to the floor the rules require, and record what happened.

    Adds a 'floor' block: the floor itself, the reasons behind it, and whether
    the model's own verdict had to be overridden. Keep the original in
    'model_verdict' - a disagreement is worth logging, since a floor that fires
    often means the prompt is under-calling, and one that never fires on real
    traffic may be dead weight.
    """
    signals_set = set(signals or [])
    tactics = {t["id"] for t in analysis.get("tactics", [])}
    high = {t["id"] for t in analysis.get("tactics", []) if t.get("severity") == "high"}

    hits = _rule_hits(tactics, signals_set, high)

    model_verdict = analysis.get("verdict", "safe")
    floor = BY_RANK[max((ORDER[v] for v, _ in hits), default=0)]

    final = BY_RANK[max(ORDER.get(model_verdict, 0), ORDER[floor])]

    out = dict(analysis)
    out["model_verdict"] = model_verdict
    out["verdict"] = final
    out["floor"] = {
        "level": floor,
        "reasons": [r for _, r in hits],
        "raised": final != model_verdict,
    }
    return out


def explain_floor(result: dict) -> str:
    """One line for the log. Empty when the floor had nothing to say."""
    floor = result.get("floor") or {}
    if not floor.get("reasons"):
        return ""

    verb = (
        f"raised {floor['level']} over the model's {result['model_verdict']}"
        if floor.get("raised")
        else f"floor {floor['level']}, model already at or above it"
    )
    return f"{verb} - {'; '.join(floor['reasons'])}"
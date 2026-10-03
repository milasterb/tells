"""
Tells - evaluation harness.

Runs every fixture case through the LLM layer plus the deterministic floor and
reports where the result disagrees with what the case expects. This is the
acceptance test: run it after every prompt change, before touching anything
else.

    python tests/run_eval.py              # all cases
    python tests/run_eval.py p09 L12      # just these

Signals are taken from the fixture rather than computed here. The deterministic
detection lives in the extension (JS) and is tested in the browser; this
harness isolates the LLM so a prompt regression is unambiguous.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from analyze import MalformedAnalysis, analyze, verify_evidence  # noqa: E402
from scoring import apply_floor, explain_floor  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "tells_testset.json"

GREEN, YELLOW, RED, CYAN, DIM, BOLD, OFF = (
    "\033[32m", "\033[33m", "\033[31m", "\033[36m", "\033[2m", "\033[1m", "\033[0m",
)


def run_case(case: dict) -> dict:
    signals = case.get("expected_signals") or []

    analysis = analyze(case, signals=signals)
    result = apply_floor(analysis, signals)

    got_tactics = {t["id"] for t in result.get("tactics", [])}
    want_tactics = set(case.get("expected_tactics", []))

    return {
        "id": case["id"],
        "label": case["label"],
        "want_verdict": case["expected_verdict"],
        "got_verdict": result["verdict"],
        "model_verdict": result["model_verdict"],
        "verdict_ok": result["verdict"] == case["expected_verdict"],
        "floor": result["floor"],
        "floor_note": explain_floor(result),
        "missing_tactics": sorted(want_tactics - got_tactics),
        "extra_tactics": sorted(got_tactics - want_tactics),
        "bad_quotes": verify_evidence(case, result),
        "confidence": result.get("confidence"),
        "attempts": result.get("_attempts", 1),
        "headline": result.get("headline", ""),
        "action": result.get("recommended_action", {}),
        "analysis": result,
    }


def error_row(case: dict, exc: Exception) -> dict:
    return {
        "id": case["id"],
        "label": case["label"],
        "error": f"{type(exc).__name__}: {exc}",
        "want_verdict": case["expected_verdict"],
        "got_verdict": "-",
        "model_verdict": "-",
        "verdict_ok": False,
        "floor": {},
        "floor_note": "",
        "missing_tactics": [],
        "extra_tactics": [],
        "bad_quotes": [],
        "confidence": "-",
        "attempts": 0,
        "headline": "",
        "action": {},
    }


def main() -> int:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    cases = fixture["cases"]

    wanted = set(sys.argv[1:])
    if wanted:
        cases = [c for c in cases if c["id"] in wanted]
        if not cases:
            print(f"No case matched {sorted(wanted)}")
            return 2

    results, errors = [], []
    for case in cases:
        print(f"{DIM}running {case['id']}...{OFF}", end="\r", flush=True)
        try:
            results.append(run_case(case))
        except (MalformedAnalysis, Exception) as exc:  # one failure must not end the run
            print(f"{RED}{case['id']}: {type(exc).__name__}: {exc}{OFF}")
            row = error_row(case, exc)
            results.append(row)
            errors.append(row)

    print(" " * 40, end="\r")
    print(f"\n{BOLD}{'id':<5} {'want':<11} {'final':<11} {'model':<11} "
          f"{'conf':<7} {'try':<4} notes{OFF}")
    print("-" * 94)

    for r in results:
        colour = GREEN if r["verdict_ok"] else RED
        notes = []

        if r.get("error"):
            notes.append(f"{RED}{r['error'][:60]}{OFF}")
        if r["floor"].get("raised"):
            notes.append(f"{CYAN}FLOOR RAISED{OFF}")
        if r["missing_tactics"]:
            notes.append(f"missed: {','.join(r['missing_tactics'])}")
        if r["extra_tactics"]:
            notes.append(f"{YELLOW}extra: {','.join(r['extra_tactics'])}{OFF}")
        if r["bad_quotes"]:
            notes.append(f"{RED}PARAPHRASED {len(r['bad_quotes'])} quote(s){OFF}")
        if r["label"] == "legitimate" and not r["verdict_ok"]:
            notes.append(f"{RED}FALSE POSITIVE{OFF}")

        attempts = r["attempts"]
        attempts_str = f"{YELLOW}{attempts}{OFF}" if attempts > 1 else str(attempts)

        print(
            f"{colour}{r['id']:<5}{OFF} {r['want_verdict']:<11} "
            f"{colour}{r['got_verdict']:<11}{OFF} {str(r['model_verdict']):<11} "
            f"{str(r['confidence']):<7} {attempts_str:<4} {' | '.join(notes)}"
        )

    legit = [r for r in results if r["label"] == "legitimate"]
    phish = [r for r in results if r["label"] == "phishing"]
    false_pos = [r for r in legit if not r["verdict_ok"]]
    missed = [r for r in phish if r["got_verdict"] == "safe"]
    paraphrased = [r for r in results if r["bad_quotes"]]
    raised = [r for r in results if r["floor"].get("raised")]
    fired = [r for r in results if r["floor"].get("reasons")]
    retried = [r for r in results if r["attempts"] > 1]

    print("\n" + "=" * 94)
    print(f"verdicts correct   {sum(r['verdict_ok'] for r in results)}/{len(results)}")

    if legit:
        tag = GREEN if not false_pos else RED
        print(f"{tag}false positives    {len(false_pos)}/{len(legit)} legitimate "
              f"messages flagged{OFF}"
              + (f"  -> {', '.join(r['id'] for r in false_pos)}" if false_pos else ""))

    if phish:
        tag = GREEN if not missed else RED
        print(f"{tag}missed entirely    {len(missed)}/{len(phish)} phishing "
              f"messages called safe{OFF}"
              + (f"  -> {', '.join(r['id'] for r in missed)}" if missed else ""))

    if paraphrased:
        print(f"{RED}paraphrased quotes {len(paraphrased)} case(s) -> "
              f"{', '.join(r['id'] for r in paraphrased)}{OFF}")
        print(f"{DIM}  Highlighting breaks for these. Tighten the evidence rule.{OFF}")

    if errors:
        print(f"{RED}hard failures      {len(errors)} case(s) -> "
              f"{', '.join(r['id'] for r in errors)}{OFF}")

    if retried:
        print(f"{YELLOW}needed a retry     {len(retried)} case(s) -> "
              f"{', '.join(r['id'] for r in retried)}{OFF}")

    print(f"\n{BOLD}Floor{OFF}")
    print(f"  rules fired      {len(fired)}/{len(results)} case(s)")
    print(f"  verdict raised   {len(raised)} case(s)"
          + (f"  -> {', '.join(r['id'] for r in raised)}" if raised else ""))

    if raised:
        print(f"{CYAN}  The model called these lower than the rules allow. Either the"
              f"\n  prompt is under-calling, or a rule is too aggressive - read both"
              f"\n  and decide which.{OFF}")
    elif fired:
        print(f"{DIM}  Rules agreed with the model everywhere they had an opinion.{OFF}")
    else:
        print(f"{YELLOW}  No rule fired at all. The floor is carrying nothing - check"
              f"\n  the signals are actually reaching it.{OFF}")

    for r in results:
        if r["floor_note"]:
            print(f"  {DIM}{r['id']}{OFF}  {r['floor_note']}")

    print("=" * 94)
    print(f"\n{DIM}Headlines:{OFF}")
    for r in results:
        if r["headline"]:
            print(f"  {DIM}{r['id']}{OFF}  {r['headline']}")

    out = Path(__file__).parent / "last_run.json"
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n{DIM}Full output: {out}{OFF}")

    # Non-zero if a legitimate message was flagged, phishing slipped through,
    # a quote was paraphrased, or a case failed outright.
    return 1 if (false_pos or missed or paraphrased or errors) else 0


if __name__ == "__main__":
    sys.exit(main())
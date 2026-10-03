"""
Tells - evaluation harness.

Runs every fixture case through the LLM layer and reports where the analysis
disagrees with what the case expects. This is the acceptance test: run it after
every prompt change, before touching anything else.

    python tests/run_eval.py              # all cases
    python tests/run_eval.py p09 L12      # just these

Signals are taken from the fixture rather than computed here. The deterministic
layer lives in the extension (JS) and is tested in the browser; this harness
isolates the LLM so a prompt regression is unambiguous.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from analyze import analyze, verify_evidence  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "tells_testset.json"

GREEN, YELLOW, RED, DIM, BOLD, OFF = (
    "\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[1m", "\033[0m",
)


def run_case(case: dict) -> dict:
    analysis = analyze(case, signals=case.get("expected_signals"))

    got_tactics = {t["id"] for t in analysis.get("tactics", [])}
    want_tactics = set(case.get("expected_tactics", []))

    return {
        "id": case["id"],
        "label": case["label"],
        "want_verdict": case["expected_verdict"],
        "got_verdict": analysis["verdict"],
        "verdict_ok": analysis["verdict"] == case["expected_verdict"],
        "missing_tactics": sorted(want_tactics - got_tactics),
        "extra_tactics": sorted(got_tactics - want_tactics),
        "bad_quotes": verify_evidence(case, analysis),
        "confidence": analysis.get("confidence"),
        "headline": analysis.get("headline", ""),
        "action": analysis.get("recommended_action", {}),
        "analysis": analysis,
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

    results = []
    for case in cases:
        print(f"{DIM}running {case['id']}...{OFF}", end="\r", flush=True)
        try:
            results.append(run_case(case))
        except Exception as exc:  # keep going; one failure shouldn't end the run
            print(f"{RED}{case['id']}: {type(exc).__name__}: {exc}{OFF}")
            results.append({
                "id": case["id"], "label": case["label"], "error": str(exc),
                "verdict_ok": False, "want_verdict": case["expected_verdict"],
                "got_verdict": "-", "missing_tactics": [], "extra_tactics": [],
                "bad_quotes": [], "confidence": "-", "headline": "", "action": {},
            })

    print(" " * 40, end="\r")
    print(f"\n{BOLD}{'id':<5} {'want':<11} {'got':<11} {'conf':<7} notes{OFF}")
    print("-" * 78)

    for r in results:
        colour = GREEN if r["verdict_ok"] else RED
        notes = []
        if r["missing_tactics"]:
            notes.append(f"missed: {','.join(r['missing_tactics'])}")
        if r["extra_tactics"]:
            notes.append(f"{YELLOW}extra: {','.join(r['extra_tactics'])}{OFF}")
        if r["bad_quotes"]:
            notes.append(f"{RED}PARAPHRASED {len(r['bad_quotes'])} quote(s){OFF}")
        if r["label"] == "legitimate" and not r["verdict_ok"]:
            notes.append(f"{RED}FALSE POSITIVE{OFF}")

        print(
            f"{colour}{r['id']:<5}{OFF} {r['want_verdict']:<11} "
            f"{colour}{r['got_verdict']:<11}{OFF} {str(r['confidence']):<7} "
            f"{' | '.join(notes)}"
        )

    legit = [r for r in results if r["label"] == "legitimate"]
    phish = [r for r in results if r["label"] == "phishing"]
    false_pos = [r for r in legit if not r["verdict_ok"]]
    missed = [r for r in phish if r["got_verdict"] == "safe"]
    paraphrased = [r for r in results if r["bad_quotes"]]

    print("\n" + "=" * 78)
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

    print("=" * 78)
    print(f"\n{DIM}Headlines:{OFF}")
    for r in results:
        if r["headline"]:
            print(f"  {DIM}{r['id']}{OFF}  {r['headline']}")

    out = Path(__file__).parent / "last_run.json"
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n{DIM}Full output: {out}{OFF}")

    # Non-zero if a legitimate message was flagged or phishing slipped through.
    return 1 if (false_pos or missed or paraphrased) else 0


if __name__ == "__main__":
    sys.exit(main())
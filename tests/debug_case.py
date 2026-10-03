"""
Tells - single-case debugger.

Shows the raw, unvalidated response for one fixture case: stop reason, token
usage, and the exact JSON the model produced. Use it when run_eval reports
something that makes no sense.

    python tests/debug_case.py p04
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import analyze as A  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "tells_testset.json"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    case_id = sys.argv[1]
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
    case = next((c for c in cases if c["id"] == case_id), None)
    if case is None:
        print(f"No case {case_id!r}")
        return 2

    response = A._client.messages.create(
        model=A.MODEL,
        max_tokens=A.MAX_TOKENS,
        system=A.SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": A.build_message_block(case, case.get("expected_signals")),
        }],
    )

    print(f"stop_reason : {response.stop_reason}")
    print(f"input       : {response.usage.input_tokens} tokens")
    print(f"output      : {response.usage.output_tokens} tokens (cap {A.MAX_TOKENS})")
    if response.stop_reason == "max_tokens":
        print("\n>>> TRUNCATED. The JSON was cut off mid-write; raise MAX_TOKENS.")
    print(f"blocks      : {[b.type for b in response.content]}\n")

    for block in response.content:
        if block.type == "text":
            print(f"--- text ---\n{block.text}\n")
        elif block.type == "tool_use":
            print("--- tool_use input ---")
            print(json.dumps(block.input, indent=2, ensure_ascii=False))

            clean, problems = A.validate(block.input)
            print(f"\n--- validation ---\n{problems or 'clean'}")

            bad = A.verify_evidence(case, clean)
            if bad:
                print("\n--- quotes NOT found in the message ---")
                for q in bad:
                    print(f"  model wrote : {q!r}")
                    # show the nearest run of source text, to see what differs
                    needle = " ".join(q.split())[:40]
                    hay = " ".join(f"{case['subject']} {case['body']}".split())
                    head = needle[:18]
                    at = hay.find(head)
                    print(f"  source near : {hay[max(0, at - 10):at + 90]!r}"
                          if at >= 0 else "  source near : (no overlap at all)")
                    print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
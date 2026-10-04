/**
 * Tells - signal detection tests.
 *
 * Runs the deterministic layer against the fixture, with no browser and no
 * API calls. This is the half the Python eval cannot see: run_eval.py feeds
 * signals in from the fixture, so it proves the model reasons well about
 * signals it was handed. This proves the signals are found in the first place.
 *
 *   node tests/test_signals.js
 */

const fs = require("fs");
const path = require("path");

const S = require(path.join(__dirname, "..", "extension", "content", "signals.js"));

const FIXTURE = path.join(__dirname, "fixtures", "tells_testset.json");

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

function main() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const cases = fixture.cases;

  const rows = cases.map((c) => {
    const { signals, details } = S.findSignals(c);
    const got = new Set(signals);
    const want = new Set(c.expected_signals || []);

    return {
      id: c.id,
      label: c.label,
      got,
      want,
      missing: [...want].filter((s) => !got.has(s)).sort(),
      extra: [...got].filter((s) => !want.has(s)).sort(),
      details,
    };
  });

  console.log(`\n${BOLD}${"id".padEnd(5)} ${"signals found".padEnd(46)} notes${OFF}`);
  console.log("-".repeat(96));

  for (const r of rows) {
    const exact = r.missing.length === 0 && r.extra.length === 0;
    const colour = exact ? GREEN : r.extra.length && r.label === "legitimate" ? RED : YELLOW;

    const notes = [];
    if (r.missing.length) notes.push(`${YELLOW}missed: ${r.missing.join(",")}${OFF}`);
    if (r.extra.length) notes.push(`${RED}extra: ${r.extra.join(",")}${OFF}`);

    console.log(
      `${colour}${r.id.padEnd(5)}${OFF} ${([...r.got].sort().join(", ") || DIM + "(none)" + OFF).padEnd(46)} ` +
      notes.join(" | ")
    );
  }

  const legit = rows.filter((r) => r.label === "legitimate");
  const phish = rows.filter((r) => r.label === "phishing");
  const falseFires = legit.filter((r) => r.got.size > 0);
  const exact = rows.filter((r) => !r.missing.length && !r.extra.length);
  const phishWithSignal = phish.filter((r) => r.got.size > 0);

  console.log("\n" + "=".repeat(96));
  console.log(`exact match        ${exact.length}/${rows.length} cases`);

  const fireTag = falseFires.length ? RED : GREEN;
  console.log(
    `${fireTag}fired on legitimate ${falseFires.length}/${legit.length}${OFF}` +
    (falseFires.length ? `  -> ${falseFires.map((r) => r.id).join(", ")}` : "")
  );
  console.log(
    `caught a signal    ${phishWithSignal.length}/${phish.length} phishing messages ` +
    `${DIM}(the rest need the model)${OFF}`
  );

  const silent = phish.filter((r) => r.got.size === 0);
  if (silent.length) {
    console.log(
      `\n${BOLD}No deterministic signal at all:${OFF} ${silent.map((r) => r.id).join(", ")}`
    );
    console.log(
      `${DIM}  These are the cases rules cannot reach. If that set is just the\n` +
      `  AI-written ones, the whole argument for the project holds.${OFF}`
    );
  }

  console.log("=".repeat(96));

  // Normalisation must agree with _normalise() in analyze.py or quotes that
  // pass the eval will fail to highlight in the page.
  const checks = [
    ["don’t tell", "don't tell"],
    ["back‑to‑back", "back-to-back"],
    ["a  b\n\nc", "a b c"],
    ["“quoted”", '"quoted"'],
    ["wait…", "wait..."],
    ["a b", "a b"],
  ];
  const bad = checks.filter(([input, want]) => S.normalise(input) !== want);

  console.log(`\n${BOLD}normalise() parity${OFF}`);
  if (bad.length) {
    console.log(`${RED}  ${bad.length} case(s) disagree with the Python side:${OFF}`);
    for (const [input, want] of bad) {
      console.log(`    ${JSON.stringify(input)} -> ${JSON.stringify(S.normalise(input))}, expected ${JSON.stringify(want)}`);
    }
  } else {
    console.log(`${GREEN}  all ${checks.length} folds match${OFF}`);
  }

  const failed = falseFires.length > 0 || bad.length > 0;
  if (failed) console.log(`\n${RED}FAIL${OFF}`);
  process.exit(failed ? 1 : 0);
}

main();
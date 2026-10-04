/**
 * Tells - result card renderer.
 *
 * A pure function: analysis in, DOM element out. The popup renders it in the
 * popup; the Gmail content script injects the same element into the page. No
 * other module needs to know how a verdict looks.
 *
 * Everything is built with createElement and textContent. Never innerHTML:
 * the strings here come from a stranger's message by way of a language model,
 * and a card that renders attacker-supplied markup in the reader's mailbox
 * would be a worse problem than the one this tool solves.
 */

(function (root) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Words
   *
   * The enum ids are for the code. Nobody says "credential_request" to
   * their grandmother. Each tactic gets a name that says what the sender
   * is doing to the reader, in the second person, because that is who it
   * is being done to.
   * ------------------------------------------------------------------ */

  const TACTIC_NAMES = {
    urgency: "Rushing you",
    authority: "Pulling rank",
    fear: "Frightening you",
    reward: "Dangling a prize",
    secrecy: "Asking you to keep it quiet",
    isolation: "Keeping you from checking",
    impersonation: "Pretending to be someone else",
    credential_request: "Asking for your password",
    payment_request: "Asking for money",
    ai_generated_polish: "Too polished for a stranger",
  };

  const VERDICT_WORDS = {
    safe: "Nothing out of place",
    suspicious: "Worth checking",
    dangerous: "Don't act on this",
  };

  const SIGNAL_WORDS = {
    link_text_mismatch: "A link goes somewhere other than it says",
    lookalike_domain: "The sender's address imitates a real company",
    punycode_domain: "The address uses lookalike characters",
    display_name_mismatch: "The sender's name doesn't match their address",
    reply_to_mismatch: "Replies would go to a different address",
  };

  function tacticName(id) {
    return TACTIC_NAMES[id] || id.replace(/_/g, " ");
  }

  /* ------------------------------------------------------------------ *
   * Mascot
   *
   * Three resting states plus one shared reaction. The placeholder below
   * is geometric SVG; swapping it for the pixel sprites means replacing
   * this function and nothing else.
   * ------------------------------------------------------------------ */

  const MASCOT_EYES = {
    safe: { lid: 10, pupil: 3.2, brow: null },
    suspicious: { lid: 7, pupil: 3.6, brow: "M9 7 L16 5" },
    dangerous: { lid: 12, pupil: 4.6, brow: "M9 4 L16 6" },
    working: { lid: 5, pupil: 3.0, brow: null },
  };

  function mascotFor(verdict) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const shape = MASCOT_EYES[verdict] || MASCOT_EYES.working;

    svg.setAttribute("viewBox", "0 0 32 32");
    svg.setAttribute("class", "tells-mascot");
    svg.setAttribute("aria-hidden", "true");

    const el = (name, attrs) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.appendChild(node);
      return node;
    };

    el("ellipse", {
      cx: 16, cy: 16, rx: 14, ry: shape.lid,
      fill: "none", stroke: "currentColor", "stroke-width": 2,
    });
    el("circle", { cx: 16, cy: 16, r: shape.pupil, fill: "currentColor" });
    if (shape.brow) {
      el("path", {
        d: shape.brow, fill: "none", stroke: "currentColor",
        "stroke-width": 2, "stroke-linecap": "round",
      });
    }

    svg.style.color = "var(--verdict)";
    return svg;
  }

  /* ------------------------------------------------------------------ *
   * Text normalisation
   *
   * MUST match _normalise() in backend/analyze.py and normalise() in
   * signals.js. Used to find a quote inside the message text: the model
   * writes typographic punctuation where the source has ASCII, and a
   * literal match would fail on quotes that are otherwise correct.
   * ------------------------------------------------------------------ */

  const PUNCTUATION_FOLD = [
    ["‘", "'"], ["’", "'"], ["‚", "'"], ["‛", "'"],
    ["“", '"'], ["”", '"'], ["„", '"'],
    ["‐", "-"], ["‑", "-"], ["‒", "-"],
    ["–", "-"], ["—", "-"], ["−", "-"],
    [" ", " "], ["…", "..."],
  ];

  function normalise(s) {
    let out = String(s == null ? "" : s);
    for (const [fancy, plain] of PUNCTUATION_FOLD) out = out.split(fancy).join(plain);
    return out.trim().split(/\s+/).join(" ");
  }

  /* ------------------------------------------------------------------ *
   * Pieces
   * ------------------------------------------------------------------ */

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * The quote, with the giveaway marked.
   *
   * The model's evidence is the whole quote, so the marker covers all of it.
   * Where the quote is long, the words are still the message's own - the
   * marker is a reader's highlighter, not a diff.
   */
  function quoteBlock(tactic) {
    const p = node("p", "tells-quote");
    const mark = node("span", "tells-quote-mark", normalise(tactic.evidence));
    p.append(document.createTextNode("“"), mark, document.createTextNode("”"));
    return p;
  }

  function tacticItem(tactic) {
    const li = node("li", "tells-item");
    li.dataset.severity = tactic.severity || "low";

    const why = node("p", "tells-why");
    why.appendChild(node("span", "tells-sev"));
    why.appendChild(node("b", null, tacticName(tactic.id)));
    why.appendChild(document.createTextNode(" — " + (tactic.explanation || "")));

    li.append(quoteBlock(tactic), why);
    return li;
  }

  /* ------------------------------------------------------------------ *
   * The card
   * ------------------------------------------------------------------ */

  /**
   * Build a card for a finished analysis.
   *
   * @param {object} result  the /analyse response
   * @param {object} [opts]  { animate: boolean }
   */
  function renderCard(result, opts) {
    const options = opts || {};
    const verdict = result.verdict || "suspicious";

    const card = node("div", "tells-card");
    card.dataset.verdict = verdict;
    card.dataset.state = "done";
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", "Tells analysis");

    /* head */
    const head = node("div", "tells-head");
    const mascot = mascotFor(verdict);
    if (options.animate) mascot.dataset.reacting = "true";

    const headText = node("div");
    headText.append(
      node("p", "tells-verdict-word", VERDICT_WORDS[verdict] || verdict),
      node("h2", "tells-headline", result.headline || "")
    );
    head.append(mascot, headText);
    card.appendChild(head);

    /* what to do */
    const action = result.recommended_action || {};
    if (action.detail) {
      const el = node("p", "tells-action", action.detail);
      el.dataset.kind = action.type || "none";
      card.appendChild(el);
    }

    /* the tells themselves */
    const tactics = result.tactics || [];
    if (tactics.length) {
      const list = node("ul", "tells-list");
      for (const t of tactics) list.appendChild(tacticItem(t));
      card.appendChild(list);
    }

    /* what the checks found, where the model did not already quote it */
    const signals = result.signals || [];
    if (signals.length) {
      const list = node("ul", "tells-list");
      for (const s of signals) {
        const li = node("li", "tells-item");
        li.dataset.severity = "medium";
        const why = node("p", "tells-why");
        why.appendChild(node("span", "tells-sev"));
        why.appendChild(document.createTextNode(SIGNAL_WORDS[s] || s));
        li.appendChild(why);
        list.appendChild(li);
      }
      card.appendChild(list);
    }

    /* the simple explanation, folded away - the headline usually does it */
    if (result.explain_simple) {
      const details = node("details", "tells-simple");
      details.appendChild(node("summary", null, "Explain it simply"));
      details.appendChild(node("p", "tells-simple-body", result.explain_simple));
      card.appendChild(details);
    }

    /* why this might be fine - shown only where it could be */
    if (result.benign_reading && verdict !== "dangerous") {
      card.appendChild(node("p", "tells-benign", result.benign_reading));
    }

    return card;
  }

  /** The card while the analysis is running. Same shape, so nothing jumps. */
  function renderWorking(message) {
    const card = node("div", "tells-card");
    card.dataset.state = "working";
    card.setAttribute("role", "status");

    const head = node("div", "tells-head");
    head.append(
      mascotFor("working"),
      node("h2", "tells-headline", message || "Reading the message…")
    );
    card.appendChild(head);
    return card;
  }

  /**
   * The card when it could not run.
   *
   * It says what to do next, not that something went wrong. "Failed to fetch"
   * tells the reader nothing they can act on.
   */
  function renderFailed(reason, onRetry) {
    const card = node("div", "tells-card");
    card.dataset.state = "failed";
    card.setAttribute("role", "alert");

    const head = node("div", "tells-head");
    head.append(
      mascotFor("working"),
      node("h2", "tells-headline", reason || "Tells could not reach its backend.")
    );
    card.appendChild(head);

    if (onRetry) {
      const button = node("button", "tells-retry", "Try again");
      button.type = "button";
      button.addEventListener("click", onRetry);
      card.appendChild(button);
    }
    return card;
  }

  const api = {
    renderCard,
    renderWorking,
    renderFailed,
    mascotFor,
    normalise,
    TACTIC_NAMES,
    VERDICT_WORDS,
    SIGNAL_WORDS,
  };

  root.TellsCard = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
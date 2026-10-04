/**
 * Tells - deterministic signal detection.
 *
 * Runs entirely in the page. Nothing here calls the network, which is what
 * makes Automatic mode free: every message gets these checks, and the backend
 * is only woken when one of them fires or the reader asks.
 *
 * Two classes of check, and the difference matters because scoring.py treats
 * them differently:
 *
 *   MECHANICAL   Either two strings differ or they do not. No judgement, so
 *                these can raise a verdict on their own.
 *                  link_text_mismatch, punycode_domain, reply_to_mismatch
 *
 *   HEURISTIC    A guess about intent behind a name. Will misfire on real
 *                senders, so these only count alongside an actual ask.
 *                  lookalike_domain, display_name_mismatch
 *
 * Works in the browser (globalThis.TellsSignals) and under Node, so the same
 * code can be tested against the fixture without loading Chrome.
 */

(function (root) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Text normalisation
   *
   * MUST stay identical to _normalise() in backend/analyze.py. The model's
   * quotes are matched against the page with this applied on both sides; if
   * the two implementations drift, a quote that passes the eval will fail to
   * highlight in Gmail and the most visible part of the product breaks.
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
    for (const [fancy, plain] of PUNCTUATION_FOLD) {
      out = out.split(fancy).join(plain);
    }
    return out.trim().split(/\s+/).join(" ");
  }

  /* ------------------------------------------------------------------ *
   * Domains
   * ------------------------------------------------------------------ */

  // Suffixes that take one more label than usual. Not the full public suffix
  // list - that is 10k entries and the wrong trade for this. Enough to stop
  // barclays.co.uk being read as "co.uk".
  const MULTIPART_SUFFIXES = new Set([
    "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk",
    "com.au", "net.au", "org.au", "gov.au", "edu.au",
    "co.nz", "co.za", "co.jp", "or.jp", "ne.jp",
    "com.br", "com.mx", "com.tr", "com.cn", "com.hk", "com.sg",
    "co.in", "net.in", "org.in",
  ]);

  /** Host part of an email address or URL, lower-cased, no port or www. */
  function hostOf(value) {
    if (!value) return "";
    let v = String(value).trim().toLowerCase();

    const at = v.lastIndexOf("@");
    if (at !== -1 && !v.includes("://")) {
      v = v.slice(at + 1);
    } else {
      v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
      const at2 = v.lastIndexOf("@");
      if (at2 !== -1) v = v.slice(at2 + 1);
      v = v.split(/[/?#]/)[0];
    }

    v = v.split(":")[0].replace(/^www\./, "").replace(/\.$/, "");
    return v;
  }

  /** The registrable domain: example.co.uk, not mail.example.co.uk. */
  function registrableDomain(value) {
    const host = hostOf(value);
    if (!host || !host.includes(".")) return host;

    const parts = host.split(".");
    const lastTwo = parts.slice(-2).join(".");
    const take = MULTIPART_SUFFIXES.has(lastTwo) ? 3 : 2;
    return parts.slice(-take).join(".");
  }

  /** Labels of a domain minus its suffix: ["barclays", "secure", "alerts"]. */
  function domainLabels(value) {
    const reg = registrableDomain(value);
    if (!reg) return [];
    const parts = reg.split(".");
    const lastTwo = parts.slice(-2).join(".");
    const suffixLen = MULTIPART_SUFFIXES.has(lastTwo) ? 2 : 1;
    return parts.slice(0, parts.length - suffixLen).flatMap((p) => p.split("-"));
  }

  function isPunycode(value) {
    return hostOf(value).split(".").some((label) => label.startsWith("xn--"));
  }

  /** Levenshtein, capped - we only ever care about distances of 0, 1 or 2. */
  function editDistance(a, b, cap) {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;

    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const curr = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        curr[j] = Math.min(
          prev[j] + 1,
          curr[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        rowMin = Math.min(rowMin, curr[j]);
      }
      if (rowMin > cap) return cap + 1;
      prev = curr;
    }
    return prev[b.length];
  }

  /* ------------------------------------------------------------------ *
   * Known senders
   *
   * Lookalike detection needs to know what the real domain is. There is no
   * way around that: "barclays-secure-alerts.com" is only suspicious if you
   * know Barclays uses barclays.co.uk.
   *
   * This list is demo-scale on purpose. A real deployment would build it from
   * the reader's own contact history, which is how mail providers do it - and
   * it is why a lookalike of the reader's school or employer cannot be caught
   * here without configuring it.
   * ------------------------------------------------------------------ */

  const KNOWN_BRANDS = [
    { token: "barclays", domains: ["barclays.co.uk", "barclays.com"] },
    { token: "hsbc", domains: ["hsbc.co.uk", "hsbc.com"] },
    { token: "paypal", domains: ["paypal.com", "paypal.co.uk"] },
    { token: "microsoft", domains: ["microsoft.com", "live.com", "outlook.com"] },
    { token: "apple", domains: ["apple.com", "icloud.com"] },
    { token: "google", domains: ["google.com", "gmail.com"] },
    { token: "amazon", domains: ["amazon.com", "amazon.co.uk", "amazon.de"] },
    { token: "netflix", domains: ["netflix.com"] },
    { token: "github", domains: ["github.com"] },
    { token: "hmrc", domains: ["hmrc.gov.uk", "gov.uk"] },
    { token: "dpd", domains: ["dpd.com", "dpd.co.uk", "dpd.cz"] },
    { token: "dhl", domains: ["dhl.com", "dhl.de"] },
    { token: "fedex", domains: ["fedex.com"] },
    { token: "alza", domains: ["alza.cz", "alza.sk"] },
    { token: "zasilkovna", domains: ["zasilkovna.cz"] },
    { token: "fio", domains: ["fio.cz"] },
    { token: "csob", domains: ["csob.cz"] },
    { token: "komercni", domains: ["kb.cz"] },
    { token: "moneta", domains: ["moneta.cz"] },
    { token: "cez", domains: ["cez.cz"] },
  ];

  const FREEMAIL = new Set([
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
    "yahoo.com", "yahoo.co.uk", "aol.com", "icloud.com", "me.com",
    "proton.me", "protonmail.com", "gmx.com", "gmx.de", "mail.ru",
    "yandex.ru", "seznam.cz", "centrum.cz", "volny.cz", "email.cz",
  ]);

  /* ------------------------------------------------------------------ *
   * Checks
   * ------------------------------------------------------------------ */

  /**
   * MECHANICAL. Fires when a link's visible text names a domain and the link
   * goes to a different one.
   *
   * Only when the text names a domain. "Browse the sale" pointing at
   * alza.cz is not a mismatch - that is what link text is for. The deception
   * is showing one address and using another.
   */
  function checkLinkTextMismatch(links) {
    const hits = [];

    for (const link of links || []) {
      const text = normalise(link.anchor_text || "");
      const href = link.href || "";
      if (!text || !href) continue;

      // Does the visible text itself name a host?
      const named = text.match(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i);
      if (!named) continue;

      const shown = registrableDomain(named[1]);
      const actual = registrableDomain(href);
      if (shown && actual && shown !== actual) {
        hits.push({ shown, actual, text, href });
      }
    }

    return hits;
  }

  /** MECHANICAL. Punycode anywhere in the sender or a link destination. */
  function checkPunycode(msg) {
    const suspects = [msg.from_address, msg.reply_to]
      .concat((msg.links || []).map((l) => l.href))
      .filter(Boolean);

    return suspects.filter(isPunycode).map((s) => hostOf(s));
  }

  /**
   * MECHANICAL. Replies would leave for another domain.
   *
   * Caveat worth knowing: legitimate bulk senders do this routinely, routing
   * replies through a mail provider. It is a strong signal on a message that
   * looks like one-to-one business correspondence and a weak one on a
   * newsletter, and this check cannot tell the two apart.
   */
  function checkReplyTo(msg) {
    if (!msg.reply_to) return null;

    const from = registrableDomain(msg.from_address);
    const reply = registrableDomain(msg.reply_to);
    if (!from || !reply || from === reply) return null;

    return { from, reply };
  }

  /**
   * HEURISTIC. The sending domain imitates a known brand without being it.
   *
   * Two ways in: the brand's name appears as a label in a domain that is not
   * theirs ("barclays-secure-alerts.com"), or the domain is one or two edits
   * from a real one ("paypa1.com", "githab.com").
   */
  function checkLookalikeDomain(msg) {
    const hits = [];
    const seen = new Set();

    const candidates = [msg.from_address, msg.reply_to]
      .concat((msg.links || []).map((l) => l.href))
      .filter(Boolean);

    for (const candidate of candidates) {
      const domain = registrableDomain(candidate);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);

      const labels = new Set(domainLabels(candidate));

      for (const brand of KNOWN_BRANDS) {
        if (brand.domains.includes(domain)) break; // it really is them

        if (labels.has(brand.token)) {
          hits.push({ domain, brand: brand.token, why: "brand name in a domain that is not theirs" });
          break;
        }

        const near = brand.domains.find((d) => {
          const dist = editDistance(domain, d, 2);
          return dist > 0 && dist <= 2 && Math.min(domain.length, d.length) > 6;
        });
        if (near) {
          hits.push({ domain, brand: brand.token, why: `one or two characters from ${near}` });
          break;
        }
      }
    }

    return hits;
  }

  /**
   * HEURISTIC, and the weakest check here - read the note before trusting it.
   *
   * It catches one thing reliably: a display name that claims a brand while
   * the address is somewhere else ("Barclays Security" from a .com that is
   * not theirs, or from a freemail account).
   *
   * It does NOT catch a person's name sent from a freemail address, which is
   * what most impersonation of an individual actually looks like. "Milan
   * Sterba" from m.sterba.exec@gmail.com contains the name, matches fine, and
   * looks exactly like the millions of people who legitimately use Gmail.
   * Separating those needs the reader's contact history - whether this person
   * has ever written from this address before - which the extension does not
   * have. That gap is real and it belongs in the README, not papered over
   * with a rule that fires on half the honest mail anyone gets.
   */
  function checkDisplayNameMismatch(msg) {
    const display = normalise(msg.from_display || "");
    if (!display) return null;

    const domain = registrableDomain(msg.from_address);
    if (!domain) return null;

    const words = display.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

    for (const brand of KNOWN_BRANDS) {
      if (!words.includes(brand.token)) continue;
      if (brand.domains.includes(domain)) return null; // consistent

      return {
        claimed: brand.token,
        actual: domain,
        why: FREEMAIL.has(domain)
          ? "a brand name sent from a personal mail account"
          : "a brand name sent from a domain that is not theirs",
      };
    }

    // A display name written as an address, pointing elsewhere.
    const asAddress = display.match(/[\w.+-]+@([\w.-]+\.[a-z]{2,})/i);
    if (asAddress && registrableDomain(asAddress[1]) !== domain) {
      return {
        claimed: registrableDomain(asAddress[1]),
        actual: domain,
        why: "the display name is an address that does not match the sender",
      };
    }

    return null;
  }

  /* ------------------------------------------------------------------ *
   * Entry point
   * ------------------------------------------------------------------ */

  /**
   * Run every check over a normalised message.
   *
   * Returns { signals, details } - signals are the ids the backend and
   * scoring.py consume; details are for the card, so the reader can be told
   * which link went where rather than just that something was wrong.
   */
  function findSignals(msg) {
    const details = {};
    const signals = [];

    const linkHits = checkLinkTextMismatch(msg.links);
    if (linkHits.length) {
      signals.push("link_text_mismatch");
      details.link_text_mismatch = linkHits;
    }

    const puny = checkPunycode(msg);
    if (puny.length) {
      signals.push("punycode_domain");
      details.punycode_domain = puny;
    }

    const replyTo = checkReplyTo(msg);
    if (replyTo) {
      signals.push("reply_to_mismatch");
      details.reply_to_mismatch = replyTo;
    }

    const lookalike = checkLookalikeDomain(msg);
    if (lookalike.length) {
      signals.push("lookalike_domain");
      details.lookalike_domain = lookalike;
    }

    const displayName = checkDisplayNameMismatch(msg);
    if (displayName) {
      signals.push("display_name_mismatch");
      details.display_name_mismatch = displayName;
    }

    return { signals, details };
  }

  const api = {
    findSignals,
    normalise,
    hostOf,
    registrableDomain,
    domainLabels,
    isPunycode,
    editDistance,
    KNOWN_BRANDS,
    FREEMAIL,
  };

  root.TellsSignals = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
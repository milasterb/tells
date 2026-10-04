/**
 * Tells - Gmail adapter.
 *
 * The only file in the project that knows Gmail exists. It turns an open
 * message into the same plain object the popup builds from pasted text:
 *
 *   { from_display, from_address, reply_to, subject, body, links[] }
 *
 * Everything downstream - signals, backend, card - is unchanged. Supporting
 * Outlook later means writing a second file like this one and nothing else.
 *
 * Gmail's markup is generated and its class names are short and opaque, but a
 * few hooks have been stable for years: `div.adn` wraps a message, `div.a3s`
 * holds its body, and the sender span carries `email` and `name` attributes.
 * Each is tried with fallbacks, and when none of them match the adapter says
 * so and points at the popup rather than guessing. A wrong extraction is
 * worse than none: it would analyse the wrong text and state a verdict about
 * it with full confidence.
 */

(function () {
  "use strict";

  const SELECTORS = {
    // A single message inside an open thread.
    message: ["div.adn.ads", "div.adn", "div[data-legacy-message-id]"],
    // Its body.
    body: ["div.a3s.aiL", "div.a3s", "div.ii.gt div"],
    // The sender chip: <span class="gD" email="..." name="...">
    sender: ["span.gD[email]", "span[email][name]", "span[email]"],
    // Thread subject, shared by every message in the thread.
    subject: ["h2.hP", "h2[data-thread-perm-id]", "div.ha h2"],
    // Quoted history and signatures - present, but not this message.
    exclude: [".gmail_quote", ".gmail_signature", "blockquote", ".adL"],
  };

  const INJECTED = "data-tells-injected";
  const DEBOUNCE_MS = 400;

  function pick(root, candidates) {
    for (const selector of candidates) {
      const found = root.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Links
   *
   * Gmail routes outbound links through its own redirector. The visible
   * text is what the reader sees; the destination we care about is the
   * real target, not google.com/url. Getting this wrong would make every
   * link in every message look like a mismatch.
   * ------------------------------------------------------------------ */

  function realHref(anchor) {
    const raw = anchor.getAttribute("href") || "";
    const safe = anchor.getAttribute("data-saferedirecturl") || "";

    for (const candidate of [raw, safe]) {
      if (!candidate) continue;
      if (!/^https?:\/\/(www\.)?google\.[a-z.]+\/url\?/i.test(candidate)) {
        return candidate;
      }
      try {
        const params = new URL(candidate).searchParams;
        const unwrapped = params.get("q") || params.get("url");
        if (unwrapped) return unwrapped;
      } catch {
        /* malformed - fall through to the other candidate */
      }
    }
    return raw;
  }

  function extractLinks(bodyEl) {
    const links = [];
    const seen = new Set();

    for (const anchor of bodyEl.querySelectorAll("a[href]")) {
      const href = realHref(anchor);
      if (!href || href.startsWith("mailto:") || href.startsWith("#")) continue;

      const text = (anchor.textContent || "").trim().replace(/\s+/g, " ");
      const key = `${text}\u0000${href}`;
      if (seen.has(key)) continue;
      seen.add(key);

      links.push({ anchor_text: text, href });
    }
    return links;
  }

  /* ------------------------------------------------------------------ *
   * Extraction
   * ------------------------------------------------------------------ */

  /** Body text with quoted history and signatures removed. */
  function bodyText(bodyEl) {
    const copy = bodyEl.cloneNode(true);
    for (const selector of SELECTORS.exclude) {
      for (const node of copy.querySelectorAll(selector)) node.remove();
    }
    return (copy.innerText || copy.textContent || "")
      .replace(/ /g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Build the message object for one open message.
   * Returns null when the markup does not match - the caller then tells the
   * reader to use the popup instead of analysing something made up.
   */
  function extractMessage(messageEl) {
    const bodyEl = pick(messageEl, SELECTORS.body);
    if (!bodyEl) return null;

    const senderEl = pick(messageEl, SELECTORS.sender);
    const subjectEl = pick(document, SELECTORS.subject);

    const body = bodyText(bodyEl);
    if (!body) return null;

    return {
      msg: {
        from_display: senderEl ? senderEl.getAttribute("name") || (senderEl.textContent || "").trim() : "",
        from_address: senderEl ? senderEl.getAttribute("email") || "" : "",
        reply_to: "",  // not exposed in the DOM; the backend treats it as absent
        subject: subjectEl ? (subjectEl.textContent || "").trim() : "",
        body,
        links: extractLinks(bodyEl),
      },
      id:
        messageEl.getAttribute("data-legacy-message-id") ||
        messageEl.getAttribute("data-message-id") ||
        null,
    };
  }

  /* ------------------------------------------------------------------ *
   * Backend, via the service worker
   *
   * The worker holds the extension's own origin, so host_permissions
   * cover the call. A fetch straight from here would be judged against
   * mail.google.com's policy instead.
   * ------------------------------------------------------------------ */

  function analyse(msg, signals, id) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "analyse",
          msg,
          signals,
          id,
          // The reader's language, not the message's. The quotes stay in the
          // original; everything written about them comes back in this.
          reader_language: navigator.language,
          source: "gmail",
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!response || !response.ok) {
            reject(new Error((response && response.error) || "No response from Tells."));
          } else {
            resolve(response.result);
          }
        }
      );
    });
  }

  function getMode() {
    return new Promise((resolve) => {
      chrome.storage.local.get("mode", (stored) => {
        resolve((stored && stored.mode) || "manual");
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Injection
   * ------------------------------------------------------------------ */

  function mountPoint(messageEl) {
    const bodyEl = pick(messageEl, SELECTORS.body);
    if (!bodyEl) return null;

    let host = messageEl.querySelector(".tells-host");
    if (!host) {
      host = document.createElement("div");
      host.className = "tells-host";
      bodyEl.parentNode.insertBefore(host, bodyEl);
    }
    return host;
  }

  /** The compact bar: what the reader sees before anything has been checked. */
  function renderBar(text, buttonLabel, onClick) {
    const bar = document.createElement("div");
    bar.className = "tells-bar";

    const mascot = TellsCard.mascotFor("working");
    mascot.classList.add("tells-bar-mascot");

    const label = document.createElement("span");
    label.className = "tells-bar-text";
    label.textContent = text;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "tells-bar-button";
    button.textContent = buttonLabel;
    button.addEventListener("click", onClick);

    bar.append(mascot, label, button);
    return bar;
  }

  async function run(messageEl, host, extracted, signals) {
    host.replaceChildren(TellsCard.renderWorking("Reading this message…"));

    try {
      const result = await analyse(extracted.msg, signals, extracted.id);
      host.replaceChildren(TellsCard.renderCard(result, { animate: true }));
    } catch (error) {
      host.replaceChildren(
        TellsCard.renderFailed(
          `Tells can't reach its backend. ${error.message}`,
          () => run(messageEl, host, extracted, signals)
        )
      );
    }
  }

  async function handleMessage(messageEl) {
    if (messageEl.getAttribute(INJECTED) === "1") return;
    messageEl.setAttribute(INJECTED, "1");

    const host = mountPoint(messageEl);
    if (!host) return;

    const extracted = extractMessage(messageEl);

    // Gmail changed, or this is not a message after all. Say so plainly and
    // point somewhere that still works.
    if (!extracted) {
      host.replaceChildren(
        renderBar(
          "Tells couldn't read this message.",
          "Open Tells",
          () => chrome.runtime.sendMessage({ type: "open-popup" })
        )
      );
      return;
    }

    const { signals } = TellsSignals.findSignals(extracted.msg);
    const mode = await getMode();

    // Automatic mode spends nothing until a local check fires. Everything in
    // signals.js runs in this page - no message leaves the browser unless
    // something about it is already wrong, or the reader asks.
    if (mode === "automatic" && signals.length) {
      run(messageEl, host, extracted, signals);
      return;
    }

    const text = mode === "automatic" && !signals.length
      ? "No obvious signs in this message."
      : "";

    host.replaceChildren(
      renderBar(text, "Check this message", () => run(messageEl, host, extracted, signals))
    );
  }

  /* ------------------------------------------------------------------ *
   * Watching
   *
   * Gmail never reloads the page, so opening a message is a DOM change
   * like any other. The observer is debounced because Gmail mutates
   * constantly, and re-entry is guarded by the INJECTED attribute.
   * ------------------------------------------------------------------ */

  function scan() {
    for (const selector of SELECTORS.message) {
      const found = document.querySelectorAll(selector);
      if (found.length) {
        for (const el of found) handleMessage(el);
        return;
      }
    }
  }

  function start() {
    let timer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(scan, DEBOUNCE_MS);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
/**
 * Tells - popup.
 *
 * The paste path: text in, card out. Same backend, same card and same
 * deterministic checks as the Gmail flow - this is the Gmail flow with the
 * adapter replaced by a textarea, which is why it was built first. If the
 * Gmail DOM ever changes under us, this still works.
 *
 * It is also the answer to "does it only do Gmail": a message from WhatsApp,
 * a text or Messenger can be pasted here, and nothing downstream knows the
 * difference.
 */

(function () {
  "use strict";

  const API = "http://127.0.0.1:8000";

  const form = document.getElementById("paste-form");
  const input = document.getElementById("paste");
  const checkButton = document.getElementById("check");
  const clearButton = document.getElementById("clear");
  const result = document.getElementById("result");
  const status = document.getElementById("status");

  /* ------------------------------------------------------------------ *
   * Parsing pasted text
   *
   * People paste whatever they have. Sometimes that includes headers
   * copied out of a mail client, usually it is just the words. Any header
   * found is used; everything else is the body.
   *
   * One thing is lost here and it is worth being honest about: plain text
   * has no links, only URLs. The anchor-text-versus-destination check -
   * the strongest signal there is - cannot run on a paste, because the
   * visible text and the real destination are the same string once the
   * formatting is gone. That check needs the Gmail path.
   * ------------------------------------------------------------------ */

  /**
   * Header labels, in the languages a reader is likely to be pasting from.
   *
   * Without these the whole block falls into the body: the model still reads
   * it and usually works it out, but from_address never gets set, so none of
   * the deterministic checks can run. The strongest part of the tool goes
   * quiet because of a word in the wrong language, which is a poor way for a
   * multilingual tool to behave.
   *
   * Both the ASCII colon and the full-width one are accepted, since the
   * latter is what a Chinese or Japanese client writes.
   */
  const HEADER_PATTERNS = [
    // sender
    [/^(?:from|sender|von|absender|de|da|van|od|fr[aå]n|l[äa]hett[äa]j[äa]|发件人|寄件者|差出人|보낸사람)\s*[:：]\s*(.+)$/i, "from"],
    // reply-to
    [/^(?:reply[\s-]?to|antwort[\s-]?an|responder[\s-]?a|r[ée]pondre[\s-]?[àa]|rispondi[\s-]?a|odpowiedz[\s-]?do|odpov[ěe][ďd][\s-]?komu|回复)\s*[:：]\s*(.+)$/i, "reply_to"],
    // subject
    [/^(?:subject|betreff|asunto|objet|oggetto|assunto|onderwerp|temat|p[řr]edm[ěe]t|[äa]rende|aihe|主题|主旨|件名|제목)\s*[:：]\s*(.+)$/i, "subject"],
  ];

  const URL_PATTERN = /\b((?:https?:\/\/|www\.)[^\s<>()[\]{}"']+)/gi;

  /** "Barclays Security <no-reply@x.com>" -> display and address. */
  function splitSender(value) {
    const angled = value.match(/^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/);
    if (angled) {
      return {
        display: angled[1].replace(/^["']|["']$/g, "").trim(),
        address: angled[2].trim(),
      };
    }
    if (value.includes("@") && !/\s/.test(value.trim())) {
      return { display: "", address: value.trim() };
    }
    return { display: value.trim(), address: "" };
  }

  function parsePaste(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const msg = {
      from_display: "",
      from_address: "",
      reply_to: "",
      subject: "",
      body: "",
      links: [],
    };

    // Headers only count at the top of the paste, before any real prose.
    let cursor = 0;
    while (cursor < lines.length) {
      const line = lines[cursor].trim();
      if (!line) {
        cursor++;
        continue;
      }

      const hit = HEADER_PATTERNS.map(([re, field]) => [line.match(re), field])
        .find(([match]) => match);

      if (!hit) break;

      const [match, field] = hit;
      const value = match[1].trim();

      if (field === "from") {
        const { display, address } = splitSender(value);
        msg.from_display = display;
        msg.from_address = address;
      } else {
        msg[field] = value;
      }
      cursor++;
    }

    msg.body = lines.slice(cursor).join("\n").trim();

    // Nothing looked like a header: the whole paste is the message.
    if (!msg.body) {
      msg.body = text.trim();
    }

    const seen = new Set();
    for (const match of `${msg.subject}\n${msg.body}`.matchAll(URL_PATTERN)) {
      const url = match[1].replace(/[.,;:)\]]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      msg.links.push({
        anchor_text: url,
        href: url.startsWith("www.") ? `https://${url}` : url,
      });
    }

    return msg;
  }

  /* ------------------------------------------------------------------ *
   * Backend
   * ------------------------------------------------------------------ */

  async function checkHealth() {
    try {
      const response = await fetch(`${API}/health`, { method: "GET" });
      const data = await response.json();

      if (!data.key_configured) {
        status.textContent = "Backend is running, but no API key is set in backend/.env";
        status.dataset.ok = "false";
        return false;
      }

      status.textContent = `Backend ready · ${data.model}`;
      status.dataset.ok = "true";
      return true;
    } catch {
      status.textContent = "Backend not running. Start it with: uvicorn main:app --port 8000";
      status.dataset.ok = "false";
      return false;
    }
  }

  async function analyse(msg, signals) {
    const response = await fetch(`${API}/analyse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...msg,
        signals,
        // The browser's language, so the explanation comes back in the
        // reader's words even when the message is in someone else's.
        reader_language: navigator.language,
        source: "paste",
      }),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || `Backend returned ${response.status}`);
    }
    return response.json();
  }

  /* ------------------------------------------------------------------ *
   * Flow
   * ------------------------------------------------------------------ */

  function show(element) {
    result.replaceChildren(element);
  }

  async function run() {
    const text = input.value.trim();
    if (!text) return;

    const msg = parsePaste(text);
    const { signals } = TellsSignals.findSignals(msg);

    checkButton.disabled = true;
    show(TellsCard.renderWorking("Reading the message…"));

    try {
      const analysis = await analyse(msg, signals);
      show(TellsCard.renderCard(analysis, { animate: true }));
    } catch (error) {
      const reachable = await checkHealth();
      show(
        TellsCard.renderFailed(
          reachable
            ? `Tells could not finish: ${error.message}`
            : "Tells can't reach its backend. Start it and try again.",
          run
        )
      );
    } finally {
      checkButton.disabled = false;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run();
  });

  clearButton.addEventListener("click", () => {
    input.value = "";
    result.replaceChildren();
    chrome.storage?.local.remove("draft");
    input.focus();
  });

  // Ctrl/Cmd+Enter from inside the textarea, so a long paste can be checked
  // without reaching for the mouse.
  input.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      run();
    }
  });

  // A popup closes the moment you click outside it. Losing a pasted message
  // to that is infuriating, so the draft is kept.
  input.addEventListener("input", () => {
    chrome.storage?.local.set({ draft: input.value });
  });

  chrome.storage?.local.get("draft", (stored) => {
    if (stored && stored.draft) input.value = stored.draft;
  });

  /* ------------------------------------------------------------------ *
   * Gmail mode
   *
   * Manual is the default and stays the default. Watching someone's mail
   * is not something a tool should start doing because it was installed -
   * the reader turns it on, having read what it means.
   * ------------------------------------------------------------------ */

  const modeInputs = document.querySelectorAll('input[name="mode"]');

  chrome.storage?.local.get("mode", (stored) => {
    const mode = (stored && stored.mode) || "manual";
    for (const radio of modeInputs) radio.checked = radio.value === mode;
  });

  for (const radio of modeInputs) {
    radio.addEventListener("change", () => {
      if (radio.checked) chrome.storage?.local.set({ mode: radio.value });
    });
  }

  checkHealth();
  input.focus();
})();
/**
 * Tells - service worker.
 *
 * Sits between the Gmail content script and the backend for one reason: this
 * context has the extension's own origin, so host_permissions cover the call.
 * A fetch from the content script would be judged against mail.google.com's
 * policy instead.
 *
 * It also holds the result cache. Gmail re-renders a message every time the
 * reader scrolls back to it, and paying for the same analysis twice is money
 * for nothing. The cache lives in memory: Chrome stops an idle worker and the
 * cache goes with it, which is fine - the cost of a miss is one more call,
 * and nothing about a message is worth writing to disk.
 */

const API = "http://127.0.0.1:8000";
const CACHE_LIMIT = 50;
const TIMEOUT_MS = 30000;

/** messageId -> analysis. Insertion-ordered, so the oldest key is the first. */
const cache = new Map();

function remember(id, result) {
  if (!id) return;
  cache.set(id, result);
  while (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
}

async function callBackend(payload) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${API}/analyse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || `Backend returned ${response.status}.`);
    }
    return response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("The backend took too long to answer.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "analyse") {
    if (request.id && cache.has(request.id)) {
      sendResponse({ ok: true, result: cache.get(request.id), cached: true });
      return false;
    }

    callBackend({
      ...request.msg,
      signals: request.signals || [],
      reader_language: request.reader_language || null,
      source: request.source || "gmail",
    })
      .then((result) => {
        remember(request.id, result);
        sendResponse({ ok: true, result });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });

    return true; // the channel stays open for the async reply
  }

  if (request.type === "open-popup") {
    chrome.action.openPopup?.();
    return false;
  }

  if (request.type === "clear-cache") {
    cache.clear();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// Manual is the default on a fresh install. The first thing a security tool
// does should not be to start reading mail on its own.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("mode", (stored) => {
    if (!stored || !stored.mode) {
      chrome.storage.local.set({ mode: "manual" });
    }
  });
});
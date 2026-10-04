"""
Tells - API.

One endpoint. The extension sends a normalised message plus whatever its own
deterministic checks found; the backend analyses it, applies the verdict floor
and sends back something the card can render.

Run it:
    uvicorn main:app --reload --port 8000

The API key lives here and only here. The extension never sees it - a Chrome
extension is a zipped folder anyone can open, so a key shipped inside one is
a published key.
"""

import logging
import os
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from analyze import MODEL, MalformedAnalysis, analyze
from scoring import apply_floor, explain_floor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("tells")

app = FastAPI(title="Tells", version="0.1.0")

# The content script runs on mail.google.com, so every call is cross-origin.
# Local development only - a deployed instance would name its own origins and
# require a shared secret, since this endpoint spends money on every request.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://mail.google.com",
        "chrome-extension://*",
    ],
    allow_origin_regex=r"chrome-extension://.*",
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

MAX_BODY_CHARS = 20_000


class Link(BaseModel):
    anchor_text: str = ""
    href: str = ""


class AnalyseRequest(BaseModel):
    """
    Whatever the adapter extracted. Platform-agnostic on purpose: a Gmail
    message, a pasted WhatsApp text and an SMS all arrive in this shape, and
    only `links` and the header fields differ between them.
    """

    from_display: str | None = None
    from_address: str | None = None
    reply_to: str | None = None
    subject: str | None = None
    body: str = ""
    links: list[Link] = Field(default_factory=list)

    # Found in the page by signals.js. Trusted as fact by the prompt, so the
    # model is told about checks it cannot run itself.
    signals: list[str] = Field(default_factory=list)

    # Where this came from, for logging only. Never changes the analysis.
    source: str = "unknown"


@app.get("/health")
def health() -> dict:
    """Is the backend up, and is a key configured. The popup checks this."""
    return {
        "ok": True,
        "model": MODEL,
        "key_configured": bool(os.environ.get("ANTHROPIC_API_KEY")),
    }


@app.post("/analyse")
def analyse(req: AnalyseRequest) -> dict:
    started = time.monotonic()

    if not req.body.strip() and not (req.subject or "").strip():
        raise HTTPException(status_code=400, detail="Nothing to analyse.")

    msg = req.model_dump(exclude={"signals", "source"})
    msg["links"] = [link.model_dump() for link in req.links]

    # A long forwarded thread would cost a fortune and analyse mostly quoted
    # history. The top of a message is where the ask lives.
    if len(msg["body"]) > MAX_BODY_CHARS:
        msg["body"] = msg["body"][:MAX_BODY_CHARS]
        truncated = True
    else:
        truncated = False

    try:
        # strict=False: a degraded answer reaches the reader; a crash does not.
        analysis = analyze(msg, signals=req.signals, strict=False)
    except MalformedAnalysis as exc:
        log.error("analysis failed (%s): %s", req.source, exc)
        raise HTTPException(status_code=502, detail="Could not analyse this message.")
    except Exception as exc:  # network, auth, rate limit
        log.exception("upstream error (%s)", req.source)
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}") from exc

    result = apply_floor(analysis, req.signals)
    elapsed = time.monotonic() - started

    note = explain_floor(result)
    log.info(
        "%s  %s  %.1fs  tactics=%d  attempts=%s%s",
        req.source,
        result["verdict"],
        elapsed,
        len(result.get("tactics", [])),
        result.get("_attempts", 1),
        f"  | floor {note}" if note else "",
    )
    if result.get("_problems"):
        log.warning("degraded output: %s", result["_problems"])

    return {
        "verdict": result["verdict"],
        "confidence": result.get("confidence"),
        "headline": result.get("headline"),
        "benign_reading": result.get("benign_reading"),
        "explain_simple": result.get("explain_simple"),
        "tactics": result.get("tactics", []),
        "recommended_action": result.get("recommended_action"),
        "language": result.get("language"),
        "signals": req.signals,
        "meta": {
            # Both verdicts, so the card can say when the rules overrode the
            # model - and so a disagreement is visible rather than silent.
            "model_verdict": result.get("model_verdict"),
            "floor": result.get("floor"),
            "attempts": result.get("_attempts", 1),
            "degraded": bool(result.get("_problems")),
            "truncated": truncated,
            "elapsed_ms": round(elapsed * 1000),
        },
    }
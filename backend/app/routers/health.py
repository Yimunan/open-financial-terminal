"""Health / readiness — reports qhfi import status and vLLM proxy reachability."""

from __future__ import annotations

import httpx
from fastapi import APIRouter

from app.config import (
    MARKET_DATA_CATEGORIES,
    get_alpaca_creds,
    get_crypto_exchange,
    get_crypto_realtime_enabled,
    get_depth_enabled,
    get_depth_source,
    get_depth_topic_token,
    get_engine_settings,
    get_options_caps,
    get_options_default_underlying,
    get_options_enabled,
    get_options_expiry_window,
    get_options_source,
    get_equity_feed,
    get_realtime_source,
    get_terminal_settings,
    normalize_llm_base_url,
)
from app.deps import get_llm_model
from app.services.bootstrap import status as bootstrap_status
from app.services.universe import list_universes

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health() -> dict:
    eng = get_engine_settings()
    term = get_terminal_settings()

    # qhfi is import-checked simply by reaching here (these imports resolve at module load).
    qhfi_ok = True

    # vLLM proxy: probe the OpenAI-compatible /models endpoint with a short timeout.
    llm_ok, llm_detail = False, "unreachable"
    base = normalize_llm_base_url(eng.llm_base_url)
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{base}/models")
            llm_ok = r.status_code == 200
            llm_detail = "ok" if llm_ok else f"http {r.status_code}"
    except Exception as e:  # noqa: BLE001 - probe failures are expected when the stack is down
        llm_detail = type(e).__name__

    return {
        "status": "ok",
        "qhfi": {"ok": qhfi_ok, "llm_model": get_llm_model()},
        "llm": {"ok": llm_ok, "detail": llm_detail, "base_url": eng.llm_base_url},
        "data_dir": str(term.data_dir),
        "crypto_exchange": get_crypto_exchange(),
        # Equity realtime needs the source set to Alpaca AND credentials present; the per-category
        # "Realtime: Off" toggle (realtime_source=none) disables it without removing the keys.
        "equity_stream": {
            "enabled": get_realtime_source("equity") == "alpaca" and bool(get_alpaca_creds()[0]),
            "feed": get_equity_feed(),
        },
        # Crypto realtime: on/off per the category toggle (bars/charts keep working when off).
        "crypto_stream": {"enabled": get_crypto_realtime_enabled()},
        # Per-class order-book depth: the chosen source, the hub topic token to subscribe on (empty
        # when off), and whether depth is available now. Lets the OrderBook widget switch live/empty
        # per asset class without loading Settings.
        "depth": {
            a: {"source": get_depth_source(a), "token": get_depth_topic_token(a),
                "enabled": get_depth_enabled(a)}
            for a in MARKET_DATA_CATEGORIES
        },
        # Options-chain status: active source, capabilities, seed underlying/window (drives the
        # Options Chain widget's live/unavailable state + greeks-column visibility).
        "options": {
            "source": get_options_source(),
            "enabled": get_options_enabled(),
            "capabilities": get_options_caps(),
            "default_underlying": get_options_default_underlying(),
            "expiry_window": get_options_expiry_window(),
        },
        "universes": list_universes(),
        # First-run data bootstrap progress (idle/running/done/skipped/error).
        "bootstrap": bootstrap_status(),
    }

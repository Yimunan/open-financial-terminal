"""Tests for the Market Data settings: config round-trip + clamping, cache invalidation, and the
`/api/settings/market-data` endpoints driven through the real FastAPI app.

The existing `market_data.json` override (if any) is saved and restored, so the test leaves the
real config untouched. Network-touching paths (the exchange-probe `test` endpoint against a real
exchange) are avoided — only the offline rejection branch is asserted.

Run: `cd backend && pytest tests/test_market_data_settings.py -v`
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import config
from app import deps
from app.main import app


@pytest.fixture()
def clean_override():
    """Isolate the market_data.json override: blank it for the test, restore the original after."""
    path = config._market_data_path()
    backup = path.read_bytes() if path.exists() else None
    path.unlink(missing_ok=True)
    try:
        yield path
    finally:
        if backup is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(backup)


# ── config round-trip + clamping ─────────────────────────────────────────────────
def test_defaults_when_no_override(clean_override):
    cfg = config.get_market_data_config()
    # falls back to the env-derived TerminalSettings exchange (kraken by default)
    assert cfg["exchange"] in config.SUPPORTED_EXCHANGES
    assert cfg["intraday_ttl"] == config.DEFAULT_INTRADAY_TTL
    assert cfg["history_years"] == config.DEFAULT_HISTORY_YEARS


def test_round_trip_and_clamping(clean_override):
    config.set_market_data_config(
        exchange="coinbase", intraday_ttl=9999, history_years=999,
        alpaca_api_key="k1", alpaca_api_secret="s1", alpaca_paper=False,
    )
    cfg = config.get_market_data_config()
    assert cfg["exchange"] == "coinbase"
    assert cfg["intraday_ttl"] == 600.0          # clamped to the [5, 600] ceiling
    assert cfg["history_years"] == 30            # clamped to the [1, 30] ceiling
    assert cfg["alpaca_api_key"] == "k1" and cfg["alpaca_api_secret"] == "s1"
    assert cfg["alpaca_paper"] is False
    # accessors read the override
    assert config.get_crypto_exchange() == "coinbase"
    assert config.get_alpaca_creds() == ("k1", "s1", False)


def test_unknown_exchange_falls_back(clean_override):
    config.set_market_data_config("kraken", 60, 3)
    config.set_market_data_config("not-an-exchange", 60, 3)  # invalid → keeps the current value
    assert config.get_market_data_config()["exchange"] == "kraken"


def test_equity_feed_round_trip_and_fallback(clean_override):
    config.set_market_data_config("kraken", 60, 3, equity_feed="sip")
    assert config.get_market_data_config()["equity_feed"] == "sip"
    assert config.get_equity_feed() == "sip"
    # invalid feed → default iex
    config.set_market_data_config("kraken", 60, 3, equity_feed="bogus")
    assert config.get_equity_feed() == "iex"


def test_blank_alpaca_keeps_saved_secret(clean_override):
    config.set_market_data_config("kraken", 60, 3, alpaca_api_key="key", alpaca_api_secret="sec")
    # re-save with blank creds → previously saved key/secret are preserved (UI shows them masked)
    config.set_market_data_config("binance", 120, 5)
    cfg = config.get_market_data_config()
    assert cfg["alpaca_api_key"] == "key" and cfg["alpaca_api_secret"] == "sec"


def test_credentials_encrypted_at_rest(clean_override):
    config.set_market_data_config(
        "kraken", 60, 3, alpaca_api_key="PKSECRETKEY123", alpaca_api_secret="topsecretvalue",
    )
    raw = clean_override.read_text("utf-8")
    # the plaintext key/secret never appear on disk; the stored values are enc:-prefixed tokens
    assert "PKSECRETKEY123" not in raw and "topsecretvalue" not in raw
    assert '"alpaca_api_key": "enc:' in raw and '"alpaca_api_secret": "enc:' in raw
    # …but they decrypt transparently for the broker
    assert config.get_alpaca_creds()[:2] == ("PKSECRETKEY123", "topsecretvalue")


# ── per-asset-class categories ─────────────────────────────────────────────────────
def test_category_defaults_shape(clean_override):
    cats = config.get_market_data_config()["categories"]
    assert set(cats) == set(config.MARKET_DATA_CATEGORIES)
    assert cats["equity"]["bars_source"] == "yfinance"
    assert cats["equity"]["realtime_source"] == "alpaca"
    assert cats["crypto"]["source"] in config.SUPPORTED_EXCHANGES
    assert cats["equity"]["default_symbol"] and cats["crypto"]["default_symbol"]


def test_categories_persist_and_resolve_per_class(clean_override):
    config.set_market_data_config(categories={
        "equity": {"realtime_source": "none", "realtime_feed": "sip",
                   "intraday_ttl": 30, "history_years": 5, "default_symbol": "msft"},
        "crypto": {"source": "coinbase", "intraday_ttl": 90, "history_years": 1,
                   "default_symbol": "eth/usdt"},
    })
    # per-asset accessors read the right category
    assert config.get_intraday_ttl("equity") == 30.0
    assert config.get_intraday_ttl("crypto") == 90.0
    assert config.get_history_years("equity") == 5
    assert config.get_history_years("crypto") == 1
    assert config.get_crypto_exchange() == "coinbase"
    assert config.get_equity_feed() == "sip"
    assert config.get_realtime_source("equity") == "none"
    assert config.get_default_symbol("equity") == "MSFT"
    assert config.get_default_symbol("crypto") == "ETH/USDT"  # slash preserved


def test_categories_clamp_and_reject_bad_values(clean_override):
    config.set_market_data_config(categories={
        "equity": {"realtime_source": "bogus", "intraday_ttl": 99999, "history_years": 999},
        "crypto": {"source": "not-an-exchange", "default_symbol": ""},
    })
    cats = config.get_market_data_config()["categories"]
    assert cats["equity"]["realtime_source"] == "alpaca"      # bad source → default kept
    assert cats["equity"]["intraday_ttl"] == 600.0            # clamped
    assert cats["equity"]["history_years"] == 30              # clamped
    assert cats["crypto"]["source"] in config.SUPPORTED_EXCHANGES  # bad exchange → default kept
    assert cats["crypto"]["default_symbol"]                   # blank → kept default


def test_legacy_flat_json_migrates_to_categories(clean_override, monkeypatch):
    # a pre-categories market_data.json (flat keys only) must migrate on read
    import json
    clean_override.write_text(json.dumps({
        "exchange": "binance", "equity_feed": "sip", "intraday_ttl": 45, "history_years": 7,
    }), "utf-8")
    cats = config.get_market_data_config()["categories"]
    assert cats["crypto"]["source"] == "binance"
    assert cats["equity"]["realtime_feed"] == "sip"
    assert cats["equity"]["intraday_ttl"] == cats["crypto"]["intraday_ttl"] == 45.0
    assert cats["equity"]["history_years"] == cats["crypto"]["history_years"] == 7


def test_get_returns_categories_and_meta(clean_override):
    client = TestClient(app)
    body = client.get("/api/settings/market-data").json()
    assert set(body["categories"]) == set(config.MARKET_DATA_CATEGORIES)
    meta = body["category_meta"]
    assert meta["equity"]["bars_sources"] == list(config.EQUITY_BARS_SOURCES)
    assert set(meta["crypto"]["sources"]) == set(config.SUPPORTED_EXCHANGES)


def test_put_categories_round_trip(clean_override):
    client = TestClient(app)
    r = client.put("/api/settings/market-data", json={"categories": {
        "crypto": {"source": "okx", "history_years": 2},
        "equity": {"history_years": 8},
    }})
    assert r.status_code == 200
    body = r.json()
    assert body["categories"]["crypto"]["source"] == "okx"
    assert body["categories"]["crypto"]["history_years"] == 2
    assert body["categories"]["equity"]["history_years"] == 8
    assert client.get("/api/health").json()["crypto_exchange"] == "okx"


# ── cache invalidation ────────────────────────────────────────────────────────────
def test_reload_clears_data_manager_cache(clean_override):
    deps.get_data_manager.cache_clear()
    deps.get_data_manager()  # prime
    assert deps.get_data_manager.cache_info().currsize == 1
    deps.reload_market_data()
    assert deps.get_data_manager.cache_info().currsize == 0


# ── endpoints ──────────────────────────────────────────────────────────────────────
def test_get_returns_state_with_supported(clean_override):
    client = TestClient(app)
    r = client.get("/api/settings/market-data")
    assert r.status_code == 200
    body = r.json()
    assert set(config.SUPPORTED_EXCHANGES) == set(body["supported"])
    assert "has_alpaca_key" in body and "cached_symbols" in body and "realtime" in body
    # equity-stream capability is exposed; secret is never leaked
    assert set(config.SUPPORTED_EQUITY_FEEDS) == set(body["supported_equity_feeds"])
    assert body["equity_stream"] == {"enabled": False, "feed": "iex"}
    assert "alpaca_api_secret" not in body


def test_equity_stream_enabled_flips_with_key(clean_override):
    client = TestClient(app)
    client.put(
        "/api/settings/market-data",
        json={"exchange": "kraken", "intraday_ttl": 60, "history_years": 3,
              "equity_feed": "sip", "alpaca_api_key": "k", "alpaca_api_secret": "s",
              "alpaca_paper": True},
    )
    body = client.get("/api/settings/market-data").json()
    assert body["equity_stream"] == {"enabled": True, "feed": "sip"}
    assert client.get("/api/health").json()["equity_stream"]["enabled"] is True


def test_put_persists_and_health_reflects(clean_override):
    client = TestClient(app)
    r = client.put(
        "/api/settings/market-data",
        json={"exchange": "coinbase", "intraday_ttl": 120, "history_years": 5, "alpaca_paper": True},
    )
    assert r.status_code == 200 and r.json()["exchange"] == "coinbase"
    assert client.get("/api/health").json()["crypto_exchange"] == "coinbase"


def test_clear_alpaca_creds_removes_key(clean_override):
    config.set_market_data_config(
        categories={"crypto": {"source": "okx"}},
        alpaca_api_key="PKKEY", alpaca_api_secret="SEC",
    )
    assert bool(config.get_market_data_config()["alpaca_api_key"]) is True
    out = config.clear_alpaca_creds()
    assert bool(out["alpaca_api_key"]) is False
    assert config.get_alpaca_creds()[:2] == ("", "")
    # category config is preserved across the credential wipe
    assert out["categories"]["crypto"]["source"] == "okx"


def test_delete_alpaca_endpoint(clean_override):
    client = TestClient(app)
    client.put("/api/settings/market-data", json={"alpaca_api_key": "k", "alpaca_api_secret": "s"})
    assert client.get("/api/settings/market-data").json()["has_alpaca_key"] is True
    r = client.delete("/api/settings/market-data/alpaca")
    assert r.status_code == 200
    body = r.json()
    assert body["has_alpaca_key"] is False and body["broker"] == "sim"
    # persists across a re-GET (reopening settings)
    assert client.get("/api/settings/market-data").json()["has_alpaca_key"] is False


def test_equity_probe_requires_creds(clean_override):
    client = TestClient(app)
    r = client.post("/api/settings/market-data/test-equity", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False and "no Alpaca" in body["detail"]


def test_equity_probe_ok_with_key(clean_override, monkeypatch):
    # stub the Alpaca data client so the probe validates without touching the network
    class _Trade:
        price = 199.5

    class _Client:
        def __init__(self, *a, **k):
            pass

        def get_stock_latest_trade(self, req):
            return {"AAPL": _Trade()}

    import alpaca.data.historical as hist
    monkeypatch.setattr(hist, "StockHistoricalDataClient", _Client)
    client = TestClient(app)
    r = client.post(
        "/api/settings/market-data/test-equity",
        json={"api_key": "k", "api_secret": "s", "feed": "iex"},
    )
    body = r.json()
    assert body["ok"] is True and "AAPL" in body["detail"] and "IEX" in body["detail"]


def test_equity_probe_uses_saved_key_when_blank(clean_override, monkeypatch):
    # a saved Alpaca key + blank request creds → the probe falls back to the saved creds
    config.set_market_data_config(alpaca_api_key="savedk", alpaca_api_secret="saveds")

    class _Trade:
        price = 1.0

    captured = {}

    class _Client:
        def __init__(self, key, secret, *a, **k):
            captured["key"] = key

        def get_stock_latest_trade(self, req):
            return {"AAPL": _Trade()}

    import alpaca.data.historical as hist
    monkeypatch.setattr(hist, "StockHistoricalDataClient", _Client)
    client = TestClient(app)
    r = client.post("/api/settings/market-data/test-equity", json={"feed": "sip"})
    assert r.json()["ok"] is True
    assert captured["key"] == "savedk"  # fell back to the saved key


def test_test_endpoint_rejects_unknown_exchange(clean_override):
    client = TestClient(app)
    r = client.post("/api/settings/market-data/test", json={"exchange": "nope"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False and "unsupported" in body["detail"]


def test_clear_cache_endpoint(clean_override):
    client = TestClient(app)
    r = client.post("/api/settings/market-data/clear-cache")
    assert r.status_code == 200 and r.json()["ok"] is True

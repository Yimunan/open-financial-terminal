# Open Financial Terminal

A local-first, LLM-native financial terminal — a dockable, Bloomberg-style workspace over the
[qhfi](https://github.com/<github-username>/quant-hedge-fund-incubator) quant engine and your local
vLLM stack. Open source (MIT).

## What it is

- **Bento-grid workspace** — every tool is a widget in a draggable / resizable / tabbed grid
  (Dockview). Layouts persist as named workspaces.
- **Channel linking** — widgets share an active symbol per color channel: click AAPL in a
  channel-red watchlist and every channel-red chart/news/research widget retargets.
- **Ctrl+K command bar** — jump to tickers, open widgets, switch theme. Free text falls
  through to the local LLM, which maps it onto the qhfi factor screener
  ("defensive low-vol names in dow30" → configured screener widget).
- **Realtime crypto** — order-book depth heatmap, time & sales with whale prints, and live
  flashing watchlist rows, fed by free exchange websockets (ccxt.pro) through one coalesced
  backend stream. Equities are EOD/polled — every widget badges its data honesty
  (LIVE / DELAYED / EOD).
- **Quant analytics from qhfi** — factor screener (11 factors incl. Alpha101), monthly-rebalanced
  factor backtests with real costs and **PSR / Deflated Sharpe** robustness, portfolio risk
  (correlations, Sharpe/Sortino/MaxDD), fundamentals + LLM news sentiment.
- **Streaming assistant** — symbol-aware chat dock streaming tokens from your local model.

## Widgets

Watchlist · Chart (candles / Heikin Ashi / area, indicator overlays, 1m–1d scrubber) ·
Order Book · Time & Sales · News (LLM sentiment) · Research · Screener (+NL ask) ·
Backtest · Portfolio · Assistant

## Requirements

- Windows (PowerShell scripts; the stack itself is portable)
- Python 3.11+, Node 18+
- The [qhfi](https://github.com/<github-username>/quant-hedge-fund-incubator) engine cloned as a
  **sibling** directory next to this repo (so the path resolves to `../quant-hedge-fund-incubator`).
  `scripts/setup.ps1` installs it editable (`pip install -e ../quant-hedge-fund-incubator`) and fails
  fast if the sibling is missing.
- A local OpenAI-compatible LLM proxy on `:8001` (vLLM) for the assistant/sentiment features —
  everything else works without it

## Quickstart

```powershell
./scripts/setup.ps1   # one-time: backend venv + qhfi (editable) + npm install
./scripts/dev.ps1     # backend :8050 + frontend :5173 in separate windows
```

Open http://localhost:5173. Press **Ctrl+K**.

## Desktop app

OFT also runs as a standalone Windows desktop app — a PyWebView shell over a PyInstaller-frozen
backend, packaged with an Inno Setup installer. The built installer is **not** committed to the repo;
build it locally following [docs/DESKTOP.md](docs/DESKTOP.md).

## Keyboard

| Key | Action |
| --- | --- |
| `Ctrl+K` | Command bar (tickers, widgets, commands, NL ask) |
| `T` | Ticker search (command bar) |
| `C` | New chart widget |
| `N` | New news widget |

Single-key shortcuts are inactive while typing in an input.

## Configuration

Backend env (`backend/.env`, `OFT_` prefix): `OFT_DATA_DIR`, `OFT_UNIVERSE_DIR`, `OFT_DB_PATH`,
`OFT_LLM_MODEL` (explicit model id; otherwise the served id is resolved from the proxy's
`/v1/models`, preferring gemma). The qhfi engine reads its own `QHFI_` config for the LLM
endpoint.

## MCP (Model Context Protocol)

The terminal speaks MCP in both directions.

**Expose the terminal as an MCP server.** A standalone stdio server in `backend/mcp_server/`
exposes the seven read-only assistant tools (`get_quote`, `get_performance`, `get_fundamentals`,
`get_news`, `screen`, `compare`, `search_symbols`) so Claude Code / Claude Desktop / OpenCode and
other agents can query live market data. It's a thin process that calls the running backend over
HTTP, so the backend must be up first.

```bash
# from backend/, with the venv python; backend must be running on :8050
python -m mcp_server.server                 # speaks stdio
# point it at a non-default backend:
OFT_MCP_BASE_URL=http://localhost:8050 python -m mcp_server.server
```

Register it with Claude Code (use the venv's python so `mcp` is importable):

```bash
claude mcp add oft -- "C:\\Project\\Open Financial Terminal\\backend\\.venv\\Scripts\\python.exe" -m mcp_server.server
```

Or in Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oft": {
      "command": "C:\\Project\\Open Financial Terminal\\backend\\.venv\\Scripts\\python.exe",
      "args": ["-m", "mcp_server.server"],
      "cwd": "C:\\Project\\Open Financial Terminal\\backend",
      "env": { "OFT_MCP_BASE_URL": "http://localhost:8050" }
    }
  }
}
```

**Consume external MCP servers.** Register MCP servers (Settings → MCP Servers, or by editing
`backend/data/mcp_servers.json`) and their tools join the grounded assistant's plan→fetch→stream
loop, namespaced `mcp:<server>:<tool>`. Discovery is best-effort — a down or misconfigured server
is simply skipped and never breaks chat. Each entry is `{name, transport: "stdio"|"http", command,
args, env, url, headers, enabled}`.

> Trust model: the backend has no auth (localhost/CORS only), and the MCP server inherits that.
> Intended for local use.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The short version: FastAPI backend that
imports qhfi as a library (never reimplements quant logic), a realtime hub that ref-counts
ccxt.pro exchange websockets and coalesces fan-out to ~150ms, and a React/TS frontend where
Dockview owns layout, zustand owns linking, and TanStack Query owns REST state.

/** Built-in workspace templates: ready-made bento layouts for common desks.
 *
 * Each template is a `build(api)` function that arranges panels with `api.addPanel`,
 * exactly like `seedDefaultLayout` in `layoutUtil.ts` — authored programmatically rather
 * than as serialized Dockview JSON so they stay robust to Dockview's internal format.
 * Widgets sharing a link `channel` (red/blue/green) track the same symbol; templates use
 * this to wire a coherent, pre-linked desk. Applied via `useWorkspace.applyBuiltinTemplate`.
 */

import type { DockviewApi } from "dockview";
import { widgetTitle } from "../lib/i18n";
import { useSettings } from "../state/settings";
import { WIDGETS, type WidgetParams, type WidgetType } from "./widgetRegistry";

export interface BuiltinTemplate {
  id: string;
  name: string;
  description: string;
  build: (api: DockviewApi) => void;
}

/** Mints a builder bound to a fresh, collision-free panel-id counter so every panel within a
 * template (and across rapid re-applies) gets a unique id, matching `openWidget`'s scheme. */
function builder(steps: (add: AddPanel) => void): (api: DockviewApi) => void {
  return (api) => {
    let seq = 0;
    const stamp = Date.now();
    const add: AddPanel = (type, opts = {}) => {
      seq += 1;
      const lang = useSettings.getState().language;
      return api.addPanel({
        id: `${type}-${stamp}-${seq}`,
        component: type,
        title: opts.title ?? widgetTitle(type, lang),
        // Persist an explicit custom title as a `label` param so it survives module-name
        // retitling on reload; panels without one recompute from the registry title (and so
        // track module renames automatically).
        params: { channel: WIDGETS[type].defaultChannel, ...(opts.title ? { label: opts.title } : {}), ...opts.params },
        ...(opts.position ? { position: opts.position } : {}),
      });
    };
    steps(add);
  };
}

type AddOpts = {
  title?: string;
  params?: WidgetParams;
  position?: { referencePanel: string; direction: "left" | "right" | "above" | "below" | "within" };
};
type AddPanel = (type: WidgetType, opts?: AddOpts) => ReturnType<DockviewApi["addPanel"]>;

const LEFT_WIDTH = 340;

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: "equities-day-trading",
    name: "Equities Day-Trading",
    description: "Watchlist, intraday chart, time & sales, quote and news — linked on the red channel.",
    build: builder((add) => {
      const watchlist = add("watchlist", { params: { channel: "red" } });
      const chart = add("chart", {
        title: "Chart · 1m",
        params: { channel: "red", timeframe: "1m", chartType: "candles" },
        position: { referencePanel: watchlist.id, direction: "right" },
      });
      add("timesales", {
        params: { channel: "red" },
        position: { referencePanel: chart.id, direction: "below" },
      });
      const quote = add("quote", {
        params: { channel: "red" },
        position: { referencePanel: chart.id, direction: "right" },
      });
      add("news", {
        params: { channel: "red" },
        position: { referencePanel: quote.id, direction: "below" },
      });
      watchlist.api.setSize({ width: LEFT_WIDTH });
    }),
  },
  {
    id: "crypto-trading",
    name: "Crypto Trading",
    description: "Crypto watchlist, 1m chart, order book, time & sales and market-making — linked on the blue channel.",
    build: builder((add) => {
      const watchlist = add("watchlist", { title: "Crypto Watchlist", params: { channel: "blue" } });
      const chart = add("chart", {
        title: "Chart · 1m",
        params: { channel: "blue", asset: "crypto", timeframe: "1m", chartType: "candles" },
        position: { referencePanel: watchlist.id, direction: "right" },
      });
      add("timesales", {
        params: { channel: "blue" },
        position: { referencePanel: chart.id, direction: "below" },
      });
      const orderbook = add("orderbook", {
        params: { channel: "blue" },
        position: { referencePanel: chart.id, direction: "right" },
      });
      add("market_making", {
        params: { channel: "blue" },
        position: { referencePanel: orderbook.id, direction: "below" },
      });
      watchlist.api.setSize({ width: LEFT_WIDTH });
    }),
  },
  {
    id: "research-due-diligence",
    name: "Research & Due Diligence",
    description: "Research, daily chart, public filings, news, committees and assistant for deep dives.",
    build: builder((add) => {
      const profile = add("metrics", { params: { channel: "red", tab: "fundamentals" } });
      const chart = add("chart", {
        title: "Chart · 1d",
        params: { channel: "red", timeframe: "1d", chartType: "candles" },
        position: { referencePanel: profile.id, direction: "right" },
      });
      add("filings", {
        params: { channel: "red" },
        position: { referencePanel: chart.id, direction: "below" },
      });
      const news = add("news", {
        params: { channel: "red" },
        position: { referencePanel: chart.id, direction: "right" },
      });
      add("committee", {
        params: { channel: "red" },
        position: { referencePanel: news.id, direction: "below" },
      });
      add("assistant", {
        params: { channel: "red" },
        position: { referencePanel: news.id, direction: "below" },
      });
      profile.api.setSize({ width: LEFT_WIDTH });
    }),
  },
  {
    id: "quant-research",
    name: "Quant Research",
    description: "Factor library, factor performance, backtest, sandbox and strategies — the alpha-dev loop.",
    build: builder((add) => {
      const factors = add("factors");
      const monitor = add("factor_monitor", {
        position: { referencePanel: factors.id, direction: "right" },
      });
      add("backtest", {
        position: { referencePanel: monitor.id, direction: "below" },
      });
      const sandbox = add("sandbox", {
        params: { channel: "red" },
        position: { referencePanel: monitor.id, direction: "right" },
      });
      add("strategies", {
        params: { channel: "red" },
        position: { referencePanel: sandbox.id, direction: "below" },
      });
      factors.api.setSize({ width: LEFT_WIDTH });
    }),
  },
  {
    id: "portfolio-risk",
    name: "Portfolio & Risk",
    description: "Portfolio, risk attribution, metrics, portfolio builder and paper trading for book monitoring.",
    build: builder((add) => {
      const portfolio = add("portfolio");
      const risk = add("risk_attribution", {
        position: { referencePanel: portfolio.id, direction: "right" },
      });
      add("metrics", {
        params: { channel: "red" },
        position: { referencePanel: risk.id, direction: "below" },
      });
      const portfolios = add("portfolios", {
        position: { referencePanel: risk.id, direction: "right" },
      });
      add("paper", {
        params: { channel: "red" },
        position: { referencePanel: portfolios.id, direction: "below" },
      });
      portfolio.api.setSize({ width: LEFT_WIDTH });
    }),
  },
  {
    id: "macro-markets",
    name: "Macro & Markets Overview",
    description: "Market board, macro, market & macro topic news, new listings and news — a top-down view.",
    build: builder((add) => {
      const board = add("market_board");
      const macro = add("macro", {
        position: { referencePanel: board.id, direction: "right" },
      });
      add("topicnews", {
        title: "Macro News",
        params: { channel: "none", category: "macro", label: "Macro" },
        position: { referencePanel: macro.id, direction: "below" },
      });
      const listings = add("listings", {
        params: { channel: "red" },
        position: { referencePanel: macro.id, direction: "right" },
      });
      add("topicnews", {
        title: "Market News",
        params: { channel: "none", category: "market", label: "Market" },
        position: { referencePanel: listings.id, direction: "below" },
      });
      board.api.setSize({ width: LEFT_WIDTH });
    }),
  },
  {
    id: "algo-execution",
    name: "Algo / Execution Desk",
    description: "Algo trading, 5m chart, order book, paper trading and agent workflow for automated execution.",
    build: builder((add) => {
      const algo = add("algo_trading", { params: { channel: "red" } });
      const chart = add("chart", {
        title: "Chart · 5m",
        params: { channel: "red", timeframe: "5m", chartType: "candles" },
        position: { referencePanel: algo.id, direction: "right" },
      });
      add("orderbook", {
        params: { channel: "blue" },
        position: { referencePanel: chart.id, direction: "below" },
      });
      const paper = add("paper", {
        params: { channel: "red" },
        position: { referencePanel: chart.id, direction: "right" },
      });
      add("agent", {
        params: { channel: "red" },
        position: { referencePanel: paper.id, direction: "below" },
      });
      algo.api.setSize({ width: LEFT_WIDTH });
    }),
  },
];

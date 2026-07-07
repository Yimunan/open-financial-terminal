import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CryptoCategory, DataRefreshConfigIn, DataRefreshStatus, EquityCategory, FiccCategory, LlmSettings, LlmTestResult, MarketDataSettings, McpServer, McpTestResult, NewsFeedCandidate, NewsSource, NewsSourceSettings, NewsTopic, RegPaths } from "../api/types";

/** FICC asset classes shown in Market Data settings (yfinance bars + a selectable depth source). */
const FICC_MD: { key: "rates" | "fx" | "commodity"; label: string }[] = [
  { key: "rates", label: "Rates (futures)" },
  { key: "fx", label: "FX" },
  { key: "commodity", label: "Commodities (futures)" },
];

/** Human label for an order-book depth-source id. */
function depthLabel(s: string): string {
  if (s === "sim") return "Simulated";
  if (s === "exchange") return "Exchange (real L2)";
  if (s === "ibkr") return "IBKR";
  if (s === "databento") return "Databento";
  if (s === "dxfeed") return "dxFeed";
  if (s === "none") return "Off";
  return s;
}

/** The instrument a depth source delivers for an asset class, when a class's sources differ:
 * "spot" | "futures" | "". Today only FX splits — Simulated/IBKR/dxFeed give spot FX, but Databento
 * serves the CME FX future. Other classes are uniform (equity/crypto = spot, rates/commodities =
 * futures), so the block header already says it and no per-option tag is needed. */
function depthInstrument(asset: string, source: string): "spot" | "futures" | "" {
  if (asset !== "fx" || source === "none") return "";
  return source === "databento" ? "futures" : "spot";
}

/** Dropdown option label, tagged with spot/futures only where a class's sources differ (FX). */
function depthOptionLabel(asset: string, source: string): string {
  const inst = depthInstrument(asset, source);
  return inst ? `${depthLabel(source)} (${inst})` : depthLabel(source);
}

/** A short caveat when the selected depth vendor's book instrument differs from the block's
 * spot/futures nature — e.g. Databento has no spot FX, so it serves the CME FX future instead.
 * Empty when the vendor's depth matches the block (the common case). */
function depthHint(asset: string, source: string): string {
  if (asset === "fx" && source === "databento") return "↳ CME FX future (6E), not spot";
  return "";
}

/** Human label for an options-chain source id. */
function optionsSourceLabel(s: string): string {
  if (s === "yfinance") return "yfinance (free, delayed)";
  if (s === "tradier") return "Tradier";
  if (s === "polygon") return "Polygon";
  if (s === "ibkr") return "IBKR";
  if (s === "none") return "Off";
  return s;
}

/** Capability note for the selected options source, e.g. "chains · IV · greeks computed locally". */
function optionsCapNote(caps?: { chains: boolean; iv: boolean; greeks: boolean; realtime: boolean }): string {
  if (!caps || !caps.chains) return "";
  const parts = ["chains"];
  if (caps.iv) parts.push("IV");
  parts.push(caps.greeks ? "greeks" : "greeks computed locally (Black-Scholes)");
  if (caps.realtime) parts.push("realtime");
  return parts.join(" · ");
}
import { useT, type Lang } from "../lib/i18n";
import { retitlePanels } from "../workspace/layoutUtil";
import { cx } from "../lib/format";
import { setStreamExchange } from "../lib/wsClient";
import {
  ACCENT_SWATCHES,
  DEFAULT_ACCENT,
  DEFAULT_CANDLE,
  LANGUAGES,
  SAVED_ACCENT_MAX,
  useSettings,
  type CandleScheme,
} from "../state/settings";
import { useWorkspace } from "../state/workspace";
import { useLinking } from "../state/linking";

const llmInputCls =
  "focus-ring w-full rounded border border-term-border bg-term-sunken px-2 py-1 font-mono text-xs text-term-text focus:border-term-accent";

// Same look as llmInputCls but WITHOUT `w-full`, so it can be flex-sized inside a row without
// overflowing (used by the News Topics rows, where width must yield to the Add/Remove buttons).
const topicInputCls =
  "focus-ring rounded border border-term-border bg-term-sunken px-2 py-1 font-mono text-xs text-term-text focus:border-term-accent";

/** Compact numeric input (for inline weight/parameter fields next to a slider). */
const numCls =
  "focus-ring w-14 rounded border border-term-border bg-term-sunken px-1 py-0.5 text-right text-[10px] tabular-nums text-term-text focus:border-term-accent";

const clampNum = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

/** OpenAI-compatible providers for one-click base-URL fill. */
const LLM_PRESETS: { label: string; url: string; model: string }[] = [
  { label: "Open WebUI", url: "http://localhost:3000/openai/v1", model: "" },
  { label: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1", model: "" },
  { label: "Groq", url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { label: "Together", url: "https://api.together.xyz/v1", model: "" },
];

type SectionKey = "appearance" | "llm" | "news" | "topics" | "marketData" | "dataRefresh" | "mcp" | "data";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "appearance", label: "Appearance" },
  { key: "llm", label: "LLM Model" },
  { key: "news", label: "News" },
  { key: "topics", label: "News Topics" },
  { key: "marketData", label: "Market Data" },
  { key: "dataRefresh", label: "Data Refresh" },
  { key: "mcp", label: "MCP Servers" },
  { key: "data", label: "Data" },
];

/** Relative "x ago" / "in x" for refresh timestamps; null → "never". */
function relTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  const unit = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  if (m < 1) return ms >= 0 ? "soon" : "just now";
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}

function NavItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "focus-ring block w-full rounded px-2.5 py-1.5 text-left text-xs transition-colors",
        active
          ? "bg-term-accent/15 text-term-accent"
          : "text-term-muted hover:bg-term-border/40 hover:text-term-text",
      )}
    >
      {children}
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <span className="text-xs text-term-muted">{label}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

function Choice({
  active,
  onClick,
  children,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "focus-ring rounded border px-2.5 py-1 text-xs transition-colors disabled:opacity-40",
        active
          ? "border-term-accent bg-term-accent/15 text-term-accent"
          : "border-term-border text-term-muted hover:text-term-text",
      )}
    >
      {children}
    </button>
  );
}

/** Compact ranking-priority control for a news source (0–100; 50 = neutral). */
function WeightSlider({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1" title="Ranking priority (0–100)">
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-16 accent-term-accent"
        aria-label="Ranking priority"
      />
      <input
        type="number"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(e) => onChange(clampNum(Number(e.target.value), 0, 100))}
        className={cx(numCls, "w-11")}
        aria-label="Ranking priority value"
      />
    </span>
  );
}

export default function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const {
    theme,
    language,
    scheme,
    accent,
    savedAccents,
    candleUp,
    candleDown,
    showEmoji,
    showIcons,
    setTheme,
    setLanguage,
    setScheme,
    setAccent,
    saveAccent,
    removeSavedAccent,
    setCandleUp,
    setCandleDown,
    setShowEmoji,
    setShowIcons,
  } = useSettings();
  const [section, setSection] = useState<SectionKey>("appearance");

  // ── Linked qhfi directories (factors / strategies / model repository) ──
  const [paths, setPaths] = useState<RegPaths | null>(null);
  const [pathCounts, setPathCounts] = useState<{ factors: number; strategies: number; models: number } | null>(null);
  const [pathsBusy, setPathsBusy] = useState(false);
  const [pathsMsg, setPathsMsg] = useState<{ ok: boolean; detail: string } | null>(null);

  const loadPaths = async () => {
    try {
      const [p, f, s, m] = await Promise.all([
        api.registryPaths(),
        api.registryFactors().catch(() => null),
        api.registryStrategies().catch(() => null),
        api.repoModels().catch(() => null),
      ]);
      setPaths(p);
      setPathCounts({
        factors: f?.engine?.length ?? 0,
        strategies: s?.engine?.length ?? 0,
        models: m?.models?.length ?? 0,
      });
    } catch {
      /* leave nulls — section just shows blank inputs */
    }
  };

  const savePaths = async () => {
    if (!paths) return;
    setPathsBusy(true);
    setPathsMsg(null);
    try {
      const saved = await api.savePaths(paths);
      setPaths(saved);
      // Re-discover engine/linked content under the new dirs, then refresh the widgets.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["reg-factors"] }),
        qc.invalidateQueries({ queryKey: ["reg-strategies"] }),
        qc.invalidateQueries({ queryKey: ["reg-models"] }),
        qc.invalidateQueries({ queryKey: ["repo-models"] }),
      ]);
      await loadPaths();
      setPathsMsg({ ok: true, detail: "Saved · widgets refreshed" });
    } catch (e) {
      setPathsMsg({ ok: false, detail: e instanceof Error ? e.message : "save failed" });
    } finally {
      setPathsBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadPaths();
  }, [open]);

  // ── Data refresh (background auto-update) ──
  const [dr, setDr] = useState<DataRefreshStatus | null>(null);
  const [drBusy, setDrBusy] = useState(false);
  const [drMsg, setDrMsg] = useState<{ ok: boolean; detail: string } | null>(null);

  const loadDr = async () => {
    try {
      setDr(await api.dataRefreshStatus());
    } catch {
      /* leave — section shows a loading hint */
    }
  };

  // Poll live status every 5s while the Data Refresh section is open (last-run / running state).
  useEffect(() => {
    if (!open || section !== "dataRefresh") return;
    void loadDr();
    const id = setInterval(() => void loadDr(), 5000);
    return () => clearInterval(id);
  }, [open, section]);

  const applyDr = async (body: DataRefreshConfigIn) => {
    setDrBusy(true);
    setDrMsg(null);
    try {
      setDr(await api.saveDataRefreshConfig(body));
      setDrMsg({ ok: true, detail: "Saved" });
    } catch (e) {
      setDrMsg({ ok: false, detail: e instanceof Error ? e.message : "save failed" });
    } finally {
      setDrBusy(false);
    }
  };

  const runDr = async (job: string) => {
    setDrBusy(true);
    setDrMsg(null);
    try {
      const res = await api.runDataRefreshJob(job);
      setDrMsg({ ok: res.status !== "error", detail: `${job} → ${res.status}` });
      await loadDr();
    } catch (e) {
      setDrMsg({ ok: false, detail: e instanceof Error ? e.message : "run failed" });
    } finally {
      setDrBusy(false);
    }
  };

  // ── LLM provider (server-side; local proxy vs an online API) ──
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [llmBusy, setLlmBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [probing, setProbing] = useState(false);
  const [testRes, setTestRes] = useState<Pick<LlmTestResult, "ok" | "detail"> | null>(null);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await api.llmSettings();
        if (cancelled) return;
        setLlm(s);
        setBaseUrl(s.custom ? s.base_url : "");
        setModel(s.model_pinned ? s.model : "");
        setApiKey("");
        setShowKey(false);
        setTestRes(null);
        // detect the models the active provider serves so the user can switch between them
        const r = await api.llmModels();
        if (!cancelled) setModels(r.models ?? []);
      } catch {
        /* leave defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const detectModels = async () => {
    setLlmBusy(true);
    setTestRes(null);
    try {
      const r = await api.testLlmSettings({ base_url: baseUrl.trim(), api_key: apiKey, model: model.trim() });
      setModels(r.models ?? []);
      setTestRes({ ok: r.ok, detail: r.ok ? `${r.models.length} model(s) detected` : r.detail });
    } catch (e) {
      setTestRes({ ok: false, detail: e instanceof Error ? e.message : "detect failed" });
    } finally {
      setLlmBusy(false);
    }
  };

  const saveLlm = async () => {
    setLlmBusy(true);
    try {
      const s = await api.saveLlmSettings({ base_url: baseUrl.trim(), api_key: apiKey, model: model.trim() });
      setLlm(s);
      setApiKey("");
      setBaseUrl(s.custom ? s.base_url : "");
      setModel(s.model_pinned ? s.model : "");
      setTestRes({
        ok: true,
        detail: s.custom ? `Saved · ${s.model}` : s.model_pinned ? `Local model · ${s.model}` : "Local proxy · auto model",
      });
      const r = await api.llmModels();
      setModels(r.models ?? []);
    } catch (e) {
      setTestRes({ ok: false, detail: e instanceof Error ? e.message : "save failed" });
    } finally {
      setLlmBusy(false);
    }
  };

  const testLlm = async () => {
    setLlmBusy(true);
    setTestRes(null);
    try {
      const r = await api.testLlmSettings({ base_url: baseUrl.trim(), api_key: apiKey, model: model.trim() });
      setTestRes(r);
    } catch (e) {
      setTestRes({ ok: false, detail: e instanceof Error ? e.message : "test failed" });
    } finally {
      setLlmBusy(false);
    }
  };

  // Live generation probe — actually asks the model to reply, end-to-end. Local models may need
  // to warm up (the proxy cold-loads on the first call), so this can take a while; online APIs
  // should answer immediately.
  const probeLlm = async () => {
    setLlmBusy(true);
    setProbing(true);
    setTestRes(null);
    try {
      const r = await api.probeLlmSettings({ base_url: baseUrl.trim(), api_key: apiKey, model: model.trim() });
      setTestRes({ ok: r.ok, detail: r.detail });
    } catch (e) {
      setTestRes({ ok: false, detail: e instanceof Error ? e.message : "probe failed" });
    } finally {
      setLlmBusy(false);
      setProbing(false);
    }
  };

  // Remove the saved API key entirely (backend drops it from disk); keeps the provider base_url +
  // model. Distinct from blank-on-save, which keeps the previously saved key.
  const removeLlmKey = async () => {
    setLlmBusy(true);
    setTestRes(null);
    try {
      const s = await api.clearLlmKey();
      setLlm(s);
      setApiKey("");
      setTestRes({ ok: true, detail: "API key removed" });
    } catch (e) {
      setTestRes({ ok: false, detail: e instanceof Error ? e.message : "remove failed" });
    } finally {
      setLlmBusy(false);
    }
  };

  const useLocalProxy = async () => {
    setBaseUrl("");
    setModel("");
    setApiKey("");
    setLlmBusy(true);
    try {
      const s = await api.saveLlmSettings({ base_url: "" });
      setLlm(s);
      setTestRes({ ok: true, detail: "Using local proxy" });
    } finally {
      setLlmBusy(false);
    }
  };

  // ── News sources (which feeds the News widget pulls from) ──
  const [news, setNews] = useState<NewsSourceSettings | null>(null);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newsBusy, setNewsBusy] = useState(false);
  const [newsMsg, setNewsMsg] = useState<{ ok: boolean; detail: string } | null>(null);
  const [discoverQ, setDiscoverQ] = useState("");
  const [candidates, setCandidates] = useState<NewsFeedCandidate[]>([]);

  useEffect(() => {
    if (!open) return;
    api.newsSettings().then(setNews).catch(() => {});
  }, [open]);

  const toggleBuiltin = (key: string) =>
    setNews((n) => (n ? { ...n, builtin: { ...n.builtin, [key]: !n.builtin[key] } } : n));
  const setBuiltinWeight = (key: string, weight: number) =>
    setNews((n) => (n ? { ...n, builtin_weights: { ...n.builtin_weights, [key]: weight } } : n));
  const setRanking = (patch: Partial<NewsSourceSettings["ranking"]>) =>
    setNews((n) => (n ? { ...n, ranking: { ...n.ranking, ...patch } } : n));
  const resetRanking = () =>
    setNews((n) => (n ? { ...n, ranking: { ...n.ranking_default } } : n));
  const patchCustom = (i: number, patch: Partial<NewsSource>) =>
    setNews((n) => (n ? { ...n, custom: n.custom.map((c, j) => (j === i ? { ...c, ...patch } : c)) } : n));
  const removeCustom = (i: number) =>
    setNews((n) => (n ? { ...n, custom: n.custom.filter((_, j) => j !== i) } : n));
  const addCustom = () => {
    if (!news || !newUrl.trim()) return;
    setNews({ ...news, custom: [...news.custom, { name: newName.trim() || "Custom feed", url: newUrl.trim(), enabled: true, weight: 50 }] });
    setNewName("");
    setNewUrl("");
  };

  const saveNews = async () => {
    if (!news) return;
    setNewsBusy(true);
    setNewsMsg(null);
    try {
      const saved = await api.saveNewsSettings({
        builtin: news.builtin,
        builtin_weights: news.builtin_weights,
        custom: news.custom,
        max_items: news.max_items,
        ranking: news.ranking,
      });
      setNews(saved);
      const active = Object.values(saved.builtin).filter(Boolean).length + saved.custom.filter((c) => c.enabled).length;
      setNewsMsg({ ok: true, detail: `Saved · ${active} source(s) active` });
      qc.invalidateQueries({ queryKey: ["news"] });
    } catch (e) {
      setNewsMsg({ ok: false, detail: e instanceof Error ? e.message : "save failed" });
    } finally {
      setNewsBusy(false);
    }
  };

  const testNewsUrl = async (url: string, name: string) => {
    if (!url.trim()) return;
    setNewsBusy(true);
    setNewsMsg(null);
    try {
      const r = await api.testNewsSource({ url: url.trim(), name: name.trim() });
      setNewsMsg({ ok: r.ok, detail: r.detail });
    } catch (e) {
      setNewsMsg({ ok: false, detail: e instanceof Error ? e.message : "test failed" });
    } finally {
      setNewsBusy(false);
    }
  };

  const discoverFeeds = async () => {
    if (!discoverQ.trim()) return;
    setNewsBusy(true);
    setNewsMsg(null);
    setCandidates([]);
    try {
      const r = await api.discoverNewsSources(discoverQ.trim());
      setCandidates(r.candidates);
      setNewsMsg({ ok: r.ok, detail: r.detail });
    } catch (e) {
      setNewsMsg({ ok: false, detail: e instanceof Error ? e.message : "search failed" });
    } finally {
      setNewsBusy(false);
    }
  };

  const addCandidate = (c: NewsFeedCandidate) => {
    setNews((n) =>
      n ? { ...n, custom: [...n.custom, { name: c.title, url: c.url, enabled: true, weight: 50 }] } : n,
    );
    setCandidates((cs) => cs.filter((x) => x.url !== c.url));
  };

  // ── External MCP servers (whose tools the grounded assistant can call) ──
  const [mcp, setMcp] = useState<McpServer[] | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpMsg, setMcpMsg] = useState<{ ok: boolean; detail: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    api.mcpSettings().then((r) => setMcp(r.servers)).catch(() => {});
  }, [open]);

  const patchServer = (i: number, patch: Partial<McpServer>) =>
    setMcp((s) => (s ? s.map((srv, j) => (j === i ? { ...srv, ...patch } : srv)) : s));
  const removeServer = (i: number) => setMcp((s) => (s ? s.filter((_, j) => j !== i) : s));
  const addServer = () =>
    setMcp((s) => [
      ...(s ?? []),
      { name: "", transport: "stdio", command: "", args: [], env: {}, url: "", headers: {}, enabled: true },
    ]);

  const saveMcp = async () => {
    if (!mcp) return;
    setMcpBusy(true);
    setMcpMsg(null);
    try {
      const saved = await api.saveMcpSettings({ servers: mcp });
      setMcp(saved.servers);
      const active = saved.servers.filter((s) => s.enabled).length;
      setMcpMsg({ ok: true, detail: `Saved · ${active} server(s) enabled` });
    } catch (e) {
      setMcpMsg({ ok: false, detail: e instanceof Error ? e.message : "save failed" });
    } finally {
      setMcpBusy(false);
    }
  };

  const testServer = async (srv: McpServer) => {
    setMcpBusy(true);
    setMcpMsg(null);
    try {
      const r: McpTestResult = await api.testMcpServer(srv);
      const names = r.tools.map((tl) => tl.name).slice(0, 6).join(", ");
      setMcpMsg({
        ok: r.ok,
        detail: r.ok ? `${srv.name || "server"}: ${r.detail}${names ? ` — ${names}` : ""}` : r.detail,
      });
    } catch (e) {
      setMcpMsg({ ok: false, detail: e instanceof Error ? e.message : "test failed" });
    } finally {
      setMcpBusy(false);
    }
  };

  // ── News topics ("interest subscriptions") ──
  const [topics, setTopics] = useState<NewsTopic[] | null>(null);
  const [topLabel, setTopLabel] = useState("");
  const [topQuery, setTopQuery] = useState("");
  const [topBusy, setTopBusy] = useState(false);
  const [topMsg, setTopMsg] = useState<{ ok: boolean; detail: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    api.newsTopicsConfig().then((r) => setTopics(r.topics)).catch(() => {});
  }, [open]);

  // Persist a topic list to the backend and reflect the server's normalized result. Shared by the
  // immediate add/remove/toggle actions and the explicit "Save edits" button.
  const persistTopics = async (list: NewsTopic[]) => {
    setTopBusy(true);
    setTopMsg(null);
    try {
      const r = await api.saveNewsTopics(list);
      setTopics(r.topics);
      setTopMsg({ ok: true, detail: `Saved · ${r.topics.length} topic(s)` });
      qc.invalidateQueries({ queryKey: ["news-topics"] }); // refresh the Cmd+K launcher
      return r.topics;
    } catch (e) {
      setTopMsg({ ok: false, detail: e instanceof Error ? e.message : "save failed" });
      return null;
    } finally {
      setTopBusy(false);
    }
  };

  // Inline label/query text edits stay local until "Save edits" (avoid a round-trip per keystroke).
  const patchTopic = (i: number, patch: Partial<NewsTopic>) =>
    setTopics((ts) => (ts ? ts.map((t, j) => (j === i ? { ...t, ...patch } : t)) : ts));
  // Add / remove / enable-toggle persist immediately so there's no separate save step for them.
  const toggleTopic = (i: number) =>
    persistTopics((topics ?? []).map((t, j) => (j === i ? { ...t, enabled: !t.enabled } : t)));
  const removeTopic = (i: number) => persistTopics((topics ?? []).filter((_, j) => j !== i));
  // Labels are entered comma-separated (one topic can carry several aliases, all on one query).
  const parseLabels = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const addTopic = async () => {
    const labels = parseLabels(topLabel);
    if (!labels.length || !topQuery.trim()) return;
    const saved = await persistTopics([
      ...(topics ?? []),
      { key: "", labels, query: topQuery.trim(), enabled: true },
    ]);
    if (saved) {
      setTopLabel("");
      setTopQuery("");
    }
  };

  const previewTopic = async (query: string) => {
    if (!query.trim()) return;
    setTopBusy(true);
    setTopMsg(null);
    try {
      const r = await api.previewNewsTopic(query.trim());
      setTopMsg({ ok: r.ok, detail: r.detail });
    } catch (e) {
      setTopMsg({ ok: false, detail: e instanceof Error ? e.message : "preview failed" });
    } finally {
      setTopBusy(false);
    }
  };

  const saveTopics = async () => {
    // Commit inline label/query edits; fold in a pending add-row so a typed topic isn't lost.
    const pendingLabels = parseLabels(topLabel);
    const pending: NewsTopic[] =
      pendingLabels.length && topQuery.trim()
        ? [{ key: "", labels: pendingLabels, query: topQuery.trim(), enabled: true }]
        : [];
    const saved = await persistTopics([...(topics ?? []), ...pending]);
    if (saved) {
      setTopLabel("");
      setTopQuery("");
    }
  };

  // ── Market data (crypto exchange, cache/history, Alpaca creds, status) ──
  const [md, setMd] = useState<MarketDataSettings | null>(null);
  const [mdKey, setMdKey] = useState("");
  const [mdSecret, setMdSecret] = useState("");
  const [showMdKey, setShowMdKey] = useState(false);
  const [showMdSecret, setShowMdSecret] = useState(false);
  const [mdBusy, setMdBusy] = useState(false);
  const [mdMsg, setMdMsg] = useState<{ ok: boolean; detail: string } | null>(null);
  // patch one asset-class category in the in-progress md state
  const patchEquity = (p: Partial<EquityCategory>) =>
    setMd((m) => (m ? { ...m, categories: { ...m.categories, equity: { ...m.categories.equity, ...p } } } : m));
  const patchCrypto = (p: Partial<CryptoCategory>) =>
    setMd((m) => (m ? { ...m, categories: { ...m.categories, crypto: { ...m.categories.crypto, ...p } } } : m));
  const patchFicc = (cat: "rates" | "fx" | "commodity", p: Partial<FiccCategory>) =>
    setMd((m) => (m ? { ...m, categories: { ...m.categories, [cat]: { ...m.categories[cat], ...p } } } : m));
  const patchOptions = (p: Partial<import("../api/types").OptionsCategory>) =>
    setMd((m) => (m && m.categories.options
      ? { ...m, categories: { ...m.categories, options: { ...m.categories.options, ...p } } }
      : m));

  useEffect(() => {
    if (!open) return;
    api.marketDataSettings()
      .then((s) => {
        setMd(s);
        setMdKey("");
        setMdSecret("");
      })
      .catch(() => {});
  }, [open]);

  const saveMarketData = async () => {
    if (!md || !md.categories) return;
    setMdBusy(true);
    setMdMsg(null);
    try {
      const saved = await api.saveMarketDataSettings({
        categories: md.categories,
        alpaca_api_key: mdKey,
        alpaca_api_secret: mdSecret,
        alpaca_paper: md.alpaca_paper,
      });
      setMd(saved);
      setMdKey("");
      setMdSecret("");
      setShowMdKey(false);
      setShowMdSecret(false);
      setStreamExchange(saved.exchange); // repoint live realtime widgets immediately
      // seed the linking channels from the saved default symbols (first run only — see App)
      useLinking.getState().seedDefaults(
        saved.categories.equity.default_symbol,
        saved.categories.crypto.default_symbol,
      );
      qc.invalidateQueries({ queryKey: ["health"] });
      setMdMsg({ ok: true, detail: `Saved · ${saved.exchange} · broker ${saved.broker}` });
    } catch (e) {
      setMdMsg({ ok: false, detail: e instanceof Error ? e.message : "save failed" });
    } finally {
      setMdBusy(false);
    }
  };

  const testExchange = async () => {
    if (!md) return;
    setMdBusy(true);
    setMdMsg(null);
    try {
      const r = await api.testMarketDataExchange(md.categories.crypto.source);
      setMdMsg(r);
    } catch (e) {
      setMdMsg({ ok: false, detail: e instanceof Error ? e.message : "test failed" });
    } finally {
      setMdBusy(false);
    }
  };

  const testEquity = async () => {
    if (!md) return;
    setMdBusy(true);
    setMdMsg(null);
    try {
      // probe with the in-progress key/secret if typed (else the saved creds), on the chosen feed
      const r = await api.testMarketDataEquity({
        api_key: mdKey,
        api_secret: mdSecret,
        feed: md.categories.equity.realtime_feed,
      });
      setMdMsg(r);
    } catch (e) {
      setMdMsg({ ok: false, detail: e instanceof Error ? e.message : "test failed" });
    } finally {
      setMdBusy(false);
    }
  };

  const testDepth = async (asset: string, source: string) => {
    if (!md) return;
    setMdBusy(true);
    setMdMsg(null);
    try {
      const r = await api.testMarketDataDepth({ asset, source });
      setMdMsg(r);
    } catch (e) {
      setMdMsg({ ok: false, detail: e instanceof Error ? e.message : "test failed" });
    } finally {
      setMdBusy(false);
    }
  };

  const testOptions = async (source: string, underlying: string) => {
    if (!md) return;
    setMdBusy(true);
    setMdMsg(null);
    try {
      const r = await api.testMarketDataOptions({ source, underlying });
      setMdMsg(r);
    } catch (e) {
      setMdMsg({ ok: false, detail: e instanceof Error ? e.message : "test failed" });
    } finally {
      setMdBusy(false);
    }
  };

  const removeAlpaca = async () => {
    if (!md || !md.has_alpaca_key) return;
    if (!window.confirm("Remove the saved Alpaca credentials? The paper broker reverts to the local simulator and equity realtime stops.")) return;
    setMdBusy(true);
    setMdMsg(null);
    try {
      const saved = await api.removeAlpacaCreds();
      setMd(saved);
      setMdKey("");
      setMdSecret("");
      setShowMdKey(false);
      setShowMdSecret(false);
      qc.invalidateQueries({ queryKey: ["health"] });
      setMdMsg({ ok: true, detail: `Alpaca credentials removed · broker ${saved.broker}` });
    } catch (e) {
      setMdMsg({ ok: false, detail: e instanceof Error ? e.message : "remove failed" });
    } finally {
      setMdBusy(false);
    }
  };

  const clearMarketCache = async () => {
    setMdBusy(true);
    setMdMsg(null);
    try {
      const r = await api.clearMarketDataCache();
      setMdMsg(r);
      const s = await api.marketDataSettings(); // refresh cached-symbol/realtime status
      setMd(s);
    } catch (e) {
      setMdMsg({ ok: false, detail: e instanceof Error ? e.message : "clear failed" });
    } finally {
      setMdBusy(false);
    }
  };

  // Dockview tab titles are serialized strings, not reactive — retitle live panels whenever the
  // language flips (shared with the load-time retitle that propagates module renames).
  const retitle = (lang: Lang) => {
    const dv = useWorkspace.getState().api;
    if (dv) retitlePanels(dv, lang);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Recover the theme's base bull/bear colors from the live tokens by undoing the
  // active scheme's swap, so each candle-scheme swatch previews its own convention.
  const schemeGreen = scheme === "cn" ? "rgb(var(--term-down))" : "rgb(var(--term-up))";
  const schemeRed = scheme === "cn" ? "rgb(var(--term-up))" : "rgb(var(--term-down))";

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        className="fixed left-1/2 top-[10vh] z-50 flex h-[min(560px,82vh)] w-[min(720px,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-term-border bg-term-elev shadow-elev-3"
      >
        <div className="flex items-center justify-between border-b border-term-border px-4 py-2.5">
          <span className="text-sm font-semibold">{t("settings.title")}</span>
          <button onClick={onClose} aria-label="Close settings" className="focus-ring rounded text-term-muted hover:text-term-text">×</button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="w-44 shrink-0 space-y-0.5 border-r border-term-border p-2">
            {SECTIONS.map((s) => (
              <NavItem key={s.key} active={section === s.key} onClick={() => setSection(s.key)}>
                {s.label}
              </NavItem>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {section === "appearance" && (
            <div className="divide-y divide-term-border/50">
          <Row label={t("settings.theme")}>
            <Choice active={theme === "dark"} onClick={() => setTheme("dark")}>
              {t("settings.dark")}
            </Choice>
            <Choice active={theme === "light"} onClick={() => setTheme("light")}>
              {t("settings.light")}
            </Choice>
          </Row>

          <Row label={t("settings.language")}>
            <select
              value={language}
              onChange={(e) => {
                const code = e.target.value as Lang;
                setLanguage(code);
                retitle(code);
              }}
              className="focus-ring min-w-[160px] rounded border border-term-border bg-term-sunken px-2 py-1 text-xs text-term-text focus:border-term-accent"
            >
              {LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </Row>

          <Row label={t("settings.scheme")}>
            {(
              [
                ["classic", t("settings.schemeClassic")],
                ["cn", t("settings.schemeCn")],
              ] as [CandleScheme, string][]
            ).map(([key, label]) => (
              <Choice key={key} active={scheme === key} onClick={() => setScheme(key)}>
                <span className="mr-1.5 inline-flex items-center gap-px align-middle">
                  {/* Stable per-scheme preview that still tracks the theme palette: classic = green
                     up / red down, cn flips them. `green`/`red` are recovered from the live tokens
                     by undoing the active scheme's swap, so each preview shows its own convention. */}
                  <span
                    className="inline-block h-2.5 w-1.5 rounded-sm"
                    style={{ backgroundColor: key === "cn" ? schemeRed : schemeGreen }}
                  />
                  <span
                    className="inline-block h-2.5 w-1.5 rounded-sm"
                    style={{ backgroundColor: key === "cn" ? schemeGreen : schemeRed }}
                  />
                </span>
                {label}
              </Choice>
            ))}
          </Row>

          <Row label={t("settings.candleCustom")}>
            {/* Per-direction overrides. Setting either writes an inline --term-up/--term-down token
                that wins over the scheme preset; Reset clears both back to the scheme default. */}
            <label className="flex items-center gap-1.5 text-[11px] text-term-muted">
              {t("settings.candleUp")}
              <input
                type="color"
                value={candleUp ?? DEFAULT_CANDLE[theme][scheme].up}
                onChange={(e) => setCandleUp(e.target.value)}
                className="focus-ring h-5 w-7 cursor-pointer rounded border border-term-border bg-transparent p-0"
                aria-label="custom up candle color"
                title={t("settings.candleUp")}
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-term-muted">
              {t("settings.candleDown")}
              <input
                type="color"
                value={candleDown ?? DEFAULT_CANDLE[theme][scheme].down}
                onChange={(e) => setCandleDown(e.target.value)}
                className="focus-ring h-5 w-7 cursor-pointer rounded border border-term-border bg-transparent p-0"
                aria-label="custom down candle color"
                title={t("settings.candleDown")}
              />
            </label>
            {(candleUp || candleDown) && (
              <button
                onClick={() => {
                  setCandleUp(null);
                  setCandleDown(null);
                }}
                className="focus-ring ml-1 rounded text-[10px] uppercase tracking-wide text-term-muted hover:text-term-text"
              >
                {t("settings.reset")}
              </button>
            )}
          </Row>

          <Row label={t("settings.accent")}>
            {ACCENT_SWATCHES.map((hex) => (
              <button
                key={hex}
                onClick={() => setAccent(hex)}
                className={cx(
                  "focus-ring h-5 w-5 rounded-full border-2 transition-opacity",
                  (accent ?? DEFAULT_ACCENT[theme]).toLowerCase() === hex.toLowerCase()
                    ? "border-term-text"
                    : "border-transparent opacity-70 hover:opacity-100",
                )}
                style={{ backgroundColor: hex }}
                aria-label={`accent ${hex}`}
              />
            ))}
            {/* User-pinned swatches: click to apply, hover to reveal a × that unpins it. */}
            {savedAccents.map((hex) => (
              <span key={hex} className="group relative inline-flex">
                <button
                  onClick={() => setAccent(hex)}
                  className={cx(
                    "focus-ring h-5 w-5 rounded-full border-2 transition-opacity",
                    (accent ?? DEFAULT_ACCENT[theme]).toLowerCase() === hex
                      ? "border-term-text"
                      : "border-transparent opacity-70 hover:opacity-100",
                  )}
                  style={{ backgroundColor: hex }}
                  aria-label={`saved accent ${hex}`}
                />
                <button
                  onClick={() => removeSavedAccent(hex)}
                  className="focus-ring absolute -right-1 -top-1 hidden h-3 w-3 items-center justify-center rounded-full bg-term-elev text-[8px] leading-none text-term-muted shadow-elev-1 hover:text-term-text group-hover:flex"
                  aria-label={t("settings.removeSwatch")}
                  title={t("settings.removeSwatch")}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              type="color"
              value={accent ?? DEFAULT_ACCENT[theme]}
              onChange={(e) => setAccent(e.target.value)}
              className="focus-ring h-5 w-7 cursor-pointer rounded border border-term-border bg-transparent p-0"
              aria-label="custom accent color"
              title={t("settings.accent")}
            />
            {/* Pin the current color. Hidden for presets/already-saved values and when the
                shelf is full of a fresh set — saveAccent itself dedupes and caps at the max. */}
            {(() => {
              const cur = accent?.toLowerCase() ?? null;
              const isPreset = !!cur && ACCENT_SWATCHES.some((h) => h.toLowerCase() === cur);
              const canSave =
                !!cur && !isPreset && !savedAccents.includes(cur) && savedAccents.length < SAVED_ACCENT_MAX;
              return canSave ? (
                <button
                  onClick={() => accent && saveAccent(accent)}
                  className="focus-ring flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-term-border text-term-muted hover:border-term-text hover:text-term-text"
                  aria-label={t("settings.saveSwatch")}
                  title={t("settings.saveSwatch")}
                >
                  +
                </button>
              ) : null;
            })()}
            <button
              onClick={() => setAccent(null)}
              className="focus-ring ml-1 rounded text-[10px] uppercase tracking-wide text-term-muted hover:text-term-text"
            >
              {t("settings.reset")}
            </button>
          </Row>

          <Row label={t("settings.emoji")}>
            <Choice active={showEmoji} onClick={() => setShowEmoji(true)}>
              {t("settings.emojiOn")}
            </Choice>
            <Choice active={!showEmoji} onClick={() => setShowEmoji(false)}>
              {t("settings.emojiOff")}
            </Choice>
          </Row>

          <Row label={t("settings.icons")}>
            <Choice active={showIcons} onClick={() => setShowIcons(true)}>
              {t("settings.iconsOn")}
            </Choice>
            <Choice active={!showIcons} onClick={() => setShowIcons(false)}>
              {t("settings.iconsOff")}
            </Choice>
          </Row>
            </div>
            )}

            {/* ── LLM API / proxy ── */}
            {section === "llm" && (
            <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-semibold text-term-text">Model & provider</span>
            <span
              className={cx(
                "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
                llm?.custom ? "bg-term-accent/15 text-term-accent" : "bg-term-border/40 text-term-muted",
              )}
            >
              {llm?.custom ? "Online API" : "Local proxy"}
            </span>
          </div>

          {/* ── Default model — the model used everywhere ── */}
          <label className="mb-1 block text-[11px] font-semibold text-term-text">Default model</label>
          <p className="mb-1.5 text-[10px] leading-relaxed text-term-muted">
            The model the whole terminal uses — assistant chat, agent workflows, backtest narration
            and news sentiment. <span className="text-term-text">Auto</span> lets the active provider
            pick (prefers a {llm?.model && !llm.model_pinned ? llm.model : "gemma"} locally).
          </p>
          <div className="flex items-center gap-1">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={cx(llmInputCls, "flex-1")}
              title="Choose the default model — pick one to switch the active LLM"
            >
              <option value="">Auto (server default)</option>
              {model && !models.includes(model) && <option value={model}>{model}</option>}
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              onClick={detectModels}
              disabled={llmBusy}
              title="Detect models served by this provider"
              className="shrink-0 rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:border-term-accent hover:text-term-accent disabled:opacity-50"
            >
              ↻ Detect{models.length ? ` (${models.length})` : ""}
            </button>
          </div>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="or type a model id — e.g. gpt-4o-mini"
            className={cx(llmInputCls, "mt-1.5")}
            spellCheck={false}
          />

          {/* ── Provider (optional) — point at an online OpenAI-compatible API ── */}
          <label className="mb-1 mt-3 block text-[11px] font-semibold text-term-text">
            Provider <span className="font-normal text-term-muted">— optional</span>
          </label>
          <p className="mb-2 text-[10px] leading-relaxed text-term-muted">
            Leave blank to use the local proxy ({llm && !llm.custom ? llm.base_url : "localhost:8001"}).
            Set a Base URL + API key to point at an OpenAI-compatible API instead. Open WebUI users
            can paste the UI root; it will be saved as /openai/v1.
          </p>

          <div className="mb-2 flex flex-wrap gap-1">
            {LLM_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => {
                  setBaseUrl(p.url);
                  if (p.model) setModel(p.model);
                }}
                className="rounded border border-term-border px-1.5 py-0.5 text-[10px] text-term-muted hover:border-term-accent hover:text-term-accent"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="Base URL — https://api.openai.com/v1"
              className={llmInputCls}
              spellCheck={false}
            />
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={llm?.has_key ? "API key — •••• saved (blank keeps it)" : "API key"}
                className={cx(llmInputCls, "pr-12")}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                disabled={!apiKey}
                title={showKey ? "Mask the API key" : "Reveal the API key"}
                aria-label={showKey ? "Mask the API key" : "Reveal the API key"}
                aria-pressed={showKey}
                className="absolute inset-y-0 right-1.5 my-auto h-fit rounded px-1 text-[10px] uppercase tracking-wide text-term-muted hover:text-term-text disabled:opacity-30"
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <button
              onClick={saveLlm}
              disabled={llmBusy}
              className="rounded border border-term-accent bg-term-accent/10 px-2.5 py-1 text-xs text-term-accent hover:bg-term-accent/20 disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={testLlm}
              disabled={llmBusy}
              title="List the models this provider serves (does not generate)"
              className="rounded border border-term-border px-2.5 py-1 text-xs text-term-muted hover:text-term-text disabled:opacity-50"
            >
              Test
            </button>
            <button
              onClick={probeLlm}
              disabled={llmBusy}
              title="Send a real one-word request to confirm the model actually replies, and measure latency (local models may need to warm up)"
              className="rounded border border-term-border px-2.5 py-1 text-xs text-term-muted hover:text-term-text disabled:opacity-50"
            >
              Probe
            </button>
            {llm?.has_key && (
              <button
                onClick={removeLlmKey}
                disabled={llmBusy}
                title="Delete the saved API key from the backend entirely (keeps the provider URL + model)"
                className="rounded border border-term-down/50 px-2.5 py-1 text-xs text-term-down hover:bg-term-down/10 disabled:opacity-50"
              >
                Remove key
              </button>
            )}
            <button
              onClick={useLocalProxy}
              disabled={llmBusy}
              className="ml-auto text-[10px] uppercase tracking-wide text-term-muted hover:text-term-text disabled:opacity-50"
            >
              Use local proxy
            </button>
          </div>

          {(llmBusy || testRes) && (
            <div
              className={cx(
                "mt-1.5 truncate text-[10px]",
                llmBusy ? "text-term-muted" : testRes?.ok ? "text-term-up" : "text-term-down",
              )}
              title={testRes?.detail}
            >
              {llmBusy
                ? probing
                  ? "Probing… local models may need to warm up (up to ~2 min)"
                  : "Working…"
                : `${testRes?.ok ? "✓" : "✕"} ${testRes?.detail}`}
            </div>
          )}
        </div>

            )}

            {/* ── News sources ── */}
            {section === "news" && (
            <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-semibold text-term-text">News Sources</span>
            {news && (
              <span className="rounded bg-term-border/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-term-muted">
                {Object.values(news.builtin).filter(Boolean).length + news.custom.filter((c) => c.enabled).length} active
              </span>
            )}
          </div>
          <p className="mb-2 text-[10px] leading-relaxed text-term-muted">
            Choose which feeds the News widget pulls from, and set each source's ranking priority
            (the slider, 0–100 · 50 = neutral) — higher floats that source up the ranked feed. Add
            your own RSS feeds with <span className="font-mono">{"{symbol}"}</span> in the URL — e.g.{" "}
            <span className="font-mono">https://news.google.com/rss/search?q={"{symbol}"}+stock</span>.
          </p>

          {/* max headlines — the News widget feed cap (ranked, then truncated to this) */}
          {news && (
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-term-muted">Max headlines</span>
              <input
                type="number"
                min={10}
                max={100}
                step={5}
                value={news.max_items}
                onChange={(e) =>
                  setNews((n) =>
                    n ? { ...n, max_items: Math.max(10, Math.min(100, Number(e.target.value) || 30)) } : n,
                  )
                }
                aria-label="Max headlines"
                className="focus-ring w-20 rounded border border-term-border bg-term-sunken px-2 py-1 text-xs text-term-text focus:border-term-accent"
              />
            </div>
          )}

          {/* built-in feeds */}
          <div className="space-y-1">
            {(news?.builtin_meta ?? []).map((b) => (
              <div key={b.key} className="flex items-center gap-2 text-xs text-term-text">
                <label className="flex flex-1 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={news?.builtin[b.key] ?? false}
                    onChange={() => toggleBuiltin(b.key)}
                    className="accent-term-accent"
                  />
                  {b.label}
                </label>
                <WeightSlider
                  value={news?.builtin_weights[b.key] ?? 50}
                  onChange={(n) => setBuiltinWeight(b.key, n)}
                />
              </div>
            ))}
          </div>

          {/* custom feeds */}
          {news && news.custom.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {news.custom.map((c, i) => (
                <div key={i} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    onChange={() => patchCustom(i, { enabled: !c.enabled })}
                    className="accent-term-accent"
                    title="Enabled"
                  />
                  <input
                    value={c.name}
                    onChange={(e) => patchCustom(i, { name: e.target.value })}
                    placeholder="Name"
                    className={cx(llmInputCls, "w-24 shrink-0")}
                    spellCheck={false}
                  />
                  <input
                    value={c.url}
                    onChange={(e) => patchCustom(i, { url: e.target.value })}
                    placeholder="RSS URL with {symbol}"
                    className={cx(llmInputCls, "flex-1")}
                    spellCheck={false}
                  />
                  <WeightSlider value={c.weight ?? 50} onChange={(n) => patchCustom(i, { weight: n })} />
                  <button
                    onClick={() => testNewsUrl(c.url, c.name)}
                    disabled={newsBusy}
                    title="Test feed"
                    className="shrink-0 rounded border border-term-border px-1.5 py-1 text-[10px] text-term-muted hover:border-term-accent hover:text-term-accent disabled:opacity-50"
                  >
                    Test
                  </button>
                  <button
                    onClick={() => removeCustom(i)}
                    title="Remove feed"
                    className="shrink-0 px-1 text-term-muted hover:text-term-down"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* discover feeds by keyword / site */}
          <div className="mt-3 border-t border-term-border/40 pt-2">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-term-muted">Discover feeds</div>
            <div className="flex items-center gap-1">
              <input
                value={discoverQ}
                onChange={(e) => setDiscoverQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && discoverFeeds()}
                placeholder="Search a site or keyword, e.g. reuters or marketwatch.com"
                className={cx(llmInputCls, "flex-1")}
                spellCheck={false}
              />
              <button
                onClick={discoverFeeds}
                disabled={newsBusy || !discoverQ.trim()}
                className="shrink-0 rounded border border-term-accent px-1.5 py-1 text-[10px] text-term-accent hover:bg-term-accent/10 disabled:opacity-40"
              >
                Search
              </button>
            </div>
            {candidates.length > 0 && (
              <div className="mt-1.5 space-y-1">
                {candidates.map((c) => (
                  <div key={c.url} className="flex items-center gap-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-term-text">{c.title}</div>
                      <div className="truncate text-[10px] text-term-muted" title={c.url}>
                        {c.url}
                      </div>
                    </div>
                    <button
                      onClick={() => addCandidate(c)}
                      className="shrink-0 rounded border border-term-accent px-1.5 py-1 text-[10px] text-term-accent hover:bg-term-accent/10"
                    >
                      + Add
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* add a custom feed */}
          <div className="mt-2 flex items-center gap-1">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name"
              className={cx(llmInputCls, "w-24 shrink-0")}
              spellCheck={false}
            />
            <input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCustom()}
              placeholder="RSS URL with {symbol}"
              className={cx(llmInputCls, "flex-1")}
              spellCheck={false}
            />
            <button
              onClick={() => testNewsUrl(newUrl, newName)}
              disabled={newsBusy || !newUrl.trim()}
              className="shrink-0 rounded border border-term-border px-1.5 py-1 text-[10px] text-term-muted hover:border-term-accent hover:text-term-accent disabled:opacity-50"
            >
              Test
            </button>
            <button
              onClick={addCustom}
              disabled={!newUrl.trim()}
              className="shrink-0 rounded border border-term-accent px-1.5 py-1 text-[10px] text-term-accent hover:bg-term-accent/10 disabled:opacity-40"
            >
              + Add
            </button>
          </div>

          {/* ranking formula — explanation + tunable weights */}
          {news && (() => {
            const r = news.ranking;
            const wrows = [
              ["recency", "Recency"],
              ["source", "Source priority"],
              ["relevance", "Relevance (LLM)"],
              ["sentiment", "Sentiment conviction"],
              ["match", "Ticker in title"],
            ] as const;
            const sum = wrows.reduce((a, [k]) => a + (r[k] || 0), 0) || 1;
            return (
              <div className="mt-3 border-t border-term-border/40 pt-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-term-muted">Ranking formula</span>
                  <button
                    onClick={resetRanking}
                    className="focus-ring rounded text-[10px] text-term-muted hover:text-term-accent"
                  >
                    Reset to defaults
                  </button>
                </div>
                <p className="mb-2 text-[10px] leading-relaxed text-term-muted">
                  In <span className="text-term-accent">Ranked</span> mode every headline gets a 0–1
                  score blending five signals: how <b>recent</b> it is, the <b>source priority</b>
                  {" "}(the sliders above), the LLM's <b>relevance</b> to the symbol, sentiment{" "}
                  <b>conviction</b> (|score|), and whether the title <b>mentions the ticker</b>.
                  The weights below set each signal's share — they're normalised, so only their{" "}
                  <i>proportions</i> matter (the % shown). Recency halves every{" "}
                  <b>{r.halflife_h}h</b>.
                </p>
                {/* live equation — coefficients are the normalised weights */}
                <div className="mb-2 overflow-x-auto rounded border border-term-border/60 bg-term-sunken px-2 py-1.5 font-mono text-[10px] leading-relaxed">
                  <div className="whitespace-nowrap">
                    <span className="text-term-accent">score</span> ={" "}
                    {wrows.map(([k], idx) => (
                      <span key={k} className="text-term-text">
                        {idx > 0 ? " + " : ""}
                        <span className="text-term-accent">{((r[k] || 0) / sum).toFixed(2)}</span>·{k}
                      </span>
                    ))}
                  </div>
                  <div className="whitespace-nowrap text-term-muted">
                    recency = 0.5<sup>(age_hours / {r.halflife_h})</sup> &nbsp;·&nbsp; source,
                    relevance, sentiment, match ∈ [0, 1]
                  </div>
                </div>
                <div className="space-y-0.5">
                  {wrows.map(([key, label]) => (
                    <div key={key} className="flex items-center gap-2 text-xs">
                      <span className="w-32 shrink-0 text-term-muted">{label}</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={r[key]}
                        onChange={(e) =>
                          setRanking({ [key]: Number(e.target.value) } as Partial<NewsSourceSettings["ranking"]>)
                        }
                        className="h-1 flex-1 accent-term-accent"
                        aria-label={`${label} weight`}
                      />
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={r[key]}
                        onChange={(e) =>
                          setRanking({ [key]: clampNum(Number(e.target.value), 0, 1) } as Partial<NewsSourceSettings["ranking"]>)
                        }
                        className={numCls}
                        aria-label={`${label} weight value`}
                      />
                      <span className="w-9 text-right text-[10px] tabular-nums text-term-accent">
                        {Math.round(((r[key] || 0) / sum) * 100)}%
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center gap-2 pt-0.5 text-xs">
                    <span className="w-32 shrink-0 text-term-muted">Recency half-life</span>
                    <input
                      type="range"
                      min={1}
                      max={72}
                      step={1}
                      value={r.halflife_h}
                      onChange={(e) => setRanking({ halflife_h: Number(e.target.value) })}
                      className="h-1 flex-1 accent-term-accent"
                      aria-label="Recency half-life (hours)"
                    />
                    <span className="flex items-center gap-0.5">
                      <input
                        type="number"
                        min={1}
                        max={168}
                        step={1}
                        value={r.halflife_h}
                        onChange={(e) => setRanking({ halflife_h: clampNum(Number(e.target.value), 1, 168) })}
                        className={numCls}
                        aria-label="Recency half-life value (hours)"
                      />
                      <span className="text-[10px] text-term-muted">h</span>
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}

          <div className="mt-3 flex items-center gap-1.5">
            <button
              onClick={saveNews}
              disabled={newsBusy || !news}
              className="rounded border border-term-accent bg-term-accent/10 px-2.5 py-1 text-xs text-term-accent hover:bg-term-accent/20 disabled:opacity-50"
            >
              Save
            </button>
          </div>

          {(newsBusy || newsMsg) && (
            <div
              className={cx(
                "mt-1.5 truncate text-[10px]",
                newsBusy ? "text-term-muted" : newsMsg?.ok ? "text-term-up" : "text-term-down",
              )}
              title={newsMsg?.detail}
            >
              {newsBusy ? "Working…" : `${newsMsg?.ok ? "✓" : "✕"} ${newsMsg?.detail}`}
            </div>
          )}

        </div>

            )}

            {/* ── News topics ("interest subscriptions") ── */}
            {section === "topics" && (
            <div>
            <div className="mb-1 text-xs font-semibold text-term-text">Topics</div>
            <p className="mb-2 text-[10px] leading-relaxed text-term-muted">
              Subscribe to an interest (e.g. <span className="font-mono">semiconductors</span>,{" "}
              <span className="font-mono">oil prices</span>). Each becomes a topic you can open as a
              news widget from the <span className="text-term-accent">⌘K</span> launcher, alongside the
              built-in <b>Market</b> and <b>Macro</b> feeds. Give a topic <b>several labels</b>{" "}
              (comma-separated) and each appears in the launcher, all feeding the one query. Adding,
              removing and enabling apply immediately; use <b>Save edits</b> after changing labels or
              keywords.
            </p>

            {topics && topics.length > 0 && (
              <div className="space-y-1.5">
                {topics.map((tp, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1">
                    <input
                      type="checkbox"
                      checked={tp.enabled}
                      onChange={() => toggleTopic(i)}
                      disabled={topBusy}
                      className="accent-term-accent"
                      title="Enabled (applies immediately)"
                    />
                    <input
                      value={tp.labels.join(", ")}
                      onChange={(e) => patchTopic(i, { labels: parseLabels(e.target.value) })}
                      placeholder="Labels (comma-separated)"
                      title="One or more labels/aliases, comma-separated — all feed the same query"
                      className={cx(topicInputCls, "w-40 shrink-0")}
                      spellCheck={false}
                    />
                    <input
                      value={tp.query}
                      onChange={(e) => patchTopic(i, { query: e.target.value })}
                      placeholder="Interest / keywords, e.g. semiconductors OR chips"
                      className={cx(topicInputCls, "min-w-0 flex-1")}
                      spellCheck={false}
                    />
                    <button
                      onClick={() => previewTopic(tp.query)}
                      disabled={topBusy}
                      title="Preview headlines"
                      className="shrink-0 rounded border border-term-border px-1.5 py-1 text-[10px] text-term-muted hover:border-term-accent hover:text-term-accent disabled:opacity-50"
                    >
                      Preview
                    </button>
                    <button
                      onClick={() => removeTopic(i)}
                      disabled={topBusy}
                      title="Remove this topic (applies immediately)"
                      className="shrink-0 rounded border border-term-down/60 px-2 py-1 text-[10px] font-semibold text-term-down hover:bg-term-down/10 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* add a topic */}
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <input
                value={topLabel}
                onChange={(e) => setTopLabel(e.target.value)}
                placeholder="Labels, e.g. Semis, Chips"
                title="One or more labels/aliases, comma-separated — all feed the same query"
                className={cx(topicInputCls, "w-40 shrink-0")}
                spellCheck={false}
              />
              <input
                value={topQuery}
                onChange={(e) => setTopQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addTopic()}
                placeholder="Interest / keywords"
                className={cx(topicInputCls, "min-w-0 flex-1")}
                spellCheck={false}
              />
              <button
                onClick={() => previewTopic(topQuery)}
                disabled={topBusy || !topQuery.trim()}
                className="shrink-0 rounded border border-term-border px-1.5 py-1 text-[10px] text-term-muted hover:border-term-accent hover:text-term-accent disabled:opacity-50"
              >
                Preview
              </button>
              <button
                onClick={addTopic}
                disabled={!topLabel.trim() || !topQuery.trim()}
                title="Add this topic (applies immediately)"
                className="shrink-0 rounded border border-term-accent bg-term-accent/10 px-3 py-1 text-[10px] font-semibold text-term-accent hover:bg-term-accent/20 disabled:opacity-40"
              >
                Add
              </button>
            </div>

            <div className="mt-3 flex items-center gap-1.5">
              <button
                onClick={saveTopics}
                disabled={topBusy}
                title="Commit edits to existing topics' label / keywords"
                className="rounded border border-term-accent bg-term-accent/10 px-2.5 py-1 text-xs text-term-accent hover:bg-term-accent/20 disabled:opacity-50"
              >
                Save edits
              </button>
            </div>

            {(topBusy || topMsg) && (
              <div
                className={cx(
                  "mt-1.5 truncate text-[10px]",
                  topBusy ? "text-term-muted" : topMsg?.ok ? "text-term-up" : "text-term-down",
                )}
                title={topMsg?.detail}
              >
                {topBusy ? "Working…" : `${topMsg?.ok ? "✓" : "✕"} ${topMsg?.detail}`}
              </div>
            )}
          </div>

            )}

            {/* ── Market data (exchange, cache/history, Alpaca creds, status) ── */}
            {section === "marketData" && (
            <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-semibold text-term-text">Market Data</span>
            {md && (
              <span className="rounded bg-term-border/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-term-muted">
                broker · {md.broker}
              </span>
            )}
          </div>
          <p className="mb-3 text-[10px] leading-relaxed text-term-muted">
            Each asset class has its own <b>data source</b> (historical + realtime), cache TTL,
            history window and default symbol. Crypto's exchange drives both bars and the realtime
            ticker / order-book / time-&-sales widgets (Kraken is the safe default — binance returns
            HTTP 451 from geo-restricted IPs); equity bars come from yfinance with realtime via Alpaca.
          </p>

          {md && !md.categories && (
            <p className="rounded border border-term-down/50 bg-term-down/10 px-2 py-1.5 text-[10px] text-term-down">
              Backend is out of date (no per-category market-data config). Restart the API server to
              load the latest build.
            </p>
          )}

          {md && md.categories && md.category_meta && (
            <div className="space-y-3">
              {/* ── Equity category ── */}
              <div className="rounded border border-term-border/60 bg-term-sunken/30 p-2.5">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-term-accent">
                  Equity (spot)
                </div>
                <div className="divide-y divide-term-border/50">
                  <Row label="Bars source">
                    <span className="rounded bg-term-border/40 px-1.5 py-0.5 font-mono text-[11px] text-term-text">
                      {md.categories.equity.bars_source}
                    </span>
                    <span className="text-[10px] text-term-muted">only provider today</span>
                  </Row>
                  <Row label="Realtime source">
                    {md.category_meta.equity.realtime_sources.map((s) => (
                      <Choice
                        key={s}
                        active={md.categories.equity.realtime_source === s}
                        onClick={() => patchEquity({ realtime_source: s })}
                      >
                        {s === "alpaca" ? "Alpaca" : "Off"}
                      </Choice>
                    ))}
                    <button
                      onClick={testEquity}
                      disabled={mdBusy || md.categories.equity.realtime_source !== "alpaca"}
                      title="Probe Alpaca market data with the entered (or saved) API key"
                      className="shrink-0 rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:border-term-accent hover:text-term-accent disabled:opacity-50"
                    >
                      Test
                    </button>
                  </Row>
                  <Row label="Realtime feed">
                    {md.category_meta.equity.feeds.map((f) => (
                      <Choice
                        key={f}
                        active={md.categories.equity.realtime_feed === f}
                        disabled={md.categories.equity.realtime_source !== "alpaca"}
                        onClick={() => patchEquity({ realtime_feed: f })}
                      >
                        {f.toUpperCase()}
                      </Choice>
                    ))}
                  </Row>
                  {md.category_meta.equity.depth_sources && (
                    <Row label="Order-book depth">
                      <select
                        value={md.categories.equity.depth_source}
                        onChange={(e) => patchEquity({ depth_source: e.target.value })}
                        className={cx(llmInputCls, "min-w-[140px]")}
                        title="Order-book (L2) depth source"
                      >
                        {md.category_meta.equity.depth_sources.map((s) => (
                          <option key={s} value={s}>
                            {depthOptionLabel("equity", s)}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => testDepth("equity", md.categories.equity.depth_source)}
                        disabled={mdBusy || md.categories.equity.depth_source === "none"}
                        title="Probe the order-book depth source for the default symbol"
                        className="shrink-0 rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:border-term-accent hover:text-term-accent disabled:opacity-50"
                      >
                        Test
                      </button>
                    </Row>
                  )}
                  <Row label="Intraday cache TTL (s)">
                    <input
                      type="number"
                      min={5}
                      max={600}
                      step={5}
                      value={md.categories.equity.intraday_ttl}
                      onChange={(e) => patchEquity({ intraday_ttl: clampNum(Number(e.target.value), 5, 600) })}
                      className={cx(numCls, "w-16")}
                      aria-label="Equity intraday cache TTL seconds"
                    />
                  </Row>
                  <Row label="Daily history (years)">
                    <input
                      type="number"
                      min={1}
                      max={30}
                      step={1}
                      value={md.categories.equity.history_years}
                      onChange={(e) => patchEquity({ history_years: clampNum(Number(e.target.value), 1, 30) })}
                      className={cx(numCls, "w-16")}
                      aria-label="Equity default daily history years"
                    />
                  </Row>
                  <Row label="Default symbol">
                    <input
                      value={md.categories.equity.default_symbol}
                      onChange={(e) => patchEquity({ default_symbol: e.target.value.toUpperCase() })}
                      className={cx(llmInputCls, "max-w-[120px]")}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Equity default symbol"
                    />
                  </Row>
                </div>
              </div>

              {/* ── Crypto category ── */}
              <div className="rounded border border-term-border/60 bg-term-sunken/30 p-2.5">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-term-accent">
                  Crypto (spot)
                </div>
                <div className="divide-y divide-term-border/50">
                  <Row label="Exchange (bars + realtime)">
                    <select
                      value={md.categories.crypto.source}
                      onChange={(e) => patchCrypto({ source: e.target.value })}
                      className={cx(llmInputCls, "min-w-[140px]")}
                      title="ccxt exchange for crypto bars + realtime"
                    >
                      {md.category_meta.crypto.sources.map((ex) => (
                        <option key={ex} value={ex}>
                          {ex}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={testExchange}
                      disabled={mdBusy}
                      title="Probe this exchange's markets"
                      className="shrink-0 rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:border-term-accent hover:text-term-accent disabled:opacity-50"
                    >
                      Test
                    </button>
                  </Row>
                  <Row label="Realtime">
                    <Choice active={md.categories.crypto.realtime} onClick={() => patchCrypto({ realtime: true })}>
                      On
                    </Choice>
                    <Choice active={!md.categories.crypto.realtime} onClick={() => patchCrypto({ realtime: false })}>
                      Off
                    </Choice>
                    <span className="text-[10px] text-term-muted">off keeps charts</span>
                  </Row>
                  {md.category_meta.crypto.depth_sources && (
                    <Row label="Order-book depth">
                      <select
                        value={md.categories.crypto.depth_source}
                        onChange={(e) => patchCrypto({ depth_source: e.target.value })}
                        className={cx(llmInputCls, "min-w-[140px]")}
                        title="Order-book (L2) depth source"
                      >
                        {md.category_meta.crypto.depth_sources.map((s) => (
                          <option key={s} value={s}>
                            {depthOptionLabel("crypto", s)}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => testDepth("crypto", md.categories.crypto.depth_source)}
                        disabled={mdBusy || md.categories.crypto.depth_source === "none"}
                        title="Probe the crypto order-book depth source"
                        className="shrink-0 rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:border-term-accent hover:text-term-accent disabled:opacity-50"
                      >
                        Test
                      </button>
                    </Row>
                  )}
                  <Row label="Intraday cache TTL (s)">
                    <input
                      type="number"
                      min={5}
                      max={600}
                      step={5}
                      value={md.categories.crypto.intraday_ttl}
                      onChange={(e) => patchCrypto({ intraday_ttl: clampNum(Number(e.target.value), 5, 600) })}
                      className={cx(numCls, "w-16")}
                      aria-label="Crypto intraday cache TTL seconds"
                    />
                  </Row>
                  <Row label="Daily history (years)">
                    <input
                      type="number"
                      min={1}
                      max={30}
                      step={1}
                      value={md.categories.crypto.history_years}
                      onChange={(e) => patchCrypto({ history_years: clampNum(Number(e.target.value), 1, 30) })}
                      className={cx(numCls, "w-16")}
                      aria-label="Crypto default daily history years"
                    />
                  </Row>
                  <Row label="Default symbol">
                    <input
                      value={md.categories.crypto.default_symbol}
                      onChange={(e) => patchCrypto({ default_symbol: e.target.value.toUpperCase() })}
                      className={cx(llmInputCls, "max-w-[120px]")}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Crypto default symbol"
                    />
                  </Row>
                </div>
              </div>

              {/* ── FICC categories (rates futures / spot FX / commodity futures) ── */}
              {FICC_MD.map(({ key, label }) => {
                const cat = md.categories[key];
                if (!cat) return null;
                return (
                  <div key={key} className="rounded border border-term-border/60 bg-term-sunken/30 p-2.5">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-term-accent">
                      {label}
                      <span className="ml-1.5 font-normal normal-case tracking-normal text-term-muted">
                        · yfinance bars
                      </span>
                    </div>
                    <div className="divide-y divide-term-border/50">
                      {md.category_meta[key]?.depth_sources && (
                        <Row label="Order-book depth">
                          <select
                            value={cat.depth_source}
                            onChange={(e) => patchFicc(key, { depth_source: e.target.value })}
                            className={cx(llmInputCls, "min-w-[140px]")}
                            title="Order-book (L2) depth source"
                          >
                            {md.category_meta[key].depth_sources.map((s) => (
                              <option key={s} value={s}>
                                {depthOptionLabel(key, s)}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => testDepth(key, cat.depth_source)}
                            disabled={mdBusy || cat.depth_source === "none"}
                            title="Probe the order-book depth source for the default symbol"
                            className="shrink-0 rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:border-term-accent hover:text-term-accent disabled:opacity-50"
                          >
                            Test
                          </button>
                          {depthHint(key, cat.depth_source) && (
                            <span className="text-[10px] text-term-muted" title="This vendor's depth instrument differs from the spot/futures label above">
                              {depthHint(key, cat.depth_source)}
                            </span>
                          )}
                        </Row>
                      )}
                      <Row label="Intraday cache TTL (s)">
                        <input
                          type="number"
                          min={5}
                          max={600}
                          step={5}
                          value={cat.intraday_ttl}
                          onChange={(e) => patchFicc(key, { intraday_ttl: clampNum(Number(e.target.value), 5, 600) })}
                          className={cx(numCls, "w-16")}
                          aria-label={`${label} intraday cache TTL seconds`}
                        />
                      </Row>
                      <Row label="Daily history (years)">
                        <input
                          type="number"
                          min={1}
                          max={30}
                          step={1}
                          value={cat.history_years}
                          onChange={(e) => patchFicc(key, { history_years: clampNum(Number(e.target.value), 1, 30) })}
                          className={cx(numCls, "w-16")}
                          aria-label={`${label} default daily history years`}
                        />
                      </Row>
                      <Row label="Default symbol">
                        <input
                          value={cat.default_symbol}
                          onChange={(e) => patchFicc(key, { default_symbol: e.target.value.toUpperCase() })}
                          className={cx(llmInputCls, "max-w-[120px]")}
                          spellCheck={false}
                          autoComplete="off"
                          aria-label={`${label} default symbol`}
                        />
                      </Row>
                    </div>
                  </div>
                );
              })}

              {/* ── Options (standalone chain subsystem — a chain source + knobs) ── */}
              {md.categories.options && md.category_meta.options && (
                <div className="rounded border border-term-border/60 bg-term-sunken/30 p-2.5">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-term-accent">
                    Options
                    <span className="ml-1.5 font-normal normal-case tracking-normal text-term-muted">· chains</span>
                  </div>
                  <div className="divide-y divide-term-border/50">
                    <Row label="Chain source">
                      <select
                        value={md.categories.options.source}
                        onChange={(e) => patchOptions({ source: e.target.value })}
                        className={cx(llmInputCls, "min-w-[160px]")}
                        title="Options-chain data source"
                      >
                        {md.category_meta.options.sources.map((s) => (
                          <option key={s} value={s}>
                            {optionsSourceLabel(s)}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() =>
                          testOptions(
                            md.categories.options?.source ?? "",
                            md.categories.options?.default_underlying ?? "",
                          )
                        }
                        disabled={mdBusy || md.categories.options.source === "none"}
                        title="Probe the options-chain source for the default underlying"
                        className="shrink-0 rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:border-term-accent hover:text-term-accent disabled:opacity-50"
                      >
                        Test
                      </button>
                    </Row>
                    {optionsCapNote(md.category_meta.options.capabilities[md.categories.options.source]) && (
                      <Row label="Provides">
                        <span className="text-[10px] text-term-muted">
                          {optionsCapNote(md.category_meta.options.capabilities[md.categories.options.source])}
                        </span>
                      </Row>
                    )}
                    <Row label="Default underlying">
                      <input
                        value={md.categories.options.default_underlying}
                        onChange={(e) => patchOptions({ default_underlying: e.target.value.toUpperCase() })}
                        className={cx(llmInputCls, "max-w-[120px]")}
                        spellCheck={false}
                        autoComplete="off"
                        aria-label="Options default underlying"
                      />
                    </Row>
                    <Row label="Expiries window (days)">
                      <input
                        type="number"
                        min={7}
                        max={365}
                        step={1}
                        value={md.categories.options.expiry_window}
                        onChange={(e) => patchOptions({ expiry_window: clampNum(Number(e.target.value), 7, 365) })}
                        className={cx(numCls, "w-16")}
                        aria-label="Options expiries window days"
                      />
                    </Row>
                    <Row label="Chain cache TTL (s)">
                      <input
                        type="number"
                        min={5}
                        max={600}
                        step={5}
                        value={md.categories.options.chain_ttl}
                        onChange={(e) => patchOptions({ chain_ttl: clampNum(Number(e.target.value), 5, 600) })}
                        className={cx(numCls, "w-16")}
                        aria-label="Options chain cache TTL seconds"
                      />
                    </Row>
                  </div>
                </div>
              )}

              <p className="text-[10px] leading-relaxed text-term-muted">
                Default symbols seed the channel tickers on first launch; they don't override a symbol
                you've already changed in a channel. Rates/FX/commodities use yfinance bars (no exchange
                or realtime tape) — the history window also sets how far back the auto data-refresh pulls
                their bars. Order-book depth for them comes from the selected depth source (Simulated by
                default — a modelled book around the real mid).
              </p>
            </div>
          )}

          {/* Alpaca credentials — paper broker today; reserved for an Alpaca data provider */}
          {md && (
            <div className="mt-3 border-t border-term-border pt-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-term-text">Alpaca credentials</span>
                <div className="flex items-center gap-1.5">
                  <span
                    className={cx(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium",
                      md.has_alpaca_key ? "bg-term-up/15 text-term-up" : "bg-term-border/40 text-term-muted",
                    )}
                  >
                    {md.has_alpaca_key ? "✓ key saved" : "no key saved"}
                  </span>
                  {md.has_alpaca_key && (
                    <button
                      onClick={removeAlpaca}
                      disabled={mdBusy}
                      title="Delete the saved Alpaca credentials from the server"
                      className="focus-ring shrink-0 rounded border border-term-down/50 px-2 py-0.5 text-[10px] text-term-down hover:bg-term-down/10 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
              <p className="mb-2 text-[10px] leading-relaxed text-term-muted">
                Used to route paper trades to Alpaca's hosted paper environment (otherwise a local
                simulator runs). Equity <b>bars stay on yfinance</b> — these keys are the hook for a
                future Alpaca market-data provider. The saved key is never shown again (only the dots);
                for security it's stored encrypted on the server.
              </p>
              <div className="space-y-1.5">
                <div className="relative">
                  <input
                    type={showMdKey ? "text" : "password"}
                    value={mdKey}
                    onChange={(e) => setMdKey(e.target.value)}
                    placeholder={md.has_alpaca_key ? "API key — •••• saved (blank keeps it)" : "Alpaca API key"}
                    className={cx(llmInputCls, "pr-12")}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowMdKey((v) => !v)}
                    disabled={!mdKey}
                    title={showMdKey ? "Mask the API key" : "Reveal the API key"}
                    aria-label={showMdKey ? "Mask the API key" : "Reveal the API key"}
                    aria-pressed={showMdKey}
                    className="absolute inset-y-0 right-1.5 my-auto h-fit rounded px-1 text-[10px] uppercase tracking-wide text-term-muted hover:text-term-text disabled:opacity-30"
                  >
                    {showMdKey ? "Hide" : "Show"}
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showMdSecret ? "text" : "password"}
                    value={mdSecret}
                    onChange={(e) => setMdSecret(e.target.value)}
                    placeholder={md.has_alpaca_key ? "API secret — •••• saved (blank keeps it)" : "Alpaca API secret"}
                    className={cx(llmInputCls, "pr-12")}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowMdSecret((v) => !v)}
                    disabled={!mdSecret}
                    title={showMdSecret ? "Mask the API secret" : "Reveal the API secret"}
                    aria-label={showMdSecret ? "Mask the API secret" : "Reveal the API secret"}
                    aria-pressed={showMdSecret}
                    className="absolute inset-y-0 right-1.5 my-auto h-fit rounded px-1 text-[10px] uppercase tracking-wide text-term-muted hover:text-term-text disabled:opacity-30"
                  >
                    {showMdSecret ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              {(mdKey || mdSecret) && (
                <p className="mt-1 text-[10px] font-medium text-term-accent">
                  ● Unsaved — click <b>Save</b> below to store these. <b>Test</b> only probes; it doesn't save.
                </p>
              )}
              <Row label="Environment">
                <Choice active={md.alpaca_paper} onClick={() => setMd({ ...md, alpaca_paper: true })}>
                  Paper
                </Choice>
                <Choice active={!md.alpaca_paper} onClick={() => setMd({ ...md, alpaca_paper: false })}>
                  Live
                </Choice>
              </Row>
              <p className="mt-1 text-[10px] leading-relaxed text-term-muted">
                Real-time equity ticker + time-&-sales (Market Board, Watchlist, Time&nbsp;&amp;&nbsp;Sales)
                stream from Alpaca when the <b>Equity → Realtime source</b> is Alpaca and keys are set.
                The <b>IEX</b>/<b>SIP</b> feed is chosen in the Equity category above. Alpaca has no equity
                L2, so order-book depth for equities/rates/FX/commodities comes from the per-class
                <b>Order-book depth</b> source (Simulated by default); crypto uses its real exchange L2.
              </p>
            </div>
          )}

          {/* read-only status */}
          {md && (
            <div className="mt-3 border-t border-term-border pt-3">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-term-muted">Status</div>
              <dl className="space-y-1 text-[10px]">
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-term-muted">Cache dir</dt>
                  <dd className="truncate text-right font-mono text-term-text" title={md.data_dir}>{md.data_dir}</dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-term-muted">qhfi lake</dt>
                  <dd className="truncate text-right font-mono text-term-text" title={md.lake_dir}>{md.lake_dir}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-term-muted">Cached symbols</dt>
                  <dd className="tabular-nums text-term-text">{md.cached_symbols}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-term-muted">Realtime</dt>
                  <dd className="text-term-text">
                    {md.realtime.topics.length} topic(s)
                    {md.realtime.exchanges.length ? ` · ${md.realtime.exchanges.join(", ")}` : ""}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          <div className="mt-3 flex items-center gap-1.5">
            <button
              onClick={saveMarketData}
              disabled={mdBusy || !md}
              className="rounded border border-term-accent bg-term-accent/10 px-2.5 py-1 text-xs text-term-accent hover:bg-term-accent/20 disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={clearMarketCache}
              disabled={mdBusy}
              title="Drop the intraday cache + rebuild the data manager"
              className="rounded border border-term-border px-2.5 py-1 text-xs text-term-muted hover:text-term-text disabled:opacity-50"
            >
              Clear cache
            </button>
          </div>

          {(mdBusy || mdMsg) && (
            <div
              className={cx(
                "mt-1.5 truncate text-[10px]",
                mdBusy ? "text-term-muted" : mdMsg?.ok ? "text-term-up" : "text-term-down",
              )}
              title={mdMsg?.detail}
            >
              {mdBusy ? "Working…" : `${mdMsg?.ok ? "✓" : "✕"} ${mdMsg?.detail}`}
            </div>
          )}
        </div>
            )}

            {/* ── Linked qhfi directories ── */}
            {section === "mcp" && (
            <div>
          <div className="mb-1.5 text-xs font-semibold text-term-text">External MCP servers</div>
          <p className="mb-2 text-[10px] leading-relaxed text-term-muted">
            Register Model Context Protocol servers and the grounded assistant can call their tools
            mid-answer (namespaced <span className="font-mono">mcp:server:tool</span>). A down or
            misconfigured server is simply skipped. <span className="font-mono">stdio</span> spawns a
            local command; <span className="font-mono">http</span> connects to a streamable-HTTP URL.
          </p>

          {mcp && mcp.length > 0 && (
            <div className="space-y-2">
              {mcp.map((srv, i) => (
                <div key={i} className="rounded border border-term-border bg-term-sunken/40 p-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={srv.enabled}
                      onChange={() => patchServer(i, { enabled: !srv.enabled })}
                      className="accent-term-accent"
                      title="Enabled"
                    />
                    <input
                      value={srv.name}
                      onChange={(e) => patchServer(i, { name: e.target.value })}
                      placeholder="name"
                      className={cx(topicInputCls, "flex-1")}
                      spellCheck={false}
                    />
                    <Choice active={srv.transport === "stdio"} onClick={() => patchServer(i, { transport: "stdio" })}>
                      stdio
                    </Choice>
                    <Choice active={srv.transport === "http"} onClick={() => patchServer(i, { transport: "http" })}>
                      http
                    </Choice>
                    <button
                      onClick={() => testServer(srv)}
                      disabled={mcpBusy}
                      className="rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:text-term-text disabled:opacity-50"
                    >
                      Test
                    </button>
                    <button
                      onClick={() => removeServer(i)}
                      className="shrink-0 px-1 text-term-muted hover:text-term-down"
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                  {srv.transport === "stdio" ? (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <input
                        value={srv.command ?? ""}
                        onChange={(e) => patchServer(i, { command: e.target.value })}
                        placeholder="command (e.g. npx, python)"
                        className={cx(topicInputCls, "flex-1")}
                        spellCheck={false}
                      />
                      <input
                        value={(srv.args ?? []).join(" ")}
                        onChange={(e) => patchServer(i, { args: e.target.value.split(/\s+/).filter(Boolean) })}
                        placeholder="args (space-separated)"
                        className={cx(topicInputCls, "flex-1")}
                        spellCheck={false}
                      />
                    </div>
                  ) : (
                    <div className="mt-1.5">
                      <input
                        value={srv.url ?? ""}
                        onChange={(e) => patchServer(i, { url: e.target.value })}
                        placeholder="https://host/mcp"
                        className={llmInputCls}
                        spellCheck={false}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-2 flex items-center gap-1.5">
            <button
              onClick={addServer}
              className="rounded border border-term-border px-2.5 py-1 text-xs text-term-muted hover:text-term-text"
            >
              + Add server
            </button>
            <button
              onClick={saveMcp}
              disabled={mcpBusy || !mcp}
              className="rounded border border-term-accent bg-term-accent/10 px-2.5 py-1 text-xs text-term-accent hover:bg-term-accent/20 disabled:opacity-50"
            >
              Save
            </button>
          </div>

          {(mcpBusy || mcpMsg) && (
            <div
              className={cx(
                "mt-1.5 text-[10px]",
                mcpBusy ? "text-term-muted" : mcpMsg?.ok ? "text-term-up" : "text-term-down",
              )}
              title={mcpMsg?.detail}
            >
              {mcpBusy ? "Working…" : `${mcpMsg?.ok ? "✓" : "✕"} ${mcpMsg?.detail}`}
            </div>
          )}
            </div>
            )}

            {section === "data" && (
            <div>
          <div className="mb-1.5 text-xs font-semibold text-term-text">Linked qhfi directories</div>
          <p className="mb-2 text-[10px] leading-relaxed text-term-muted">
            Where the Factor, Strategy and Model-Repository widgets read from. Point factors/strategies
            at a folder of qhfi-style <span className="font-mono">.py</span> modules (imported so their
            <span className="font-mono"> @register</span> classes become listable + runnable); point models
            at a qhfi <span className="font-mono">ModelRepository</span> root (versioned cards).
          </p>

          <div className="space-y-2">
            {(
              [
                ["factors_dir", "Factors", pathCounts ? `${pathCounts.factors} in registry` : ""],
                ["strategies_dir", "Strategies", pathCounts ? `${pathCounts.strategies} in registry` : ""],
                ["models_dir", "Model repository", pathCounts ? `${pathCounts.models} model(s)` : ""],
              ] as [keyof RegPaths, string, string][]
            ).map(([key, label, hint]) => (
              <label key={key} className="block">
                <span className="mb-0.5 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-term-muted">{label}</span>
                  {hint && <span className="text-[9px] text-term-accent">{hint}</span>}
                </span>
                <input
                  value={paths?.[key] ?? ""}
                  onChange={(e) => paths && setPaths({ ...paths, [key]: e.target.value })}
                  placeholder={`Absolute path to ${label.toLowerCase()} directory`}
                  className={llmInputCls}
                  spellCheck={false}
                />
              </label>
            ))}
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <button
              onClick={savePaths}
              disabled={pathsBusy || !paths}
              className="rounded border border-term-accent bg-term-accent/10 px-2.5 py-1 text-xs text-term-accent hover:bg-term-accent/20 disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={loadPaths}
              disabled={pathsBusy}
              className="rounded border border-term-border px-2.5 py-1 text-xs text-term-muted hover:text-term-text disabled:opacity-50"
            >
              ↻ Rescan
            </button>
          </div>

          {(pathsBusy || pathsMsg) && (
            <div
              className={cx(
                "mt-1.5 truncate text-[10px]",
                pathsBusy ? "text-term-muted" : pathsMsg?.ok ? "text-term-up" : "text-term-down",
              )}
              title={pathsMsg?.detail}
            >
              {pathsBusy ? "Working…" : `${pathsMsg?.ok ? "✓" : "✕"} ${pathsMsg?.detail}`}
            </div>
          )}

          <div className="my-3 border-t border-term-border" />
          <KnowledgeDirSetting inputCls={llmInputCls} />
            </div>
            )}

            {section === "dataRefresh" && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-semibold text-term-text">Automatic data refresh</span>
                {dr && (
                  <span className="flex items-center gap-1.5">
                    <span className="text-[10px] text-term-muted">All auto-refresh</span>
                    <Choice active={dr.master_enabled} onClick={() => applyDr({ master_enabled: true })}>On</Choice>
                    <Choice active={!dr.master_enabled} onClick={() => applyDr({ master_enabled: false })}>Off</Choice>
                  </span>
                )}
              </div>
              <p className="mb-3 text-[10px] leading-relaxed text-term-muted">
                Keeps the data lake current in the background for your active symbols (watchlist +
                holdings + algo universes). Each category runs on its own schedule — market data and
                news refresh frequently, the slower domains less often. Fundamentals are fetched live
                on demand (no schedule).
              </p>

              {!dr && <div className="text-[10px] text-term-muted">Loading…</div>}

              {dr && (
                <>
                  <div className="mb-3 flex items-center justify-between rounded border border-term-border/60 bg-term-sunken/30 px-2.5 py-2">
                    <span className="text-[11px] text-term-muted">
                      Active set:{" "}
                      {Object.entries(dr.active_by_asset ?? {}).filter(([, n]) => n > 0).length === 0
                        ? <span className="text-term-text">empty</span>
                        : Object.entries(dr.active_by_asset)
                            .filter(([, n]) => n > 0)
                            .map(([a, n], i) => (
                              <span key={a}>
                                {i > 0 ? " · " : ""}
                                <span className="text-term-text">{n}</span> {a}
                              </span>
                            ))}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-[10px] text-term-muted" title="Skip equity refresh outside US market hours (crypto always runs)">
                        Market hours only
                      </span>
                      <Choice active={dr.market_hours_only} onClick={() => applyDr({ market_hours_only: true })}>On</Choice>
                      <Choice active={!dr.market_hours_only} onClick={() => applyDr({ market_hours_only: false })}>Off</Choice>
                    </span>
                  </div>

                  <div className="space-y-2">
                    {Object.entries(dr.jobs).map(([name, job]) => (
                      <div key={name} className="rounded border border-term-border/60 bg-term-sunken/30 p-2.5">
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="text-[11px] font-semibold text-term-text">
                            {job.label}
                            {job.running && <span className="ml-1.5 text-[9px] text-term-accent">● running</span>}
                          </span>
                          <span className="flex items-center gap-1.5">
                            <Choice active={job.enabled} onClick={() => applyDr({ jobs: { [name]: { enabled: true } } })}>On</Choice>
                            <Choice active={!job.enabled} onClick={() => applyDr({ jobs: { [name]: { enabled: false } } })}>Off</Choice>
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="flex items-center gap-1.5 text-[10px] text-term-muted">
                            Every
                            <input
                              type="number"
                              min={2}
                              step={1}
                              value={Math.round(job.interval_minutes)}
                              onChange={(e) =>
                                setDr((d) =>
                                  d
                                    ? { ...d, jobs: { ...d.jobs, [name]: { ...d.jobs[name], interval_minutes: clampNum(Number(e.target.value), 2, 10080) } } }
                                    : d,
                                )
                              }
                              onBlur={(e) => applyDr({ jobs: { [name]: { interval_minutes: clampNum(Number(e.target.value), 2, 10080) } } })}
                              className={cx(numCls, "w-16")}
                              aria-label={`${job.label} interval minutes`}
                            />
                            min
                          </span>
                          <span className="flex items-center gap-2 text-[10px] text-term-muted">
                            <span title={job.last_run ?? "never"}>last {relTime(job.last_run)}</span>
                            {job.enabled && job.last_run && <span title={job.next_run ?? ""}>· next {relTime(job.next_run)}</span>}
                            <button
                              onClick={() => runDr(name)}
                              disabled={drBusy || job.running}
                              className="rounded border border-term-accent/70 px-2 py-0.5 text-[10px] text-term-accent hover:bg-term-accent/15 disabled:opacity-40"
                            >
                              Run now
                            </button>
                          </span>
                        </div>
                        {job.last_result?.status === "error" && (
                          <div className="mt-1 truncate text-[9px] text-term-down" title={String(job.last_result.error ?? "")}>
                            ✕ {String(job.last_result.error ?? "error")}
                          </div>
                        )}
                        {job.last_result?.status === "ok" && (
                          <div className="mt-1 truncate text-[9px] text-term-muted">
                            {Object.entries(job.last_result)
                              .filter(([k]) => !["ts", "status", "duration_s"].includes(k))
                              .map(([k, v]) => `${k}=${String(v)}`)
                              .join(" · ")}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <p className="mt-3 text-[9px] leading-relaxed text-term-muted">
                    News is fetched live and cached on demand — this keeps the cache warm. SEC filings
                    need a configured SEC_USER_AGENT and are off by default. Rates/macro pull from FRED
                    (with fallbacks) and may be unavailable on restricted networks.
                  </p>
                </>
              )}

              {(drBusy || drMsg) && (
                <div
                  className={cx("mt-2 truncate text-[10px]", drBusy ? "text-term-muted" : drMsg?.ok ? "text-term-up" : "text-term-down")}
                  title={drMsg?.detail}
                >
                  {drBusy ? "Working…" : `${drMsg?.ok ? "✓" : "✕"} ${drMsg?.detail}`}
                </div>
              )}
            </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** AI agent knowledge base directory — where the Committees module saves agents' RAG files, laid
 * out as Directory → Committee → Agent. Lives in the CrewAI service's filesystem (a WSL path). */
function KnowledgeDirSetting({ inputCls }: { inputCls: string }) {
  const [dir, setDir] = useState("");
  const [def, setDef] = useState("");
  const [supported, setSupported] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; detail: string } | null>(null);

  const load = () =>
    api
      .committeeKnowledgeDir()
      .then((r) => {
        setDir(r.dir);
        setDef(r.default);
        setSupported(r.supported);
      })
      .catch((e) => setMsg({ ok: false, detail: e?.message ?? "crewai-service unreachable" }));
  useEffect(() => {
    load();
  }, []);

  const save = async (value: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.setCommitteeKnowledgeDir(value);
      setDir(r.dir);
      setMsg({ ok: true, detail: `Saved · ${r.dir}` });
    } catch (e) {
      setMsg({ ok: false, detail: (e as Error)?.message ?? "failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-term-text">AI agent knowledge base</div>
      <p className="mb-2 text-[10px] leading-relaxed text-term-muted">
        Where the Committees module saves each agent's RAG files, laid out as{" "}
        <span className="font-mono">Directory → Committee → Agent</span>. This folder is on the AI
        service's filesystem (a WSL path, e.g. <span className="font-mono">/root/crewai/knowledge</span>{" "}
        or <span className="font-mono">/mnt/c/Users/you/kb</span>). Supported files:{" "}
        <span className="font-mono">{(supported.length ? supported : [".txt", ".md", ".pdf", ".csv"]).join(" ")}</span>.
      </p>
      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-term-muted">Directory</span>
        <input
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          placeholder={def || "/root/crewai/knowledge"}
          className={inputCls}
          spellCheck={false}
        />
      </label>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={() => save(dir)}
          disabled={busy}
          className="rounded border border-term-accent bg-term-accent/10 px-2.5 py-1 text-xs text-term-accent hover:bg-term-accent/20 disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={() => save("")}
          disabled={busy}
          className="rounded border border-term-border px-2.5 py-1 text-xs text-term-muted hover:text-term-text disabled:opacity-50"
          title={def}
        >
          Use default
        </button>
      </div>
      {(busy || msg) && (
        <div
          className={cx(
            "mt-1.5 truncate text-[10px]",
            busy ? "text-term-muted" : msg?.ok ? "text-term-up" : "text-term-down",
          )}
          title={msg?.detail}
        >
          {busy ? "Working…" : `${msg?.ok ? "✓" : "✕"} ${msg?.detail}`}
        </div>
      )}
    </div>
  );
}

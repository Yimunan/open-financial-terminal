/** Singleton client for the multiplexed realtime socket (/api/ws/stream).
 *
 * Widgets call `subscribeStream(topic, cb)` and get back an unsubscribe function.
 * Topics are ref-counted client-side: the first listener sends `sub`, the last sends
 * `unsub`. On reconnect every active topic is re-subscribed, so widgets never notice
 * a dropped socket. The server already coalesces to ~150ms, so callbacks render directly.
 */

import type { StreamFrame } from "../api/types";

type Listener = (frame: StreamFrame) => void;

const listeners = new Map<string, Set<Listener>>();
let socket: WebSocket | null = null;
let retryDelay = 1000;

function url(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/ws/stream`;
}

function ensureSocket(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  socket = new WebSocket(url());
  socket.onopen = () => {
    retryDelay = 1000;
    for (const topic of listeners.keys()) {
      socket?.send(JSON.stringify({ op: "sub", topic }));
    }
  };
  socket.onmessage = (e) => {
    const frame = JSON.parse(e.data) as StreamFrame;
    listeners.get(frame.topic)?.forEach((cb) => cb(frame));
  };
  socket.onclose = () => {
    socket = null;
    if (listeners.size > 0) {
      setTimeout(ensureSocket, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    }
  };
  socket.onerror = () => socket?.close();
}

function sendOp(op: "sub" | "unsub", topic: string): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ op, topic }));
  }
}

export function subscribeStream(topic: string, cb: Listener): () => void {
  let set = listeners.get(topic);
  if (!set) {
    set = new Set();
    listeners.set(topic, set);
    ensureSocket();
    sendOp("sub", topic); // no-op if still connecting; onopen replays all topics
  }
  set.add(cb);

  return () => {
    const cur = listeners.get(topic);
    if (!cur) return;
    cur.delete(cb);
    if (cur.size === 0) {
      listeners.delete(topic);
      sendOp("unsub", topic);
    }
  };
}

/** The exchange realtime topics target. Mirrors the backend's configured crypto exchange
 * (Settings → Market Data → else OFT_CRYPTO_EXCHANGE, default kraken — reachable from
 * geo-restricted IPs where binance returns 451). Seeded on app startup and updated when the
 * Market Data setting is saved, so live widgets repoint without a reload.
 */
let streamExchange = "kraken";

/** Point realtime topics at a new exchange (call after loading/saving the Market Data setting). */
export function setStreamExchange(exchange: string): void {
  if (exchange) streamExchange = exchange;
}

/** Topic builders matching the backend's kind:exchange:symbol scheme. */
export const topics = {
  ticker: (symbol: string, exchange = streamExchange) => `ticker:${exchange}:${symbol}`,
  book: (symbol: string, exchange = streamExchange) => `book:${exchange}:${symbol}`,
  trades: (symbol: string, exchange = streamExchange) => `trades:${exchange}:${symbol}`,
};

/** Source token for equity realtime topics (matches the backend's EQUITY_SOURCE). */
export const EQUITY_STREAM_SOURCE = "alpaca";

/** Equity realtime topics (Alpaca). Only ticker + trades — no L2 depth (`book`) for equities.
 * Whether to subscribe is gated by `useEquityStreamEnabled()` (driven by /api/health). */
export const equityTopics = {
  ticker: (symbol: string) => `ticker:${EQUITY_STREAM_SOURCE}:${symbol}`,
  trades: (symbol: string) => `trades:${EQUITY_STREAM_SOURCE}:${symbol}`,
};

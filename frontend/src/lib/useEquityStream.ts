import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

/** Whether equity real-time streaming is available (backend has Alpaca credentials).
 *
 * Reads the shared `["health"]` query (already polled by App), so widgets reactively switch between
 * the Alpaca live stream and interval polling when credentials are added/removed. When false, equity
 * widgets keep their existing polled/EOD behaviour.
 */
export function useEquityStreamEnabled(): boolean {
  const { data } = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 30_000 });
  return !!data?.equity_stream?.enabled;
}

/** Whether crypto real-time streaming is on (Settings → Market Data → Crypto → Realtime). When off,
 * crypto widgets fall back to polling — bars/charts keep working. Reads the shared health query. */
export function useCryptoStreamEnabled(): boolean {
  const { data } = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 30_000 });
  return data?.crypto_stream?.enabled ?? true; // default on until health loads
}

import { useEffect, useRef, useState } from "react";
import type { TradeFrame } from "../api/types";
import { cx, fmtCompact, fmtPrice, fmtQty, fmtTime } from "../lib/format";
import { useT } from "../lib/i18n";
import { equityTopics, subscribeStream, topics } from "../lib/wsClient";
import { useCryptoStreamEnabled, useEquityStreamEnabled } from "../lib/useEquityStream";
import type { WidgetProps } from "../workspace/widgetRegistry";
import { WidgetShell, useWidgetSymbol } from "./shell";
import { EmptyState } from "../components/States";

const MAX_ROWS = 150;
const WHALE_NOTIONAL = 100_000; // USD-ish; prints above this glow

interface Print extends TradeFrame {
  id: number;
}

export default function TimeSalesWidget(props: WidgetProps) {
  const { symbol, asset, channel, setChannel } = useWidgetSymbol(props);
  const t = useT();
  const equityStream = useEquityStreamEnabled();
  const cryptoStream = useCryptoStreamEnabled();
  const streamed = (asset === "crypto" && cryptoStream) || (asset === "equity" && equityStream);
  const [prints, setPrints] = useState<Print[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    if (!streamed) return;
    setPrints([]);
    const topic = asset === "crypto" ? topics.trades(symbol) : equityTopics.trades(symbol);
    return subscribeStream(topic, (frame) => {
      if (frame.type !== "trades") return;
      setPrints((cur) => {
        const next = frame.data.map((t) => ({ ...t, id: ++seq.current }));
        return [...next.reverse(), ...cur].slice(0, MAX_ROWS);
      });
    });
  }, [symbol, asset, streamed]);

  return (
    <WidgetShell
      channel={channel}
      onChannelChange={setChannel}
      badge={streamed ? "live" : "eod"}
      toolbar={<span className="font-mono text-sm font-bold">{symbol}</span>}
    >
      {!streamed ? (
        <EmptyState title={t("tape.cryptoOnly")} />
      ) : (
        <table className="w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 bg-term-panel">
            <tr className="border-b border-term-border text-[10px] uppercase tracking-wider text-term-muted">
              <th className="px-2 py-1 text-left font-medium">{t("common.time")}</th>
              <th className="px-2 py-1 text-right font-medium">{t("common.price")}</th>
              <th className="px-2 py-1 text-right font-medium">{t("common.size")}</th>
              <th className="px-2 py-1 text-right font-medium">{t("tape.notional")}</th>
            </tr>
          </thead>
          <tbody>
            {prints.length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-term-muted">
                  {t("tape.waiting", { x: symbol })}
                </td>
              </tr>
            )}
            {prints.map((p) => {
              const notional = (p.price ?? 0) * (p.amount ?? 0);
              const whale = notional >= WHALE_NOTIONAL;
              return (
                <tr key={p.id} className="border-b border-term-border/30">
                  <td className="px-2 py-0.5 text-term-muted">{fmtTime(p.ts)}</td>
                  <td
                    className={cx(
                      "px-2 py-0.5 text-right",
                      p.side === "buy" ? "text-term-up" : p.side === "sell" ? "text-term-down" : "text-term-text",
                      whale && "whale",
                    )}
                  >
                    {fmtPrice(p.price)}
                  </td>
                  <td className={cx("px-2 py-0.5 text-right text-term-muted", whale && "whale")}>
                    {fmtQty(p.amount)}
                  </td>
                  <td className={cx("px-2 py-0.5 text-right text-term-muted", whale && "whale")}>
                    {fmtCompact(notional)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </WidgetShell>
  );
}

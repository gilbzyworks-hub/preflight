"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { TokenScan } from "@shared/types.ts";
import type { GuardLine } from "@/lib/guardrails";
import { fmtPrice, fmtUsd } from "@/lib/format";
import { AsOf } from "./ui";
import { useScan } from "./ScanProvider";

const PREFIX = "I'm overriding: ";
const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
const localInput = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

const ICON: Record<GuardLine["state"], string> = { ok: "✓", triggered: "!", not_set: "–", off: "–" };

export default function LogTradeForm({ scan, onDone }: { scan: TokenScan; onDone: () => void }) {
  const { settings, bump } = useScan();
  const mint = scan.metrics.mint;
  const [kind, setKind] = useState<"paper" | "real">("paper");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");
  const [stop, setStop] = useState("");
  const [maxLoss, setMaxLoss] = useState("");
  const [amount, setAmount] = useState("");
  const [entryPrice, setEntryPrice] = useState(scan.metrics.priceUsd != null ? String(scan.metrics.priceUsd) : "");
  const [entryTime, setEntryTime] = useState(localInput());
  const [override, setOverride] = useState(PREFIX);
  const [lines, setLines] = useState<GuardLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase().from("trades").select("status,amount_usd,pnl_usd").eq("kind", "paper");
      const rows = data ?? [];
      const b =
        settings.paper.startingBalance +
        rows.filter((t) => t.status === "closed").reduce((a, t) => a + Number(t.pnl_usd ?? 0), 0) -
        rows.filter((t) => t.status === "open").reduce((a, t) => a + Number(t.amount_usd), 0);
      setBalance(b);
    })();
  }, [settings.paper.startingBalance]);

  // Paper size defaults to a % of the paper balance; real amounts are typed by hand.
  const [lastKind, setLastKind] = useState(kind);
  useEffect(() => {
    if (lastKind !== kind) { setAmount(""); setLastKind(kind); }
  }, [kind, lastKind]);
  useEffect(() => {
    if (kind === "paper" && balance != null && amount === "") setAmount(((balance * settings.paper.defaultSizePct) / 100).toFixed(2));
  }, [kind, balance, amount, settings.paper.defaultSizePct]);

  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await fetch(`/api/guardrails?mint=${mint}&kind=${kind}&size=${num(amount) || ""}`);
      if (r.ok) setLines((await r.json()).lines);
    }, 350);
    return () => clearTimeout(t);
  }, [mint, kind, amount]);

  const triggered = lines.filter((l) => l.state === "triggered");
  const blocked = kind === "paper" ? triggered.filter((l) => l.blocksPaper) : [];
  const needsFailOverride = triggered.some((l) => l.id === "requiredFail");
  const overrideOk = /^\s*I['’]m overriding:\s*.{3,}$/i.test(override);
  const missing = (() => {
    const m: string[] = [];
    if (!reason.trim()) m.push("reason");
    if (!(num(target) > 0)) m.push("target");
    if (!(num(stop) > 0)) m.push("stop");
    if (!(num(maxLoss) > 0)) m.push("max loss");
    if (!(num(amount) > 0)) m.push("amount");
    if (kind === "real") {
      if (!(num(entryPrice) > 0)) m.push("entry price");
      if (!entryTime) m.push("time");
    }
    if (kind === "paper" && needsFailOverride && !overrideOk) m.push("typed override");
    return m;
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        mint,
        symbol: scan.metrics.symbol,
        reason,
        target: num(target),
        stop: num(stop),
        maxLossUsd: num(maxLoss),
        amountUsd: num(amount),
        entryPrice: num(entryPrice),
        entryTime: entryTime ? new Date(entryTime).toISOString() : null,
        overrideText: override.trim() === PREFIX.trim() ? "" : override,
      }),
    });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) {
      setErr(j.error ?? "Could not log trade");
      if (j.lines) setLines(j.lines);
      return;
    }
    bump();
    const t = j.trade;
    setDone(
      kind === "paper"
        ? `Paper trade logged. Filled at ${fmtPrice(Number(t.entry_price))} (last scanned price plus ${settings.paper.slippagePct}% slippage, ${settings.paper.feePct}% fee).${t.tags.length ? ` Tags: ${t.tags.join(", ")}.` : ""}`
        : `Real trade recorded.${t.tags.length ? ` Tags: ${t.tags.join(", ")}.` : " Followed your rules."} Nothing was sent anywhere; place and manage the trade yourself in Fomo.`,
    );
  }

  if (done)
    return (
      <div className="panel p-4 text-sm" role="status">
        <p>{done}</p>
        <button className="btn btn-sm mt-3" onClick={onDone}>Close</button>
      </div>
    );

  return (
    <form onSubmit={submit} className="panel flex flex-col gap-4 p-4" aria-label="Log trade">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Log trade — {scan.metrics.symbol ?? "token"}</h3>
        <button type="button" className="btn btn-sm" onClick={onDone}>Cancel</button>
      </div>

      <div role="radiogroup" aria-label="Trade type" className="grid grid-cols-2 gap-1 rounded-md bg-bg p-1">
        {(["paper", "real"] as const).map((k) => (
          <button
            type="button"
            key={k}
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={`rounded px-3 py-2 text-sm ${kind === k ? "bg-raised text-ink" : "text-muted"}`}
          >
            {k === "paper" ? "Paper" : "Real (placed manually in Fomo)"}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">
        {kind === "paper"
          ? `Simulated. Fills at the last scanned price with ${settings.paper.slippagePct}% slippage and ${settings.paper.feePct}% fee each side. Paper balance available: ${balance == null ? "…" : "$" + balance.toFixed(2)}.`
          : "A record of a trade you placed yourself in Fomo. Preflight does not connect to Fomo or any wallet, and never blocks this entry."}
      </p>

      <div>
        <label className="label" htmlFor="reason">Reason for the trade</label>
        <textarea id="reason" className="field mt-1" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="target">Target price (USD)</label>
          <input id="target" className="field num mt-1" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="stop">Stop price (USD)</label>
          <input id="stop" className="field num mt-1" inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} required />
        </div>
        <div className="col-span-2 sm:col-span-1">
          <label className="label" htmlFor="ml">Max loss (USD)</label>
          <input id="ml" className="field num mt-1" inputMode="decimal" value={maxLoss} onChange={(e) => setMaxLoss(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="amt">{kind === "paper" ? `Size (USD, default ${settings.paper.defaultSizePct}%)` : "Amount (USD)"}</label>
          <input id="amt" className="field num mt-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
        {kind === "real" && (
          <>
            <div>
              <label className="label" htmlFor="ep">Entry price (USD)</label>
              <input id="ep" className="field num mt-1" inputMode="decimal" value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="et">Entry time</label>
              <input id="et" type="datetime-local" className="field mt-1" value={entryTime} onChange={(e) => setEntryTime(e.target.value)} required />
            </div>
          </>
        )}
      </div>
      {kind === "real" && (
        <p className="label">
          Suggested entry price is the last scanned price ({fmtPrice(scan.metrics.priceUsd)}), <AsOf at={scan.scannedAt} className="inline" />. Edit it to what you actually got.
        </p>
      )}

      <div>
        <h4 className="text-sm font-medium">Guardrails</h4>
        <ul className="mt-2 flex flex-col gap-1.5 text-sm">
          {lines.map((l) => (
            <li key={l.id} className="flex gap-2">
              <span aria-hidden className={`w-4 text-center ${l.state === "triggered" ? "text-warn" : "text-muted"}`}>{ICON[l.state]}</span>
              <span>
                <span className="font-medium">{l.label}:</span>{" "}
                <span className={l.state === "triggered" ? "text-warn" : "text-muted"}>
                  {l.state === "not_set" ? "Not set" : l.state === "off" ? "Off" : l.detail}
                </span>
                {l.state === "triggered" && (
                  <span className="label block">
                    {kind === "paper"
                      ? l.blocksPaper
                        ? "Blocked in paper trading."
                        : "Needs a typed override."
                      : `Will be recorded with the tag “${l.tag}”. Not blocked.`}
                  </span>
                )}
              </span>
            </li>
          ))}
          {!lines.length && <li className="text-muted">Checking…</li>}
        </ul>
      </div>

      {(needsFailOverride || (kind === "real" && triggered.length > 0)) && (
        <div>
          <label className="label" htmlFor="ov">
            {kind === "paper" ? "A required check failed. Type your override to continue" : "You are going ahead despite a guardrail. Optional note"}
          </label>
          <input id="ov" className="field mt-1" value={override} onChange={(e) => setOverride(e.target.value)} />
          <p className="label mt-1">Recorded with a “Rule override” tag.</p>
        </div>
      )}

      {err && <p className="text-sm text-warn" role="alert">! {err}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy || missing.length > 0 || blocked.length > 0}>
          {busy ? "Saving…" : kind === "paper" ? "Log paper trade" : "Record real trade"}
        </button>
        {blocked.length > 0 && <span className="text-sm text-warn">! Blocked: {blocked.map((b) => b.label).join(", ")}</span>}
        {!blocked.length && missing.length > 0 && <span className="label">Still needed: {missing.join(", ")}</span>}
      </div>
      <p className="label">FDV for reference: {fmtUsd(scan.metrics.fdv)}. This tool is decision-support only.</p>
    </form>
  );
}

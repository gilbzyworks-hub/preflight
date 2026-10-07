"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useScan } from "@/components/ScanProvider";
import { fmtPrice, short, stamp } from "@/lib/format";
import { ALL_TAGS } from "@/lib/guardrails";
import { supabase } from "@/lib/supabase/client";

interface Trade {
  id: string; kind: "paper" | "real"; mint: string; symbol: string | null; status: "open" | "closed"; reason: string;
  target: number; stop: number; max_loss_usd: number; amount_usd: number; entry_price: number; entry_time: string;
  tags: string[]; followed_rules: boolean; override_text: string | null; exit_price: number | null; exit_time: string | null;
  exit_reason: string | null; exit_note: string | null; pnl_usd: number | null; fees_usd: number;
}

const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const localInput = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const REASON: Record<string, string> = { stop: "Stop reached", target: "Target reached", max_loss: "Max loss reached", manual: "Manual exit" };

function ExitForm({ t, onDone }: { t: Trade; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [price, setPrice] = useState("");
  const [time, setTime] = useState(localInput());
  const [fees, setFees] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/trades/${t.id}/exit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note, exitPrice: Number(price), exitTime: new Date(time).toISOString(), feesUsd: fees ? Number(fees) : 0 }),
    });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) return setErr(j.error ?? "Could not log exit");
    onDone();
  }
  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 border-t border-line pt-3 text-sm">
      <div>
        <label className="label" htmlFor={`n-${t.id}`}>Reason for the exit</label>
        <input id={`n-${t.id}`} className="field mt-1" value={note} onChange={(e) => setNote(e.target.value)} required />
      </div>
      {t.kind === "real" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div><label className="label" htmlFor={`p-${t.id}`}>Exit price (USD)</label><input id={`p-${t.id}`} className="field num mt-1" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required /></div>
          <div><label className="label" htmlFor={`t-${t.id}`}>Exit time</label><input id={`t-${t.id}`} type="datetime-local" className="field mt-1" value={time} onChange={(e) => setTime(e.target.value)} required /></div>
          <div><label className="label" htmlFor={`f-${t.id}`}>Fees paid (USD, optional)</label><input id={`f-${t.id}`} className="field num mt-1" inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} /></div>
        </div>
      ) : (
        <p className="label">Paper exits close at the latest scanned price, minus slippage and fee. Real fills may differ.</p>
      )}
      {err && <p className="text-warn" role="alert">! {err}</p>}
      <div><button className="btn btn-sm btn-primary" disabled={busy}>{busy ? "Saving…" : t.kind === "paper" ? "Close paper position" : "Record exit"}</button></div>
    </form>
  );
}

export default function Journal() {
  const { settings, tick, bump } = useScan();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [kind, setKind] = useState<"paper" | "real">("paper");
  const [adherence, setAdherence] = useState<"all" | "followed" | "overrode">("all");
  const [tag, setTag] = useState("");
  const [exiting, setExiting] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase().from("trades").select("*").order("entry_time", { ascending: false });
    setTrades((data as Trade[]) ?? []);
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load, tick]);

  const ofKind = useMemo(() => trades.filter((t) => t.kind === kind), [trades, kind]);
  const filtered = useMemo(() => ofKind.filter((t) =>
    (adherence === "all" || (adherence === "followed" ? t.followed_rules : !t.followed_rules)) && (!tag || t.tags.includes(tag))), [ofKind, adherence, tag]);

  const stats = useMemo(() => {
    const closed = filtered.filter((t) => t.status === "closed");
    const pnl = closed.reduce((a, t) => a + Number(t.pnl_usd ?? 0), 0);
    const wins = closed.filter((t) => Number(t.pnl_usd) > 0).length;
    return { closed: closed.length, open: filtered.length - closed.length, pnl, wins, losses: closed.length - wins };
  }, [filtered]);

  const paperBalance = useMemo(() => {
    const p = trades.filter((t) => t.kind === "paper");
    return settings.paper.startingBalance + p.filter((t) => t.status === "closed").reduce((a, t) => a + Number(t.pnl_usd ?? 0), 0) - p.filter((t) => t.status === "open").reduce((a, t) => a + Number(t.amount_usd), 0);
  }, [trades, settings.paper.startingBalance]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-4">
      <h1 className="text-base font-semibold">Journal</h1>
      <p className="mt-1 text-sm text-muted">Paper and real trades are kept separate so rule-following can be compared with impulsive trades. Real trades are records of trades you placed yourself in Fomo.</p>

      <div role="tablist" aria-label="Trade type" className="mt-4 grid max-w-sm grid-cols-2 gap-1 rounded-md bg-panel p-1">
        {(["paper", "real"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setExiting(null); }}
            className={`rounded px-3 py-2 text-sm ${kind === k ? "bg-raised text-ink" : "text-muted"}`}>
            {k === "paper" ? "Paper" : "Real (manual in Fomo)"} <span className="label">({trades.filter((t) => t.kind === k).length})</span>
          </button>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          ["P&L (closed)", usd(stats.pnl)],
          ["Wins / losses", `${stats.wins} / ${stats.losses}`],
          ["Closed", String(stats.closed)],
          ["Open", String(stats.open)],
          kind === "paper" ? ["Paper balance", `$${paperBalance.toFixed(2)}`] : ["Trades logged", String(ofKind.length)],
        ].map(([k, v]) => (
          <div key={k} className="panel p-3"><div className="label">{k}</div><div className="num mt-0.5 text-base">{v}</div></div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Rule adherence" className="flex gap-1">
          {([["all", "All"], ["followed", "Followed rules"], ["overrode", "Overrode rules"]] as const).map(([v, l]) => (
            <button key={v} className="btn btn-sm" aria-pressed={adherence === v} style={adherence === v ? { background: "#2a2d32" } : undefined} onClick={() => setAdherence(v)}>{l}</button>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="tagf">Override reason</label>
          <select id="tagf" className="field mt-1 !min-h-8 !py-1" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Any</option>
            {ALL_TAGS.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
      </div>

      {!loaded ? <div className="panel mt-4 p-5 text-sm text-muted">Loading…</div> : filtered.length === 0 ? (
        <div className="panel mt-4 p-5 text-sm text-muted">No {kind} trades match. Open a token checklist and choose Log trade.</div>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {filtered.map((t) => (
            <li key={t.id} className="panel p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="font-medium">
                  <Link className="hover:underline" href={`/?t=${t.mint}`}>{t.symbol ?? short(t.mint)}</Link>{" "}
                  <span className="tag ml-1">{t.status === "open" ? "Open" : "Closed"}</span>
                </div>
                <div className="num text-sm">{t.status === "closed" ? <>P&amp;L {usd(Number(t.pnl_usd))}</> : <span className="text-muted">Position open</span>}</div>
              </div>
              <p className="mt-1 text-sm">{t.reason}</p>
              <dl className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-4">
                <div>Entry {fmtPrice(Number(t.entry_price))}</div><div>Size ${Number(t.amount_usd).toFixed(2)}</div>
                <div>Target {fmtPrice(Number(t.target))}</div><div>Stop {fmtPrice(Number(t.stop))}</div>
                <div>Max loss ${Number(t.max_loss_usd)}</div><div>In {stamp(t.entry_time)}</div>
                {t.exit_price != null && <><div>Exit {fmtPrice(Number(t.exit_price))}</div><div>Out {stamp(t.exit_time!)}</div></>}
              </dl>
              {t.exit_reason && <p className="label mt-1">{REASON[t.exit_reason] ?? t.exit_reason}{t.exit_note ? ` — ${t.exit_note}` : ""}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {t.followed_rules ? <span className="tag">✓ Followed rules</span> : <span className="tag tag-warn">! Overrode rules</span>}
                {t.tags.map((x) => <span key={x} className="tag tag-warn">{x}</span>)}
              </div>
              {t.override_text && <p className="label mt-1">{t.override_text}</p>}
              {t.status === "open" && (
                <div className="mt-2">
                  <button className="btn btn-sm" aria-expanded={exiting === t.id} onClick={() => setExiting(exiting === t.id ? null : t.id)}>Log exit</button>
                  {exiting === t.id && <ExitForm t={t} onDone={() => { setExiting(null); load(); bump(); }} />}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

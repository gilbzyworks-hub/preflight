"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import TokenPanel from "@/components/TokenPanel";
import { useScan, type AlertRow } from "@/components/ScanProvider";
import { AsOf, CountSummary, TwoPane } from "@/components/ui";
import { fmtPrice, fmtUsd, stamp } from "@/lib/format";
import { supabase } from "@/lib/supabase/client";
import { reEvaluate, useScansFor } from "@/lib/useToken";
import type { AlertRules } from "@shared/types.ts";

interface Item { id: string; mint: string; symbol: string | null; name: string | null; rules: AlertRules }
const KIND: Record<string, string> = { price_cross: "Price level", liquidity_drop: "Liquidity drop", required_fail: "Required check" };

function RulesEditor({ item, onSaved }: { item: Item; onSaved: () => void }) {
  const { settings } = useScan();
  const [price, setPrice] = useState(item.rules.priceLevel != null ? String(item.rules.priceLevel) : "");
  const [liqOn, setLiqOn] = useState(item.rules.liqDropOn);
  const [liqPct, setLiqPct] = useState(item.rules.liqDropPct != null ? String(item.rules.liqDropPct) : "");
  const [reqOn, setReqOn] = useState(item.rules.requiredFailOn);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    const rules: AlertRules = {
      priceLevel: price.trim() ? Number(price) : null,
      liqDropOn: liqOn,
      liqDropPct: liqPct.trim() ? Number(liqPct) : null,
      requiredFailOn: reqOn,
    };
    if ((rules.priceLevel !== null && !(rules.priceLevel > 0)) || (rules.liqDropPct !== null && !(rules.liqDropPct > 0 && rules.liqDropPct <= 100))) {
      return setMsg("Check the numbers: price must be above 0, drop must be 1–100.");
    }
    const { error } = await supabase().from("watchlist").update({ rules }).eq("id", item.id);
    setMsg(error ? error.message : "Saved.");
    if (!error) onSaved();
  }

  return (
    <div className="mt-2 grid gap-3 border-t border-line pt-3 text-sm">
      <div>
        <label className="label" htmlFor={`pl-${item.id}`}>Alert when price crosses (USD, blank = off)</label>
        <input id={`pl-${item.id}`} className="field num mt-1" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2"><input type="checkbox" checked={liqOn} onChange={(e) => setLiqOn(e.target.checked)} /> Liquidity drops by</label>
        <input aria-label="Liquidity drop percent" className="field num w-24" inputMode="decimal" placeholder={String(settings.alerts.liquidityDropPct)} value={liqPct} onChange={(e) => setLiqPct(e.target.value)} />
        <span className="text-muted">% since last scan</span>
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={reqOn} onChange={(e) => setReqOn(e.target.checked)} /> A required check newly fails</label>
      <div className="flex items-center gap-3">
        <button className="btn btn-sm" onClick={save}>Save rules</button>
        {msg && <span className="label" role="status">{msg}</span>}
      </div>
    </div>
  );
}

export default function Watchlist() {
  const router = useRouter();
  const sp = useSearchParams();
  const selected = sp.get("t");
  const alertId = sp.get("a");
  const { settings, tick, bump } = useScan();
  const [items, setItems] = useState<Item[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const db = supabase();
    const [{ data: w }, { data: a }] = await Promise.all([
      db.from("watchlist").select("id,mint,symbol,name,rules").order("added_at", { ascending: false }),
      db.from("alerts").select("*").order("created_at", { ascending: false }).limit(50),
    ]);
    setItems((w as Item[]) ?? []);
    setAlerts((a as AlertRow[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load, tick]);

  const scans = useScansFor(useMemo(() => items.map((i) => i.mint), [items]), tick);
  const alert = alerts.find((a) => a.id === alertId) ?? null;
  const go = (q: string) => router.push(q ? `/watchlist?${q}` : "/watchlist");

  const left = (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="inbox-h">
        <div className="flex items-baseline justify-between">
          <h1 id="inbox-h" className="text-base font-semibold">Alert inbox</h1>
          {alerts.some((a) => !a.read_at) && (
            <button className="btn btn-sm" onClick={async () => { await supabase().from("alerts").update({ read_at: new Date().toISOString() }).is("read_at", null); load(); bump(); }}>Mark all read</button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">Alerts are saved for review. They are not sent anywhere while the site is closed, but they are still recorded by the background scan.</p>
        {alerts.length === 0 ? (
          <div className="panel mt-3 p-4 text-sm text-muted">No alerts yet. They appear here when a watched token meets one of its alert rules.</div>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {alerts.map((a) => (
              <li key={a.id}>
                <button onClick={() => go(`t=${a.mint}&a=${a.id}`)} className={`panel w-full p-3 text-left hover:border-[#444851] ${alertId === a.id ? "border-[#6b7686]" : ""}`}>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{a.symbol ?? "Token"} <span className="tag ml-1">{KIND[a.kind] ?? a.kind}</span> {!a.read_at && <span className="tag tag-warn ml-1">New</span>}</span>
                    <span className="label num">scan {stamp(a.scan_at)}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted">{a.message}</p>
                  <p className="label mt-1">Open to see the full checklist</p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="watch-h">
        <h2 id="watch-h" className="text-base font-semibold">Watching <span className="label">({items.length})</span></h2>
        {items.length === 0 ? (
          <div className="panel mt-3 p-4 text-sm text-muted">Nothing watched yet. Open a token from the Scanner and choose Watch.</div>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {items.map((it) => {
              const s = scans[it.mint] ? reEvaluate(scans[it.mint], settings) : null;
              return (
                <li key={it.id} className={`panel p-3 ${selected === it.mint ? "border-[#6b7686]" : ""}`}>
                  <button className="block w-full text-left" onClick={() => go(`t=${it.mint}`)}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{it.symbol ?? "Unknown"} <span className="text-sm font-normal text-muted">{it.name}</span></span>
                      <span className="num text-sm">{fmtPrice(s?.metrics.priceUsd)}</span>
                    </div>
                    {s ? (
                      <>
                        <div className="num mt-1 text-xs text-muted">Liquidity {fmtUsd(s.metrics.liquidityUsd)} · 24h volume {fmtUsd(s.metrics.volume24h)}</div>
                        <div className="mt-1"><CountSummary c={s.evaluation.counts} /></div>
                        <div className="mt-1"><AsOf at={s.scannedAt} /></div>
                      </>
                    ) : <div className="label mt-1">No scan stored yet.</div>}
                  </button>
                  <div className="mt-2 flex gap-2">
                    <button className="btn btn-sm" aria-expanded={open === it.id} onClick={() => setOpen(open === it.id ? null : it.id)}>Alert rules</button>
                    <button className="btn btn-sm" onClick={async () => { await supabase().from("watchlist").delete().eq("id", it.id); load(); bump(); }}>Remove</button>
                  </div>
                  {open === it.id && <RulesEditor item={it} onSaved={load} />}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );

  return <TwoPane left={left} right={selected ? <TokenPanel key={`${selected}-${alertId}`} mint={selected} alert={alert} /> : null} selected={!!selected} onBack={() => go("")} />;
}

"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import TokenPanel from "@/components/TokenPanel";
import { useScan } from "@/components/ScanProvider";
import { AsOf, CountSummary, TwoPane } from "@/components/ui";
import { fmtHours, fmtPct, fmtUsd } from "@/lib/format";
import { loadScans, reEvaluate } from "@/lib/useToken";
import type { TokenScan } from "@shared/types.ts";
import { activePreset } from "@shared/defaults.ts";
import { looksLikeMint } from "@shared/dex.ts";

const FEED_WINDOW_MS = 30 * 60_000;

export default function Scanner() {
  const router = useRouter();
  const sp = useSearchParams();
  const selected = sp.get("t");
  const { settings, tick, scanning, now, ready } = useScan();
  const [raw, setRaw] = useState<TokenScan[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ mint: string; symbol: string | null; name: string | null; liquidityUsd: number | null; fdv: number | null }[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const preset = activePreset(settings);

  useEffect(() => {
    loadScans(undefined, FEED_WINDOW_MS).then((l) => { setRaw(l); setLoaded(true); });
  }, [tick]);

  const rows = useMemo(() => {
    const all = raw.map((s) => reEvaluate(s, settings));
    const list = showAll ? all : all.filter((s) => s.evaluation.matches);
    return list.sort((a, b) => (b.metrics.volume24h ?? 0) - (a.metrics.volume24h ?? 0));
  }, [raw, settings, showAll]);

  const go = (mint: string | null) => router.push(mint ? `/?t=${mint}` : "/");

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const v = q.trim();
    setSearchErr(null);
    setResults([]);
    if (looksLikeMint(v)) return go(v);
    if (v.length < 2) return;
    setSearching(true);
    const r = await fetch(`/api/search?q=${encodeURIComponent(v)}`);
    const j = await r.json();
    setSearching(false);
    if (!r.ok) setSearchErr(j.error ?? "Search failed");
    else if (!j.results.length) setSearchErr("No Solana tokens found for that search.");
    else setResults(j.results);
  }

  const left = (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-base font-semibold">{preset.name}</h1>
        {preset.subtitle && <p className="mt-0.5 text-sm text-muted">{preset.subtitle}</p>}
      </div>
      <form onSubmit={search} className="flex gap-2" role="search">
        <input aria-label="Search by name or paste a token address" className="field" placeholder="Paste a token address or search by name" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" disabled={searching}>{searching ? "…" : "Look up"}</button>
      </form>
      {searchErr && <p className="text-sm text-warn" role="status">! {searchErr}</p>}
      {results.length > 0 && (
        <ul className="panel divide-y divide-line">
          {results.map((r) => (
            <li key={r.mint}>
              <button className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-raised" onClick={() => { setResults([]); go(r.mint); }}>
                <span>{r.symbol} <span className="text-muted">{r.name}</span></span>
                <span className="label num">liq {fmtUsd(r.liquidityUsd)} · FDV {fmtUsd(r.fdv)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{showAll ? "All recently scanned" : "Matching your active preset"} <span className="label">({rows.length})</span></h2>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Include tokens with failed required checks
        </label>
      </div>
      <p className="label">Candidates come from DEX Screener’s recently profiled, updated and boosted lists. Periodic scan (~every 2 min) while this site is open.</p>
      {!loaded || !ready ? (
        <div className="panel p-5 text-sm text-muted" role="status">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="panel p-5 text-sm text-muted" role="status">
          {scanning ? "Scanning candidates…" : "No recently scanned tokens match this preset. That is normal with strict filters. Try Scan now, loosen a threshold in Settings, or look up a token directly."}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((s) => {
            const m = s.metrics;
            const on = selected === m.mint;
            return (
              <li key={m.mint}>
                <button onClick={() => go(m.mint)} aria-current={on ? "true" : undefined}
                  className={`panel w-full p-3 text-left hover:border-[#444851] ${on ? "border-[#6b7686]" : ""}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{m.symbol ?? "Unknown"} <span className="text-sm font-normal text-muted">{m.name}</span></div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2">
                        {m.boosted && <span className="tag tag-warn">Paid promotion</span>}
                        {!s.evaluation.matches && <span className="tag">Required check failed</span>}
                      </div>
                    </div>
                    <div className="label num shrink-0 text-right">{m.pairCreatedAt ? fmtHours((new Date(s.scannedAt).getTime() - m.pairCreatedAt) / 3.6e6) : "age ?"} old</div>
                  </div>
                  <dl className="num mt-2 grid grid-cols-3 gap-2 text-sm">
                    <div><dt className="label">Liquidity</dt><dd>{fmtUsd(m.liquidityUsd)}</dd></div>
                    <div><dt className="label">24h volume</dt><dd>{fmtUsd(m.volume24h)}</dd></div>
                    <div><dt className="label">FDV</dt><dd>{fmtUsd(m.fdv)}</dd></div>
                  </dl>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <CountSummary c={s.evaluation.counts} />
                    <span className="label num">24h {fmtPct(m.priceChange.h24)}</span>
                  </div>
                  <div className="mt-1"><AsOf at={s.scannedAt} /></div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  void now;
  return <TwoPane left={left} right={selected ? <TokenPanel key={selected} mint={selected} /> : null} selected={!!selected} onBack={() => go(null)} />;
}

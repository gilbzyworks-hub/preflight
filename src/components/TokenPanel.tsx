"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { failedRequiredIds } from "@shared/engine.ts";
import type { Evaluation, HolderData, HolderEntry, PoolInfo, TokenScan } from "@shared/types.ts";
import { fmtHours, fmtPct, fmtPrice, fmtUsd, short } from "@/lib/format";
import { loadScans, reEvaluate } from "@/lib/useToken";
import LogTradeForm from "./LogTradeForm";
import { useScan, type AlertRow } from "./ScanProvider";
import { AsOf, CountSummary, StatusBadge } from "./ui";

interface WatchRow { id: string; added_at: string; added_price: number | null; added_checks: Evaluation | null }

const explorer = (addr: string) => `https://solscan.io/account/${addr}`;
const KIND_TAG: Record<HolderEntry["kind"], string> = {
  liquidity_pool: "Excluded: liquidity pool", burn: "Excluded: burn address", program_owned_known: "Excluded: lock/vesting program",
  program_owned_unclassified: "! Unclassified program account", wallet: "Wallet", unresolved: "? Owner not readable",
};

/** Every large token account with its label and share, so each can be checked on a block explorer.
 *  Laid out as rows (not a table) so the share is always visible, however narrow the screen. */
function HolderList({ holders }: { holders: HolderData }) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted">Show the {holders.entries.length} largest token accounts ({holders.rawTop10Pct.toFixed(1)}% raw / {holders.adjustedTop10Pct.toFixed(1)}% adjusted)</summary>
      <ol className="mt-2">
        {holders.entries.map((e, i) => (
          <li key={e.tokenAccount} className="grid grid-cols-[1.75rem_minmax(0,1fr)_3.5rem] items-start gap-x-2 border-t border-line py-1.5">
            <span className="num">{i + 1}{i < 10 ? "" : "*"}</span>
            <div className="min-w-0">
              <div className={`font-medium ${e.kind === "program_owned_unclassified" || e.kind === "unresolved" ? "text-warn" : ""}`}>{KIND_TAG[e.kind]}</div>
              <div className="num break-all">
                <a className="underline" href={explorer(e.tokenAccount)} target="_blank" rel="noopener noreferrer nofollow">{short(e.tokenAccount)} ↗</a>
                {e.owner && <> · owner <a className="underline" href={explorer(e.owner)} target="_blank" rel="noopener noreferrer nofollow">{short(e.owner)} ↗</a></>}
              </div>
              <div className="label">{e.label}. {e.basis}.</div>
            </div>
            <span className="num text-right">{e.pct.toFixed(2)}%</span>
          </li>
        ))}
      </ol>
      <p className="label mt-1">* ranks 11-20 are only used to fill the adjusted top 10 after exclusions. RPC returns at most the 20 largest accounts.</p>
    </details>
  );
}

function PoolList({ pools, mainShare }: { pools: PoolInfo[]; mainShare: number | null }) {
  const { now } = useScan();
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted">Show all {pools.length} pool{pools.length === 1 ? "" : "s"}{mainShare !== null ? ` (main pool holds ${mainShare.toFixed(0)}% of liquidity)` : ""}</summary>
      <ol className="mt-2">
        {pools.map((p, i) => (
          <li key={p.pairAddress ?? i} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 border-t border-line py-1.5">
            <div className="min-w-0">
              <span className="font-medium">{p.url ? <a className="underline" href={p.url} target="_blank" rel="noopener noreferrer nofollow">{p.dexId ?? "?"} ↗</a> : (p.dexId ?? "?")}</span>
              <span className="text-muted"> · quoted in {p.quoteSymbol ?? "?"}</span>
              {i === 0 && <span className="tag ml-1.5">Main pool</span>}
              <div className="label">age {p.createdAt ? fmtHours((now - p.createdAt) / 3.6e6) : "?"}</div>
            </div>
            <span className="num text-right">{fmtUsd(p.liquidityUsd)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

export default function TokenPanel({ mint, alert }: { mint: string; alert?: AlertRow | null }) {
  const { settings, bump, tick } = useScan();
  const [cached, setCached] = useState<TokenScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [warn, setWarn] = useState<string | null>(null);
  const [watch, setWatch] = useState<WatchRow | null>(null);
  const [logging, setLogging] = useState(false);
  const [rc, setRc] = useState<{ source: string; risks: { name: string; level: string }[] } | null>(null);
  const [rcState, setRcState] = useState<"idle" | "loading" | "none">("idle");
  const formRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (opts: { withRc?: boolean } = {}) => {
    setLoading(true);
    setWarn(null);
    try {
      const r = await fetch(`/api/token/${mint}${opts.withRc ? "?rc=1" : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      const s = j.scan as TokenScan;
      if (s.metrics.dataOk) setCached(s);
      else setWarn(`Fresh market data is unavailable${j.errors?.[0] ? ` (${j.errors[0]})` : ""}. Showing the last stored scan, if any.`);
      if (opts.withRc) {
        if (j.thirdParty) { setRc(j.thirdParty); setRcState("idle"); } else setRcState("none");
      }
      bump();
    } catch (e) {
      setWarn(`Could not refresh: ${e instanceof Error ? e.message : "unknown error"}. Showing the last stored scan, if any.`);
    } finally {
      setLoading(false);
    }
  }, [mint, bump]);

  // Open: record first view, show stored scan immediately, then fetch a fresh one.
  useEffect(() => {
    setCached(null); setRc(null); setRcState("idle"); setLogging(false); setWarn(null);
    fetch("/api/views", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mint }) });
    loadScans([mint]).then((l) => { if (l[0]) setCached(l[0]); });
    refresh();
  }, [mint, refresh]);

  useEffect(() => {
    supabase().from("watchlist").select("id,added_at,added_price,added_checks").eq("mint", mint).maybeSingle().then(({ data }: { data: unknown }) => setWatch(data as WatchRow | null));
  }, [mint, tick]);

  useEffect(() => {
    if (alert && !alert.read_at) supabase().from("alerts").update({ read_at: new Date().toISOString() }).eq("id", alert.id).then(() => bump());
  }, [alert, bump]);

  const scan = useMemo(() => (cached ? reEvaluate(cached, settings) : null), [cached, settings]);
  const m = scan?.metrics;

  const changes = useMemo(() => {
    if (!watch?.added_checks || !scan) return [];
    const out: string[] = [];
    for (const c of scan.evaluation.checks) {
      const was = watch.added_checks.checks.find((x) => x.id === c.id);
      if (was && (was.status !== c.status || was.value !== c.value)) {
        out.push(`${c.label}: ${was.value} (${was.status}) → ${c.value} (${c.status})`);
      }
    }
    return out;
  }, [watch, scan]);

  async function toggleWatch() {
    const db = supabase();
    if (watch) {
      await db.from("watchlist").delete().eq("id", watch.id);
      setWatch(null);
    } else if (scan) {
      const { data } = await db.from("watchlist").insert({
        mint, symbol: scan.metrics.symbol, name: scan.metrics.name, added_price: scan.metrics.priceUsd, added_checks: scan.evaluation,
        last_state: { price: scan.metrics.priceUsd, liquidityUsd: scan.metrics.liquidityUsd, failedRequired: failedRequiredIds(scan.evaluation), at: scan.scannedAt },
      }).select("id,added_at,added_price,added_checks").single();
      setWatch(data as WatchRow);
    }
    bump();
  }

  if (!scan || !m) {
    return (
      <div className="panel p-6 text-sm text-muted" role="status">
        {loading ? "Scanning this token…" : (warn ?? "No data available for this token.")}
        {!loading && <div className="mt-3"><button className="btn btn-sm" onClick={() => refresh()}>Try again</button></div>}
      </div>
    );
  }
  const ev = scan.evaluation;
  const chartUrl = m.dexUrl ?? `https://dexscreener.com/solana/${mint}`;

  return (
    <div className="flex flex-col gap-3">
      {alert && (
        <div className="panel border-[#5b4a22] p-3 text-sm" role="status">
          <span className="font-medium text-warn">! Alert</span> — {alert.message}
          <span className="label ml-2">saved from the scan at {new Date(alert.scan_at).toLocaleString()}</span>
        </div>
      )}
      <div className="panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{m.symbol ?? "Unknown token"} <span className="text-sm font-normal text-muted">{m.name}</span></h2>
            <p className="label num">{short(mint)} · {m.dexId ?? "no DEX data"}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {m.boosted && <span className="tag tag-warn">Paid promotion</span>}
              <AsOf at={scan.scannedAt} />
            </div>
          </div>
          <div className="text-right">
            <div className="num text-lg">{fmtPrice(m.priceUsd)}</div>
            <div className="label num">5m {fmtPct(m.priceChange.m5)} · 1h {fmtPct(m.priceChange.h1)} · 6h {fmtPct(m.priceChange.h6)} · 24h {fmtPct(m.priceChange.h24)}</div>
          </div>
        </div>
        <div className="mt-3"><CountSummary c={ev.counts} /></div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn btn-sm" onClick={toggleWatch}>{watch ? "Stop watching" : "Watch"}</button>
          <button className="btn btn-sm" onClick={() => { setLogging(true); setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }}>Log trade</button>
          <button className="btn btn-sm" onClick={() => refresh()} disabled={loading}>{loading ? "Scanning…" : "Rescan"}</button>
          <a className="btn btn-sm" href={chartUrl} target="_blank" rel="noopener noreferrer">DEX Screener chart ↗</a>
        </div>
        {warn && <p className="mt-3 text-sm text-warn" role="status">! {warn}</p>}
      </div>

      {changes.length > 0 && (
        <div className="panel p-4">
          <h3 className="text-sm font-medium">Changes since you watched this token ({new Date(watch!.added_at).toLocaleDateString()})</h3>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">{changes.map((c) => <li key={c}>• {c}</li>)}</ul>
          {watch?.added_price != null && m.priceUsd != null && (
            <p className="label mt-2">Price when added {fmtPrice(watch.added_price)} → now {fmtPrice(m.priceUsd)} ({fmtPct((m.priceUsd / watch.added_price - 1) * 100)})</p>
          )}
        </div>
      )}

      <div className="panel">
        <h3 className="border-b border-line px-4 py-2.5 text-sm font-medium">Checklist · {settings.presets.find((p) => p.id === settings.activePresetId)?.name}</h3>
        <ul>
          {ev.checks.map((c) => (
            <li key={c.id} className="grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[96px_minmax(0,1fr)_minmax(0,15rem)]">
              <div><StatusBadge status={c.status} /></div>
              <div className="min-w-0">
                <div className="text-sm font-medium">{c.label} <span className="label font-normal">{c.severity === "required" ? "Required" : c.severity === "warning" ? "Warning" : "Off"}</span></div>
                <p className="mt-0.5 text-xs text-muted">{c.explanation}</p>
                {c.notes?.map((n) => (
                  <p key={n} className={`mt-1 text-xs ${n.startsWith("!") ? "text-warn" : "text-muted"}`}>{n}</p>
                ))}
                {c.id === "top10" && scan.chain.holders && <HolderList holders={scan.chain.holders} />}
                {c.id === "poolSplit" && m.pools?.length > 0 && <PoolList pools={m.pools} mainShare={m.mainPoolShare} />}
              </div>
              <div className="num min-w-0 break-words text-sm sm:text-right">
                <div>{c.value}</div>
                <div className="label">needs {c.threshold}</div>
              </div>
            </li>
          ))}
          <li className="grid gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[96px_1fr_auto]">
            <div><StatusBadge status={ev.unknownRow.status} /></div>
            <div>
              <div className="text-sm font-medium">Unknown data <span className="label font-normal">Warning</span></div>
              <p className="mt-0.5 text-xs text-muted">Missing or failed data is shown as UNKNOWN and treated as a warning. It is never counted as a pass.</p>
            </div>
            <div className="num text-sm sm:text-right">{ev.unknownRow.detail}</div>
          </li>
        </ul>
      </div>
      <p className="px-1 text-xs text-muted">Passing these checks only screens out some known red flags. It does not mean the token is sound or likely to rise.</p>

      {(m.links.length > 0 || true) && (
        <div className="panel p-4 text-sm">
          <h3 className="font-medium">Project links</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {m.links.length ? m.links.map((l) => (
              <a key={l.url} className="btn btn-sm" href={l.url} target="_blank" rel="noopener noreferrer nofollow">{l.label} ↗</a>
            )) : <span className="text-muted">None listed.</span>}
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <h3 className="font-medium">Third-party opinion <span className="label font-normal">optional, not part of the checks</span></h3>
            {rc ? (
              <ul className="mt-2 flex flex-col gap-1 text-xs text-muted">
                <li>Source: {rc.source}. Their opinion, not ours; it can be wrong or incomplete.</li>
                {rc.risks.length ? rc.risks.map((r) => <li key={r.name}>• {r.name} ({r.level})</li>) : <li>• No items listed.</li>}
              </ul>
            ) : (
              <div className="mt-2 flex items-center gap-3">
                <button className="btn btn-sm" disabled={rcState === "loading" || loading} onClick={async () => { setRcState("loading"); await refresh({ withRc: true }); }}>
                  {rcState === "loading" ? "Loading…" : "Show RugCheck summary"}
                </button>
                {rcState === "none" && <span className="text-xs text-warn">! Unavailable right now.</span>}
              </div>
            )}
          </div>
        </div>
      )}

      <div ref={formRef}>{logging && <LogTradeForm scan={scan} onDone={() => setLogging(false)} />}</div>
    </div>
  );
}

"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useScan } from "@/components/ScanProvider";
import { CountSummary, StatusBadge } from "@/components/ui";
import { fmtPrice, fmtUsd, short, stamp } from "@/lib/format";
import { supabase } from "@/lib/supabase/client";
import { HORIZONS, rugLabel, type NoteLite, type RugLabel, type SnapshotLite } from "@shared/outcomes.ts";
import type { Status } from "@shared/types.ts";

interface Cohort { id: string; mint: string; entered_at: string; preset_version_id: string; entry_observation_id: number }
interface StoredCheck { id: string; label: string; status: Status; severity: string; value: string; threshold: string; notes?: string[] | null }
interface Obs {
  id: number; metrics: { symbol: string | null; liquidityUsd: number | null; priceUsd: number | null; pools?: unknown[]; mainPoolShare?: number | null };
  counts: { pass: number; warn: number; fail: number; unknown: number; notRun?: number }; sources: string[]; paid_promotion: boolean; shown: boolean;
  schema_version: number; checks: StoredCheck[]; holders: { rawTop10Pct: number; adjustedTop10Pct: number } | null; extensions: { name: string }[] | null;
  creator: { status: string; address: string | null } | null; clustering: { status: string; pctFirst3Slots: number | null } | null; rpc_budget: { calls?: number; budgetHit?: boolean } | null;
}

/** Fields added with schema version 2. Rows written earlier never had them, so they are not "unknown": they were not collected. */
const V2_FIELDS = ["Top-10 holders (raw and adjusted)", "Liquidity split across pools", "Token program and extensions", "Creator wallet holding", "Early-buyer clustering (estimate)"];

function StoredChecks({ o }: { o: Obs }) {
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-muted">Checks as they stood when first shown</summary>
      <ul className="mt-2 space-y-1.5">
        {o.checks.map((c) => (
          <li key={c.id} className="grid grid-cols-[96px_1fr] items-start gap-x-3 gap-y-0.5">
            <StatusBadge status={c.status} />
            <div><span className="font-medium">{c.label}</span> <span className="label">{c.value}</span>{c.notes?.map((n) => <div key={n} className={`text-xs ${n.startsWith("!") ? "text-warn" : "text-muted"}`}>{n}</div>)}</div>
          </li>
        ))}
        {o.schema_version < 2 && V2_FIELDS.map((f) => (
          <li key={f} className="grid grid-cols-[96px_1fr] items-start gap-x-3 text-muted">
            <span className="inline-flex min-w-[88px] items-center gap-1.5 rounded border border-line px-1.5 py-0.5 text-xs"><span aria-hidden>–</span>NOT COLLECTED</span>
            <div>{f}: <span className="label">not collected at the time</span></div>
          </li>
        ))}
      </ul>
      {o.schema_version >= 2 && o.rpc_budget && <p className="label mt-2">{o.rpc_budget.calls ?? 0} RPC requests used in that scan{o.rpc_budget.budgetHit ? "; the request budget was reached, so some checks show NOT RUN" : ""}.</p>}
    </details>
  );
}
interface Snap extends SnapshotLite { cohort_id: string; due_at: string; taken_at: string; price_usd: number | null; fdv: number | null; reason: string | null }
interface Note extends NoteLite { id: number; cohort_id: string; created_at: string }
interface Actions { cohort_id: string; watched: boolean; paper_traded: boolean; real_traded: boolean }
interface Version { id: string; created_at: string; preset: { name: string } }

const SOURCE_LABEL: Record<string, string> = { profiled: "Profiled list", boosted: "Boosted list", watchlist: "Watchlist", manual: "Manual lookup" };

function RugTag({ r }: { r: RugLabel }) {
  if (r.kind === "verified") return <span className="tag tag-warn" title={r.note}>! Verified rug (your note)</span>;
  if (r.kind === "likely") return <span className="tag tag-warn" title={r.why}>! Likely rug (estimate): {r.why}</span>;
  if (r.kind === "none") return <span className="tag">No rug flag from snapshots so far (estimate only)</span>;
  return <span className="tag">Too early to estimate</span>;
}

function VerifyForm({ cohortId, verified, onDone }: { cohortId: string; verified: boolean; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save(kind: "verified_rug" | "unverify_rug" | "note") {
    setBusy(true);
    setErr(null);
    const { error } = await supabase().from("outcome_notes").insert({ cohort_id: cohortId, kind, note: note.trim() });
    setBusy(false);
    if (error) return setErr(error.message);
    setNote("");
    onDone();
  }
  const ok = note.trim().length >= 3;
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-muted">Add a note or confirm a rug</summary>
      <div className="mt-2 space-y-2">
        <label className="label" htmlFor={`n-${cohortId}`}>Source note (required, e.g. a link or what you saw)</label>
        <textarea id={`n-${cohortId}`} className="field" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm" disabled={!ok || busy} onClick={() => save(verified ? "unverify_rug" : "verified_rug")}>
            {verified ? "Withdraw verified-rug label" : "Mark as verified rug"}
          </button>
          <button className="btn btn-sm" disabled={!ok || busy} onClick={() => save("note")}>Add note only</button>
        </div>
        {err && <p className="text-xs text-warn">! {err}</p>}
        <p className="text-xs text-muted">Notes are append-only. Nothing is edited or deleted; a withdrawal is a new entry.</p>
      </div>
    </details>
  );
}

export default function Outcomes() {
  const { now, settings } = useScan();
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [obs, setObs] = useState<Map<number, Obs>>(new Map());
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [acts, setActs] = useState<Map<string, Actions>>(new Map());
  const [versions, setVersions] = useState<Version[]>([]);
  const [total, setTotal] = useState<{ obs: number; first: string | null; last: string | null }>({ obs: 0, first: null, last: null });
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const db = supabase();
    const { data: cs, error } = await db.from("cohorts").select("id,mint,entered_at,preset_version_id,entry_observation_id").order("entered_at", { ascending: false }).limit(100);
    if (error) { setErr(error.message); setLoaded(true); return; }
    const list = (cs ?? []) as Cohort[];
    const ids = list.map((c) => c.id);
    const [o, s, n, a, v, cnt, first, last] = await Promise.all([
      db.from("observations").select("id,metrics,counts,sources,paid_promotion,shown,schema_version,checks,holders,extensions,creator,clustering,rpc_budget").in("id", list.map((c) => c.entry_observation_id)),
      db.from("snapshots").select("cohort_id,horizon,due_at,taken_at,status,pair_status,price_usd,liquidity_usd,fdv,reason").in("cohort_id", ids),
      db.from("outcome_notes").select("id,cohort_id,kind,note,created_at").in("cohort_id", ids).order("created_at", { ascending: true }),
      db.from("cohort_actions").select("cohort_id,watched,paper_traded,real_traded").in("cohort_id", ids),
      db.from("preset_versions").select("id,created_at,preset").order("created_at", { ascending: true }),
      db.from("observations").select("id", { count: "exact", head: true }),
      db.from("observations").select("observed_at").order("observed_at", { ascending: true }).limit(1),
      db.from("observations").select("observed_at").order("observed_at", { ascending: false }).limit(1),
    ]);
    setCohorts(list);
    setObs(new Map(((o.data ?? []) as Obs[]).map((x) => [x.id, x])));
    setSnaps((s.data ?? []) as Snap[]);
    setNotes((n.data ?? []) as Note[]);
    setActs(new Map(((a.data ?? []) as Actions[]).map((x) => [x.cohort_id, x])));
    setVersions((v.data ?? []) as Version[]);
    setTotal({ obs: cnt.count ?? 0, first: first.data?.[0]?.observed_at ?? null, last: last.data?.[0]?.observed_at ?? null });
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);

  const coverage = useMemo(() => {
    const due = snaps.length;
    const missed = snaps.filter((x) => x.status === "missed").length;
    return { due, missed, pct: due ? Math.round((missed / due) * 100) : null };
  }, [snaps]);
  const versionNo = (id: string) => versions.findIndex((v) => v.id === id) + 1;

  return (
    <div className="mx-auto max-w-4xl px-4 py-4">
      <h1 className="text-lg font-semibold">Outcomes</h1>
      <p className="mt-1 text-sm text-muted">
        A log of every token the scanner showed, with the checks as they stood at the time and what the market data looked like about 1 hour, 24 hours and 7 days later.
        Collection only: no conclusions are drawn here yet.
      </p>

      <div className="panel mt-3 p-3 text-sm" role="note">
        {total.obs === 0 ? (
          <>No observations yet. They are written as the scanner runs.</>
        ) : (
          <>
            Based on tokens surfaced by DEX Screener&apos;s profiled/boosted lists and your watchlist between {stamp(total.first!)} and {stamp(total.last!)}.
            This is not the full Solana token market. {total.obs.toLocaleString()} observations; {coverage.pct === null ? "no follow-ups due yet" : `${coverage.pct}% missing follow-ups`}
            {coverage.due ? ` (${coverage.missed} of ${coverage.due} due)` : ""}.
          </>
        )}
      </div>

      {err && <p className="mt-3 text-sm text-warn">! Could not load outcomes: {err}</p>}
      {!loaded && <p className="mt-4 text-sm text-muted">Loading…</p>}
      {loaded && !err && cohorts.length === 0 && <p className="mt-4 text-sm text-muted">Nothing recorded yet. Open the Scanner and tokens will start to appear here.</p>}

      <ul className="mt-4 space-y-3">
        {cohorts.map((c) => {
          const o = obs.get(c.entry_observation_id);
          const mySnaps = snaps.filter((x) => x.cohort_id === c.id);
          const myNotes = notes.filter((x) => x.cohort_id === c.id);
          const a = acts.get(c.id);
          const label = rugLabel(o?.metrics.liquidityUsd ?? null, mySnaps, myNotes, settings.outcomes.rugLiquidityDropPct);
          const entered = new Date(c.entered_at).getTime();
          return (
            <li key={c.id} className="panel p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="font-medium">{o?.metrics.symbol ?? "Unknown"} <span className="label num">{short(c.mint)}</span></div>
                <div className="label">first shown {stamp(c.entered_at)} · preset version {versionNo(c.preset_version_id) || "?"}</div>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {o?.sources.map((s) => <span key={s} className="tag">{SOURCE_LABEL[s] ?? s}</span>)}
                {o?.paid_promotion && <span className="tag tag-warn">! Paid promotion (boosted)</span>}
                <span className="tag">{o?.shown ? "Shown in feed" : "Not shown in feed"}</span>
                <span className="tag">{a?.watched ? "Watched" : "Not watched"}</span>
                <span className="tag">{a?.paper_traded ? "Paper-traded" : "No paper trade"}</span>
                <span className="tag">{a?.real_traded ? "Real trade logged" : "No real trade logged"}</span>
              </div>
              {o && <div className="mt-2"><CountSummary c={o.counts} /></div>}
              {o && <StoredChecks o={o} />}
              <div className="mt-1.5"><RugTag r={label} /></div>

              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {HORIZONS.map((h) => {
                  const s = mySnaps.find((x) => x.horizon === h.id);
                  const due = entered + h.ms;
                  return (
                    <div key={h.id} className="rounded border border-line p-2 text-sm">
                      <div className="label">+{h.id}</div>
                      {s?.status === "ok" && s.pair_status === "active" && (
                        <div className="num">{fmtPrice(s.price_usd)} <span className="label">liq {fmtUsd(s.liquidity_usd)}</span></div>
                      )}
                      {s?.status === "ok" && s.pair_status === "not_returned" && <div className="text-warn">! No pair returned</div>}
                      {s?.status === "missed" && <div className="text-warn" title={s.reason ?? ""}>? Missed: {s.reason}</div>}
                      {!s && <div className="label">{now < due ? `Due ${stamp(due)}` : "Due now"}</div>}
                      {s && <div className="label">taken {stamp(s.taken_at)}</div>}
                    </div>
                  );
                })}
              </div>

              {myNotes.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-muted">
                  {myNotes.map((n) => <li key={n.id}>{stamp(n.created_at)} · {n.kind.replace("_", " ")}: {n.note}</li>)}
                </ul>
              )}
              <VerifyForm cohortId={c.id} verified={label.kind === "verified"} onDone={load} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

"use client";
import type { Status } from "@shared/types.ts";
import { ago, clock } from "@/lib/format";
import { useScan } from "./ScanProvider";

const META: Record<Status, { icon: string; label: string; cls: string }> = {
  PASS: { icon: "✓", label: "PASS", cls: "text-ok border-line" },
  FAIL: { icon: "✕", label: "FAIL", cls: "text-fail border-[#5a2b28]" },
  WARN: { icon: "!", label: "WARN", cls: "text-warn border-[#5b4a22]" },
  UNKNOWN: { icon: "?", label: "UNKNOWN", cls: "text-warn border-[#5b4a22]" },
  NOT_RUN: { icon: "○", label: "NOT RUN", cls: "text-muted border-line" },
  OFF: { icon: "–", label: "OFF", cls: "text-muted border-line" },
};

export function StatusBadge({ status }: { status: Status }) {
  const m = META[status];
  return (
    <span className={`inline-flex min-w-[88px] items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs font-medium ${m.cls}`}>
      <span aria-hidden className="w-3 text-center">{m.icon}</span>
      {m.label}
    </span>
  );
}

/** "as of" time for any scanned data; amber STALE label when older than the threshold. */
export function AsOf({ at, className = "" }: { at: string | null | undefined; className?: string }) {
  const { now, settings } = useScan();
  if (!at) return <span className={`label ${className}`}>no scan yet</span>;
  const stale = now - new Date(at).getTime() > settings.staleMinutes * 60_000;
  return (
    <span className={`label num ${className}`} title={new Date(at).toLocaleString()}>
      {stale && <span className="mr-1.5 font-medium text-warn">! STALE</span>}
      as of {clock(at)} · {ago(at, now)}
    </span>
  );
}

export function CountSummary({ c }: { c: { pass: number; warn: number; fail: number; unknown: number; notRun?: number } }) {
  return (
    <span className="num flex flex-wrap gap-x-2.5 text-xs text-muted" aria-label={`${c.pass} pass, ${c.warn} warn, ${c.fail} fail, ${c.unknown} unknown${c.notRun ? `, ${c.notRun} not run` : ""}`}>
      <span>✓ {c.pass} pass</span>
      <span className={c.warn ? "text-warn" : ""}>! {c.warn} warn</span>
      <span className={c.fail ? "text-fail" : ""}>✕ {c.fail} fail</span>
      <span className={c.unknown ? "text-warn" : ""}>? {c.unknown} unknown</span>
      {c.notRun ? <span>○ {c.notRun} not run</span> : null}
    </span>
  );
}

/** Two columns on wide screens; on phones show the detail pane only when something is selected. */
export function TwoPane({ left, right, selected, onBack }: { left: React.ReactNode; right: React.ReactNode; selected: boolean; onBack: () => void }) {
  return (
    <div className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <section className={selected ? "hidden lg:block" : ""}>{left}</section>
      <section className={selected ? "" : "hidden lg:block"}>
        {selected && (
          <button className="btn btn-sm mb-3 lg:hidden" onClick={onBack}>← Back to list</button>
        )}
        {selected ? right : (
          <div className="panel p-6 text-sm text-muted">Select a token to see its checklist.</div>
        )}
      </section>
    </div>
  );
}

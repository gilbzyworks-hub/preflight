"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { ago, clock } from "@/lib/format";
import { ScanProvider, useScan } from "./ScanProvider";

export const DISCLAIMER = "Decision-support only, not financial advice. Meme coins can lose most or all of their value quickly.";

const NAV = [
  { href: "/", label: "Scanner" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/journal", label: "Journal" },
  { href: "/outcomes", label: "Outcomes" },
  { href: "/settings", label: "Settings" },
];

function Freshness() {
  const { lastOk, bgStale, bgFailed, lastSiteScan, now, scanError, settings, runs } = useScan();
  const lastDone = runs.find((r) => r.status !== "running");
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted" aria-label="Data freshness">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
        <span className="num">
          {bgStale && <span className="mr-1.5 font-medium text-warn">! STALE</span>}
          Background scan:{" "}
          {lastOk ? <>last successful {ago(lastOk.finished_at!, now).replace(" ago", "")} ago</> : "no successful run yet"}
        </span>
        <span className="num">Site scan: {lastSiteScan ? `${clock(lastSiteScan)} (${ago(lastSiteScan, now)})` : "none yet"}</span>
        <span>Periodic scan (~every 2 min) · stale after {settings.staleMinutes} min</span>
      </div>
      {bgFailed && (
        <div className="num text-warn" role="status">
          ✕ Background scan failed at {clock(bgFailed.finished_at ?? bgFailed.started_at)}
          {bgFailed.error ? ` — ${bgFailed.error.slice(0, 120)}` : ""}
        </div>
      )}
      {lastDone?.budget && lastDone.budget.hits > 0 && (
        <div className="num text-warn" role="status">
          ! Data request budget reached on the last background scan
          {lastDone.budget.skipped ? `: ${lastDone.budget.skipped} token${lastDone.budget.skipped === 1 ? "" : "s"} had creator/early-buyer checks marked NOT RUN` : ""} ({lastDone.budget.calls} requests). They are retried on later scans.
        </div>
      )}
      {scanError && <div className="text-warn" role="status">! Site scan issue: {scanError}</div>}
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { scanNow, scanning, banner, dismissBanner, ready } = useScan();
  const [ack, setAck] = useState(true);
  useEffect(() => {
    try { setAck(localStorage.getItem("pf.disclaimer.v1") === "1"); } catch { setAck(false); }
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-2.5">
          {/* Phones: logo and buttons on the first row, all five tabs on their own full-width row. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Link href="/" className="font-semibold tracking-tight">Preflight</Link>
            <nav className="order-last flex w-full gap-0.5 overflow-x-auto sm:order-none sm:w-auto sm:flex-1" aria-label="Main">
              {NAV.map((n) => {
                const on = n.href === "/" ? path === "/" : path.startsWith(n.href);
                return (
                  <Link key={n.href} href={n.href} aria-current={on ? "page" : undefined}
                    className={`rounded px-1.5 py-1.5 text-[13px] sm:px-2.5 sm:text-sm ${on ? "bg-raised text-ink" : "text-muted hover:text-ink"}`}>
                    {n.label}
                  </Link>
                );
              })}
            </nav>
            <div className="ml-auto flex items-center gap-2 sm:ml-0">
              <button className="btn btn-sm" onClick={scanNow} disabled={scanning || !ready}>
                {scanning ? "Scanning…" : "Scan now"}
              </button>
              <button className="btn btn-sm" onClick={async () => { await supabase().auth.signOut(); router.replace("/login"); }}>Sign out</button>
            </div>
          </div>
          <Freshness />
        </div>
        {banner && (
          <div className="border-t border-line bg-panel" role="status">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <span className="text-muted">Alert saved to your inbox:</span>
              <span>{banner.symbol ?? "Token"} — {banner.message}</span>
              <span className="label">scan {clock(banner.scan_at)}</span>
              <Link className="btn btn-sm" href={`/watchlist?t=${banner.mint}&a=${banner.id}`} onClick={dismissBanner}>Open checklist</Link>
              <button className="btn btn-sm" onClick={dismissBanner}>Dismiss</button>
            </div>
          </div>
        )}
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-line px-4 py-3 text-center text-xs text-muted">{DISCLAIMER}</footer>
      {!ack && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="disc-h">
          <div className="panel w-full max-w-md p-5">
            <h2 id="disc-h" className="text-base font-semibold">Before you start</h2>
            <p className="mt-2 text-sm">{DISCLAIMER}</p>
            <p className="mt-2 text-sm text-muted">
              Preflight screens tokens against your own rules using public data. It never connects to a wallet or to Fomo,
              and it cannot place trades. A token passing the checks is not a recommendation.
            </p>
            <button className="btn btn-primary mt-4 w-full" onClick={() => { try { localStorage.setItem("pf.disclaimer.v1", "1"); } catch {} setAck(true); }}>
              I understand
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ScanProvider>
      <Frame>{children}</Frame>
    </ScanProvider>
  );
}

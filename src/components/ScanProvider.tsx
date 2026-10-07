"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { mergeSettings } from "@shared/defaults.ts";
import type { Settings } from "@shared/types.ts";

export interface ScanRun { id: number; started_at: string; finished_at: string | null; status: "running" | "ok" | "error"; error: string | null; budget?: { calls: number; hits: number; skipped: number } | null }
export interface AlertRow { id: string; mint: string; symbol: string | null; kind: string; message: string; scan_at: string; created_at: string; read_at: string | null }

interface Ctx {
  settings: Settings;
  saveSettings: (s: Settings) => Promise<string | null>;
  now: number;
  runs: ScanRun[];
  lastOk: ScanRun | null;
  lastSiteScan: string | null;
  bgStale: boolean;
  bgFailed: ScanRun | null;
  scanning: boolean;
  scanError: string | null;
  scanNow: () => Promise<void>;
  tick: number; // bumps after every scan so pages reload their data
  bump: () => void;
  banner: AlertRow | null;
  dismissBanner: () => void;
  ready: boolean;
}

const C = createContext<Ctx | null>(null);
export const useScan = () => {
  const v = useContext(C);
  if (!v) throw new Error("ScanProvider missing");
  return v;
};

const inQuiet = (start: string, end: string, d: Date) => {
  const cur = d.getHours() * 60 + d.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const a = sh * 60 + sm, b = eh * 60 + em;
  if (a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
};

export function ScanProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => mergeSettings(null));
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [runs, setRuns] = useState<ScanRun[]>([]);
  const [lastSiteScan, setLastSiteScan] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [banner, setBanner] = useState<AlertRow | null>(null);
  const userId = useRef<string | null>(null);
  const seenAlerts = useRef<Set<string>>(new Set());
  const busy = useRef(false);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const loadRuns = useCallback(async () => {
    const db = supabase();
    const { data } = await db.from("scan_runs").select("id,started_at,finished_at,status,error,budget:detail->budget").order("started_at", { ascending: false }).limit(10);
    setRuns((data as ScanRun[]) ?? []);
    const { data: site } = await db.from("token_scans").select("scanned_at").eq("source", "site").order("scanned_at", { ascending: false }).limit(1);
    setLastSiteScan((cur) => cur ?? site?.[0]?.scanned_at ?? null);
  }, []);

  const runScan = useCallback(async (opts: { watchlist: boolean; candidates: boolean }) => {
    if (busy.current) return;
    busy.current = true;
    setScanning(true);
    setScanError(null);
    try {
      const calls: Promise<Response>[] = [];
      if (opts.watchlist) calls.push(fetch("/api/scan/watchlist", { method: "POST" }));
      if (opts.candidates) calls.push(fetch("/api/scan/candidates", { method: "POST" }));
      const res = await Promise.all(calls);
      const bad = res.find((r) => !r.ok);
      if (bad) setScanError(`Scan failed (HTTP ${bad.status})`);
      else {
        const bodies = await Promise.all(res.map((r) => r.json()));
        const errs = bodies.flatMap((b) => b.errors ?? []);
        if (errs.length) setScanError(String(errs[0]).slice(0, 140));
      }
      setLastSiteScan(new Date().toISOString());
      bump();
    } catch (e) {
      setScanError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      busy.current = false;
      setScanning(false);
    }
  }, [bump]);

  const scanNow = useCallback(() => runScan({ watchlist: true, candidates: true }), [runScan]);

  // Boot: user, settings, runs; fallback rescan if background data is stale; first candidate scan.
  useEffect(() => {
    let alive = true;
    (async () => {
      const db = supabase();
      const { data: u } = await db.auth.getUser();
      if (!u.user || !alive) return;
      userId.current = u.user.id;
      const { data: row } = await db.from("settings").select("data").maybeSingle();
      const s = mergeSettings(row?.data);
      if (!row?.data?.timezone) s.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      if (!alive) return;
      setSettings(s);
      await loadRuns();
      setReady(true);
      const { data: r } = await db.from("scan_runs").select("finished_at,status").eq("status", "ok").order("started_at", { ascending: false }).limit(1);
      const last = r?.[0]?.finished_at ? new Date(r[0].finished_at).getTime() : 0;
      const stale = Date.now() - last > s.staleMinutes * 60_000;
      runScan({ watchlist: stale, candidates: true });
    })();
    return () => { alive = false; };
  }, [loadRuns, runScan]);

  // Clock + periodic refresh while the tab is visible.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    const r = setInterval(() => { if (document.visibilityState === "visible") loadRuns(); }, 30_000);
    const c = setInterval(() => { if (document.visibilityState === "visible") runScan({ watchlist: false, candidates: true }); }, 120_000);
    return () => { clearInterval(t); clearInterval(r); clearInterval(c); };
  }, [loadRuns, runScan]);

  // Alert banner: quiet, no sound or motion. Quiet hours and the hourly cap apply to the banner;
  // every alert is still saved to the inbox.
  useEffect(() => {
    if (!ready) return;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const { data } = await supabase().from("alerts").select("*").is("read_at", null).order("created_at", { ascending: false }).limit(20);
      const rows = (data as AlertRow[]) ?? [];
      const fresh = rows.filter((a) => !seenAlerts.current.has(a.id));
      const first = seenAlerts.current.size === 0 && fresh.length && !sessionStorage.getItem("pf.alertsInit");
      rows.forEach((a) => seenAlerts.current.add(a.id));
      sessionStorage.setItem("pf.alertsInit", "1");
      if (!fresh.length || first) return;
      if (inQuiet(settings.alerts.quietStart, settings.alerts.quietEnd, new Date())) return;
      let shown: number[] = [];
      try { shown = (JSON.parse(localStorage.getItem("pf.bannerLog") ?? "[]") as number[]).filter((t) => Date.now() - t < 3_600_000); } catch {}
      if (shown.length >= settings.alerts.maxPerHour) return;
      try { localStorage.setItem("pf.bannerLog", JSON.stringify([...shown, Date.now()])); } catch {}
      setBanner(fresh[0]);
    };
    check();
    const i = setInterval(check, 45_000);
    return () => clearInterval(i);
  }, [ready, tick, settings.alerts.quietStart, settings.alerts.quietEnd, settings.alerts.maxPerHour]);

  const saveSettings = useCallback(async (s: Settings) => {
    if (!userId.current) return "Not signed in";
    const { error } = await supabase().from("settings").upsert({ user_id: userId.current, data: s, updated_at: new Date().toISOString() });
    if (error) return error.message;
    setSettings(s);
    bump();
    return null;
  }, [bump]);

  const lastOk = useMemo(() => runs.find((r) => r.status === "ok" && r.finished_at) ?? null, [runs]);
  const bgStale = !lastOk || now - new Date(lastOk.finished_at!).getTime() > settings.staleMinutes * 60_000;
  const latestDone = runs.find((r) => r.status !== "running") ?? null;
  const bgFailed = latestDone?.status === "error" ? latestDone : null;

  const value: Ctx = {
    settings, saveSettings, now, runs, lastOk, lastSiteScan, bgStale, bgFailed, scanning, scanError,
    scanNow, tick, bump, banner, dismissBanner: () => setBanner(null), ready,
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}

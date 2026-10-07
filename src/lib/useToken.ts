"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { evaluate } from "@shared/engine.ts";
import { activePreset } from "@shared/defaults.ts";
import type { Settings, TokenScan } from "@shared/types.ts";

/** Re-evaluate a stored scan against the currently active preset, as of the scan time. */
export function reEvaluate(scan: TokenScan, settings: Settings): TokenScan {
  const preset = activePreset(settings);
  return {
    ...scan,
    presetId: preset.id,
    evaluation: evaluate(scan.metrics, scan.chain, preset, new Date(scan.scannedAt).getTime()),
  };
}

export async function loadScans(mints?: string[], sinceMs?: number): Promise<TokenScan[]> {
  let q = supabase().from("token_scans").select("data,scanned_at");
  if (mints) q = q.in("mint", mints);
  if (sinceMs) q = q.gte("scanned_at", new Date(Date.now() - sinceMs).toISOString());
  const { data } = await q.order("scanned_at", { ascending: false }).limit(200);
  return (data ?? []).map((r: { data: unknown; scanned_at: string }) => ({ ...(r.data as TokenScan), scannedAt: r.scanned_at }));
}

export function useScansFor(mints: string[], tick: number) {
  const key = mints.join(",");
  const [scans, setScans] = useState<Record<string, TokenScan>>({});
  const reload = useCallback(async () => {
    const list = key ? await loadScans(key.split(",")) : [];
    setScans(Object.fromEntries(list.map((s) => [s.metrics.mint, s])));
  }, [key]);
  useEffect(() => { reload(); }, [reload, tick]);
  return scans;
}

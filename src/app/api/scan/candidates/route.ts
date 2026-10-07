import { NextResponse } from "next/server";
import { session, rpcUrl } from "@/lib/api";
import { scanCandidates } from "@shared/scan.ts";

export const maxDuration = 120;

/** Broader feed scan. Runs only while the site is open or on "Scan now". */
export async function POST() {
  const s = await session();
  if ("error" in s) return s.error;
  const r = await scanCandidates(s.db, s.user.id, { rpcUrl: rpcUrl(), preset: s.preset, source: "site", settings: s.settings });
  return NextResponse.json({ ...r, at: new Date().toISOString() });
}

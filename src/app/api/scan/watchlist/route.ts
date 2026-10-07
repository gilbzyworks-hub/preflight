import { NextResponse } from "next/server";
import { session, rpcUrl } from "@/lib/api";
import { scanForUser } from "@shared/scan.ts";

export const maxDuration = 120;

/** Fallback/manual rescan of watchlist + open paper positions (same code as the background job). */
export async function POST() {
  const s = await session();
  if ("error" in s) return s.error;
  const r = await scanForUser(s.db, s.user.id, { rpcUrl: rpcUrl(), source: "site" });
  return NextResponse.json({ ...r, at: new Date().toISOString() });
}

import { NextResponse } from "next/server";
import { session } from "@/lib/api";
import { evaluateGuardrails } from "@/lib/guardrails";
import type { TokenScan } from "@shared/types.ts";

/** Preview of guardrail status for the log-trade form (read-only; authoritative check repeats on submit). */
export async function GET(req: Request) {
  const s = await session();
  if ("error" in s) return s.error;
  const q = new URL(req.url).searchParams;
  const mint = q.get("mint") ?? "";
  const kind = q.get("kind") === "real" ? "real" : "paper";
  const size = q.get("size") ? Number(q.get("size")) : null;
  const { data } = await s.db.from("token_scans").select("data").eq("mint", mint).maybeSingle();
  const lines = await evaluateGuardrails(s.db, s.user.id, s.settings, { kind, mint, sizeUsd: size, scan: (data?.data as TokenScan) ?? null });
  return NextResponse.json({ lines });
}

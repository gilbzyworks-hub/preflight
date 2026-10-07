import { NextResponse } from "next/server";
import { session } from "@/lib/api";
import { looksLikeMint, searchSolana } from "@shared/dex.ts";

/** Manual search / paste. Addresses resolve directly; text queries return Solana matches. */
export async function GET(req: Request) {
  const s = await session();
  if ("error" in s) return s.error;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ results: [] });
  if (looksLikeMint(q)) return NextResponse.json({ mint: q, results: [] });
  try {
    const results = await searchSolana(q);
    return NextResponse.json({
      results: results.map((m) => ({ mint: m.mint, symbol: m.symbol, name: m.name, liquidityUsd: m.liquidityUsd, fdv: m.fdv })),
    });
  } catch (e) {
    return NextResponse.json({ results: [], error: e instanceof Error ? e.message : "Search failed" }, { status: 502 });
  }
}

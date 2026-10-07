import { NextResponse } from "next/server";
import { session, rpcUrl } from "@/lib/api";
import { saveScans, scanTokens } from "@shared/scan.ts";
import { logCoverage, observeScans } from "@shared/outcomes.ts";
import { looksLikeMint } from "@shared/dex.ts";

export const maxDuration = 90;

/** Fresh checklist for one token (market data + on-chain checks), saved as the latest site scan. */
export async function GET(req: Request, ctx: { params: Promise<{ mint: string }> }) {
  const s = await session();
  if ("error" in s) return s.error;
  const { mint } = await ctx.params;
  if (!looksLikeMint(mint)) return NextResponse.json({ error: "Not a valid Solana token address" }, { status: 400 });
  // A checklist the user opened always gets the expensive checks (creator and early buyers are cached once found).
  const { scans, errors } = await scanTokens([mint], { rpcUrl: rpcUrl(), preset: s.preset, source: "site", settings: s.settings, db: s.db, userId: s.user.id, force: new Set([mint]) });
  const scan = scans.get(mint)!;
  await saveScans(s.db, s.user.id, [scan]);

  // Outcome capture for a manual lookup. Never allowed to break the checklist itself.
  try {
    const { data: wl } = await s.db.from("watchlist").select("mint").eq("user_id", s.user.id);
    const watch = new Set<string>((wl ?? []).map((w: { mint: string }) => w.mint));
    const { written } = await observeScans(s.db, s.user.id, s.preset, [{ scan, sources: watch.has(mint) ? ["watchlist"] : ["manual"], shown: false }], watch);
    await logCoverage(s.db, s.user.id, { kind: "manual", tokensReturned: 1, tokensWithData: scan.metrics.dataOk ? 1 : 0, observationsWritten: written, errors });
  } catch (e) {
    errors.push(`Outcome capture: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Optional third-party opinion; never part of the checks.
  let thirdParty: { source: string; risks: { name: string; level: string }[] } | null = null;
  if (new URL(req.url).searchParams.get("rc") === "1") {
    try {
      const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j = await r.json();
        thirdParty = {
          source: "RugCheck",
          risks: (Array.isArray(j.risks) ? j.risks : []).slice(0, 8).map((x: { name?: string; level?: string }) => ({
            name: String(x.name ?? "Unnamed"),
            level: String(x.level ?? "info"),
          })),
        };
      }
    } catch {
      /* optional; ignore */
    }
  }
  return NextResponse.json({ scan, errors, thirdParty });
}

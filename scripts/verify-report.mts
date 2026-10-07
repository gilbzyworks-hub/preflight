// Prints a Solscan-checkable report for 5 real tokens from the current feed (read-only).
// Usage: SOLANA_RPC_URL=... npx tsx scripts/verify-report.mts
import { fetchCandidates, fetchMetrics } from "../supabase/functions/_shared/dex.ts";
import { DEFAULT_PRESET, DEFAULT_SETTINGS } from "../supabase/functions/_shared/defaults.ts";
import { passesMarketChecks, scanTokens } from "../supabase/functions/_shared/scan.ts";
import type { TokenScan } from "../supabase/functions/_shared/types.ts";

const RPC = process.env.SOLANA_RPC_URL!;
const sol = (a: string) => `https://solscan.io/account/${a}`;
const redact = (s: string) => s.split(RPC).join("<rpc>");

const { candidates } = await fetchCandidates();
const { metrics } = await fetchMetrics(candidates.map((c) => c.mint));
const pool = [...metrics.values()].filter((m) => m.dataOk && passesMarketChecks(m, DEFAULT_PRESET)).sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, 24).map((m) => m.mint);

// Cheap pass first, to pick a varied sample (Token-2022, multi-pool, ...).
const cheap = await scanTokens(pool, { rpcUrl: RPC, preset: DEFAULT_PRESET, source: "site", settings: { ...DEFAULT_SETTINGS, rpcBudget: { cheapPerScan: 400, expensivePerScan: 0, creatorPageBudget: 10 } } });
const all = [...cheap.scans.values()].filter((s) => s.chain.holders);
const pick: TokenScan[] = [];
const add = (s?: TokenScan) => { if (s && !pick.includes(s) && pick.length < 5) pick.push(s); };
add(all.find((s) => s.chain.tokenProgram === "token-2022"));
add(all.filter((s) => s.metrics.pools.length >= 2).sort((a, b) => b.metrics.pools.length - a.metrics.pools.length)[0]);
add(all.find((s) => s.chain.holders!.excludedCount > 0));
add(all.find((s) => s.chain.tokenProgram === "token-2022" && s.chain.extensions!.length > 2));
for (const s of all) add(s);

// Full pass (with creator + clustering) for the chosen five.
const mints = pick.map((s) => s.metrics.mint);
const full = await scanTokens(mints, { rpcUrl: RPC, preset: DEFAULT_PRESET, source: "site", force: new Set(mints), settings: { ...DEFAULT_SETTINGS, rpcBudget: { cheapPerScan: 100, expensivePerScan: 900, creatorPageBudget: 10 } } });

let n = 0;
for (const mint of mints) {
  const s = full.scans.get(mint)!;
  const m = s.metrics, c = s.chain, h = c.holders;
  console.log(`\n## ${++n}. ${m.symbol ?? "?"} (${m.name ?? "?"})`);
  console.log(`- Mint: ${mint}  ${sol(mint)}`);
  console.log(`- Token program: ${c.tokenProgram}${c.tokenProgram === "token-2022" ? ` (${c.extensions?.length ?? "?"} extensions)` : ""}`);
  console.log(`- Authorities revoked: mint=${c.mintAuthorityRevoked}, freeze=${c.freezeAuthorityRevoked}`);
  if (h) {
    console.log(`- Top-10 holders: ${h.rawTop10Pct.toFixed(2)}% raw / ${h.adjustedTop10Pct.toFixed(2)}% adjusted (supply ${h.supply.toLocaleString()}; ${h.excludedCount} excluded${h.partial ? "; PARTIAL" : ""}; unclassified in top 10: ${h.unclassifiedInTop10})`);
    console.log("  | # | token account | owner | label | % | basis |\n  |---|---|---|---|---|---|");
    h.entries.slice(0, 12).forEach((e, i) => console.log(`  | ${i + 1} | ${e.tokenAccount} | ${e.owner ?? "?"} | ${e.kind} | ${e.pct.toFixed(2)} | ${e.basis} |`));
  }
  console.log(`- Main pool: ${m.dexId} / quote ${m.quoteSymbol}, pair ${m.pairAddress}  liquidity $${Math.round(m.liquidityUsd ?? 0).toLocaleString()}; ${m.pools.length} pools, total $${Math.round(m.totalLiquidityUsd ?? 0).toLocaleString()}, main pool share ${m.mainPoolShare?.toFixed(1)}%`);
  for (const p of m.pools.slice(0, 6)) console.log(`  - ${p.dexId} / ${p.quoteSymbol}: $${Math.round(p.liquidityUsd ?? 0).toLocaleString()}  ${p.pairAddress}`);
  const ex = (c.extensions ?? []).filter((e) => !["metadataPointer", "tokenMetadata"].includes(e.name));
  console.log(`- Extensions: ${c.extensions === null ? "UNREADABLE" : c.extensions.length ? c.extensions.map((e) => `${e.name}${e.authority ? ` (authority ${e.authority})` : ""}`).join(", ") : "none"}${ex.length === 0 && c.extensions?.length ? " (metadata only)" : ""}`);
  const cr = c.creator;
  console.log(`- Creator: ${cr?.address ? `${cr.address}  ${sol(cr.address)}  holds ${cr.holdingPct?.toFixed(3)}% (identified by: ${cr.method})` : `${cr?.status}: ${cr?.reason}`}`);
  const k = c.clustering;
  console.log(`- Clustering: ${k?.status === "ok" ? `${k.pctFirst3Slots?.toFixed(2)}% of supply in first 3 slots by ${k.buyersFirst3Slots} wallets; ${k.txsExamined} txs over ${k.slotsExamined} slots from ref slot ${k.creationSlot}; largest group sharing a funder: ${k.maxSharedFunding ?? "n/a"} (source: ${k.source})` : `${k?.status}: ${k?.reason}`}`);
  console.log(`- Checklist: ${s.evaluation.checks.map((x) => `${x.id}=${x.status}`).join(", ")}`);
}
console.log(redact(`\nRPC requests used: cheap pass ${cheap.stats.cheapUsed}, full pass ${full.stats.cheapUsed + full.stats.expensiveUsed}`));

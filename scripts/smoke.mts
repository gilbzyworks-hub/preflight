import { fetchCandidates, fetchMetrics, emptyMetrics } from "../supabase/functions/_shared/dex.ts";
import { getChainData, emptyChain, RpcBudget } from "../supabase/functions/_shared/rpc.ts";
import { evaluate } from "../supabase/functions/_shared/engine.ts";
import { passesMarketChecks } from "../supabase/functions/_shared/scan.ts";
import { DEFAULT_PRESET } from "../supabase/functions/_shared/defaults.ts";

const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const { candidates, errors } = await fetchCandidates();
console.log("candidates", candidates.length, "boosted", candidates.filter((c) => c.boosted).length, errors);
const { metrics, errors: e2 } = await fetchMetrics(candidates.map((c) => c.mint));
console.log("metrics ok", [...metrics.values()].filter((m) => m.dataOk).length, e2);
const survivors = [...metrics.values()].filter((m) => m.dataOk && passesMarketChecks(m, DEFAULT_PRESET));
console.log("pass market checks:", survivors.length);

// Well-known mints for an end-to-end sample: BONK, JUP
for (const mint of ["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"]) {
  const { metrics: mm } = await fetchMetrics([mint], new Set(), { allPools: true });
  const m = mm.get(mint)!;
  const chain = await getChainData(RPC, mint, { budget: new RpcBudget(50), poolAddresses: new Set(m.pools.map((p) => p.pairAddress).filter((x): x is string => !!x)) });
  const ev = evaluate(m, chain, DEFAULT_PRESET);
  console.log(m.symbol, ev.counts, ev.checks.map((c) => `${c.id}:${c.status}(${c.value})`).join(" "), chain.errors);
}

// Acceptance: missing data => UNKNOWN, never PASS
const ev = evaluate(emptyMetrics("x"), emptyChain("down"), DEFAULT_PRESET);
const bad = ev.checks.filter((c) => c.status === "PASS");
console.log("all-missing statuses:", ev.checks.map((c) => c.status).join(","), "unknownRow", ev.unknownRow.status, bad.length === 0 ? "OK no PASS" : "FAIL");

// Records real RPC / DEX Screener responses into tests/fixtures and checks the vault-authority seeds against chain.
// Usage: SOLANA_RPC_URL=... npx tsx scripts/record-fixtures.mts   (read-only; throttled to stay under free-tier limits)
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchCandidates, fetchMetrics } from "../supabase/functions/_shared/dex.ts";
import { passesMarketChecks } from "../supabase/functions/_shared/scan.ts";
import { DEFAULT_PRESET } from "../supabase/functions/_shared/defaults.ts";
import { dexAuthorities } from "../supabase/functions/_shared/holders.ts";
import { PUMP_BONDING_CURVE_SEED, PUMP_PROGRAM } from "../supabase/functions/_shared/solana-config.ts";
import { base58Decode, findProgramAddress } from "../supabase/functions/_shared/solana-keys.ts";

const RPC = process.env.SOLANA_RPC_URL!;
const OUT = new URL("../tests/fixtures/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(method: string, params: unknown[]) {
  await sleep(300);
  for (let a = 0; a < 4; a++) {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const t = await r.text();
    if (r.status === 429) { await sleep(2000 * (a + 1)); continue; }
    const j = JSON.parse(t);
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
  throw new Error("rate limited");
}
const save = (name: string, data: unknown) => { writeFileSync(OUT + name, JSON.stringify(data, null, 1)); console.log("saved", name); };
const trimPair = (p: any) => ({ chainId: p.chainId, dexId: p.dexId, url: p.url, pairAddress: p.pairAddress, baseToken: p.baseToken, quoteToken: p.quoteToken, priceUsd: p.priceUsd, fdv: p.fdv, marketCap: p.marketCap, volume: p.volume, liquidity: p.liquidity, pairCreatedAt: p.pairCreatedAt, txns: p.txns, priceChange: p.priceChange });
const pairsOf = async (mint: string) => (await (await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`)).json()) as any[];

// A. real Token-2022 mint with a transfer fee, hook, permanent delegate (PYUSD) and B. a classic mint (BONK)
save("pyusd-mint.json", await rpc("getAccountInfo", ["2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", { encoding: "jsonParsed" }]));
save("bonk-mint.json", await rpc("getAccountInfo", ["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", { encoding: "jsonParsed" }]));
// C. a token with split liquidity (BONK has many pools)
save("bonk-pools.json", (await pairsOf("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")).filter((p) => p.chainId === "solana").map(trimPair));

// D. holder data for several feed tokens + authority-seed check
const { candidates } = await fetchCandidates();
const { metrics } = await fetchMetrics(candidates.map((c) => c.mint));
const sample = [...metrics.values()].filter((m) => m.dataOk && passesMarketChecks(m, DEFAULT_PRESET)).sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, 8);
const auths = await dexAuthorities();
console.log("derived authorities:", [...auths].map(([a, l]) => `${l}=${a.slice(0, 6)}…`).join(", "));
const seen: Record<string, number> = {};
let savedHolders = false, savedLaunch = false;
for (const m of sample) {
  try {
    const pools = (await pairsOf(m.mint)).filter((p) => p.chainId === "solana");
    const supply = await rpc("getTokenSupply", [m.mint]);
    const largest = await rpc("getTokenLargestAccounts", [m.mint]);
    const accs = await rpc("getMultipleAccounts", [largest.value.map((l: any) => l.address), { encoding: "jsonParsed" }]);
    const owners = [...new Set(accs.value.map((a: any) => a?.data?.parsed?.info?.owner).filter(Boolean))] as string[];
    const oacc = await rpc("getMultipleAccounts", [owners, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    const ownerPrograms: Record<string, string | null> = {};
    owners.forEach((o, i) => (ownerPrograms[o] = oacc.value[i]?.owner ?? null));
    for (const o of owners) {
      const tag = auths.has(o) ? `authority:${auths.get(o)}` : ownerPrograms[o] === null ? "off-curve-or-empty-no-account" : "has-account";
      seen[tag] = (seen[tag] ?? 0) + 1;
    }
    const hasPool = largest.value.some((l: any, i: number) => { const o = accs.value[i]?.data?.parsed?.info?.owner; return auths.has(o) || (ownerPrograms[o] && ownerPrograms[o] !== "11111111111111111111111111111111"); });
    console.log(m.symbol, m.mint.slice(0, 6), "pools:", pools.length, "top-20 owners resolved:", owners.length, hasPool ? "(has program-owned/pool holder)" : "");
    if (!savedHolders && hasPool) {
      save("lp-vault-holders.json", { mint: m.mint, supply, largest, accounts: accs, ownerPrograms, pools: pools.map(trimPair) });
      savedHolders = true;
    }
    if (!savedLaunch && pools.some((p) => p.dexId === "pumpswap")) {
      // E. launch data for a pump.fun token: bonding curve account, oldest signatures, early transactions
      const curve = (await findProgramAddress([PUMP_BONDING_CURVE_SEED, base58Decode(m.mint)], PUMP_PROGRAM)).address;
      const curveAcc = await rpc("getAccountInfo", [curve, { encoding: "base64" }]);
      let before: string | undefined, tail: any[] = [], reached = false;
      for (let p = 0; p < 10; p++) {
        const page = await rpc("getSignaturesForAddress", [curve, { limit: 1000, ...(before ? { before } : {}) }]);
        tail = [...page, ...tail].slice(-100);
        if (page.length < 1000) { reached = true; break; }
        before = page[page.length - 1].signature;
      }
      if (reached && curveAcc.value) {
        const asc = [...tail].filter((t) => t.err == null).sort((a, b) => a.slot - b.slot).slice(0, 12);
        const txs = [];
        for (const s of asc) {
          const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
          txs.push({ slot: s.slot, signature: s.signature, transaction: { message: { accountKeys: tx.transaction.message.accountKeys, instructions: tx.transaction.message.instructions } }, meta: { preTokenBalances: tx.meta.preTokenBalances, postTokenBalances: tx.meta.postTokenBalances, innerInstructions: tx.meta.innerInstructions } });
        }
        save("pump-launch.json", { mint: m.mint, curve, curveAccount: curveAcc, supply, txs });
        savedLaunch = true;
      } else console.log("  curve history not reachable for", m.symbol);
    }
  } catch (e) { console.log(m.symbol, "error:", (e as Error).message); }
}
console.log("\nowner tags across sampled top-20 holders:", seen);
console.log("fixtures:", { savedHolders, savedLaunch });

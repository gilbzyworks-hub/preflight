// Read-only feasibility spike. Prints findings; changes nothing. Usage: SOLANA_RPC_URL=... npx tsx scripts/spike-solana.mts
import { fetchCandidates, fetchMetrics } from "../supabase/functions/_shared/dex.ts";
import { passesMarketChecks } from "../supabase/functions/_shared/scan.ts";
import { DEFAULT_PRESET } from "../supabase/functions/_shared/defaults.ts";
import * as C from "../supabase/functions/_shared/solana-config.ts";

const RPC = process.env.SOLANA_RPC_URL!;
let calls = 0;
const redact = (s: string) => s.replace(RPC, "<rpc>");
async function rpc(method: string, params: unknown[]) {
  calls++;
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(redact(j.error.message));
  return j.result;
}
const log = (...a: unknown[]) => console.log(...a.map((x) => (typeof x === "string" ? redact(x) : x)));

// 1. Every configured address exists on-chain; programs must be executable.
const all = { ...C.DEX_PROGRAMS, ...C.LOCK_PROGRAMS, token: "", };
const ids = [C.TOKEN_PROGRAM, C.TOKEN_2022_PROGRAM, ...Object.keys(C.DEX_PROGRAMS), ...Object.keys(C.LOCK_PROGRAMS)];
const res = await rpc("getMultipleAccounts", [ids, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
log("== program IDs on-chain ==");
ids.forEach((id, i) => {
  const a = res.value[i];
  const name = id === C.TOKEN_PROGRAM ? "SPL Token" : id === C.TOKEN_2022_PROGRAM ? "Token-2022" : (C.DEX_PROGRAMS as any)[id] ?? (C.LOCK_PROGRAMS as any)[id];
  log(`${a?.executable ? "OK " : "BAD"} ${name} exec=${a?.executable} owner=${a?.owner?.slice(0, 8)}`);
});
void all;

// 2. Sample tokens from the real feed
const { candidates } = await fetchCandidates();
const { metrics } = await fetchMetrics(candidates.map((c) => c.mint));
const sample = [...metrics.values()].filter((m) => m.dataOk && passesMarketChecks(m, DEFAULT_PRESET)).sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, 20);
log(`\n== ${sample.length} feed tokens passing market checks ==`);

const PAGES = 10;
const rows: any[] = [];
for (const m of sample) {
  const row: any = { symbol: m.symbol, mint: m.mint };
  const before = calls;
  try {
    const info = await rpc("getAccountInfo", [m.mint, { encoding: "jsonParsed" }]);
    row.program = info.value.owner === C.TOKEN_2022_PROGRAM ? "token-2022" : info.value.owner === C.TOKEN_PROGRAM ? "spl-token" : `OTHER ${info.value.owner}`;
    row.extensions = (info.value.data.parsed.info.extensions ?? []).map((e: any) => e.extension);
    const supply = await rpc("getTokenSupply", [m.mint]);
    const largest = (await rpc("getTokenLargestAccounts", [m.mint])).value as any[];
    const accs = (await rpc("getMultipleAccounts", [largest.map((l) => l.address), { encoding: "jsonParsed" }])).value;
    const owners = accs.map((a: any) => a?.data?.parsed?.info?.owner as string | undefined);
    const ownerAccs = (await rpc("getMultipleAccounts", [[...new Set(owners.filter(Boolean))], { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])).value;
    const ownerMap = new Map([...new Set(owners.filter(Boolean))].map((o, i) => [o, ownerAccs[i]]));
    const total = Number(supply.value.uiAmountString);
    row.top = largest.map((l, i) => {
      const o = owners[i]; const oa = ownerMap.get(o as string);
      const prog = oa?.owner as string | undefined;
      const kind = !o ? "?" : C.BURN_ADDRESSES[o] ? "burn" : prog && C.DEX_PROGRAMS[prog] ? `pool(${C.DEX_PROGRAMS[prog]})` : prog && C.LOCK_PROGRAMS[prog] ? `lock(${C.LOCK_PROGRAMS[prog]})` : oa && prog !== "11111111111111111111111111111111" ? `program-owned? owner-acct-program=${prog?.slice(0, 6)}` : oa === null ? "no-owner-account(off-curve or empty)" : "wallet-or-system";
      return { pct: +((Number(l.uiAmountString) / total) * 100).toFixed(2), kind };
    });
    row.raw10 = +row.top.slice(0, 10).reduce((a: number, t: any) => a + t.pct, 0).toFixed(1);
    const ex = (t: any) => t.kind.startsWith("pool") || t.kind === "burn" || t.kind.startsWith("lock");
    row.adj = +row.top.filter((t: any) => !ex(t)).slice(0, 10).reduce((a: number, t: any) => a + t.pct, 0).toFixed(1);
    row.adjCount = row.top.filter((t: any) => !ex(t)).slice(0, 10).length;
    row.excluded = row.top.filter(ex).map((t: any) => `${t.kind} ${t.pct}%`);
    row.unclassified = row.top.filter((t: any) => t.kind.startsWith("program-owned")).length;
    row.cheapCalls = calls - before;

    // creation reach
    let beforeSig: string | undefined, total_sigs = 0, reached = false, pagesUsed = 0, oldest: any;
    for (let p = 0; p < PAGES; p++) {
      const page = await rpc("getSignaturesForAddress", [m.mint, { limit: 1000, ...(beforeSig ? { before: beforeSig } : {}) }]);
      pagesUsed++; total_sigs += page.length;
      if (page.length) { oldest = page[page.length - 1]; beforeSig = oldest.signature; }
      if (page.length < 1000) { reached = true; break; }
    }
    row.creation = { reached, pagesUsed, sigsSeen: total_sigs, oldestSlot: oldest?.slot, ageDays: oldest?.blockTime ? +((Date.now() / 1000 - oldest.blockTime) / 86400).toFixed(1) : null };
  } catch (e) { row.error = redact(e instanceof Error ? e.message : String(e)); }
  rows.push(row);
  log(`${row.symbol} ${m.mint.slice(0, 6)}… ${row.program} ext=[${(row.extensions ?? []).join(",")}] raw10=${row.raw10}% adj10=${row.adj}% (${row.adjCount} holders) unclassified=${row.unclassified} excl=[${(row.excluded ?? []).join("; ")}] cheapCalls=${row.cheapCalls} creation=${JSON.stringify(row.creation)} ${row.error ?? ""}`);
}
const ok = rows.filter((r) => r.creation);
log(`\ncreation tx reached within ${PAGES} pages: ${ok.filter((r) => r.creation.reached).length}/${ok.length}`);
log(`token-2022: ${rows.filter((r) => r.program === "token-2022").length}, with ext: ${rows.filter((r) => r.extensions?.length).length}`);
log(`total RPC calls: ${calls}`);

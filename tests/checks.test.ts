import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { toMetrics } from "@shared/dex.ts";
import { evaluate } from "@shared/engine.ts";
import { DEFAULT_PRESET } from "@shared/defaults.ts";
import { extensionRows, parseExtensions } from "@shared/extensions.ts";
import { classifyHolders, dexAuthorities, getHolderData, type HolderInput } from "@shared/holders.ts";
import { buyerDeltas, clusterMetrics, creatorFromCreationTx, fundingSource, largestSharedFunding, parseBondingCurveCreator } from "@shared/launch.ts";
import { getChainData, RpcBudget } from "@shared/rpc.ts";
import type { CheckRule, ExtensionRuleKey, ExtensionInfo } from "@shared/types.ts";
import { chain, holders as holdersOf, metrics, NOW } from "./helpers.ts";

// Recorded from chain / DEX Screener by scripts/record-fixtures.mts.
const fx = <T = any>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const rules = DEFAULT_PRESET.extensions;
const rule = (k: ExtensionRuleKey, o: Partial<CheckRule>): Record<ExtensionRuleKey, CheckRule> => ({ ...rules, [k]: { ...rules[k], ...o } });
const ext = (name: string, state: object) => ({ extension: name, state });

describe("Token program and extensions", () => {
  it("classic SPL token: no extensions, PASS with the standard label", () => {
    const parsed = fx("bonk-mint.json").value.data.parsed.info;
    expect(parseExtensions(parsed)).toEqual([]);
    const e = evaluate(metrics(), chain({ tokenProgram: "spl-token", extensions: [] }), DEFAULT_PRESET, NOW);
    const row = e.checks.find((c) => c.id === "tokenProgram")!;
    expect(row.status).toBe("PASS");
    expect(row.value).toBe("Standard token program, no extensions");
    expect(e.checks.some((c) => String(c.id).startsWith("ext:"))).toBe(false);
  });

  it("real Token-2022 mint (PYUSD): one row per relevant extension, benign ones skipped", () => {
    const exts = parseExtensions(fx("pyusd-mint.json").value.data.parsed.info)!;
    expect(exts.map((x) => x.name)).toContain("transferFeeConfig");
    const rows = extensionRows(exts, rules);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.permanentDelegate.status).toBe("FAIL"); // Required by default
    expect(by.permanentDelegate.value).toContain("2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk");
    expect(by.transferFeeConfig.status).toBe("WARN"); // 0 bps today: warning, not fail
    expect(by.transferFeeConfig.notes.join(" ")).toContain("Fee authority: 2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk");
    expect(by.transferHook.status).toBe("WARN");
    expect(by.mintCloseAuthority.status).toBe("WARN");
    expect(by.confidentialTransferMint.label).toBe("Unrecognised extension: confidentialTransferMint");
    expect(by.confidentialTransferMint.status).toBe("WARN");
    expect(by.metadataPointer).toBeUndefined();
    expect(by.tokenMetadata).toBeUndefined();
  });

  it("transfer fee: WARN with current and scheduled fee, FAIL above the configured maximum", () => {
    const mk = (bps: number): ExtensionInfo[] =>
      parseExtensions({ extensions: [ext("transferFeeConfig", { transferFeeConfigAuthority: "Auth1", withdrawWithheldAuthority: "Auth1",
        olderTransferFee: { epoch: 1, maximumFee: 10, transferFeeBasisPoints: 100 }, newerTransferFee: { epoch: 9, maximumFee: 99, transferFeeBasisPoints: bps } })] })!;
    const low = extensionRows(mk(200), rules)[0];
    expect(low.status).toBe("WARN");
    expect(low.value).toContain("2%");
    expect(low.value).toContain("current 1%");
    expect(extensionRows(mk(500), rules)[0].status).toBe("WARN"); // exactly 5% is not above 5%
    expect(extensionRows(mk(501), rules)[0].status).toBe("FAIL");
    expect(extensionRows(mk(501), rule("transferFeeConfig", { failAbove: 10 }))[0].status).toBe("WARN"); // editable
  });

  it("maps NonTransferable, PermanentDelegate, frozen default state and paused tokens to FAIL; severities are editable", () => {
    const one = (name: string, state: object) => extensionRows(parseExtensions({ extensions: [ext(name, state)] })!, rules)[0];
    expect(one("nonTransferable", {}).status).toBe("FAIL");
    expect(one("permanentDelegate", { delegate: "D1" }).status).toBe("FAIL");
    expect(one("defaultAccountState", { accountState: "frozen" }).status).toBe("FAIL");
    expect(one("defaultAccountState", { accountState: "initialized" }).status).toBe("PASS");
    expect(one("pausableConfig", { authority: "A1", paused: false }).status).toBe("WARN");
    expect(one("pausableConfig", { authority: "A1", paused: true }).status).toBe("FAIL");
    expect(one("transferHook", { authority: "A1", programId: "Hook1" }).value).toContain("Hook1");
    const off = extensionRows(parseExtensions({ extensions: [ext("nonTransferable", {})] })!, rule("nonTransferable", { severity: "off" }))[0];
    expect(off.status).toBe("OFF");
    const warn = extensionRows(parseExtensions({ extensions: [ext("permanentDelegate", { delegate: "D1" })] })!, rule("permanentDelegate", { severity: "warning" }))[0];
    expect(warn.status).toBe("WARN");
  });

  it("an unreadable extension list is null (UNKNOWN), never an empty list", () => {
    expect(parseExtensions({ extensions: "garbage" })).toBeNull();
    expect(parseExtensions({ extensions: [{ nope: 1 }] })).toBeNull();
  });

  it("extension FAIL rows count as failed required checks in the evaluation", () => {
    const exts = parseExtensions(fx("pyusd-mint.json").value.data.parsed.info)!;
    const e = evaluate(metrics(), chain({ tokenProgram: "token-2022", extensions: exts }), DEFAULT_PRESET, NOW);
    expect(e.checks.find((c) => c.id === "ext:permanentDelegate")!.status).toBe("FAIL");
    expect(e.matches).toBe(false);
    expect(e.checks.find((c) => c.id === "tokenProgram")!.value).toMatch(/^Token-2022, \d+ extensions$/);
  });
});

describe("Main pool and split liquidity", () => {
  const pairs = fx<any[]>("bonk-pools.json");
  const m = toMetrics("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", pairs, false, true);

  it("picks the pool with the highest liquidity, regardless of quote token or order", () => {
    const top = Math.max(...pairs.map((p) => p.liquidity?.usd ?? 0));
    expect(m.liquidityUsd).toBe(top);
    expect(m.pools[0].liquidityUsd).toBe(top);
    expect(m.pairAddress).toBe(pairs.find((p) => p.liquidity?.usd === top).pairAddress);
    const shuffled = toMetrics(m.mint, [...pairs].reverse(), false, true);
    expect(shuffled.pairAddress).toBe(m.pairAddress);
  });

  it("keeps every pool and computes total liquidity and the main pool's share", () => {
    expect(m.pools.length).toBe(pairs.length);
    const total = pairs.reduce((a, p) => a + (p.liquidity?.usd ?? 0), 0);
    expect(m.totalLiquidityUsd).toBeCloseTo(total, 2);
    expect(m.mainPoolShare).toBeCloseTo((m.liquidityUsd! / total) * 100, 6);
    expect(m.poolsComplete).toBe(true);
    expect(m.quoteSymbol).toBe(m.pools[0].quoteSymbol);
  });

  it("market data and age come from the main pool; the earliest pair is kept separately", () => {
    const main = pairs.find((p) => p.pairAddress === m.pairAddress);
    expect(m.volume24h).toBe(main.volume?.h24 ?? null);
    expect(m.pairCreatedAt).toBe(main.pairCreatedAt);
    expect(m.earliestPairAt).toBe(Math.min(...pairs.map((p) => p.pairCreatedAt).filter(Boolean)));
  });

  it("flags split liquidity below 70% (editable) and passes a single dominant pool", () => {
    const split = evaluate(m, chain(), DEFAULT_PRESET, NOW);
    const row = split.checks.find((c) => c.id === "poolSplit")!;
    expect(m.mainPoolShare!).toBeLessThan(70);
    expect(row.status).toBe("WARN");
    expect(row.value).toContain(`${pairs.length} pools`);
    const relaxed = { ...DEFAULT_PRESET, rules: { ...DEFAULT_PRESET.rules, poolSplit: { severity: "warning" as const, min: 5, max: null } } };
    expect(evaluate(m, chain(), relaxed, NOW).checks.find((c) => c.id === "poolSplit")!.status).toBe("PASS");
    const one = toMetrics(m.mint, [pairs[0]], false, true);
    expect(one.mainPoolShare).toBe(100);
    expect(evaluate(one, chain(), DEFAULT_PRESET, NOW).checks.find((c) => c.id === "poolSplit")!.status).toBe("PASS");
  });

  it("without the full pool list the split check is UNKNOWN, not PASS", () => {
    const partial = toMetrics(m.mint, [pairs[0]], false, false);
    expect(evaluate(partial, chain(), DEFAULT_PRESET, NOW).checks.find((c) => c.id === "poolSplit")!.status).toBe("UNKNOWN");
  });

  it("flags a main pool that is not quoted in SOL, USDC or USDT", () => {
    const odd = toMetrics(m.mint, [{ ...pairs[0], quoteToken: { address: "ExoticQuote111", symbol: "EXO" } }], false, true);
    const row = evaluate(odd, chain(), DEFAULT_PRESET, NOW).checks.find((c) => c.id === "liquidity")!;
    expect(row.notes!.join(" ")).toContain("quoted in EXO");
  });
});

describe("Holder classification", () => {
  const f = fx("lp-vault-holders.json");
  const input = async (): Promise<HolderInput> => ({
    supply: Number(f.supply.value.uiAmountString),
    largest: f.largest.value.map((l: any) => ({ address: l.address, amount: Number(l.uiAmountString) })),
    owners: f.accounts.value.map((a: any) => a?.data?.parsed?.info?.owner ?? null),
    ownerPrograms: new Map(Object.entries(f.ownerPrograms) as [string, string | null][]),
    poolAddresses: new Set<string>(f.pools.map((p: any) => p.pairAddress)),
    authorities: await dexAuthorities(),
  });

  it("real token whose top holder is its LP vault: pool excluded, adjusted below raw", async () => {
    const h = classifyHolders(await input());
    const pool = h.entries.filter((e) => e.kind === "liquidity_pool");
    expect(pool.length).toBeGreaterThanOrEqual(1);
    expect(pool[0].basis).toMatch(/DEX Screener|controlled by|vault authority/);
    expect(h.excludedCount).toBe(pool.length);
    expect(h.adjustedTop10Pct).toBeLessThan(h.rawTop10Pct);
    expect(h.entries.length).toBe(20);
    expect(h.adjustedCount).toBe(10); // 20 accounts leave room to fill 10 after exclusions
    expect(h.partial).toBe(false);
  });

  it("does not exclude it when the pool is unknown to DEX Screener and no known program controls it", async () => {
    const i = await input();
    const h = classifyHolders({ ...i, poolAddresses: new Set(), ownerPrograms: new Map([...i.ownerPrograms].map(([k, v]) => [k, v && v.startsWith("pAMM") ? null : v])) });
    expect(h.entries.some((e) => e.kind === "liquidity_pool")).toBe(false);
    expect(h.entries.some((e) => e.kind === "program_owned_unclassified")).toBe(true); // off-curve, so flagged, never auto-excluded
    expect(h.unclassifiedInTop10).toBeGreaterThan(0);
  });

  const base = (owners: (string | null)[], programs: Record<string, string | null> = {}, pct = 5): HolderInput => ({
    supply: 100,
    largest: owners.map((_, i) => ({ address: `acct${i}`, amount: pct })),
    owners, ownerPrograms: new Map(Object.entries(programs)), poolAddresses: new Set(), authorities: new Map(),
  });

  it("classifies burn, lock, unclassified program accounts, wallets and unresolved owners", () => {
    const wallet = "Gf8ycG1nVPjzB3W4WmNnDt9eD2w7zcXKCnnF5R9fMxJq"; // any on-curve key; replaced below with a real one
    const h = classifyHolders(base(
      ["1nc1nerator11111111111111111111111111111111", "LockOwner1", "ProgOwner1", null],
      { LockOwner1: "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m", ProgOwner1: "UnknownProgram1111111111111111111111111111" },
    ));
    const k = Object.fromEntries(h.entries.map((e) => [e.owner ?? "null", e.kind]));
    expect(k["1nc1nerator11111111111111111111111111111111"]).toBe("burn");
    expect(k.LockOwner1).toBe("program_owned_known");
    expect(h.entries[1].label).toBe("Locked/vesting (Streamflow)");
    expect(k.ProgOwner1).toBe("program_owned_unclassified");
    expect(k.null).toBe("unresolved");
    expect(h.excludedCount).toBe(2);
    expect(h.unresolvedInTop10).toBe(1);
    void wallet;
  });

  it("an unclassified program account in the top 10 produces the warning note on the checklist", () => {
    const h = classifyHolders(base(["ProgOwner1", ...Array(11).fill(null).map((_, i) => `Own${i}`)], { ProgOwner1: "UnknownProgram1111111111111111111111111111" }, 2));
    const e = evaluate(metrics(), chain({ holders: h, top10Share: h.adjustedTop10Pct }), DEFAULT_PRESET, NOW);
    const row = e.checks.find((c) => c.id === "top10")!;
    expect(row.notes).toContain("! Unclassified program account. May or may not be a pool or lock.");
  });

  it("the preset check uses the ADJUSTED share, and the row shows raw and adjusted", () => {
    const h = holdersOf(18, { rawTop10Pct: 42, adjustedTop10Pct: 18 });
    const e = evaluate(metrics(), chain({ holders: h, top10Share: 18 }), DEFAULT_PRESET, NOW);
    const row = e.checks.find((c) => c.id === "top10")!;
    expect(row.status).toBe("PASS"); // 42% raw would warn; 18% adjusted passes
    expect(row.value).toBe("42.0% raw / 18.0% adjusted");
    const high = evaluate(metrics(), chain({ holders: holdersOf(35, { rawTop10Pct: 35 }), top10Share: 35 }), DEFAULT_PRESET, NOW);
    expect(high.checks.find((c) => c.id === "top10")!.status).toBe("WARN");
  });

  it("a partial adjusted figure (fewer than 10 holders left) is UNKNOWN, never PASS", () => {
    const h = holdersOf(5, { partial: true, adjustedCount: 6 });
    const row = evaluate(metrics(), chain({ holders: h, top10Share: null }), DEFAULT_PRESET, NOW).checks.find((c) => c.id === "top10")!;
    expect(row.status).toBe("UNKNOWN");
    expect(row.value).toContain("(partial)");
  });

  it("an RPC failure while fetching holders rejects, so the check becomes UNKNOWN", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("HTTP 429"));
    await expect(getHolderData(rpc, "Mint1", new Set())).rejects.toThrow("HTTP 429");
  });

  it("getChainData turns an RPC outage into null data with errors, and the checklist shows UNKNOWN", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as never;
    try {
      const c = await getChainData("https://rpc.invalid", "OutageMint111", { budget: new RpcBudget(20), poolAddresses: new Set() });
      expect(c.holders).toBeNull();
      expect(c.top10Share).toBeNull();
      expect(c.mintAuthorityRevoked).toBeNull();
      expect(c.errors.length).toBeGreaterThan(0);
      const e = evaluate(metrics(), c, DEFAULT_PRESET, NOW);
      for (const id of ["mintAuthority", "freezeAuthority", "top10", "tokenProgram"] as const) expect(e.checks.find((x) => x.id === id)!.status).toBe("UNKNOWN");
    } finally { globalThis.fetch = orig; }
  });

  it("the RPC budget stops further calls instead of exceeding it", async () => {
    const b = new RpcBudget(2);
    b.take(); b.take();
    expect(() => b.take()).toThrow(/budget/);
    expect(b.hit).toBe(true);
    expect(b.used).toBe(2);
  });
});

describe("Creator and early-buyer clustering (real pump.fun launch)", () => {
  const f = fx("pump-launch.json");

  it("reads the creator from the bonding-curve account and it matches the creation transaction's fee payer", () => {
    const fromCurve = parseBondingCurveCreator(f.curveAccount.value.data[0]);
    expect(fromCurve).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const creation = f.txs.find((t: any) => creatorFromCreationTx(t, f.mint));
    if (creation) expect(creatorFromCreationTx(creation, f.mint)).toBe(fromCurve);
  });

  it("rejects accounts that are not bonding curves", () => {
    expect(parseBondingCurveCreator(btoa("short"))).toBeNull();
    expect(parseBondingCurveCreator(btoa("x".repeat(200)))).toBeNull(); // wrong discriminator
    expect(parseBondingCurveCreator("not base64 !!")).toBeNull();
  });

  it("a wallet that buys the whole curve in the creation slot is flagged; the curve and the pool are not counted as buyers", () => {
    const supply = Number(f.supply.value.uiAmountString);
    const txs = f.txs.map((t: any) => ({ slot: t.slot, pre: t.meta.preTokenBalances, post: t.meta.postTokenBalances }));
    // Owner of the 20.9% that moved to the PumpSwap pool in the same slot (the migration), read from the recorded data.
    const poolOwner = f.txs.flatMap((t: any) => t.meta.postTokenBalances).find((b: any) => b.mint === f.mint && Math.abs(Number(b.uiTokenAmount.uiAmountString) / supply - 0.209) < 0.002)?.owner;
    expect(poolOwner).toBeTruthy();
    const ref = Math.min(...txs.map((t: any) => t.slot));
    const withPool = clusterMetrics(txs, f.mint, ref, supply, new Set([f.curve, poolOwner]));
    const withoutPool = clusterMetrics(txs, f.mint, ref, supply, new Set([f.curve]));
    expect(withPool.pctFirst3Slots).toBeGreaterThan(79);
    expect(withPool.pctFirst3Slots).toBeLessThan(81);
    expect(withoutPool.pctFirst3Slots - withPool.pctFirst3Slots).toBeGreaterThan(20); // not excluding the pool would overcount
    const e = evaluate(metrics(), chain({ clustering: { ...chain().clustering!, pctFirst3Slots: withPool.pctFirst3Slots, buyersFirst3Slots: withPool.buyersFirst3Slots } }), DEFAULT_PRESET, NOW);
    expect(e.checks.find((c) => c.id === "earlyBuyers")!.status).toBe("WARN");
  });

  it("computes supply share and distinct buyers from token-balance deltas", () => {
    const supply = Number(f.supply.value.uiAmountString);
    const txs = f.txs.map((t: any) => ({ slot: t.slot, pre: t.meta.preTokenBalances, post: t.meta.postTokenBalances }));
    const ref = Math.min(...txs.map((t: any) => t.slot));
    const m = clusterMetrics(txs, f.mint, ref, supply, new Set([f.curve]));
    expect(m.pctFirst3Slots).toBeGreaterThanOrEqual(0);
    expect(m.pctFirst3Slots).toBeLessThanOrEqual(100);
    expect(m.buyersFirst3Slots).toBe(buyerDeltas(txs.filter((t: any) => t.slot <= ref + 2), f.mint, new Set([f.curve])).size);
    expect(m.txsExamined).toBe(txs.length);
  });

  const tx = (slot: number, entries: [string, number, number][]) => ({
    slot,
    pre: entries.map(([owner, pre]) => ({ mint: "M", owner, uiTokenAmount: { uiAmountString: String(pre) } })),
    post: entries.map(([owner, , post]) => ({ mint: "M", owner, uiTokenAmount: { uiAmountString: String(post) } })),
  });

  it("clustering math: only the first 3 slots count, sellers and the pool are not buyers", () => {
    const txs = [
      tx(100, [["pool", 1000, 900], ["a", 0, 60], ["b", 0, 40]]),
      tx(102, [["pool", 900, 850], ["a", 60, 110]]),
      tx(103, [["pool", 850, 800], ["c", 0, 50]]), // slot 103 is outside slots 100..102
      tx(101, [["d", 30, 10], ["e", 0, 20]]), // d sells 20
    ];
    const m = clusterMetrics(txs, "M", 100, 1000, new Set(["pool"]));
    expect(m.pctFirst3Slots).toBeCloseTo((110 + 40 + 20) / 1000 * 100, 6); // a: +110, b: +40, e: +20
    expect(m.buyersFirst3Slots).toBe(3);
    expect(m.topBuyers[0]).toBe("a");
  });

  it("default thresholds: WARN above 20% in 3 slots or when 3+ early buyers share a funder; never FAIL", () => {
    const check = (pct: number, shared: number | null) =>
      evaluate(metrics(), chain({ clustering: { ...chain().clustering!, pctFirst3Slots: pct, maxSharedFunding: shared } }), DEFAULT_PRESET, NOW).checks.find((c) => c.id === "earlyBuyers")!;
    expect(check(20, 2).status).toBe("PASS");
    expect(check(20.1, 1).status).toBe("WARN");
    expect(check(5, 3).status).toBe("WARN");
    expect(check(5, null).status).toBe("PASS");
    expect(check(99, 9).status).toBe("WARN"); // heuristics never FAIL
    const required = { ...DEFAULT_PRESET, rules: { ...DEFAULT_PRESET.rules, earlyBuyers: { severity: "required" as const, max: 20, maxShared: 3 } } };
    const r = evaluate(metrics(), chain({ clustering: { ...chain().clustering!, pctFirst3Slots: 99 } }), required, NOW).checks.find((c) => c.id === "earlyBuyers")!;
    expect(r.status).toBe("WARN");
    expect(r.severity).toBe("warning");
    expect(check(5, 1).label).toBe("Early-buyer clustering (estimate)");
    expect(check(5, 1).notes!.join(" ")).toContain("Heuristic estimate from early transactions.");
  });

  it("funding sources: earliest incoming SOL transfer, grouped", () => {
    const fund = { transaction: { message: { instructions: [{ program: "system", parsed: { type: "transfer", info: { source: "Funder1", destination: "W1", lamports: 5 } } }] } }, meta: { innerInstructions: [] } };
    expect(fundingSource(fund, "W1")).toBe("Funder1");
    expect(fundingSource(fund, "W2")).toBeNull();
    expect(largestSharedFunding(["Funder1", "Funder1", "Funder1", "F2", null])).toBe(3);
    expect(largestSharedFunding([null, null])).toBeNull();
  });

  it("creator holding: WARN above 5% (editable), the caveat is always shown, and the creation search failure keeps its reason", () => {
    const hi = evaluate(metrics(), chain({ creator: { status: "found", address: "C1", method: "m", reason: null, holdingPct: 6, fromCache: true } }), DEFAULT_PRESET, NOW).checks.find((c) => c.id === "creatorHolding")!;
    expect(hi.status).toBe("WARN");
    expect(hi.notes).toContain("Only tracks the original creator wallet. Tokens moved to other wallets are not detected.");
    const lo = evaluate(metrics(), chain({ creator: { status: "found", address: "C1", method: "m", reason: null, holdingPct: 5, fromCache: false } }), DEFAULT_PRESET, NOW).checks.find((c) => c.id === "creatorHolding")!;
    expect(lo.status).toBe("PASS");
    const nf = evaluate(metrics(), chain({ creator: { status: "unknown", address: null, method: null, reason: "creation tx not found within scan budget", holdingPct: null, fromCache: false } }), DEFAULT_PRESET, NOW).checks.find((c) => c.id === "creatorHolding")!;
    expect(nf.status).toBe("UNKNOWN");
    expect(nf.notes).toContain("Only tracks the original creator wallet. Tokens moved to other wallets are not detected.");
  });
});

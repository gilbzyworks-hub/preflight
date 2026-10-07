import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateGuardrails, OVERRIDE_PREFIX, startOfDay, TAG_FOR, type GuardLine } from "@/lib/guardrails";
import { evaluate } from "@shared/engine.ts";
import { DEFAULT_PRESET, mergeSettings } from "@shared/defaults.ts";
import type { ChainData, Settings, TokenMetrics, TokenScan } from "@shared/types.ts";

const NOW = Date.UTC(2026, 0, 10, 15, 0, 0); // 15:00 UTC
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

type TradeRow = { status: string; pnl_usd: number | null; exit_time: string | null; created_at: string };

/** Minimal stand-in for the two queries evaluateGuardrails runs. */
function fakeDb(view: { first_opened_at: string } | null, trades: TradeRow[]): SupabaseClient {
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or"]) q[m] = () => q;
    q.maybeSingle = () => Promise.resolve(result);
    q.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
    return q;
  };
  return {
    from: (t: string) => chain(t === "checklist_views" ? { data: view } : { data: trades }),
  } as unknown as SupabaseClient;
}

const metrics = (o: Partial<TokenMetrics> = {}): TokenMetrics => ({
  mint: "Mint111", symbol: "TST", name: "Test", dataOk: true, pairAddress: "p", dexId: "raydium", dexUrl: null,
  imageUrl: null, priceUsd: 1, liquidityUsd: 100_000, fdv: 1_000_000, marketCap: 1_000_000, volume24h: 500_000,
  priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 }, buys24h: 1, sells24h: 1, pairCreatedAt: NOW - 48 * 3_600_000,
  earliestPairAt: NOW - 48 * 3_600_000, quoteSymbol: "SOL", quoteAddress: "So11111111111111111111111111111111111111112",
  pools: [], totalLiquidityUsd: 100_000, poolsComplete: true, mainPoolShare: 100, links: [], boosted: false, ...o,
});
const scanOf = (m: Partial<TokenMetrics> = {}): TokenScan => {
  const metricsV = metrics(m);
  const chain: ChainData = {
    mintAuthorityRevoked: true, freezeAuthorityRevoked: true, top10Share: 20, errors: [], tokenProgram: "spl-token", extensions: [],
    holders: null, creator: null, clustering: null, rpcCalls: 0, budgetHit: false, skipped: null,
  };
  return { metrics: metricsV, chain, evaluation: evaluate(metricsV, chain, DEFAULT_PRESET, NOW), scannedAt: iso(NOW), source: "site", presetId: DEFAULT_PRESET.id };
};

const settings = (g: Record<string, unknown> = {}): Settings => mergeSettings({ guardrails: g });
const line = (lines: GuardLine[], id: GuardLine["id"]) => lines.find((l) => l.id === id)!;
const run = (db: SupabaseClient, s: Settings, scan: TokenScan | null = scanOf(), kind: "paper" | "real" = "paper", sizeUsd: number | null = 50) =>
  evaluateGuardrails(db, "u1", s, { kind, mint: "Mint111", sizeUsd, scan, now: NOW });

const openedAgo = (minutes: number) => ({ first_opened_at: iso(NOW - minutes * MIN) });
const tradeToday = (o: Partial<TradeRow> = {}): TradeRow => ({ status: "open", pnl_usd: null, exit_time: null, created_at: iso(NOW - 60 * MIN), ...o });

describe("cooldown", () => {
  it("is triggered and blocks paper trades while the cooldown is running", async () => {
    const l = line(await run(fakeDb(openedAgo(2), []), settings({ cooldown: { on: true, minutes: 5 } })), "cooldown");
    expect(l.state).toBe("triggered");
    expect(l.blocksPaper).toBe(true);
    expect(l.tag).toBe(TAG_FOR.cooldown);
    expect(l.detail).toContain("3 min left");
  });

  it("is ok once the cooldown has passed", async () => {
    const l = line(await run(fakeDb(openedAgo(5), []), settings({ cooldown: { on: true, minutes: 5 } })), "cooldown");
    expect(l.state).toBe("ok");
    expect(l.tag).toBeNull();
  });

  it("reports off when switched off, even if the checklist was just opened", async () => {
    const l = line(await run(fakeDb(openedAgo(0), []), settings({ cooldown: { on: false, minutes: 5 } })), "cooldown");
    expect(l.state).toBe("off");
  });

  it("blocks when the checklist was never opened", async () => {
    const l = line(await run(fakeDb(null, []), settings()), "noReview");
    expect(l.state).toBe("triggered");
    expect(l.blocksPaper).toBe(true);
  });
});

describe("daily trade limit", () => {
  const todays = (n: number) => Array.from({ length: n }, () => tradeToday());

  it("is ok below the limit", async () => {
    const l = line(await run(fakeDb(openedAgo(30), todays(2)), settings({ dailyTrades: { on: true, max: 3 } })), "dailyTrades");
    expect(l.state).toBe("ok");
    expect(l.detail).toContain("2 of 3");
  });

  it("triggers and blocks once the limit is reached", async () => {
    const l = line(await run(fakeDb(openedAgo(30), todays(3)), settings({ dailyTrades: { on: true, max: 3 } })), "dailyTrades");
    expect(l.state).toBe("triggered");
    expect(l.blocksPaper).toBe(true);
    expect(l.tag).toBe(TAG_FOR.dailyTrades);
  });

  it("does not count trades created before the start of today", async () => {
    const yesterday = tradeToday({ created_at: iso(NOW - 30 * 3_600_000), exit_time: iso(NOW - 20 * 60 * MIN) });
    const l = line(await run(fakeDb(openedAgo(30), [yesterday, yesterday, yesterday]), settings({ dailyTrades: { on: true, max: 3 } })), "dailyTrades");
    expect(l.state).toBe("ok");
  });

  it("is off when switched off", async () => {
    const l = line(await run(fakeDb(openedAgo(30), todays(9)), settings({ dailyTrades: { on: false, max: 3 } })), "dailyTrades");
    expect(l.state).toBe("off");
  });
});

describe("daily max loss", () => {
  const closed = (pnl: number) => tradeToday({ status: "closed", pnl_usd: pnl, exit_time: iso(NOW - 10 * MIN) });

  it("is not_set when no limit is configured", async () => {
    const l = line(await run(fakeDb(openedAgo(30), [closed(-100)]), settings({ dailyMaxLoss: { on: true, usd: null } })), "dailyMaxLoss");
    expect(l.state).toBe("not_set");
  });

  it("triggers when net realised loss reaches the limit; wins offset losses", async () => {
    const s = settings({ dailyMaxLoss: { on: true, usd: 50 } });
    expect(line(await run(fakeDb(openedAgo(30), [closed(-60)]), s), "dailyMaxLoss").state).toBe("triggered");
    expect(line(await run(fakeDb(openedAgo(30), [closed(-60), closed(20)]), s), "dailyMaxLoss").state).toBe("ok");
  });
});

describe("failed required check", () => {
  it("is triggered but does not block outright (it needs a typed override)", async () => {
    const l = line(await run(fakeDb(openedAgo(30), []), settings(), scanOf({ liquidityUsd: 1_000 })), "requiredFail");
    expect(l.state).toBe("triggered");
    expect(l.blocksPaper).toBe(false);
    expect(l.detail).toContain("Liquidity");
  });

  it("a warning-only failure does not trigger it", async () => {
    const scan = scanOf();
    scan.evaluation.checks.find((c) => c.id === "top10")!.status = "WARN";
    expect(line(await run(fakeDb(openedAgo(30), []), settings(), scan), "requiredFail").state).toBe("ok");
  });

  it("unknown data is not treated as a failed required check", async () => {
    const l = line(await run(fakeDb(openedAgo(30), []), settings(), scanOf({ liquidityUsd: null })), "requiredFail");
    expect(l.state).toBe("ok");
  });
});

describe("typed override", () => {
  it.each([
    "I'm overriding: liquidity is fine because the pool is locked",
    "I’m overriding: curly apostrophe works",
    "  i'm overriding:   leading space and lowercase ",
  ])("accepts %j", (t) => expect(OVERRIDE_PREFIX.test(t.trim())).toBe(true));

  it.each([
    "",
    "override",
    "I'm overriding:",
    "I'm overriding:   ",
    "I'm overriding: ab",
    "yes",
    "Im overriding: missing apostrophe",
    "please I'm overriding: not at the start",
  ])("rejects %j", (t) => expect(OVERRIDE_PREFIX.test(t.trim())).toBe(false));
});

describe("size limit (real trades only)", () => {
  it("is not evaluated for paper trades", async () => {
    const lines = await run(fakeDb(openedAgo(30), []), settings({ sizeLimit: { on: true, usd: 10 } }), scanOf(), "paper", 500);
    expect(lines.some((l) => l.id === "sizeLimit")).toBe(false);
  });

  it("is recorded but never blocks a real trade", async () => {
    const lines = await run(fakeDb(openedAgo(30), []), settings({ sizeLimit: { on: true, usd: 10 } }), scanOf(), "real", 500);
    const l = line(lines, "sizeLimit");
    expect(l.state).toBe("triggered");
    expect(l.blocksPaper).toBe(false);
  });
});

describe("startOfDay", () => {
  it("uses the configured timezone", () => {
    expect(startOfDay(NOW, "UTC").toISOString()).toBe("2026-01-10T00:00:00.000Z");
    expect(startOfDay(NOW, "America/New_York").toISOString()).toBe("2026-01-10T05:00:00.000Z");
  });
  it("falls back to UTC for an invalid timezone", () => {
    expect(startOfDay(NOW, "Not/AZone").toISOString()).toBe("2026-01-10T00:00:00.000Z");
  });
});

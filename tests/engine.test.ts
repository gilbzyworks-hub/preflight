import { describe, expect, it } from "vitest";
import { evaluate } from "@shared/engine.ts";
import { DEFAULT_PRESET } from "@shared/defaults.ts";
import type { CheckId, Preset } from "@shared/types.ts";

import { chain, cheapChain, clusteringOk, HOUR, holders, metrics, NOW } from "./helpers.ts";

const status = (e: ReturnType<typeof evaluate>, id: CheckId) => e.checks.find((c) => c.id === id)!.status;
const withRule = (id: CheckId, rule: Preset["rules"][CheckId]): Preset => ({
  ...DEFAULT_PRESET, rules: { ...DEFAULT_PRESET.rules, [id]: rule },
});

describe("missing data is never PASS", () => {
  it("passes everything when all data is present and in range", () => {
    const e = evaluate(metrics(), chain(), DEFAULT_PRESET, NOW);
    expect(e.checks.every((c) => c.status === "PASS")).toBe(true);
    expect(e.matches).toBe(true);
  });

  it("marks every missing input UNKNOWN, with an explanation that says it is not a pass", () => {
    const e = evaluate(
      metrics({ pairCreatedAt: null, liquidityUsd: null, fdv: null, volume24h: null, mainPoolShare: null, poolsComplete: false }),
      chain({
        mintAuthorityRevoked: null, freezeAuthorityRevoked: null, top10Share: null, tokenProgram: null, extensions: null, holders: null,
        creator: { status: "unknown", address: null, method: null, reason: "creation tx not found within scan budget", holdingPct: null, fromCache: false },
        clustering: { ...clusteringOk(), status: "unknown", pctFirst3Slots: null, reason: "earliest transactions not reached within scan budget" },
      }),
      DEFAULT_PRESET, NOW,
    );
    expect(e.checks.length).toBe(11);
    for (const c of e.checks) {
      expect(c.status).toBe("UNKNOWN");
      expect(c.value).toBe("No data");
      expect(c.explanation).toMatch(/not a pass/);
    }
    expect(e.counts).toEqual({ pass: 0, warn: 0, fail: 0, unknown: 11, notRun: 0 });
  });

  it("keeps the reason on UNKNOWN rows (creation tx not found within scan budget)", () => {
    const e = evaluate(metrics(), chain({ creator: { status: "unknown", address: null, method: null, reason: "creation tx not found within scan budget", holdingPct: null, fromCache: false } }), DEFAULT_PRESET, NOW);
    const row = e.checks.find((c) => c.id === "creatorHolding")!;
    expect(row.status).toBe("UNKNOWN");
    expect(row.explanation).toContain("creation tx not found within scan budget");
  });

  it("an RPC failure for holders gives UNKNOWN, never PASS", () => {
    const e = evaluate(metrics(), chain({ holders: null, top10Share: null, errors: ["RPC holders: HTTP 429"] }), DEFAULT_PRESET, NOW);
    expect(status(e, "top10")).toBe("UNKNOWN");
  });

  it("an unparseable extension list gives UNKNOWN for the program row", () => {
    const e = evaluate(metrics(), chain({ tokenProgram: "token-2022", extensions: null }), DEFAULT_PRESET, NOW);
    expect(status(e, "tokenProgram")).toBe("UNKNOWN");
  });

  it("does not treat unknown authority as revoked (false and null both fail to pass)", () => {
    expect(status(evaluate(metrics(), chain({ mintAuthorityRevoked: null }), DEFAULT_PRESET, NOW), "mintAuthority")).toBe("UNKNOWN");
    expect(status(evaluate(metrics(), chain({ mintAuthorityRevoked: false }), DEFAULT_PRESET, NOW), "mintAuthority")).toBe("FAIL");
  });

  it("does not turn a missing value into 0 that happens to satisfy a max-only rule", () => {
    const preset = withRule("top10", { severity: "warning", min: null, max: 30 });
    expect(status(evaluate(metrics(), chain({ top10Share: null, holders: null }), preset, NOW), "top10")).toBe("UNKNOWN");
  });

  it("flags the unknown-data row as a warning when any check lacks data", () => {
    const e = evaluate(metrics(), chain({ top10Share: null, holders: null }), DEFAULT_PRESET, NOW);
    expect(e.unknownRow.status).toBe("WARN");
    expect(e.unknownRow.status).not.toBe("PASS");
  });

  it("a missing required check does not count as a failure, but it is also never a match by passing", () => {
    const e = evaluate(metrics({ liquidityUsd: null }), chain(), DEFAULT_PRESET, NOW);
    expect(status(e, "liquidity")).toBe("UNKNOWN");
    expect(e.counts.pass).toBe(10);
  });

  it("NOT RUN is distinct from UNKNOWN, is never PASS and is excluded from the pass count", () => {
    const e = evaluate(metrics(), cheapChain(), DEFAULT_PRESET, NOW);
    for (const id of ["creatorHolding", "earlyBuyers"] as const) {
      expect(status(e, id)).toBe("NOT_RUN");
      expect(e.checks.find((c) => c.id === id)!.explanation).toMatch(/not a pass/);
    }
    expect(e.counts).toMatchObject({ pass: 9, notRun: 2, unknown: 0 });
    expect(e.unknownRow.detail).toMatch(/2 not run/);
  });

  it("a token whose on-chain checks were skipped shows NOT RUN, not UNKNOWN", () => {
    const e = evaluate(metrics(), chain({ skipped: "failed a market check first" }), DEFAULT_PRESET, NOW);
    for (const id of ["mintAuthority", "freezeAuthority", "top10", "poolSplit", "tokenProgram", "creatorHolding", "earlyBuyers"] as const) {
      expect(status(e, id)).toBe("NOT_RUN");
    }
  });

  it("OFF checks are neither passed nor counted", () => {
    const preset = withRule("top10", { severity: "off" });
    const e = evaluate(metrics(), chain({ top10Share: null, holders: null }), preset, NOW);
    expect(status(e, "top10")).toBe("OFF");
    expect(e.counts.unknown).toBe(0);
  });
});

describe("Required vs Warning severity", () => {
  it("a failing required check is FAIL and stops the token matching", () => {
    const e = evaluate(metrics({ liquidityUsd: 10_000 }), chain(), DEFAULT_PRESET, NOW);
    expect(status(e, "liquidity")).toBe("FAIL");
    expect(e.counts.fail).toBe(1);
    expect(e.matches).toBe(false);
  });

  it("the same failure on a warning-severity check is WARN and does not block matching", () => {
    const preset = withRule("liquidity", { severity: "warning", min: 50_000, max: null });
    const e = evaluate(metrics({ liquidityUsd: 10_000 }), chain(), preset, NOW);
    expect(status(e, "liquidity")).toBe("WARN");
    expect(e.counts).toMatchObject({ warn: 1, fail: 0 });
    expect(e.matches).toBe(true);
  });

  it("default top-10 rule is a warning: 45% gives WARN, not FAIL", () => {
    const e = evaluate(metrics(), chain({ top10Share: 45, holders: holders(45) }), DEFAULT_PRESET, NOW);
    expect(status(e, "top10")).toBe("WARN");
    expect(e.matches).toBe(true);
  });

  it("enforces both ends of a range and treats the bounds as inclusive", () => {
    const at = (fdv: number) => status(evaluate(metrics({ fdv }), chain(), DEFAULT_PRESET, NOW), "fdv");
    expect(at(249_999)).toBe("FAIL");
    expect(at(250_000)).toBe("PASS");
    expect(at(10_000_000)).toBe("PASS");
    expect(at(10_000_001)).toBe("FAIL");
  });

  it("age is measured from the pair creation time against the minimum hours", () => {
    const at = (hours: number) =>
      status(evaluate(metrics({ pairCreatedAt: NOW - hours * HOUR }), chain(), DEFAULT_PRESET, NOW), "age");
    expect(at(5.9)).toBe("FAIL");
    expect(at(6)).toBe("PASS");
  });

  it("records the severity on each result", () => {
    const e = evaluate(metrics(), chain(), DEFAULT_PRESET, NOW);
    expect(e.checks.find((c) => c.id === "top10")!.severity).toBe("warning");
    expect(e.checks.find((c) => c.id === "liquidity")!.severity).toBe("required");
  });
});

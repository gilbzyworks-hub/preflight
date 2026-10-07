import { describe, expect, it } from "vitest";
import { HORIZONS, presetHash, rugLabel, snapshotPlan } from "@shared/outcomes.ts";
import { DEFAULT_PRESET } from "@shared/defaults.ts";

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 10);

describe("preset versioning", () => {
  it("is stable for identical rules and ignores key order and renames", async () => {
    const a = await presetHash(DEFAULT_PRESET);
    const reordered = { ...DEFAULT_PRESET, name: "Renamed", rules: Object.fromEntries(Object.entries(DEFAULT_PRESET.rules).reverse()) } as typeof DEFAULT_PRESET;
    expect(await presetHash(reordered)).toBe(a);
  });

  it("changes when any threshold or severity changes", async () => {
    const a = await presetHash(DEFAULT_PRESET);
    const lower = { ...DEFAULT_PRESET, rules: { ...DEFAULT_PRESET.rules, liquidity: { severity: "required" as const, min: 40_000, max: null } } };
    const sev = { ...DEFAULT_PRESET, rules: { ...DEFAULT_PRESET.rules, top10: { severity: "required" as const, min: null, max: 30 } } };
    expect(await presetHash(lower)).not.toBe(a);
    expect(await presetHash(sev)).not.toBe(a);
  });
});

describe("follow-up schedule", () => {
  const act = (now: number, have: string[] = []) =>
    Object.fromEntries(snapshotPlan(T0, new Set(have), now).map((p) => [p.horizon, p.action]));

  it("waits until each horizon is due", () => {
    expect(act(T0 + 59 * 60_000)).toEqual({ "1h": "wait", "24h": "wait", "7d": "wait" });
  });

  it("takes a snapshot when due and inside the grace window", () => {
    expect(act(T0 + H)["1h"]).toBe("take");
    expect(act(T0 + H + 30 * 60_000)["1h"]).toBe("take");
  });

  it("records missed, never a late guess, once the window has closed", () => {
    const p = snapshotPlan(T0, new Set(), T0 + H + 31 * 60_000).find((x) => x.horizon === "1h")!;
    expect(p.action).toBe("missed");
    expect(p.lateMs).toBeGreaterThan(HORIZONS[0].graceMs);
  });

  it("skips horizons that already have a row (idempotent)", () => {
    expect(snapshotPlan(T0, new Set(["1h", "24h", "7d"]), T0 + 30 * 24 * H)).toEqual([]);
    expect(act(T0 + 25 * H, ["1h"])).toEqual({ "24h": "take", "7d": "wait" });
  });

  it("covers +1h, +24h and +7d", () => {
    expect(HORIZONS.map((h) => h.ms)).toEqual([H, 24 * H, 7 * 24 * H]);
  });
});

describe("rug labels", () => {
  const ok = (h: string, liq: number | null, pair: "active" | "not_returned" = "active") =>
    ({ horizon: h, status: "ok", pair_status: pair, liquidity_usd: liq });

  it("never says verified without a user note", () => {
    for (const snaps of [[ok("1h", 0)], [ok("1h", null, "not_returned")], []]) {
      expect(rugLabel(100_000, snaps, [], 90).kind).not.toBe("verified");
    }
  });

  it("flags a liquidity collapse as an estimate, at the threshold and not below it", () => {
    expect(rugLabel(100_000, [ok("24h", 10_000)], [], 90).kind).toBe("likely");
    expect(rugLabel(100_000, [ok("24h", 10_001)], [], 90).kind).toBe("none");
  });

  it("flags a pair that is no longer returned", () => {
    const r = rugLabel(100_000, [ok("1h", null, "not_returned")], [], 90);
    expect(r).toMatchObject({ kind: "likely" });
  });

  it("does not guess from missed or missing data", () => {
    const missed = { horizon: "1h", status: "missed", pair_status: null, liquidity_usd: null };
    expect(rugLabel(100_000, [missed], [], 90).kind).toBe("insufficient");
    expect(rugLabel(null, [ok("1h", 5)], [], 90).kind).toBe("none");
  });

  it("becomes verified only through the user's note, and a withdrawal reverts it", () => {
    const v = { kind: "verified_rug", note: "Dev wallet drained, see explorer", created_at: "2026-01-01T00:00:00Z" };
    const w = { kind: "unverify_rug", note: "Mistake, pool was migrated", created_at: "2026-01-02T00:00:00Z" };
    expect(rugLabel(100_000, [ok("1h", 90_000)], [v], 90)).toEqual({ kind: "verified", note: v.note });
    expect(rugLabel(100_000, [ok("1h", 90_000)], [v, w], 90).kind).toBe("none");
  });

  it("respects an edited threshold", () => {
    expect(rugLabel(100_000, [ok("1h", 40_000)], [], 50).kind).toBe("likely");
    expect(rugLabel(100_000, [ok("1h", 40_000)], [], 90).kind).toBe("none");
  });
});

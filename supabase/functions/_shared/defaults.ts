import type { Preset, Settings } from "./types.ts";

export const DEFAULT_PRESET: Preset = {
  id: "established",
  name: "Established-ish — passing checks ≠ endorsement",
  subtitle:
    "These filters only screen out some known red flags. Tokens that pass can still lose most or all of their value.",
  unknownData: "warning",
  rules: {
    age: { severity: "required", min: 6, max: null },
    liquidity: { severity: "required", min: 50_000, max: null },
    fdv: { severity: "required", min: 250_000, max: 10_000_000 },
    volume24h: { severity: "required", min: 100_000, max: null },
    mintAuthority: { severity: "required" },
    freezeAuthority: { severity: "required" },
    top10: { severity: "warning", min: null, max: 30 }, // checked against the ADJUSTED figure
    poolSplit: { severity: "warning", min: 70, max: null },
    tokenProgram: { severity: "warning" },
    creatorHolding: { severity: "warning", min: null, max: 5 },
    earlyBuyers: { severity: "warning", min: null, max: 20, maxShared: 3 },
  },
  extensions: {
    nonTransferable: { severity: "required" },
    permanentDelegate: { severity: "required" },
    defaultAccountState: { severity: "required" }, // only fails when the default state is frozen
    transferFeeConfig: { severity: "warning", failAbove: 5 }, // percent; fails above this
    transferHook: { severity: "warning" },
    pausableConfig: { severity: "warning" },
    mintCloseAuthority: { severity: "warning" },
    other: { severity: "warning" },
  },
};

export const DEFAULT_SETTINGS: Settings = {
  activePresetId: DEFAULT_PRESET.id,
  presets: [DEFAULT_PRESET],
  timezone: "UTC",
  alerts: { quietStart: "23:00", quietEnd: "07:00", maxPerHour: 4, liquidityDropPct: 30 },
  guardrails: {
    cooldown: { on: true, minutes: 5 },
    failedRequired: { on: true },
    dailyTrades: { on: true, max: 3 },
    dailyMaxLoss: { on: true, usd: null },
    sizeLimit: { on: true, usd: null },
  },
  paper: { startingBalance: 1000, slippagePct: 3, feePct: 1, defaultSizePct: 2 },
  staleMinutes: 6,
  outcomes: { rugLiquidityDropPct: 90 },
  rpcBudget: { cheapPerScan: 150, expensivePerScan: 300, creatorPageBudget: 10 },
};

// deno-lint-ignore no-explicit-any
export function mergeSettings(d: any): Settings {
  const s: Settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!d || typeof d !== "object") return s;
  if (Array.isArray(d.presets) && d.presets.length) {
    // Presets saved before newer checks existed get the defaults for the missing ones (their own values win).
    s.presets = d.presets.map((p: Preset) => ({
      ...p,
      rules: { ...DEFAULT_PRESET.rules, ...(p.rules ?? {}) },
      extensions: { ...DEFAULT_PRESET.extensions, ...(p.extensions ?? {}) },
    }));
  }
  if (typeof d.activePresetId === "string") s.activePresetId = d.activePresetId;
  if (!s.presets.some((p) => p.id === s.activePresetId)) s.activePresetId = s.presets[0].id;
  if (typeof d.timezone === "string") s.timezone = d.timezone;
  if (typeof d.staleMinutes === "number") s.staleMinutes = d.staleMinutes;
  s.alerts = { ...s.alerts, ...(d.alerts ?? {}) };
  s.paper = { ...s.paper, ...(d.paper ?? {}) };
  s.outcomes = { ...s.outcomes, ...(d.outcomes ?? {}) };
  s.rpcBudget = { ...s.rpcBudget, ...(d.rpcBudget ?? {}) };
  const g = d.guardrails ?? {};
  for (const k of Object.keys(s.guardrails) as (keyof Settings["guardrails"])[]) {
    s.guardrails[k] = { ...s.guardrails[k], ...(g[k] ?? {}) } as never;
  }
  return s;
}

export function activePreset(s: Settings): Preset {
  return s.presets.find((p) => p.id === s.activePresetId) ?? s.presets[0];
}

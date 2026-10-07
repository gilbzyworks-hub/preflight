import { extensionRows } from "./extensions.ts";
import type { ChainData, CheckId, CheckResult, CheckRule, Evaluation, Preset, Severity, Status, TokenMetrics } from "./types.ts";

export const fmtUsd = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
};
const fmtThresholdUsd = (n: number) => {
  if (n >= 1e6) return `$${+(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${+(n / 1e3).toFixed(1)}k`;
  return `$${n}`;
};
export const fmtHours = (h: number): string => {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${+h.toFixed(1)}h`;
  return `${+(h / 24).toFixed(1)}d`;
};

interface Computed {
  raw: number | boolean | null;
  value: string;
  /** The check was deliberately not run; shown as NOT RUN, never UNKNOWN or PASS. */
  notRun?: string;
  /** Overrides the min/max comparison when the judgement is more than a range test. */
  bad?: boolean;
  /** Caveats that are always shown under the row. A leading "!" marks a warning. */
  notes?: string[];
  /** Replaces the default explanation (used for always-visible reasons on UNKNOWN). */
  unknownReason?: string;
}
interface Def {
  id: CheckId;
  label: string;
  explain: string;
  /** Heuristics can never FAIL: a Required rule is treated as Warning. */
  warnOnly?: boolean;
  compute: (m: TokenMetrics, c: ChainData, now: number, rule: CheckRule) => Computed;
  threshold: (r: CheckRule) => string;
  pass: (raw: number | boolean, r: CheckRule) => boolean;
}

const inRange = (raw: number | boolean, r: CheckRule) => {
  const n = raw as number;
  return (r.min == null || n >= r.min) && (r.max == null || n <= r.max);
};
const rangeText = (r: CheckRule, fmt: (n: number) => string, prefix = "") => {
  if (r.min != null && r.max != null) return `${prefix}${fmt(r.min)} – ${fmt(r.max)}`;
  if (r.min != null) return `≥ ${prefix}${fmt(r.min)}`;
  if (r.max != null) return `≤ ${prefix}${fmt(r.max)}`;
  return "No limit";
};
const authority = (revoked: boolean | null, c: ChainData): Computed =>
  c.skipped ? { raw: null, value: "Not run", notRun: c.skipped } : { raw: revoked, value: revoked === null ? "No data" : revoked ? "Revoked" : "Not revoked" };

/** Scans stored before these checks existed have none of the new chain fields. They are shown as not collected, not guessed. */
const isLegacy = (c: ChainData) => (c as { tokenProgram?: unknown }).tokenProgram === undefined;
const LEGACY: Computed = { raw: null, value: "Not collected", notRun: "this stored scan was made before this check existed; it appears on the next scan" };

/** Reasons read as sentences; provider rate limits get a plain explanation. */
const friendly = (r: string): string =>
  /HTTP 429/.test(r) ? "The data provider was limiting requests; this is retried on a later scan." : r.replace(/[.\s]*$/, ".");

const CREATOR_CAVEAT = "Only tracks the original creator wallet. Tokens moved to other wallets are not detected.";
const CLUSTER_CAVEAT = "Heuristic estimate from early transactions. Bundled launches can be hidden; clustered buying can also be innocent.";

export const DEFS: Def[] = [
  {
    id: "age",
    label: "Token age",
    explain: "Very new tokens have little history. Age is measured from the main pool's creation time.",
    compute: (m, _c, now) => {
      if (m.pairCreatedAt === null) return { raw: null, value: "No data" };
      const h = Math.max(0, (now - m.pairCreatedAt) / 3_600_000);
      const earliest = m.earliestPairAt !== null && m.earliestPairAt < m.pairCreatedAt ? Math.max(0, (now - m.earliestPairAt) / 3_600_000) : null;
      return { raw: h, value: fmtHours(h), notes: earliest !== null ? [`Earliest pool listed is ${fmtHours(earliest)} old (shown for context, not checked).`] : undefined };
    },
    threshold: (r) => rangeText(r, (n) => fmtHours(n)),
    pass: inRange,
  },
  {
    id: "liquidity",
    label: "Liquidity",
    explain: "Low liquidity makes it hard to exit a position without moving the price a lot. Uses the main pool (the one with the most liquidity).",
    compute: (m) => ({
      raw: m.liquidityUsd,
      value: m.liquidityUsd === null ? "No data" : fmtUsd(m.liquidityUsd),
      notes: [
        ...(m.dexId ? [`Main pool: ${m.dexId}, quoted in ${m.quoteSymbol ?? "an unknown token"}${m.pools?.length > 1 ? ` (${m.pools.length} pools in total)` : ""}.`] : []),
        ...(m.quoteSymbol && m.quoteAddress && !MAJOR_QUOTES.has(m.quoteAddress) ? [`! Main pool is quoted in ${m.quoteSymbol}, not SOL, USDC or USDT. Liquidity in such pools can be distorted.`] : []),
      ],
    }),
    threshold: (r) => rangeText(r, fmtThresholdUsd),
    pass: inRange,
  },
  {
    id: "poolSplit",
    label: "Liquidity split across pools",
    explain: "If the main pool holds only part of the token's liquidity, the rest sits in other pools with their own prices and exit costs.",
    compute: (m, c) => {
      if (isLegacy(c)) return LEGACY;
      if (c.skipped) return { raw: null, value: "Not run", notRun: c.skipped };
      if (!m.poolsComplete) return { raw: null, value: "No data", unknownReason: "The full pool list could not be fetched." };
      if (m.mainPoolShare === null) return { raw: null, value: "No data" };
      return { raw: m.mainPoolShare, value: `${m.mainPoolShare.toFixed(0)}% in main pool (${m.pools.length} pool${m.pools.length === 1 ? "" : "s"}, ${fmtUsd(m.totalLiquidityUsd)} total)` };
    },
    threshold: (r) => rangeText(r, (n) => `${n}%`),
    pass: inRange,
  },
  {
    id: "fdv",
    label: "FDV",
    explain: "Fully diluted value: price × total supply. A rough size gauge, not a measure of worth.",
    compute: (m) => ({ raw: m.fdv, value: m.fdv === null ? "No data" : fmtUsd(m.fdv) }),
    threshold: (r) => rangeText(r, fmtThresholdUsd),
    pass: inRange,
  },
  {
    id: "volume24h",
    label: "24h volume",
    explain: "Thin trading volume can mean few active participants and wide, unpredictable spreads. Uses the main pool.",
    compute: (m) => ({ raw: m.volume24h, value: m.volume24h === null ? "No data" : fmtUsd(m.volume24h) }),
    threshold: (r) => rangeText(r, fmtThresholdUsd),
    pass: inRange,
  },
  {
    id: "mintAuthority",
    label: "Mint authority revoked",
    explain: "If not revoked, whoever holds it can still create more supply and dilute holders.",
    compute: (_m, c) => authority(c.mintAuthorityRevoked, c),
    threshold: () => "Revoked",
    pass: (raw) => raw === true,
  },
  {
    id: "freezeAuthority",
    label: "Freeze authority revoked",
    explain: "If not revoked, whoever holds it can freeze token accounts so they cannot transfer.",
    compute: (_m, c) => authority(c.freezeAuthorityRevoked, c),
    threshold: () => "Revoked",
    pass: (raw) => raw === true,
  },
  {
    id: "tokenProgram",
    label: "Token program and extensions",
    explain: "Token-2022 mints can carry extensions that change how transfers work. Each relevant extension gets its own row below.",
    compute: (_m, c) => {
      if (isLegacy(c)) return LEGACY;
      if (c.skipped) return { raw: null, value: "Not run", notRun: c.skipped };
      if (c.tokenProgram === null || c.extensions === null && c.tokenProgram !== "other") return { raw: null, value: "No data" };
      if (c.tokenProgram === "other") return { raw: null, value: "Unrecognised token program" };
      return c.tokenProgram === "spl-token"
        ? { raw: true, value: "Standard token program, no extensions" }
        : { raw: true, value: `Token-2022, ${c.extensions!.length} extension${c.extensions!.length === 1 ? "" : "s"}` };
    },
    threshold: () => "Identified",
    pass: (raw) => raw === true,
  },
  {
    id: "top10",
    label: "Top-10 holder share (adjusted)",
    explain:
      "Share of supply held by the 10 largest holders after excluding liquidity pools, burn addresses and known lock programs. Holders are resolved from token accounts to owners. High concentration lets a few holders move the price.",
    compute: (_m, c) => {
      if (isLegacy(c)) {
        // Older scans stored only the raw top-10 figure.
        return c.top10Share == null ? { raw: null, value: "No data" } : { raw: c.top10Share, value: `${c.top10Share.toFixed(1)}% (raw; older scan)` };
      }
      if (c.skipped) return { raw: null, value: "Not run", notRun: c.skipped };
      const h = c.holders;
      if (!h) return { raw: null, value: "No data" };
      const notes: string[] = [];
      if (h.unclassifiedInTop10 > 0) notes.push("! Unclassified program account. May or may not be a pool or lock.");
      if (h.unresolvedInTop10 > 0) notes.push(`! The owner of ${h.unresolvedInTop10} large account${h.unresolvedInTop10 === 1 ? "" : "s"} could not be read; ${h.unresolvedInTop10 === 1 ? "it is" : "they are"} not excluded.`);
      const value = `${h.rawTop10Pct.toFixed(1)}% raw / ${h.adjustedTop10Pct.toFixed(1)}% adjusted`;
      if (h.partial)
        return { raw: null, value: `${value} (partial)`, notes, unknownReason: `Only ${h.adjustedCount} non-excluded holders are visible (RPC returns the 20 largest accounts), so the adjusted figure is a lower bound.` };
      return { raw: h.adjustedTop10Pct, value, notes };
    },
    threshold: (r) => rangeText(r, (n) => `${n}%`),
    pass: inRange,
  },
  {
    id: "creatorHolding",
    label: "Creator wallet holding",
    explain: "A large balance still held by the wallet that created the token can be sold into the market.",
    warnOnly: true,
    compute: (_m, c) => {
      const cr = c.creator;
      const notes = [CREATOR_CAVEAT];
      if (isLegacy(c)) return { ...LEGACY, notes };
      if (c.skipped) return { raw: null, value: "Not run", notRun: c.skipped, notes };
      if (!cr || cr.status === "not_run") return { raw: null, value: "Not run", notRun: cr?.reason ?? "Expensive check not needed yet", notes };
      if (cr.address) notes.push(`Creator ${cr.address}, identified by: ${cr.method ?? "unknown method"}${cr.fromCache ? " (cached)" : ""}.`);
      if (cr.status === "unknown" || cr.holdingPct === null) return { raw: null, value: "No data", notes, unknownReason: cr.reason ?? "Creator could not be determined." };
      return { raw: cr.holdingPct, value: `${cr.holdingPct.toFixed(2)}% of supply`, notes };
    },
    threshold: (r) => rangeText(r, (n) => `${n}%`),
    pass: inRange,
  },
  {
    id: "earlyBuyers",
    label: "Early-buyer clustering (estimate)",
    explain: "Estimates how much of the supply was bought in the first few slots after launch, and whether early buyers share a funding source.",
    warnOnly: true,
    compute: (_m, c, _now, rule) => {
      const k = c.clustering;
      const notes = [CLUSTER_CAVEAT];
      if (isLegacy(c)) return { ...LEGACY, notes };
      if (c.skipped) return { raw: null, value: "Not run", notRun: c.skipped, notes };
      if (!k || k.status === "not_run") return { raw: null, value: "Not run", notRun: k?.reason ?? "Expensive check not needed yet", notes };
      if (k.status === "unknown" || k.pctFirst3Slots === null) return { raw: null, value: "No data", notes, unknownReason: k.reason ?? "Early transactions could not be analysed." };
      const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
      notes.push(`Looked at ${plural(k.txsExamined, "transaction")} over ${plural(k.slotsExamined, "slot")} after the reference slot (source: ${k.source ?? "?"}${k.fromCache ? ", cached" : ""}).`);
      const shared = k.maxSharedFunding;
      notes.push(shared === null ? "Funding sources of the early buyers: not checked or could not be resolved." : `Largest group of early buyers sharing one funding source: ${shared}.`);
      const bad = k.pctFirst3Slots > (rule.max ?? Infinity) || (shared !== null && rule.maxShared != null && shared >= rule.maxShared);
      return { raw: k.pctFirst3Slots, bad, value: `${k.pctFirst3Slots.toFixed(1)}% in first 3 slots · ${plural(k.buyersFirst3Slots ?? 0, "buyer")}`, notes };
    },
    threshold: (r) => `≤ ${r.max ?? "—"}% in 3 slots; < ${r.maxShared ?? "—"} sharing a funder`,
    pass: inRange,
  },
];

export const MAJOR_QUOTES = new Set([
  "So11111111111111111111111111111111111111112", // SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export function evaluate(
  metrics: TokenMetrics,
  chain: ChainData,
  preset: Preset,
  now: number = Date.now(),
): Evaluation {
  const checks: CheckResult[] = [];
  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0, notRun: 0 };
  const push = (r: CheckResult) => {
    checks.push(r);
    if (r.status === "PASS") counts.pass++;
    else if (r.status === "FAIL") counts.fail++;
    else if (r.status === "WARN") counts.warn++;
    else if (r.status === "UNKNOWN") counts.unknown++;
    else if (r.status === "NOT_RUN") counts.notRun++;
  };
  for (const d of DEFS) {
    const rule: CheckRule = preset.rules[d.id] ?? { severity: "off" };
    const severity: Severity = d.warnOnly && rule.severity === "required" ? "warning" : rule.severity;
    const c = d.compute(metrics, chain, now, rule);
    let status: Status;
    let explanation = d.explain;
    if (severity === "off") status = "OFF";
    else if (c.notRun !== undefined) {
      status = "NOT_RUN";
      explanation = `Not run: ${c.notRun}. This is not a pass and not counted as one. ${d.explain}`;
    } else if (c.raw === null) {
      status = "UNKNOWN";
      explanation = `${c.unknownReason ? friendly(c.unknownReason) + " " : ""}No data available, so this is treated as a warning, not a pass. ${d.explain}`;
    } else if (!(c.bad !== undefined ? !c.bad : d.pass(c.raw, rule))) status = severity === "required" ? "FAIL" : "WARN";
    else status = "PASS";
    push({ id: d.id, label: d.label, status, severity, value: c.value, threshold: d.threshold(rule), explanation, notes: c.notes });
  }

  // One row per relevant Token-2022 extension.
  if (Array.isArray(chain.extensions) && !chain.skipped && preset.extensions) {
    for (const r of extensionRows(chain.extensions, preset.extensions)) {
      push({ id: `ext:${r.name}`, label: r.label, status: r.status, severity: r.severity, value: r.value, threshold: r.threshold, explanation: r.explanation, notes: r.notes.length ? r.notes : undefined });
    }
  }

  const unknownRow =
    preset.unknownData === "off"
      ? { status: "OFF" as Status, detail: "Not checked" }
      : counts.unknown > 0
        ? { status: "WARN" as Status, detail: `${counts.unknown} check${counts.unknown > 1 ? "s" : ""} had no data${counts.notRun ? `; ${counts.notRun} not run` : ""}` }
        : { status: "PASS" as Status, detail: `All active checks that ran had data${counts.notRun ? `; ${counts.notRun} not run` : ""}` };
  return { checks, unknownRow, counts, matches: counts.fail === 0 };
}

export const failedRequiredIds = (e: Evaluation): CheckResult["id"][] =>
  e.checks.filter((c) => c.status === "FAIL").map((c) => c.id);

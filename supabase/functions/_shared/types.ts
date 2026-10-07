export type CheckId =
  | "age"
  | "liquidity"
  | "fdv"
  | "volume24h"
  | "mintAuthority"
  | "freezeAuthority"
  | "top10"
  | "poolSplit"
  | "tokenProgram"
  | "creatorHolding"
  | "earlyBuyers";

/** Rule keys for Token-2022 mint extensions. Each found extension becomes one checklist row. */
export type ExtensionRuleKey =
  | "nonTransferable"
  | "permanentDelegate"
  | "defaultAccountState"
  | "transferFeeConfig"
  | "transferHook"
  | "pausableConfig"
  | "mintCloseAuthority"
  | "other";

export type Severity = "required" | "warning" | "off";
/** NOT_RUN: the check was skipped on purpose (expensive check not needed yet, or budget used). Not UNKNOWN, never PASS. */
export type Status = "PASS" | "FAIL" | "WARN" | "UNKNOWN" | "NOT_RUN" | "OFF";

export interface CheckRule {
  severity: Severity;
  min?: number | null;
  max?: number | null;
  /** Value above which a warning-level check is promoted to FAIL (e.g. transfer fee %). */
  failAbove?: number | null;
  /** earlyBuyers only: WARN when at least this many early buyers share one funding source. */
  maxShared?: number | null;
}

export interface Preset {
  id: string;
  name: string;
  subtitle?: string;
  rules: Record<CheckId, CheckRule>;
  /** Severity/threshold per Token-2022 extension kind. */
  extensions: Record<ExtensionRuleKey, CheckRule>;
  unknownData: "warning" | "off";
}

export interface PoolInfo {
  pairAddress: string | null;
  dexId: string | null;
  quoteSymbol: string | null;
  quoteAddress: string | null;
  liquidityUsd: number | null;
  createdAt: number | null;
  url: string | null;
}

export interface TokenMetrics {
  mint: string;
  symbol: string | null;
  name: string | null;
  dataOk: boolean; // false when DEX Screener returned nothing usable
  pairAddress: string | null;
  dexId: string | null;
  dexUrl: string | null;
  imageUrl: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  fdv: number | null;
  marketCap: number | null;
  volume24h: number | null;
  priceChange: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  buys24h: number | null;
  sells24h: number | null;
  pairCreatedAt: number | null; // age of the MAIN pool
  /** Earliest pair across all pools, shown for context only. */
  earliestPairAt: number | null;
  quoteSymbol: string | null;
  quoteAddress: string | null;
  /** All Solana pools for this token, most liquid first. The first is the main pool. */
  pools: PoolInfo[];
  totalLiquidityUsd: number | null;
  /** True when `pools` holds every pool DEX Screener lists for the token (per-token lookup), not just the best pair. */
  poolsComplete: boolean;
  /** Main pool's share of total liquidity, percent. */
  mainPoolShare: number | null;
  links: { label: string; url: string }[];
  boosted: boolean;
}

export type HolderKind =
  | "liquidity_pool"
  | "burn"
  | "program_owned_known"
  | "program_owned_unclassified"
  | "wallet"
  | "unresolved"; // owner could not be read; never excluded

export interface HolderEntry {
  tokenAccount: string;
  owner: string | null;
  amount: number;
  pct: number;
  ownerProgram: string | null;
  kind: HolderKind;
  label: string;
  /** Why it was classified this way, so it can be checked on a block explorer. */
  basis: string;
}

export interface HolderData {
  supply: number;
  /** The (up to) 20 largest token accounts RPC returns, classified. */
  entries: HolderEntry[];
  rawTop10Pct: number;
  adjustedTop10Pct: number;
  adjustedCount: number;
  /** True when fewer than 10 holders remain after exclusions (RPC only returns 20 accounts). */
  partial: boolean;
  excludedCount: number;
  unclassifiedInTop10: number;
  unresolvedInTop10: number;
}

export interface ExtensionInfo {
  /** RPC jsonParsed name, e.g. "transferFeeConfig". */
  name: string;
  authority: string | null;
  details: Record<string, string | number | boolean | null>;
}

export interface CreatorData {
  status: "found" | "unknown" | "not_run";
  address: string | null;
  /** How the creator was identified. */
  method: string | null;
  reason: string | null;
  holdingPct: number | null;
  fromCache: boolean;
}

export interface ClusteringData {
  status: "ok" | "unknown" | "not_run";
  reason: string | null;
  creationSlot: number | null;
  txsExamined: number;
  slotsExamined: number;
  pctFirst3Slots: number | null;
  buyersFirst3Slots: number | null;
  /** Largest number of early buyers sharing one funding source, if checked. */
  maxSharedFunding: number | null;
  source: string | null;
  fromCache: boolean;
}

export interface ChainData {
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  /** Adjusted top-10 %, null when unavailable or only partial. */
  top10Share: number | null;
  errors: string[];
  tokenProgram: "spl-token" | "token-2022" | "other" | null;
  /** null = could not be read (UNKNOWN). [] = none. */
  extensions: ExtensionInfo[] | null;
  holders: HolderData | null;
  creator: CreatorData | null;
  clustering: ClusteringData | null;
  rpcCalls: number;
  budgetHit: boolean;
  /** Set when on-chain checks were deliberately not run for this token (e.g. it failed a market check first). */
  skipped: string | null;
}

export interface CheckResult {
  id: CheckId | `ext:${string}`;
  label: string;
  status: Status;
  severity: Severity;
  value: string;
  threshold: string;
  explanation: string;
  /** Extra lines always shown under the row (caveats, warnings about classification). */
  notes?: string[];
}

export interface Evaluation {
  checks: CheckResult[];
  unknownRow: { status: Status; detail: string };
  counts: { pass: number; warn: number; fail: number; unknown: number; notRun: number };
  matches: boolean; // no failed required check
}

export interface TokenScan {
  metrics: TokenMetrics;
  chain: ChainData;
  evaluation: Evaluation;
  scannedAt: string;
  source: "background" | "site";
  presetId: string;
}

export interface AlertRules {
  priceLevel: number | null;
  liqDropOn: boolean;
  liqDropPct: number | null;
  requiredFailOn: boolean;
}

export interface Settings {
  activePresetId: string;
  presets: Preset[];
  timezone: string;
  alerts: { quietStart: string; quietEnd: string; maxPerHour: number; liquidityDropPct: number };
  guardrails: {
    cooldown: { on: boolean; minutes: number };
    failedRequired: { on: boolean };
    dailyTrades: { on: boolean; max: number };
    dailyMaxLoss: { on: boolean; usd: number | null };
    sizeLimit: { on: boolean; usd: number | null };
  };
  paper: { startingBalance: number; slippagePct: number; feePct: number; defaultSizePct: number };
  staleMinutes: number;
  /** Heuristic for "Likely rug (estimate)": liquidity down at least this % from cohort entry. */
  outcomes: { rugLiquidityDropPct: number };
  /** Per-scan RPC call budgets; when reached, remaining expensive checks show NOT RUN. */
  rpcBudget: { cheapPerScan: number; expensivePerScan: number; creatorPageBudget: number };
}

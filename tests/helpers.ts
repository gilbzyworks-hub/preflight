import type { ChainData, ClusteringData, CreatorData, HolderData, HolderEntry, TokenMetrics } from "@shared/types.ts";

export const NOW = Date.UTC(2026, 0, 10);
export const HOUR = 3_600_000;
export const SOL = "So11111111111111111111111111111111111111112";

export const metrics = (o: Partial<TokenMetrics> = {}): TokenMetrics => ({
  mint: "Mint111", symbol: "TST", name: "Test", dataOk: true, pairAddress: "p", dexId: "raydium",
  dexUrl: null, imageUrl: null, priceUsd: 1, liquidityUsd: 100_000, fdv: 1_000_000, marketCap: 1_000_000,
  volume24h: 500_000, priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 }, buys24h: 1, sells24h: 1,
  pairCreatedAt: NOW - 48 * HOUR, earliestPairAt: NOW - 48 * HOUR, quoteSymbol: "SOL", quoteAddress: SOL,
  pools: [], totalLiquidityUsd: 100_000, poolsComplete: true, mainPoolShare: 100, links: [], boosted: false, ...o,
});

const entry = (i: number, pct: number): HolderEntry => ({
  tokenAccount: `acct${i}`, owner: `owner${i}`, amount: pct * 1000, pct, ownerProgram: null, kind: "wallet", label: "Wallet", basis: "Owner is an ordinary (on-curve) address",
});
export const holders = (adjusted = 20, o: Partial<HolderData> = {}): HolderData => ({
  supply: 100_000, entries: Array.from({ length: 10 }, (_, i) => entry(i, adjusted / 10)), rawTop10Pct: adjusted, adjustedTop10Pct: adjusted,
  adjustedCount: 10, partial: false, excludedCount: 0, unclassifiedInTop10: 0, unresolvedInTop10: 0, ...o,
});
export const creatorFound = (pct = 1): CreatorData => ({ status: "found", address: "Creator111", method: "test", reason: null, holdingPct: pct, fromCache: false });
export const clusteringOk = (pct = 5, shared: number | null = 1): ClusteringData => ({
  status: "ok", reason: null, creationSlot: 100, txsExamined: 50, slotsExamined: 10, pctFirst3Slots: pct, buyersFirst3Slots: 4,
  maxSharedFunding: shared, source: "test", fromCache: false,
});

/** A token where every cheap and expensive check had good data. */
export const chain = (o: Partial<ChainData> = {}): ChainData => ({
  mintAuthorityRevoked: true, freezeAuthorityRevoked: true, top10Share: 20, errors: [],
  tokenProgram: "spl-token", extensions: [], holders: holders(20), creator: creatorFound(), clustering: clusteringOk(),
  rpcCalls: 0, budgetHit: false, skipped: null, ...o,
});
/** Cheap checks only: the expensive ones have not been run. */
export const cheapChain = (o: Partial<ChainData> = {}): ChainData => chain({ creator: null, clustering: null, ...o });

import { getJson, memo, RateLimiter } from "./limiter.ts";
import type { PoolInfo, TokenMetrics } from "./types.ts";

const BASE = "https://api.dexscreener.com";
// Documented limits: 60/min on profile/boost lists, 300/min on pair lookups. Stay under both.
const listLimiter = new RateLimiter(50, 60_000);
const pairLimiter = new RateLimiter(240, 60_000);
// token-pairs/v1 is documented at 60 requests/min; stay under it.
const tokenPairsLimiter = new RateLimiter(50, 60_000);

// deno-lint-ignore no-explicit-any
type Any = any;
const num = (v: Any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function emptyMetrics(mint: string, boosted = false): TokenMetrics {
  return {
    mint,
    symbol: null,
    name: null,
    dataOk: false,
    pairAddress: null,
    dexId: null,
    dexUrl: null,
    imageUrl: null,
    priceUsd: null,
    liquidityUsd: null,
    fdv: null,
    marketCap: null,
    volume24h: null,
    priceChange: { m5: null, h1: null, h6: null, h24: null },
    buys24h: null,
    sells24h: null,
    pairCreatedAt: null,
    earliestPairAt: null,
    quoteSymbol: null,
    quoteAddress: null,
    pools: [],
    totalLiquidityUsd: null,
    poolsComplete: false,
    mainPoolShare: null,
    links: [],
    boosted,
  };
}

/** Build metrics from every Solana pair listed for a token. The main pool is the one with the highest liquidity;
 *  liquidity, volume, FDV, age and price all come from it. Other pools are kept for the split-liquidity check. */
export function toMetrics(mint: string, pairs: Any[], boosted: boolean, complete = false): TokenMetrics {
  const mine = pairs.filter((p) => p?.chainId === "solana" && p?.baseToken?.address === mint);
  if (!mine.length) return emptyMetrics(mint, boosted);
  mine.sort((a, b) => (num(b.liquidity?.usd) ?? -1) - (num(a.liquidity?.usd) ?? -1));
  const p = mine[0];
  const pools: PoolInfo[] = mine.map((x) => ({
    pairAddress: x.pairAddress ?? null,
    dexId: x.dexId ?? null,
    quoteSymbol: x.quoteToken?.symbol ?? null,
    quoteAddress: x.quoteToken?.address ?? null,
    liquidityUsd: num(x.liquidity?.usd),
    createdAt: num(x.pairCreatedAt),
    url: x.url ?? null,
  }));
  const liqs = pools.map((x) => x.liquidityUsd).filter((x): x is number => x !== null);
  const total = liqs.length ? liqs.reduce((a, b) => a + b, 0) : null;
  const mainLiq = pools[0].liquidityUsd;
  const created = pools.map((x) => x.createdAt).filter((x): x is number => x !== null);
  const links: { label: string; url: string }[] = [];
  for (const w of p.info?.websites ?? []) if (w?.url) links.push({ label: w.label ?? "Website", url: w.url });
  for (const s of p.info?.socials ?? []) if (s?.url) links.push({ label: s.type ?? "Social", url: s.url });
  return {
    mint,
    symbol: p.baseToken?.symbol ?? null,
    name: p.baseToken?.name ?? null,
    dataOk: true,
    pairAddress: p.pairAddress ?? null,
    dexId: p.dexId ?? null,
    dexUrl: p.url ?? null,
    imageUrl: p.info?.imageUrl ?? null,
    priceUsd: num(p.priceUsd),
    liquidityUsd: mainLiq,
    fdv: num(p.fdv),
    marketCap: num(p.marketCap),
    volume24h: num(p.volume?.h24),
    priceChange: {
      m5: num(p.priceChange?.m5),
      h1: num(p.priceChange?.h1),
      h6: num(p.priceChange?.h6),
      h24: num(p.priceChange?.h24),
    },
    buys24h: num(p.txns?.h24?.buys),
    sells24h: num(p.txns?.h24?.sells),
    pairCreatedAt: pools[0].createdAt,
    earliestPairAt: created.length ? Math.min(...created) : null,
    quoteSymbol: pools[0].quoteSymbol,
    quoteAddress: pools[0].quoteAddress,
    pools,
    totalLiquidityUsd: total,
    poolsComplete: complete,
    mainPoolShare: total && mainLiq !== null && total > 0 ? (mainLiq / total) * 100 : null,
    links,
    boosted: boosted || (num(p.boosts?.active) ?? 0) > 0,
  };
}

/** Batched lookup (30 addresses per request) via tokens/v1, which returns ONE pair per token: DEX Screener's pick.
 *  Good for pre-filtering. With `allPools`, each token is then looked up on its own (token-pairs/v1) so every pool
 *  is known and the main pool is the one with the highest liquidity. Missing tokens map to empty metrics. */
export async function fetchMetrics(
  mints: string[],
  boosted: Set<string> = new Set(),
  opts: { allPools?: boolean } = {},
): Promise<{ metrics: Map<string, TokenMetrics>; errors: string[]; failed: Set<string> }> {
  const metrics = new Map<string, TokenMetrics>();
  const errors: string[] = [];
  /** Mints whose request failed. Not the same as "request worked and no pair was returned". */
  const failed = new Set<string>();
  const unique = [...new Set(mints)];
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    try {
      const url = `${BASE}/tokens/v1/solana/${batch.join(",")}`;
      const json = (await memo(url, 15_000, () => getJson(url, pairLimiter))) as Any;
      const pairs: Any[] = Array.isArray(json) ? json : [];
      for (const m of batch) metrics.set(m, toMetrics(m, pairs, boosted.has(m)));
    } catch (e) {
      errors.push(`DEX Screener: ${e instanceof Error ? e.message : String(e)}`);
      for (const m of batch) {
        metrics.set(m, emptyMetrics(m, boosted.has(m)));
        failed.add(m);
      }
    }
  }
  if (opts.allPools) {
    await Promise.all(
      unique.map(async (m) => {
        try {
          const url = `${BASE}/token-pairs/v1/solana/${m}`;
          const json = (await memo(url, 15_000, () => getJson(url, tokenPairsLimiter))) as Any;
          const pairs: Any[] = Array.isArray(json) ? json : [];
          metrics.set(m, toMetrics(m, pairs, boosted.has(m), true));
          failed.delete(m);
        } catch (e) {
          // Keep the batch result (single best pool, flagged incomplete) rather than losing the token.
          errors.push(`DEX Screener pools: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );
  }
  return { metrics, errors, failed };
}

/** Look up specific pools by pair address (30 per request). Pairs that are not returned are simply absent. */
export async function fetchPairsByAddress(
  pairAddresses: string[],
): Promise<{ pairs: Map<string, Any>; failed: Set<string> }> {
  const pairs = new Map<string, Any>();
  const failed = new Set<string>();
  const unique = [...new Set(pairAddresses)];
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    try {
      const url = `${BASE}/latest/dex/pairs/solana/${batch.join(",")}`;
      const json = (await memo(url, 15_000, () => getJson(url, pairLimiter))) as Any;
      for (const p of Array.isArray(json?.pairs) ? json.pairs : []) if (p?.pairAddress) pairs.set(p.pairAddress, p);
    } catch {
      for (const a of batch) failed.add(a);
    }
  }
  return { pairs, failed };
}

export interface SourceStat {
  name: string;
  ok: boolean;
  returned: number;
  error?: string;
}
export interface Candidate {
  mint: string;
  boosted: boolean;
  profiled: boolean;
}

/** Candidate token addresses: recently profiled, recently updated and boosted lists. */
export async function fetchCandidates(): Promise<{
  candidates: Candidate[];
  errors: string[];
  sourceStats: SourceStat[];
}> {
  const sources: [string, boolean][] = [
    ["/token-profiles/latest/v1", false],
    ["/token-profiles/recent-updates/v1", false],
    ["/token-boosts/latest/v1", true],
    ["/token-boosts/top/v1", true],
  ];
  const found = new Map<string, Candidate>();
  const errors: string[] = [];
  const sourceStats: SourceStat[] = [];
  await Promise.all(
    sources.map(async ([path, boosted]) => {
      try {
        const url = BASE + path;
        const json = (await memo(url, 60_000, () => getJson(url, listLimiter))) as Any;
        let returned = 0;
        for (const it of Array.isArray(json) ? json : []) {
          if (it?.chainId !== "solana" || !it?.tokenAddress) continue;
          returned++;
          const c = found.get(it.tokenAddress) ?? { mint: it.tokenAddress, boosted: false, profiled: false };
          if (boosted) c.boosted = true;
          else c.profiled = true;
          found.set(it.tokenAddress, c);
        }
        sourceStats.push({ name: path, ok: true, returned });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`DEX Screener ${path}: ${msg}`);
        sourceStats.push({ name: path, ok: false, returned: 0, error: msg });
      }
    }),
  );
  return { candidates: [...found.values()], errors, sourceStats };
}

/** Manual text search; returns distinct Solana base tokens (best pair each). */
export async function searchSolana(q: string): Promise<TokenMetrics[]> {
  const url = `${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`;
  const json = (await memo(url, 15_000, () => getJson(url, pairLimiter))) as Any;
  const pairs: Any[] = (Array.isArray(json?.pairs) ? json.pairs : []).filter((p: Any) => p?.chainId === "solana");
  const mints = [...new Set(pairs.map((p) => p.baseToken?.address).filter(Boolean))] as string[];
  return mints.slice(0, 12).map((m) => toMetrics(m, pairs, false));
}

export const looksLikeMint = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());

import { activePreset, DEFAULT_SETTINGS, mergeSettings } from "./defaults.ts";
import { fetchCandidates, fetchMetrics } from "./dex.ts";
import { evaluate, failedRequiredIds, fmtUsd } from "./engine.ts";
import { lookupClustering, lookupCreator } from "./launch.ts";
import { BudgetError, emptyChain, getChainData, makeRpc, RpcBudget } from "./rpc.ts";
import { logCoverage, observeScans, runFollowUps, type ObserveItem, type ObsSource } from "./outcomes.ts";
import { PAPER_CLOSE_NOTE, paperExit } from "./paper.ts";
import type { AlertRules, ChainData, ClusteringData, CreatorData, Preset, Settings, TokenMetrics, TokenScan } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Db = any; // supabase-js client (browser-session, server-session or service role)
// deno-lint-ignore no-explicit-any
type Any = any;

export interface ScanCtx {
  rpcUrl: string;
  preset: Preset;
  source: "background" | "site";
  boosted?: Set<string>;
  /** For RPC budgets. Falls back to the defaults. */
  settings?: Settings;
  /** For the creator/clustering cache. Without them those checks still run but nothing is cached. */
  db?: Db;
  userId?: string;
  /** Tokens that always get the expensive checks (watchlist, open positions, a checklist the user opened). */
  force?: Set<string>;
}

export interface ScanStats {
  cheapUsed: number;
  cheapLimit: number;
  expensiveUsed: number;
  expensiveLimit: number;
  expensiveRun: number;
  /** Eligible tokens whose expensive checks did not run because the budget was used up. */
  budgetSkipped: number;
  budgetHit: boolean;
}

const NOT_ELIGIBLE = "only run for tokens that pass the required checks, watchlist tokens and checklists you open";
const BUDGET_REASON = "RPC budget for this scan was used up; it will run on a later scan";
const CHEAP_COST = 6; // mint info + supply + largest accounts + token accounts + owners (+ spare)

interface Miss { reason: string; at: string }
const MISS_TTL_MS = 24 * 3_600_000;
const unknownCreator = (reason: string): CreatorData => ({ status: "unknown", address: null, method: null, reason, holdingPct: null, fromCache: false });
const notRunCreator = (reason: string): CreatorData => ({ status: "not_run", address: null, method: null, reason, holdingPct: null, fromCache: false });
const notRunClustering = (reason: string): ClusteringData => ({
  status: "not_run", reason, creationSlot: null, txsExamined: 0, slotsExamined: 0, pctFirst3Slots: null,
  buyersFirst3Slots: null, maxSharedFunding: null, source: null, fromCache: false,
});

/** Scan specific mints: DEX Screener for market data, RPC for on-chain checks.
 *  Cheap checks (authorities, extensions, holders, pools) run for every token. Expensive checks (creator,
 *  early-buyer clustering) run only for eligible tokens, in priority order, until the budget is used. */
export async function scanTokens(
  mints: string[],
  ctx: ScanCtx,
  opts: { chainFor?: (m: TokenMetrics) => boolean } = {},
): Promise<{ scans: Map<string, TokenScan>; errors: string[]; stats: ScanStats }> {
  const { metrics, errors } = await fetchMetrics(mints, ctx.boosted, { allPools: true });
  const now = Date.now();
  const rb = (ctx.settings ?? DEFAULT_SETTINGS).rpcBudget;
  const cheap = new RpcBudget(rb.cheapPerScan);
  const expensive = new RpcBudget(rb.expensivePerScan);
  const chains = new Map<string, ChainData>();

  await Promise.all(
    [...metrics].map(async ([mint, m]) => {
      const wantChain = m.dataOk && (opts.chainFor ? opts.chainFor(m) : true);
      let chain = emptyChain();
      chain.skipped = wantChain ? null : m.dataOk ? "failed a market check first, so on-chain checks were skipped" : "no market data";
      if (wantChain) {
        if (cheap.left < CHEAP_COST) {
          chain.skipped = BUDGET_REASON;
          cheap.hit = true;
        } else {
          try {
            chain = await getChainData(ctx.rpcUrl, mint, {
              budget: cheap,
              poolAddresses: new Set(m.pools.map((p) => p.pairAddress).filter((x): x is string => !!x)),
            });
          } catch (e) {
            chain = emptyChain(`RPC: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      chains.set(mint, chain);
    }),
  );

  // Expensive checks: eligible tokens only, forced ones first, then by volume.
  const order = [...metrics.values()]
    .filter((m) => m.dataOk && !chains.get(m.mint)!.skipped)
    .sort((a, b) => Number(ctx.force?.has(b.mint) ?? false) - Number(ctx.force?.has(a.mint) ?? false) || (b.volume24h ?? 0) - (a.volume24h ?? 0));
  let expensiveRun = 0;
  let budgetSkipped = 0;
  for (const m of order) {
    const chain = chains.get(m.mint)!;
    const forced = ctx.force?.has(m.mint) ?? false;
    if (!forced && evaluate(m, chain, ctx.preset, now).counts.fail > 0) {
      chain.creator = notRunCreator(NOT_ELIGIBLE);
      chain.clustering = notRunClustering(NOT_ELIGIBLE);
      continue;
    }
    if (expensive.left < 10) {
      chain.creator = notRunCreator(BUDGET_REASON);
      chain.clustering = notRunClustering(BUDGET_REASON);
      expensive.hit = true;
      budgetSkipped++;
      continue;
    }
    expensiveRun++;
    await runExpensive(m, chain, ctx, expensive, rb.creatorPageBudget);
  }

  const scans = new Map<string, TokenScan>();
  for (const [mint, m] of metrics) {
    const chain = chains.get(mint)!;
    chain.rpcCalls = cheap.used + expensive.used;
    chain.budgetHit = cheap.hit || expensive.hit;
    scans.set(mint, {
      metrics: m,
      chain,
      evaluation: evaluate(m, chain, ctx.preset, now),
      scannedAt: new Date(now).toISOString(),
      source: ctx.source,
      presetId: ctx.preset.id,
    });
  }
  const stats: ScanStats = {
    cheapUsed: cheap.used, cheapLimit: cheap.limit, expensiveUsed: expensive.used, expensiveLimit: expensive.limit,
    expensiveRun, budgetSkipped, budgetHit: cheap.hit || expensive.hit,
  };
  return { scans, errors, stats };
}

/** Creator + clustering for one token, using and filling the per-mint cache. Mutates `chain`. */
async function runExpensive(m: TokenMetrics, chain: ChainData, ctx: ScanCtx, budget: RpcBudget, pageBudget: number) {
  const call = makeRpc(ctx.rpcUrl, budget);
  try {
    let cached: { creator: CreatorData | null; clustering: ClusteringData | null; creator_miss?: Miss | null; clustering_miss?: Miss | null } = { creator: null, clustering: null };
    if (ctx.db && ctx.userId) {
      const { data } = await ctx.db.from("token_facts").select("creator,clustering,creator_miss,clustering_miss").eq("user_id", ctx.userId).eq("mint", m.mint).maybeSingle();
      if (data) cached = data;
    }
    const fresh = (x?: Miss | null) => !!x && Date.now() - new Date(x.at).getTime() < MISS_TTL_MS;
    const exclude = new Set<string>((chain.holders?.entries ?? []).filter((e) => e.kind === "liquidity_pool" && e.owner).map((e) => e.owner!));
    const input = {
      call, mint: m.mint, supply: chain.holders?.supply ?? null, mainPoolAddress: m.pairAddress, excludeOwners: exclude,
      pageBudget, cachedCreator: cached.creator, cachedClustering: cached.clustering,
    };
    // A search that failed for a lasting reason is not repeated for a day.
    const found = !cached.creator && fresh(cached.creator_miss)
      ? { creator: { ...unknownCreator(cached.creator_miss!.reason), fromCache: true }, curve: null as string | null }
      : await lookupCreator(input);
    chain.creator = found.creator;
    const isPump = !!found.creator.method?.startsWith("pump.fun");
    chain.clustering = cached.clustering?.status === "ok"
      ? { ...cached.clustering, fromCache: true }
      : fresh(cached.clustering_miss)
        ? { ...notRunClustering(""), status: "unknown", reason: cached.clustering_miss!.reason, fromCache: true }
        : await lookupClustering(input, found.curve, isPump);
    if (ctx.db && ctx.userId) {
      const row: Record<string, unknown> = { user_id: ctx.userId, mint: m.mint };
      const lasting = (r: string | null) => !!r && !r.startsWith("RPC:"); // transient provider errors are retried next scan
      if (found.creator.status === "unknown" && !found.creator.fromCache && lasting(found.creator.reason)) row.creator_miss = { reason: found.creator.reason, at: new Date().toISOString() };
      if (chain.clustering.status === "unknown" && !chain.clustering.fromCache && lasting(chain.clustering.reason)) row.clustering_miss = { reason: chain.clustering.reason, at: new Date().toISOString() };
      // The creator's address never changes; their balance does, so it is not cached.
      if (found.creator.status === "found" && !found.creator.fromCache) row.creator = { ...found.creator, holdingPct: null };
      if (chain.clustering.status === "ok" && !chain.clustering.fromCache) row.clustering = chain.clustering;
      if (row.creator || row.clustering || row.creator_miss || row.clustering_miss) await ctx.db.from("token_facts").upsert(row, { onConflict: "user_id,mint" });
    }
  } catch (e) {
    const reason = e instanceof BudgetError ? BUDGET_REASON : `error: ${e instanceof Error ? e.message : String(e)}`;
    if (e instanceof BudgetError) budget.hit = true;
    chain.creator ??= notRunCreator(reason);
    chain.clustering ??= notRunClustering(reason);
  }
}

/** Market-data checks that gate whether on-chain calls are worth making. */
export const passesMarketChecks = (m: TokenMetrics, preset: Preset): boolean => {
  const e = evaluate(m, emptyChain(), preset);
  return !e.checks.some((c) => c.status === "FAIL" && ["age", "liquidity", "fdv", "volume24h"].includes(c.id));
};

/** Broader feed scan: candidate lists -> market checks -> on-chain checks for survivors. */
export async function scanCandidates(db: Db, userId: string, ctx: ScanCtx, extraMints: string[] = []) {
  const { candidates, errors: listErrors, sourceStats } = await fetchCandidates();
  const boosted = new Set(candidates.filter((c) => c.boosted).map((c) => c.mint));
  const mints = [...new Set([...candidates.map((c) => c.mint), ...extraMints])];
  const withBoost = { ...ctx, boosted, db, userId };
  const { metrics, errors } = await fetchMetrics(mints, boosted);
  const survivors = [...metrics.values()]
    .filter((m) => m.dataOk && passesMarketChecks(m, ctx.preset))
    .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
    .slice(0, 15)
    .map((m) => m.mint);
  const { scans, errors: scanErrors, stats } = await scanTokens(survivors, withBoost);
  await saveScans(db, userId, [...scans.values()]);
  const allErrors = [...listErrors, ...errors, ...scanErrors];

  // Outcome capture: failing here must never break the scan itself.
  let written = 0;
  try {
    const { data: wl } = await db.from("watchlist").select("mint").eq("user_id", userId);
    const watch = new Set<string>((wl ?? []).map((w: { mint: string }) => w.mint));
    const via = new Map(candidates.map((c) => [c.mint, c]));
    const sourcesOf = (mint: string): ObsSource[] => {
      const c = via.get(mint);
      const out: ObsSource[] = [];
      if (c?.profiled) out.push("profiled");
      if (c?.boosted) out.push("boosted");
      if (!c) out.push("manual");
      return out;
    };
    const now = Date.now();
    const items: ObserveItem[] = [];
    for (const [mint, m] of metrics) {
      if (!m.dataOk) continue;
      const skipped = emptyChain();
      skipped.skipped = "failed a market check first, so on-chain checks were skipped";
      const scan = scans.get(mint) ?? {
        metrics: m,
        chain: skipped,
        evaluation: evaluate(m, skipped, ctx.preset, now),
        scannedAt: new Date(now).toISOString(),
        source: ctx.source,
        presetId: ctx.preset.id,
      };
      items.push({ scan, sources: sourcesOf(mint), shown: scans.has(mint) });
    }
    written = (await observeScans(db, userId, ctx.preset, items, watch, { unshownOnlyAtEntry: true })).written;
  } catch (e) {
    allErrors.push(`Outcome capture: ${e instanceof Error ? e.message : String(e)}`);
  }
  await logCoverage(db, userId, {
    kind: "feed",
    sources: sourceStats,
    tokensReturned: mints.length,
    tokensWithData: [...metrics.values()].filter((m) => m.dataOk).length,
    tokensShown: scans.size,
    observationsWritten: written,
    errors: allErrors,
    rpcCalls: stats.cheapUsed + stats.expensiveUsed,
    budgetHit: stats.budgetHit,
  });
  return {
    scans: [...scans.values()],
    scanned: mints.length,
    errors: allErrors,
  };
}

/** Watchlist refreshes run every 2 minutes in the background, so they are logged at most hourly per token. */
async function observeWatchlist(db: Db, userId: string, preset: Preset, mints: string[], scans: Map<string, TokenScan>, source: "background" | "site") {
  try {
    if (!mints.length) return;
    let skip = new Set<string>();
    if (source === "background") {
      const since = new Date(Date.now() - 3_600_000).toISOString();
      const { data } = await db.from("observations").select("mint").eq("user_id", userId).contains("sources", ["watchlist"]).gte("observed_at", since).in("mint", mints);
      skip = new Set((data ?? []).map((r: { mint: string }) => r.mint));
    }
    const items: ObserveItem[] = mints
      .filter((m) => !skip.has(m) && scans.has(m))
      .map((m) => ({ scan: scans.get(m)!, sources: ["watchlist"] as ObsSource[], shown: false }));
    if (!items.length) return;
    const { written } = await observeScans(db, userId, preset, items, new Set(mints));
    await logCoverage(db, userId, {
      kind: "watchlist",
      tokensReturned: mints.length,
      tokensWithData: items.filter((i) => i.scan.metrics.dataOk).length,
      observationsWritten: written,
    });
  } catch (e) {
    console.error("watchlist observation failed:", e instanceof Error ? e.message : e);
  }
}

export async function saveScans(db: Db, userId: string, scans: TokenScan[]) {
  const rows = scans
    .filter((s) => s.metrics.dataOk) // a failed fetch keeps the previous row, which then shows its own as-of time
    .map((s) => ({
      user_id: userId,
      mint: s.metrics.mint,
      data: s,
      scanned_at: s.scannedAt,
      source: s.source,
    }));
  if (rows.length) {
    const { error } = await db.from("token_scans").upsert(rows, { onConflict: "user_id,mint" });
    if (error) throw new Error(`Saving scan results failed: ${error.message}`);
  }
}

const DEFAULT_RULES: AlertRules = { priceLevel: null, liqDropOn: true, liqDropPct: null, requiredFailOn: true };

/** Watchlist tokens + open paper positions: scan, write results, raise alerts, close paper stops/targets. */
export async function scanForUser(db: Db, userId: string, opts: { rpcUrl: string; source: "background" | "site" }) {
  const { data: srow } = await db.from("settings").select("data").eq("user_id", userId).maybeSingle();
  const settings: Settings = mergeSettings(srow?.data);
  const preset = activePreset(settings);
  const [{ data: wl }, { data: open }] = await Promise.all([
    db.from("watchlist").select("*").eq("user_id", userId),
    db.from("trades").select("*").eq("user_id", userId).eq("kind", "paper").eq("status", "open"),
  ]);
  const watch: Any[] = wl ?? [];
  const positions: Any[] = open ?? [];
  const mints = [...new Set([...watch.map((w) => w.mint), ...positions.map((p) => p.mint)])];
  if (!mints.length) return { tokens: 0, ok: 0, alerts: 0, closed: 0, errors: [] as string[], stats: null as ScanStats | null };

  // Watched tokens and open positions always get the expensive checks (creator results are cached once found).
  const { scans, errors, stats } = await scanTokens(mints, { rpcUrl: opts.rpcUrl, preset, source: opts.source, settings, db, userId, force: new Set(mints) });
  await saveScans(db, userId, [...scans.values()]);
  const okCount = [...scans.values()].filter((s) => s.metrics.dataOk).length;
  await observeWatchlist(db, userId, preset, watch.map((w) => w.mint), scans, opts.source);

  // --- alerts ---
  const alertRows: Any[] = [];
  for (const w of watch) {
    const s = scans.get(w.mint);
    if (!s?.metrics.dataOk || s.metrics.priceUsd === null) continue;
    const rules: AlertRules = { ...DEFAULT_RULES, ...(w.rules ?? {}) };
    const prev = w.last_state as { price: number | null; liquidityUsd: number | null; failedRequired: string[] } | null;
    const sym = s.metrics.symbol ?? w.symbol ?? w.mint.slice(0, 6);
    const price = s.metrics.priceUsd;
    const liq = s.metrics.liquidityUsd;
    const failed = failedRequiredIds(s.evaluation);
    const push = (kind: string, message: string) =>
      alertRows.push({ user_id: userId, mint: w.mint, symbol: sym, kind, message, scan_at: s.scannedAt });
    if (prev) {
      if (rules.priceLevel != null && prev.price != null) {
        const was = prev.price >= rules.priceLevel;
        const now = price >= rules.priceLevel;
        if (was !== now) push("price_cross", `Price crossed your level of $${rules.priceLevel} (${prev.price} → ${price}).`);
      }
      const pct = rules.liqDropPct ?? settings.alerts.liquidityDropPct;
      if (rules.liqDropOn && prev.liquidityUsd && liq !== null) {
        const drop = ((prev.liquidityUsd - liq) / prev.liquidityUsd) * 100;
        if (drop >= pct)
          push("liquidity_drop", `Liquidity fell ${drop.toFixed(0)}% since the previous scan (${fmtUsd(prev.liquidityUsd)} → ${fmtUsd(liq)}).`);
      }
      if (rules.requiredFailOn) {
        const newly = failed.filter((id) => !(prev.failedRequired ?? []).includes(id));
        if (newly.length) {
          const labels = s.evaluation.checks.filter((c) => newly.includes(c.id)).map((c) => c.label);
          push("required_fail", `Required check newly failing: ${labels.join(", ")}.`);
        }
      }
    }
    await db
      .from("watchlist")
      .update({ last_state: { price, liquidityUsd: liq, failedRequired: failed, at: s.scannedAt } })
      .eq("id", w.id);
  }
  if (alertRows.length) await db.from("alerts").insert(alertRows);

  // --- paper stops / targets ---
  let closed = 0;
  for (const t of positions) {
    const s = scans.get(t.mint);
    const price = s?.metrics.priceUsd;
    if (!s?.metrics.dataOk || price == null) continue;
    const exit = paperExit(Number(t.qty), Number(t.amount_usd), price, settings.paper);
    let reason: string | null = null;
    if (price <= Number(t.stop)) reason = "stop";
    else if (price >= Number(t.target)) reason = "target";
    else if (-exit.pnl >= Number(t.max_loss_usd)) reason = "max_loss";
    if (!reason) continue;
    const { error } = await db
      .from("trades")
      .update({
        status: "closed",
        exit_price: exit.fillPrice,
        exit_time: s.scannedAt,
        exit_reason: reason,
        exit_note: PAPER_CLOSE_NOTE,
        fees_usd: Number(t.fees_usd ?? 0) + exit.feeUsd,
        pnl_usd: exit.pnl,
      })
      .eq("id", t.id)
      .eq("status", "open");
    if (!error) closed++;
  }
  return { tokens: mints.length, ok: okCount, alerts: alertRows.length, closed, errors, stats: stats as ScanStats | null };
}

/** Background job entry: every user's watchlist + open paper positions, with a logged run. */
export async function runBackgroundScan(db: Db, rpcUrl: string) {
  const { data: run } = await db.from("scan_runs").insert({ status: "running" }).select("id").single();
  const finish = (status: "ok" | "error", error: string | null, detail: unknown) =>
    db.from("scan_runs").update({ finished_at: new Date().toISOString(), status, error, detail }).eq("id", run?.id);
  try {
    const ids = new Set<string>();
    for (const t of ["settings", "watchlist"]) {
      const { data } = await db.from(t).select("user_id");
      for (const r of data ?? []) ids.add(r.user_id);
    }
    const { data: tr } = await db.from("trades").select("user_id").eq("kind", "paper").eq("status", "open");
    for (const r of tr ?? []) ids.add(r.user_id);
    const results = [];
    const errors: string[] = [];
    for (const id of ids) {
      const r = await scanForUser(db, id, { rpcUrl, source: "background" });
      results.push(r);
      if (r.tokens > 0 && r.ok === 0) errors.push("No market data returned for any watched token");
      errors.push(...r.errors.slice(0, 2));
    }
    const fatal = results.some((r) => r.tokens > 0 && r.ok === 0);
    // Outcome follow-ups never affect the scan's own success/failure (and so not the header's "last successful").
    let followUps: unknown = null;
    try {
      followUps = await runFollowUps(db);
    } catch (e) {
      followUps = { error: e instanceof Error ? e.message : String(e) };
    }
    // RPC usage across users, so budget hits show up in the run log.
    const budget = results.reduce(
      (a, r) => ({
        calls: a.calls + (r.stats ? r.stats.cheapUsed + r.stats.expensiveUsed : 0),
        hits: a.hits + (r.stats?.budgetHit ? 1 : 0),
        skipped: a.skipped + (r.stats?.budgetSkipped ?? 0),
      }),
      { calls: 0, hits: 0, skipped: 0 },
    );
    await finish(fatal ? "error" : "ok", errors.length ? errors.slice(0, 3).join("; ").slice(0, 300) : null, { results, followUps, budget });
    return { ok: !fatal, results };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finish("error", msg.slice(0, 300), null);
    return { ok: false, error: msg };
  }
}

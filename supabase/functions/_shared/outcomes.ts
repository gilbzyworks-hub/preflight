// Outcome data collection (v1). Append-only: observations, cohorts and snapshots are only ever inserted.
import { fetchMetrics, fetchPairsByAddress, type SourceStat } from "./dex.ts";
import type { RugCheckResult } from "./rugcheck.ts";
import type { Preset, TokenScan } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Db = any; // supabase-js client
// deno-lint-ignore no-explicit-any
type Any = any;

export type ObsSource = "profiled" | "boosted" | "watchlist" | "manual";

/** Follow-ups run at these offsets from cohort entry. A snapshot taken later than `graceMs` after it
 *  was due is not taken at all: it is recorded as missed (values from a different time are never backfilled). */
export const HORIZONS = [
  { id: "1h", ms: 3_600_000, graceMs: 30 * 60_000 },
  { id: "24h", ms: 24 * 3_600_000, graceMs: 3 * 3_600_000 },
  { id: "7d", ms: 7 * 24 * 3_600_000, graceMs: 12 * 3_600_000 },
] as const;
export type HorizonId = (typeof HORIZONS)[number]["id"];

const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Any)[k])}`).join(",")}}`
      : JSON.stringify(v ?? null);

/** Identity of a preset's rules. Renaming does not create a new version; changing a rule or threshold does. */
export async function presetHash(p: Preset): Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ rules: p.rules, unknownData: p.unknownData }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ensurePresetVersion(db: Db, userId: string, preset: Preset): Promise<string> {
  const hash = await presetHash(preset);
  const find = () => db.from("preset_versions").select("id").eq("user_id", userId).eq("content_hash", hash).maybeSingle();
  const hit = await find();
  if (hit.data) return hit.data.id;
  const { error } = await db
    .from("preset_versions")
    .upsert({ user_id: userId, content_hash: hash, preset }, { onConflict: "user_id,content_hash", ignoreDuplicates: true });
  if (error) throw new Error(`Saving preset version failed: ${error.message}`);
  const again = await find();
  if (!again.data) throw new Error("Preset version missing after insert");
  return again.data.id;
}

export interface ObserveItem {
  scan: TokenScan;
  sources: ObsSource[];
  shown: boolean;
  /** Only set when the user asked for RugCheck on this lookup; otherwise null (not requested). */
  rugcheck?: RugCheckResult | null;
}

/** Record every item as an observation, and open a cohort the first time a token appears under this preset version. */
export async function observeScans(
  db: Db,
  userId: string,
  preset: Preset,
  items: ObserveItem[],
  watchMints: Set<string>,
  opts: { unshownOnlyAtEntry?: boolean } = {},
): Promise<{ written: number }> {
  const byMint = new Map<string, ObserveItem>();
  for (const it of items) if (it.scan.metrics.dataOk) byMint.set(it.scan.metrics.mint, it);
  if (!byMint.size) return { written: 0 };
  const versionId = await ensurePresetVersion(db, userId, preset);
  if (opts.unshownOnlyAtEntry) {
    // Tokens that were not shown are logged once, when their cohort opens, to keep volume sane.
    const unshown = [...byMint.values()].filter((i) => !i.shown).map((i) => i.scan.metrics.mint);
    for (let i = 0; i < unshown.length; i += 100) {
      const { data } = await db.from("cohorts").select("mint").eq("user_id", userId).eq("preset_version_id", versionId).in("mint", unshown.slice(i, i + 100));
      for (const r of data ?? []) byMint.delete(r.mint);
    }
    if (!byMint.size) return { written: 0 };
  }
  const rows = [...byMint.values()].map(({ scan, sources, shown, rugcheck }) => ({
    user_id: userId,
    observed_at: scan.scannedAt,
    mint: scan.metrics.mint,
    pair_address: scan.metrics.pairAddress,
    sources,
    paid_promotion: scan.metrics.boosted,
    shown,
    on_watchlist: watchMints.has(scan.metrics.mint),
    preset_version_id: versionId,
    metrics: scan.metrics,
    chain: scan.chain,
    checks: scan.evaluation.checks.map((c) => ({ id: c.id, label: c.label, status: c.status, severity: c.severity, value: c.value, threshold: c.threshold, notes: c.notes ?? null })),
    counts: scan.evaluation.counts,
    // Fields added with schema version 2; older rows leave them null and are shown as "not collected at the time".
    holders: scan.chain.holders,
    pools: scan.metrics.pools,
    extensions: scan.chain.extensions,
    creator: scan.chain.creator,
    clustering: scan.chain.clustering,
    rpc_budget: { calls: scan.chain.rpcCalls, budgetHit: scan.chain.budgetHit, skipped: scan.chain.skipped },
    schema_version: 2,
    rugcheck: rugcheck ?? null,
  }));
  const { data, error } = await db.from("observations").insert(rows).select("id,mint,observed_at");
  if (error) throw new Error(`Saving observations failed: ${error.message}`);
  const cohorts = (data ?? []).map((o: Any) => ({
    user_id: userId,
    mint: o.mint,
    preset_version_id: versionId,
    entered_at: o.observed_at,
    entry_observation_id: o.id,
  }));
  if (cohorts.length) {
    const { error: ce } = await db.from("cohorts").upsert(cohorts, { onConflict: "user_id,mint,preset_version_id", ignoreDuplicates: true });
    if (ce) throw new Error(`Saving cohorts failed: ${ce.message}`);
  }
  return { written: rows.length };
}

export interface CoverageEntry {
  kind: "feed" | "watchlist" | "manual" | "followup";
  sources?: SourceStat[];
  tokensReturned?: number;
  tokensWithData?: number;
  tokensShown?: number;
  observationsWritten?: number;
  errors?: string[];
  rpcCalls?: number;
  budgetHit?: boolean;
}
const RATE_LIMIT = /429|rate.?limit|too many/i;

export async function logCoverage(db: Db, userId: string | null, c: CoverageEntry) {
  const errors = (c.errors ?? []).slice(0, 20);
  const { error } = await db.from("coverage_log").insert({
    user_id: userId,
    kind: c.kind,
    sources: c.sources ?? [],
    tokens_returned: c.tokensReturned ?? 0,
    tokens_with_data: c.tokensWithData ?? 0,
    tokens_shown: c.tokensShown ?? 0,
    observations_written: c.observationsWritten ?? 0,
    errors,
    rpc_calls: c.rpcCalls ?? 0,
    budget_hit: c.budgetHit ?? false,
    rate_limited: errors.some((e) => RATE_LIMIT.test(e)) || (c.sources ?? []).some((s) => s.error && RATE_LIMIT.test(s.error)),
  });
  if (error) console.error("coverage_log insert failed:", error.message);
}

// ---------- follow-up snapshots ----------

export interface PlanItem {
  horizon: HorizonId;
  dueAt: number;
  action: "wait" | "take" | "missed";
  lateMs: number;
}

/** What to do for each horizon that has no snapshot yet. Pure, so it can be tested. */
export function snapshotPlan(enteredAt: number, have: Set<string>, now: number): PlanItem[] {
  const out: PlanItem[] = [];
  for (const h of HORIZONS) {
    if (have.has(h.id)) continue;
    const dueAt = enteredAt + h.ms;
    const lateMs = now - dueAt;
    out.push({ horizon: h.id, dueAt, lateMs, action: lateMs < 0 ? "wait" : lateMs > h.graceMs ? "missed" : "take" });
  }
  return out;
}

const MAX_MINTS_PER_RUN = 120; // 4 batched DEX Screener requests; leftovers are picked up on the next 2-min run

/** Take every follow-up snapshot that is due. Service-role client; covers all users. */
export async function runFollowUps(db: Db, now = Date.now()) {
  const { data: cohorts, error } = await db
    .from("cohorts")
    .select("id,user_id,mint,entered_at,entry_observation_id")
    .lte("entered_at", new Date(now - HORIZONS[0].ms).toISOString())
    .gte("entered_at", new Date(now - 15 * 24 * 3_600_000).toISOString())
    .order("entered_at", { ascending: true })
    .limit(2000);
  if (error) throw new Error(`Reading cohorts failed: ${error.message}`);
  const list: Any[] = cohorts ?? [];
  const have = new Map<string, Set<string>>();
  for (let i = 0; i < list.length; i += 200) {
    const ids = list.slice(i, i + 200).map((c) => c.id);
    const { data } = await db.from("snapshots").select("cohort_id,horizon").in("cohort_id", ids);
    for (const s of data ?? []) {
      if (!have.has(s.cohort_id)) have.set(s.cohort_id, new Set());
      have.get(s.cohort_id)!.add(s.horizon);
    }
  }

  const missed: Any[] = [];
  const wanted: { c: Any; p: PlanItem }[] = [];
  for (const c of list) {
    for (const p of snapshotPlan(new Date(c.entered_at).getTime(), have.get(c.id) ?? new Set(), now)) {
      if (p.action === "missed") {
        const grace = HORIZONS.find((h) => h.id === p.horizon)!.graceMs / 60_000;
        missed.push({
          cohort_id: c.id, user_id: c.user_id, horizon: p.horizon, due_at: new Date(p.dueAt).toISOString(), status: "missed", taken_at: new Date(now).toISOString(),
          pair_status: null, pair_address: null, price_usd: null, liquidity_usd: null, fdv: null, volume_24h: null,
          reason: `No successful snapshot within ${grace} min of the due time (data source unavailable or the job did not run). Not backfilled.`,
        });
      } else if (p.action === "take") wanted.push({ c, p });
    }
  }

  wanted.sort((a, b) => a.p.dueAt - b.p.dueAt); // closest to expiring first
  const mints = new Set<string>();
  const batch: typeof wanted = [];
  for (const w of wanted) {
    if (!mints.has(w.c.mint) && mints.size >= MAX_MINTS_PER_RUN) continue;
    mints.add(w.c.mint);
    batch.push(w);
  }
  // Follow the same pool that was recorded at entry. Comparing against whichever pair DEX Screener ranks first
  // today would show a false "liquidity collapse" whenever the best pool changes.
  const entryIds = [...new Set(batch.map((w) => w.c.entry_observation_id).filter((x) => x != null))];
  const pairOfObs = new Map<number, string | null>();
  for (let i = 0; i < entryIds.length; i += 200) {
    const { data } = await db.from("observations").select("id,pair_address").in("id", entryIds.slice(i, i + 200));
    for (const o of data ?? []) pairOfObs.set(o.id, o.pair_address);
  }
  const entryPair = (c: Any): string | null => pairOfObs.get(c.entry_observation_id) ?? null;
  const pairAddrs = [...new Set(batch.map((w) => entryPair(w.c)).filter((x): x is string => !!x))];
  const { pairs, failed: failedPairs } = pairAddrs.length ? await fetchPairsByAddress(pairAddrs) : { pairs: new Map<string, Any>(), failed: new Set<string>() };
  // Cohorts with no recorded pool fall back to a lookup by token.
  const fallbackMints = [...new Set(batch.filter((w) => !entryPair(w.c)).map((w) => w.c.mint))];
  const fb = fallbackMints.length ? await fetchMetrics(fallbackMints) : { metrics: new Map(), errors: [] as string[], failed: new Set<string>() };
  const errors = fb.errors;

  const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const taken: Any[] = [];
  let retrying = 0;
  for (const { c, p } of batch) {
    const base = { cohort_id: c.id, user_id: c.user_id, horizon: p.horizon, due_at: new Date(p.dueAt).toISOString(), status: "ok", taken_at: new Date(now).toISOString(), reason: null };
    const empty = { price_usd: null, liquidity_usd: null, fdv: null, volume_24h: null };
    const addr = entryPair(c);
    if (addr) {
      if (failedPairs.has(addr)) { retrying++; continue; } // request failed: retry next run until the window closes
      const pr = pairs.get(addr);
      taken.push(
        pr
          ? { ...base, pair_status: "active", pair_address: addr, price_usd: num(pr.priceUsd), liquidity_usd: num(pr.liquidity?.usd), fdv: num(pr.fdv), volume_24h: num(pr.volume?.h24) }
          // The request worked and DEX Screener did not return this pool.
          : { ...base, pair_status: "not_returned", pair_address: addr, ...empty },
      );
      continue;
    }
    if (fb.failed.has(c.mint)) { retrying++; continue; }
    const m = fb.metrics.get(c.mint);
    taken.push(
      m?.dataOk
        ? { ...base, pair_status: "active", pair_address: m.pairAddress, price_usd: m.priceUsd, liquidity_usd: m.liquidityUsd, fdv: m.fdv, volume_24h: m.volume24h }
        : { ...base, pair_status: "not_returned", pair_address: null, ...empty },
    );
  }
  const rows = [...missed, ...taken];
  for (let i = 0; i < rows.length; i += 200) {
    const { error: ie } = await db.from("snapshots").upsert(rows.slice(i, i + 200), { onConflict: "cohort_id,horizon", ignoreDuplicates: true });
    if (ie) throw new Error(`Saving snapshots failed: ${ie.message}`);
  }

  const perUser = new Map<string, { ok: number; missed: number }>();
  for (const r of rows) {
    const u = perUser.get(r.user_id) ?? { ok: 0, missed: 0 };
    if (r.status === "ok") u.ok++; else u.missed++;
    perUser.set(r.user_id, u);
  }
  for (const [userId, u] of perUser) {
    await logCoverage(db, userId, {
      kind: "followup",
      tokensReturned: u.ok + u.missed,
      tokensWithData: u.ok,
      errors: [...errors.slice(0, 3), ...(u.missed ? [`${u.missed} follow-up(s) marked missed`] : [])],
    });
  }
  return { due: wanted.length, taken: taken.length, missed: missed.length, retrying, deferred: wanted.length - batch.length, errors };
}

// ---------- rug labelling ----------

export type RugLabel =
  | { kind: "verified"; note: string }
  | { kind: "likely"; why: string }
  | { kind: "none" }
  | { kind: "insufficient" };

export interface SnapshotLite { horizon: string; status: string; pair_status: string | null; liquidity_usd: number | null }
export interface NoteLite { kind: string; note: string; created_at?: string }

/** "Verified" only comes from the user's own note with a source. Everything else is a labelled estimate. */
export function rugLabel(entryLiquidity: number | null, snaps: SnapshotLite[], notes: NoteLite[], dropPct: number): RugLabel {
  const verdicts = notes.filter((n) => n.kind === "verified_rug" || n.kind === "unverify_rug");
  const last = verdicts.length ? verdicts.reduce((a, b) => ((b.created_at ?? "") >= (a.created_at ?? "") ? b : a)) : null;
  if (last?.kind === "verified_rug") return { kind: "verified", note: last.note };
  const ok = snaps.filter((s) => s.status === "ok");
  for (const s of ok) {
    if (s.pair_status === "not_returned") return { kind: "likely", why: `No pair returned by DEX Screener at +${s.horizon}` };
    if (entryLiquidity && entryLiquidity > 0 && s.liquidity_usd !== null) {
      const drop = ((entryLiquidity - Number(s.liquidity_usd)) / entryLiquidity) * 100;
      if (drop >= dropPct) return { kind: "likely", why: `Liquidity down ${drop.toFixed(0)}% from entry at +${s.horizon}` };
    }
  }
  return ok.length ? { kind: "none" } : { kind: "insufficient" };
}

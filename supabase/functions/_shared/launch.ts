// Expensive checks: who created the token and how it was bought in its first slots.
// Everything that parses RPC data is a pure function so it can be tested against recorded fixtures.
import { base58Decode, base58Encode, findProgramAddress } from "./solana-keys.ts";
import { PUMP_BONDING_CURVE_SEED, PUMP_CURVE_CREATOR_OFFSET, PUMP_CURVE_DISCRIMINATOR, PUMP_PROGRAM } from "./solana-config.ts";
import { BudgetError, type Rpc } from "./rpc.ts";
import type { ClusteringData, CreatorData } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export interface SigInfo { signature: string; slot: number; err: unknown; blockTime?: number | null }

// ---------- pure parsers ----------

/** Creator pubkey stored in a pump.fun bonding-curve account (layout from the official IDL), or null. */
export function parseBondingCurveCreator(base64Data: string): string | null {
  let bytes: Uint8Array;
  try {
    const bin = atob(base64Data);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return null; }
  if (bytes.length < PUMP_CURVE_CREATOR_OFFSET + 32) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PUMP_CURVE_DISCRIMINATOR[i]) return null;
  return base58Encode(bytes.slice(PUMP_CURVE_CREATOR_OFFSET, PUMP_CURVE_CREATOR_OFFSET + 32));
}

const keyOf = (k: Any): string => (typeof k === "string" ? k : k?.pubkey);

/** The fee payer of a transaction that initialises `mint` (top-level or inner instruction), or null. */
export function creatorFromCreationTx(tx: Any, mint: string): string | null {
  const msg = tx?.transaction?.message;
  if (!msg) return null;
  const all: Any[] = [...(msg.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((i: Any) => i.instructions ?? [])];
  const inits = all.some((ix) => (ix?.parsed?.type === "initializeMint" || ix?.parsed?.type === "initializeMint2") && ix.parsed.info?.mint === mint);
  if (!inits) return null;
  return keyOf(msg.accountKeys?.[0]) ?? null;
}

export interface EarlyTx { slot: number; pre: Any[]; post: Any[] }

/** Net token received per owner in these transactions, positive deltas only. Works for any DEX or launchpad. */
export function buyerDeltas(txs: EarlyTx[], mint: string, exclude: Set<string>): Map<string, number> {
  const net = new Map<string, number>();
  for (const t of txs) {
    const add = (list: Any[], sign: 1 | -1) => {
      for (const b of list ?? []) {
        if (b?.mint !== mint || !b?.owner) continue;
        const n = Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0);
        net.set(b.owner, (net.get(b.owner) ?? 0) + sign * n);
      }
    };
    add(t.post, 1);
    add(t.pre, -1);
  }
  const out = new Map<string, number>();
  for (const [o, v] of net) if (v > 0 && !exclude.has(o)) out.set(o, v);
  return out;
}

export interface ClusterMetrics { pctFirst3Slots: number; buyersFirst3Slots: number; topBuyers: string[]; txsExamined: number; slotsExamined: number }

/** Supply share bought in the first 3 slots from `refSlot`, plus how many distinct wallets bought it. */
export function clusterMetrics(txs: EarlyTx[], mint: string, refSlot: number, supply: number, exclude: Set<string>): ClusterMetrics {
  const window = txs.filter((t) => t.slot >= refSlot && t.slot <= refSlot + 2);
  const d = buyerDeltas(window, mint, exclude);
  const total = [...d.values()].reduce((a, b) => a + b, 0);
  return {
    pctFirst3Slots: supply > 0 ? Math.min(100, (total / supply) * 100) : 0,
    buyersFirst3Slots: d.size,
    topBuyers: [...d].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([o]) => o),
    txsExamined: txs.length,
    slotsExamined: txs.length ? Math.max(...txs.map((t) => t.slot)) - Math.min(...txs.map((t) => t.slot)) + 1 : 0,
  };
}

/** Sender of the earliest incoming SOL transfer to `wallet`, from its oldest transaction. */
export function fundingSource(tx: Any, wallet: string): string | null {
  const msg = tx?.transaction?.message;
  const all: Any[] = [...(msg?.instructions ?? []), ...(tx?.meta?.innerInstructions ?? []).flatMap((i: Any) => i.instructions ?? [])];
  for (const ix of all) {
    if (ix?.program === "system" && ix.parsed?.type === "transfer" && ix.parsed.info?.destination === wallet) return ix.parsed.info.source ?? null;
  }
  return null;
}

/** Largest number of early buyers that share one funding source (only counting groups of 2+). */
export function largestSharedFunding(sources: (string | null)[]): number | null {
  const known = sources.filter((s): s is string => !!s);
  if (!known.length) return null;
  const counts = new Map<string, number>();
  for (const s of known) counts.set(s, (counts.get(s) ?? 0) + 1);
  return Math.max(...counts.values());
}

// ---------- RPC-backed helpers ----------

/** Page getSignaturesForAddress back toward the oldest signature. `reached` means the last page was short. */
export async function pageToOldest(call: Rpc, address: string, maxPages: number, keep = 200): Promise<{ tail: SigInfo[]; reached: boolean; pages: number }> {
  let before: string | undefined;
  let tail: SigInfo[] = [];
  let pages = 0;
  for (; pages < maxPages; ) {
    const page: SigInfo[] = await call("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }]);
    pages++;
    if (!page.length) return { tail, reached: true, pages };
    tail = [...page, ...tail].slice(-keep); // newest-first pages; keep only the oldest `keep`
    tail = [...tail].sort((a, b) => b.slot - a.slot);
    before = page[page.length - 1].signature;
    if (page.length < 1000) return { tail: tail.slice(-keep), reached: true, pages };
  }
  return { tail, reached: false, pages };
}

const getTx = (call: Rpc, signature: string) =>
  call("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);

export interface LaunchInput {
  call: Rpc;
  mint: string;
  supply: number | null;
  mainPoolAddress: string | null;
  /** Addresses whose balance changes are not buyers: pools, vaults, curves. */
  excludeOwners: Set<string>;
  pageBudget: number;
  cachedCreator?: CreatorData | null;
  cachedClustering?: ClusteringData | null;
}

const NOT_FOUND = "creation tx not found within scan budget";

/** Creator wallet and its current holding. Cached creator address is reused; the balance is re-read every time. */
export async function lookupCreator(i: LaunchInput): Promise<{ creator: CreatorData; curve: string | null; creationSlot: number | null }> {
  let curve: string | null = null;
  let creationSlot: number | null = null;
  let address = i.cachedCreator?.address ?? null;
  let method = i.cachedCreator?.method ?? null;
  const fromCache = !!address;
  const unknown = (reason: string): CreatorData => ({ status: "unknown", address: null, method: null, reason, holdingPct: null, fromCache: false });
  try {
    curve = (await findProgramAddress([PUMP_BONDING_CURVE_SEED, base58Decode(i.mint)], PUMP_PROGRAM)).address;
    if (!address) {
      const acc = await i.call("getAccountInfo", [curve, { encoding: "base64" }]);
      const v = acc?.value;
      if (v?.owner === PUMP_PROGRAM && Array.isArray(v.data)) {
        const c = parseBondingCurveCreator(v.data[0]);
        if (c) {
          address = c;
          method = "pump.fun bonding-curve account `creator` field (fee-recipient creator; can differ from the original signer if reassigned)";
        }
      }
    }
    if (!address) {
      const { tail, reached } = await pageToOldest(i.call, i.mint, i.pageBudget);
      if (!reached || !tail.length) return { creator: unknown(NOT_FOUND), curve: null, creationSlot: null };
      const oldest = tail[tail.length - 1];
      const tx = await getTx(i.call, oldest.signature);
      const c = creatorFromCreationTx(tx, i.mint);
      if (!c) return { creator: unknown("oldest transaction does not initialise the mint"), curve: null, creationSlot: null };
      address = c;
      method = "fee payer of the mint-initialisation transaction";
      creationSlot = oldest.slot;
    }
    let holdingPct: number | null = null;
    if (i.supply && i.supply > 0) {
      const r = await i.call("getTokenAccountsByOwner", [address, { mint: i.mint }, { encoding: "jsonParsed" }]);
      const held = ((r?.value ?? []) as Any[]).reduce((a, x) => a + Number(x.account?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? 0), 0);
      holdingPct = Math.min(100, (held / i.supply) * 100);
    }
    return {
      creator: holdingPct === null ? unknown("supply unavailable") : { status: "found", address, method, reason: null, holdingPct, fromCache },
      curve,
      creationSlot,
    };
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    return { creator: unknown(`RPC: ${e instanceof Error ? e.message : String(e)}`), curve, creationSlot };
  }
}

/** Early-buyer clustering. Pump.fun tokens use their bonding curve (reference = creation); others use the main pool. */
export async function lookupClustering(i: LaunchInput, curve: string | null, curveIsPump: boolean): Promise<ClusteringData> {
  const fail = (reason: string): ClusteringData => ({ status: "unknown", reason, creationSlot: null, txsExamined: 0, slotsExamined: 0, pctFirst3Slots: null, buyersFirst3Slots: null, maxSharedFunding: null, source: null, fromCache: false });
  if (!i.supply) return fail("supply unavailable");
  const source = curveIsPump && curve ? curve : i.mainPoolAddress;
  if (!source) return fail("no pool address to read early transactions from");
  try {
    const { tail, reached } = await pageToOldest(i.call, source, i.pageBudget);
    if (!reached || !tail.length) return fail("earliest transactions not reached within scan budget");
    const asc = [...tail].filter((t) => t.err == null).sort((a, b) => a.slot - b.slot).slice(0, 100);
    if (!asc.length) return fail("no successful early transactions");
    const ref = asc[0].slot;
    const within = asc.filter((t) => t.slot <= ref + 20);
    const txs: EarlyTx[] = [];
    for (const s of within) {
      const tx = await getTx(i.call, s.signature);
      if (tx?.meta) txs.push({ slot: s.slot, pre: tx.meta.preTokenBalances ?? [], post: tx.meta.postTokenBalances ?? [] });
    }
    if (!txs.length) return fail("early transactions could not be read");
    const exclude = new Set([...i.excludeOwners, ...(curve ? [curve] : []), ...(i.mainPoolAddress ? [i.mainPoolAddress] : [])]);
    const m = clusterMetrics(txs, i.mint, ref, i.supply, exclude);

    // Optional: do the biggest early buyers share a funding source?
    const sources: (string | null)[] = [];
    for (const w of m.topBuyers) {
      try {
        const p = await pageToOldest(i.call, w, 1, 5);
        if (!p.reached || !p.tail.length) { sources.push(null); continue; }
        sources.push(fundingSource(await getTx(i.call, p.tail[p.tail.length - 1].signature), w));
      } catch (e) {
        if (e instanceof BudgetError) break;
        sources.push(null);
      }
    }
    return {
      status: "ok", reason: null, creationSlot: ref, txsExamined: m.txsExamined, slotsExamined: m.slotsExamined,
      pctFirst3Slots: m.pctFirst3Slots, buyersFirst3Slots: m.buyersFirst3Slots, maxSharedFunding: largestSharedFunding(sources),
      source: curveIsPump && curve ? "pump.fun bonding curve; reference slot = creation" : "main pool; reference slot = the pool's first transaction", fromCache: false,
    };
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    return fail(`RPC: ${e instanceof Error ? e.message : String(e)}`);
  }
}

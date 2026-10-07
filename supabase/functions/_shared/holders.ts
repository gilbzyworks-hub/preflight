import { base58Decode, findProgramAddress, isOnCurve } from "./solana-keys.ts";
import { BURN_ADDRESSES, DEX_AUTHORITY_SEEDS, DEX_PROGRAMS, LOCK_PROGRAMS, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./solana-config.ts";
import type { HolderData, HolderEntry } from "./types.ts";
import type { Rpc } from "./rpc.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const EXCLUDED = new Set(["liquidity_pool", "burn", "program_owned_known"]);

let authorities: Promise<Map<string, string>> | null = null;
/** Vault-authority PDAs of the pool programs in the config, derived once per process. */
export function dexAuthorities(): Promise<Map<string, string>> {
  authorities ??= (async () => {
    const m = new Map<string, string>();
    for (const a of DEX_AUTHORITY_SEEDS) m.set((await findProgramAddress([a.seed], a.program)).address, a.label);
    return m;
  })();
  return authorities;
}

export interface HolderInput {
  /** Total supply as a UI amount. */
  supply: number;
  /** Up to 20 largest token accounts, largest first. */
  largest: { address: string; amount: number }[];
  /** Owner of each token account (parallel to `largest`); null when it could not be read. */
  owners: (string | null)[];
  /** For each distinct owner: the program that owns the owner's account, or null if that account does not exist. */
  ownerPrograms: Map<string, string | null>;
  /** Pool/pair addresses DEX Screener lists for this token. */
  poolAddresses: Set<string>;
  authorities: Map<string, string>;
}

export function classifyHolders(i: HolderInput): HolderData {
  const entries: HolderEntry[] = i.largest.map((l, idx) => {
    const owner = i.owners[idx];
    const pct = i.supply > 0 ? (l.amount / i.supply) * 100 : 0;
    const base = { tokenAccount: l.address, owner, amount: l.amount, pct, ownerProgram: null as string | null };
    const done = (kind: HolderEntry["kind"], label: string, basis: string, ownerProgram: string | null = null): HolderEntry =>
      ({ ...base, ownerProgram, kind, label, basis });
    if (!owner) return done("unresolved", "Owner could not be read", "Not excluded");
    if (BURN_ADDRESSES[owner]) return done("burn", `Burn address: ${BURN_ADDRESSES[owner]}`, "Documented burn/incinerator address (by convention)");
    if (i.poolAddresses.has(l.address) || i.poolAddresses.has(owner))
      return done("liquidity_pool", "Liquidity pool", "Matches a pool address listed by DEX Screener");
    const auth = i.authorities.get(owner);
    if (auth) return done("liquidity_pool", `Liquidity pool (${auth})`, `Owner is the ${auth} vault authority`);
    const prog = i.ownerPrograms.get(owner) ?? null;
    if (prog && prog !== SYSTEM_PROGRAM) {
      if (DEX_PROGRAMS[prog]) return done("liquidity_pool", `Liquidity pool (${DEX_PROGRAMS[prog]})`, `Owner account is controlled by ${DEX_PROGRAMS[prog]}`, prog);
      if (LOCK_PROGRAMS[prog]) return done("program_owned_known", `Locked/vesting (${LOCK_PROGRAMS[prog]})`, `Owner account is controlled by ${LOCK_PROGRAMS[prog]}`, prog);
      if (prog === TOKEN_PROGRAM || prog === TOKEN_2022_PROGRAM)
        return done("program_owned_unclassified", "Unclassified program account", `Owner is itself a token account${owner === l.address ? " (this account owns itself)" : ""}, which is unusual for a normal holder`, prog);
      return done("program_owned_unclassified", "Unclassified program account", `Owner account is controlled by program ${prog}`, prog);
    }
    let onCurve = true;
    try { onCurve = isOnCurve(base58Decode(owner)); } catch { /* treat as wallet-like but unverified */ }
    return onCurve
      ? done("wallet", "Wallet", "Owner is an ordinary (on-curve) address")
      : done("program_owned_unclassified", "Unclassified program account", "Owner is off-curve (a program-derived address) but no known program controls it");
  });

  const top10 = entries.slice(0, 10);
  const kept = entries.filter((e) => !EXCLUDED.has(e.kind));
  const adjTop = kept.slice(0, 10);
  const sum = (xs: HolderEntry[]) => xs.reduce((a, e) => a + e.pct, 0);
  const counted = new Set([...top10, ...adjTop]);
  return {
    supply: i.supply,
    entries,
    rawTop10Pct: Math.min(100, sum(top10)),
    adjustedTop10Pct: Math.min(100, sum(adjTop)),
    adjustedCount: adjTop.length,
    partial: adjTop.length < 10, // only the 20 largest accounts are available from RPC
    excludedCount: entries.filter((e) => EXCLUDED.has(e.kind)).length,
    unclassifiedInTop10: [...counted].filter((e) => e.kind === "program_owned_unclassified").length,
    unresolvedInTop10: [...counted].filter((e) => e.kind === "unresolved").length,
  };
}

/** Fetches the largest accounts, resolves owners and the programs controlling them, then classifies. */
export async function getHolderData(rpc: Rpc, mint: string, poolAddresses: Set<string>): Promise<HolderData> {
  const [supplyRes, largestRes] = await Promise.all([rpc("getTokenSupply", [mint]), rpc("getTokenLargestAccounts", [mint])]);
  const supply = Number(supplyRes?.value?.uiAmountString ?? supplyRes?.value?.uiAmount);
  const top = (largestRes?.value ?? []) as Any[];
  if (!(supply > 0) || !top.length) throw new Error("Supply or holder list unavailable");
  const largest = top.map((t) => ({ address: String(t.address), amount: Number(t.uiAmountString ?? t.uiAmount ?? 0) }));
  const accs = (await rpc("getMultipleAccounts", [largest.map((l) => l.address), { encoding: "jsonParsed" }]))?.value as Any[];
  const owners: (string | null)[] = largest.map((_, i) => accs?.[i]?.data?.parsed?.info?.owner ?? null);
  const distinct = [...new Set(owners.filter((o): o is string => !!o))];
  const ownerPrograms = new Map<string, string | null>();
  if (distinct.length) {
    const oa = (await rpc("getMultipleAccounts", [distinct, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]))?.value as Any[];
    distinct.forEach((o, i) => ownerPrograms.set(o, oa?.[i]?.owner ?? null));
  }
  return classifyHolders({ supply, largest, owners, ownerPrograms, poolAddresses, authorities: await dexAuthorities() });
}

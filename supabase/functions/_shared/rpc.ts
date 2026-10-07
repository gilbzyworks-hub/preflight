import { RateLimiter, memo } from "./limiter.ts";
import { parseExtensions } from "./extensions.ts";
import { getHolderData } from "./holders.ts";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./solana-config.ts";
import type { ChainData } from "./types.ts";

const limiter = new RateLimiter(240, 60_000);

// deno-lint-ignore no-explicit-any
type Any = any;

/** Counts RPC calls for one scan and refuses further calls once the limit is reached. */
export class RpcBudget {
  used = 0;
  hit = false;
  constructor(public limit: number) {}
  take() {
    if (this.used >= this.limit) {
      this.hit = true;
      throw new BudgetError(`RPC call budget of ${this.limit} reached`);
    }
    this.used++;
  }
  get left() { return this.limit - this.used; }
}
export class BudgetError extends Error {}

export type Rpc = (method: string, params: unknown[]) => Promise<Any>;
/** RPC function bound to a URL and (optionally) a budget. */
export const makeRpc = (url: string, budget?: RpcBudget): Rpc => (method, params) => {
  budget?.take();
  return rpc(url, method, params);
};

// Free provider tiers allow about 10 requests/second, and each server instance paces on its own, so stay well under it. Space requests so a burst of parallel token scans stays under it.
const MIN_GAP_MS = 170;
let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pace() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

async function rpc(url: string, method: string, params: unknown[]): Promise<Any> {
  await limiter.take();
  let last: Error = new Error("RPC failed");
  for (let attempt = 0; attempt < 5; attempt++) {
    await pace();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(9000),
    });
    if (res.status === 429 || res.status >= 500) {
      // Rate limited or provider hiccup: back off and retry. The budget counts the call once, not per retry.
      last = new Error(`HTTP ${res.status}`);
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Math.min(5000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? "RPC error");
    return json.result;
  }
  throw last;
}

/** Cheap on-chain checks, run for every candidate: mint/freeze authority, token program and extensions, holders
 *  (raw and adjusted top-10). Any failed piece stays null so it shows as UNKNOWN, never PASS. */
export function getChainData(rpcUrl: string, mint: string, ctx: { budget: RpcBudget; poolAddresses: Set<string> }): Promise<ChainData> {
  return memo(`chain:${mint}`, 60_000, async () => {
    const out = emptyChain();
    const call = makeRpc(rpcUrl, ctx.budget);
    const [info, holders] = await Promise.allSettled([
      call("getAccountInfo", [mint, { encoding: "jsonParsed" }]),
      getHolderData(call, mint, ctx.poolAddresses),
    ]);
    if (info.status === "fulfilled") {
      const v = info.value?.value;
      const parsed = v?.data?.parsed;
      if (parsed?.type === "mint") {
        out.mintAuthorityRevoked = parsed.info?.mintAuthority == null;
        out.freezeAuthorityRevoked = parsed.info?.freezeAuthority == null;
        out.tokenProgram = v.owner === TOKEN_PROGRAM ? "spl-token" : v.owner === TOKEN_2022_PROGRAM ? "token-2022" : "other";
        if (out.tokenProgram === "token-2022") {
          out.extensions = parseExtensions(parsed.info);
          if (out.extensions === null) out.errors.push("RPC extensions: unexpected shape");
        } else if (out.tokenProgram === "spl-token") out.extensions = [];
      } else out.errors.push("RPC: account is not a token mint");
    } else out.errors.push(`RPC authorities: ${info.reason?.message ?? info.reason}`);
    if (holders.status === "fulfilled") {
      out.holders = holders.value;
      out.top10Share = holders.value.partial ? null : holders.value.adjustedTop10Pct;
    } else out.errors.push(`RPC holders: ${holders.reason?.message ?? holders.reason}`);
    out.rpcCalls = ctx.budget.used;
    out.budgetHit = ctx.budget.hit;
    return out;
  });
}

export const emptyChain = (error?: string): ChainData => ({
  mintAuthorityRevoked: null,
  freezeAuthorityRevoked: null,
  top10Share: null,
  errors: error ? [error] : [],
  tokenProgram: null,
  extensions: null,
  holders: null,
  creator: null,
  clustering: null,
  rpcCalls: 0,
  budgetHit: false,
  skipped: null,
});

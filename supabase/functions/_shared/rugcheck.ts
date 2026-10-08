import { isValidAddress } from "./solana-keys.ts";

// RugCheck's public summary endpoint (optional third-party opinion, never part of Preflight's checks).
// Observed 2026-10-07: success = 200 with a `risks` array (possibly empty); a token RugCheck cannot report on =
// HTTP 400 {"error":"unable to generate report"}.
export const RUGCHECK_API = "https://api.rugcheck.xyz";

export interface RugCheckItem { name: string; level: string; description: string | null; value: string | null }

/** Exactly one of three outcomes. "none" is only ever produced by a successful call with an empty risk list. */
export type RugCheckResult =
  | { status: "items"; fetchedAt: string; risks: RugCheckItem[] }
  | { status: "none"; fetchedAt: string }
  | { status: "unavailable"; fetchedAt: string; reason: string };

// deno-lint-ignore no-explicit-any
type Any = any;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export async function fetchRugCheck(
  mint: string,
  opts: { base?: string; timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<RugCheckResult> {
  const fetchedAt = (opts.now ?? (() => new Date()))().toISOString();
  const down = (reason: string): RugCheckResult => ({ status: "unavailable", fetchedAt, reason });
  if (!isValidAddress(mint)) return down("not a valid token address");
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${(opts.base ?? RUGCHECK_API).replace(/\/$/, "")}/v1/tokens/${mint}/report/summary`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
      headers: { accept: "application/json" },
    });
  } catch (e) {
    const name = (e as Error)?.name;
    return down(name === "TimeoutError" || name === "AbortError" ? "request timed out" : "network error");
  }
  if (res.status === 429) return down("rate limited by RugCheck");
  if (res.status >= 500) return down(`RugCheck service error, HTTP ${res.status}`);
  if (res.status === 404) return down("RugCheck has no report for this token (not indexed)");
  if (res.status === 400) {
    const body = (await res.text().catch(() => "")).toLowerCase();
    return down(body.includes("unable to generate report") ? "RugCheck has no report for this token (not indexed)" : "request rejected, HTTP 400");
  }
  if (!res.ok) return down(`unexpected response, HTTP ${res.status}`);

  let j: Any;
  try {
    j = await res.json();
  } catch {
    return down("response could not be read");
  }
  // A missing or malformed list is never treated as "no items".
  if (!j || typeof j !== "object" || !Array.isArray(j.risks)) return down("response had no risk list");
  if (j.risks.length === 0) return { status: "none", fetchedAt };
  return {
    status: "items",
    fetchedAt,
    risks: j.risks.slice(0, 40).map((x: Any) => ({
      name: str(x?.name) ?? "Unnamed item",
      level: str(x?.level) ?? "unspecified",
      description: str(x?.description),
      value: str(x?.value),
    })),
  };
}

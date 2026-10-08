import { isValidAddress } from "@shared/solana-keys.ts";

// URL templates for third-party checkers. Every link is built ONLY from a validated base58 mint address,
// never from a token's name, symbol or project links. Preflight never fetches, scrapes or embeds these pages.
//
// Verified 2026-10-07 by opening each template in a real browser for three different tokens:
//  - RugCheck:   https://rugcheck.xyz/tokens/<mint>          page title "<token> Risk Report | <mint>" (all 3 tokens).
//  - Bubblemaps: https://app.bubblemaps.io/sol/token/<mint>  redirects to
//                https://v2.bubblemaps.io/map?address=<mint>&chain=solana and shows that token's holder map
//                (docs: https://docs.bubblemaps.io/iframe/quickstart uses chain=solana&address=<mint>).
//  - Solscan:    https://solscan.io/token/<mint>             NOT machine-verifiable: Solscan answers automated
//                browsers with a Cloudflare challenge for every path. RugCheck's own pages link Solscan as
//                /account/<address>. Spot-check this one by hand.
export const CHECKERS = [
  { id: "rugcheck", label: "RugCheck", note: "Full risk report", url: (mint: string) => `https://rugcheck.xyz/tokens/${mint}` },
  { id: "solscan", label: "Solscan", note: "Token page, for checking Preflight's on-chain values", url: (mint: string) => `https://solscan.io/token/${mint}` },
  { id: "bubblemaps", label: "Bubblemaps", note: "Holder-connection map", url: (mint: string) => `https://app.bubblemaps.io/sol/token/${mint}` },
] as const;

export const EXTERNAL_CAPTION =
  "Each site runs its own analysis. Their results can be wrong or incomplete, and are not part of Preflight's checks.";

export interface ExternalLink { id: string; label: string; note: string; href: string }

/** Links for a mint, or null when the value is not a valid 32-byte base58 address. */
export function externalLinks(mint: string): ExternalLink[] | null {
  if (typeof mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || !isValidAddress(mint)) return null;
  return CHECKERS.map((c) => ({ id: c.id, label: c.label, note: c.note, href: c.url(mint) }));
}

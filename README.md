# Preflight

A personal pre-trade checklist for Solana meme coins. It screens tokens against your own rules using
public data, explains each check, tracks a watchlist, and journals paper trades and trades you placed
manually in Fomo. **Decision-support only, not financial advice.** It never connects to Fomo or a wallet and
never places a trade.

Stack: Next.js (App Router) · Tailwind · Supabase (Postgres, auth, pg_cron + edge function) · Vercel.

## Setup
1. Create a Supabase project. In **Auth → URL configuration** add your site URL and
   `https://<your-domain>/auth/callback` (and `http://localhost:3000/auth/callback` for dev) to the redirect allow-list.
2. Apply the schema: `supabase link --project-ref <ref> && supabase db push` (migrations 0001–0003).
3. Copy `.env.example` to `.env.local` and fill it in. `SOLANA_RPC_URL` should be a provider URL (Helius, QuickNode…):
   the public endpoint rate-limits holder lookups, so the holder checks show UNKNOWN on it.
4. `npm i && npm run dev`.

### Who can sign in
Email + password works with no email service (no rate limit). Magic links also work but Supabase's built-in sender is capped
at a few per hour. To make it single-user: set `ALLOWED_EMAIL` (only that address gets in) and turn off **Auth → Sign In /
Providers → Allow new users to sign up**. Leaving `ALLOWED_EMAIL` unset lets any registered account in; each account only
sees its own data (row-level security), but all accounts share your data-provider quota, and the background job scans
every account's watchlist.

## Background scan (works while the site is closed)
```bash
supabase secrets set CRON_SECRET=<long random string> SOLANA_RPC_URL=<provider url>
supabase functions deploy scan
```
Then run `supabase/cron.sql` once (fill in the project URL and the same secret; keep the filled copy out of git).
It schedules the function every 2 minutes. Runs are logged in `scan_runs` and shown in the header, including a note when
the request budget was reached.

## What the checks do
Each check is Required, Warning or Off (editable in Settings, which creates a new preset version). **Missing data is
UNKNOWN, never PASS. A check that was deliberately skipped is NOT RUN**, which is also never PASS and is not counted as one.

- Market data comes from the **main pool**: the pool with the highest liquidity. All pools are stored, and a
  *liquidity split* check warns when the main pool holds under 70% of total liquidity.
- **Top-10 holders**: token accounts are resolved to owners and classified (liquidity pool, burn, known lock program,
  unclassified program account, wallet). The check uses the **adjusted** share (pools, burn addresses and known lock
  programs excluded); raw and adjusted are both shown, with every account linked to a block explorer.
- **Token-2022 extensions**: one row per relevant extension (transfer fee, permanent delegate, hook, pausable, …).
- **Creator wallet holding** and **early-buyer clustering (estimate)**: warn-only heuristics. They are the expensive
  checks, run only for tokens that pass the cheap required checks, watchlist tokens and checklists you open. Results that
  can never change are cached per token.
- Program IDs and known-address lists live in one file with source comments: `supabase/functions/_shared/solana-config.ts`.

### Request budget
Data-provider free tiers are small. Each scan has a budget for basic checks and a larger one for creator/clustering
(Settings → Data provider budget). When it runs out, the remaining checks show NOT RUN and are retried on later scans.
Requests are spaced to stay under ~6/second and retried on rate limits. A watched token costs roughly 5 requests per
2-minute run.

## External checkers and RugCheck
Each token has "Open in external checkers" links (RugCheck, Solscan, Bubblemaps), also shown on watchlist and journal
entries. URL templates live in `src/lib/external-links.ts` with the date they were verified; links are built only from a
validated mint address, open in a new tab, and Preflight never fetches or embeds those pages. The optional RugCheck summary
shows one of three explicit outcomes, never "safe": items with RugCheck's own levels, "no risk items" (neutral, never a pass),
or "data unavailable (reason) as of [time]". Which outcome occurred is stored on the observation. `RUGCHECK_API_BASE`
(server-only, optional) overrides the API host, used to force failures in testing.

## Outcome tracking
Every token the scanner shows is recorded with its check results and the exact rules in force, then re-checked about
1 hour, 24 hours and 7 days later (the same pool that was recorded). Rows are append-only. See the **Outcomes** page.
Rug labels are always "estimate" unless you confirm one with a source note.

## Deploy
Push to Vercel with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SOLANA_RPC_URL` (and optionally
`ALLOWED_EMAIL`).

## Layout
- `supabase/functions/_shared/` – check engine, DEX Screener / RPC clients, holder classification, extension parsing,
  creator/clustering lookups, rate limiter, scan logic. Used by both the Next.js server routes and the edge function,
  so the two paths behave identically.
- `src/app/api/` – server routes (all provider calls go through here; the RPC key stays server-side).
- `supabase/migrations/` – schema.
- `tests/` – Vitest unit tests; `tests/fixtures/` holds responses recorded from chain and DEX Screener.
- `scripts/` – `smoke.mts` (live data-layer check), `bgscan.mts` (run the background job against any Supabase),
  `record-fixtures.mts` (re-record test fixtures), `outcomes-check.mts` (end-to-end check against a **local** Supabase),
  `verify-report.mts` (prints a Solscan-checkable report for 5 live tokens), `spike-solana.mts` (read-only RPC probe).

## Tests
`npm test` (Vitest). Before shipping: `npx tsc --noEmit && npx eslint src supabase tests && npm run build`.

## Notes
- Rate limiting is in-process per server instance plus a short memo cache; fine for one user.
- DEX Screener's batched token lookup returns one pair per token and at most 30 pairs per request, so full pool lists
  are fetched per token for tokens that are shown, watched or opened.

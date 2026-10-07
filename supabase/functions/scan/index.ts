// Supabase Edge Function: invoked every ~2 min by pg_cron (see supabase/cron.sql).
// Scans watchlist tokens and open paper positions for every user, writes check values, alerts and
// paper stop/target closes, and logs each run in scan_runs.
import { createClient } from "npm:@supabase/supabase-js@2";
import { runBackgroundScan } from "../_shared/scan.ts";

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const bearer = req.headers.get("Authorization");
  const ok =
    (secret && req.headers.get("x-cron-secret") === secret) || bearer === `Bearer ${serviceKey}`;
  if (!ok) return new Response("Forbidden", { status: 403 });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false } });
  const rpcUrl = Deno.env.get("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com";
  const result = await runBackgroundScan(db, rpcUrl);
  return Response.json(result, { status: result.ok ? 200 : 500 });
});

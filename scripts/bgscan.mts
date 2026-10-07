import { createClient } from "@supabase/supabase-js";
import { runBackgroundScan } from "../supabase/functions/_shared/scan.ts";
const db = createClient(process.env.URL!, process.env.KEY!, { auth: { persistSession: false } });
console.log(JSON.stringify(await runBackgroundScan(db, process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com")));

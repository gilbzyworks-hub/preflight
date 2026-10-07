import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadSettings, activePreset } from "@/lib/settings";

export const rpcUrl = () => process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

/** Auth + settings for a route handler. Returns a 401 response if not signed in. */
export async function session() {
  const db = await createClient();
  const { data } = await db.auth.getUser();
  if (!data.user) return { error: NextResponse.json({ error: "Not signed in" }, { status: 401 }) } as const;
  const settings = await loadSettings(db, data.user.id);
  return { db, user: data.user, settings, preset: activePreset(settings) } as const;
}

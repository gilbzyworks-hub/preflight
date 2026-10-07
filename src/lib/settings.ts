import type { SupabaseClient } from "@supabase/supabase-js";
import { activePreset, mergeSettings } from "@shared/defaults.ts";
import type { Settings } from "@shared/types.ts";

export async function loadSettings(db: SupabaseClient, userId: string): Promise<Settings> {
  const { data } = await db.from("settings").select("data").eq("user_id", userId).maybeSingle();
  return mergeSettings(data?.data);
}
export { activePreset };

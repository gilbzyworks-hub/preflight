"use client";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

// Untyped tables: row shapes are defined by supabase/migrations and handled at call sites.
type Db = SupabaseClient<any, "public", any>;
let client: Db | null = null;
export function supabase(): Db {
  client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!) as Db;
  return client;
}

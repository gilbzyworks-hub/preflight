import { NextResponse } from "next/server";
import { session } from "@/lib/api";

/** Record the first time a token's checklist was opened (drives cooldown / review guardrails). */
export async function POST(req: Request) {
  const s = await session();
  if ("error" in s) return s.error;
  const { mint } = await req.json();
  if (typeof mint !== "string") return NextResponse.json({ error: "mint required" }, { status: 400 });
  await s.db
    .from("checklist_views")
    .upsert({ user_id: s.user.id, mint }, { onConflict: "user_id,mint", ignoreDuplicates: true });
  const { data } = await s.db.from("checklist_views").select("first_opened_at").eq("mint", mint).maybeSingle();
  return NextResponse.json({ firstOpenedAt: data?.first_opened_at ?? null });
}

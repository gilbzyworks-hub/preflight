import { NextResponse } from "next/server";
import { session, rpcUrl } from "@/lib/api";
import { PAPER_CLOSE_NOTE, paperExit } from "@shared/paper.ts";
import { saveScans, scanTokens } from "@shared/scan.ts";

const pos = (v: unknown) => Number.isFinite(Number(v)) && Number(v) > 0;

/** Log an exit. Paper: closed at the latest scanned price. Real: price/time entered by hand. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await session();
  if ("error" in s) return s.error;
  const { id } = await ctx.params;
  const b = await req.json();
  const { data: t } = await s.db.from("trades").select("*").eq("id", id).eq("status", "open").maybeSingle();
  if (!t) return NextResponse.json({ error: "Open trade not found" }, { status: 404 });
  const note = String(b.note ?? "").trim();
  if (!note) return NextResponse.json({ error: "A reason for the exit is required" }, { status: 400 });

  let patch: Record<string, unknown>;
  if (t.kind === "paper") {
    const { scans } = await scanTokens([t.mint], { rpcUrl: rpcUrl(), preset: s.preset, source: "site" });
    const scan = scans.get(t.mint)!;
    if (!scan.metrics.dataOk || scan.metrics.priceUsd == null)
      return NextResponse.json({ error: "No scanned price available right now. Try Scan now." }, { status: 502 });
    await saveScans(s.db, s.user.id, [scan]);
    const x = paperExit(Number(t.qty), Number(t.amount_usd), scan.metrics.priceUsd, s.settings.paper);
    patch = { exit_price: x.fillPrice, exit_time: scan.scannedAt, exit_reason: "manual", exit_note: `${note} (${PAPER_CLOSE_NOTE})`, fees_usd: Number(t.fees_usd) + x.feeUsd, pnl_usd: x.pnl };
  } else {
    if (!pos(b.exitPrice)) return NextResponse.json({ error: "Exit price is required" }, { status: 400 });
    if (!b.exitTime || Number.isNaN(Date.parse(b.exitTime))) return NextResponse.json({ error: "Exit time is required" }, { status: 400 });
    const fees = Number(b.feesUsd ?? 0) || 0;
    const pnl = Number(t.amount_usd) * (Number(b.exitPrice) / Number(t.entry_price) - 1) - fees;
    patch = { exit_price: Number(b.exitPrice), exit_time: new Date(b.exitTime).toISOString(), exit_reason: "manual", exit_note: note, fees_usd: fees, pnl_usd: pnl };
  }
  const { data, error } = await s.db.from("trades").update({ ...patch, status: "closed" }).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ trade: data });
}

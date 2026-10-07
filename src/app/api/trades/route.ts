import { NextResponse } from "next/server";
import { session, rpcUrl } from "@/lib/api";
import { evaluateGuardrails, OVERRIDE_PREFIX, OVERRIDE_TAG } from "@/lib/guardrails";
import { paperEntry } from "@shared/paper.ts";
import { saveScans, scanTokens } from "@shared/scan.ts";

const bad = (error: string, extra: object = {}) => NextResponse.json({ error, ...extra }, { status: 400 });
const pos = (v: unknown) => (typeof v === "number" || typeof v === "string") && Number.isFinite(Number(v)) && Number(v) > 0;

/** Log a paper trade (guardrails enforced) or a real trade placed manually elsewhere (recorded + tagged, never blocked). */
export async function POST(req: Request) {
  const s = await session();
  if ("error" in s) return s.error;
  const b = await req.json();
  const kind = b.kind === "real" ? "real" : b.kind === "paper" ? "paper" : null;
  if (!kind || typeof b.mint !== "string") return bad("kind and mint are required");
  if (!String(b.reason ?? "").trim()) return bad("A reason is required");
  if (!pos(b.target)) return bad("A target price is required");
  if (!pos(b.stop)) return bad("A stop price is required");
  if (!pos(b.maxLossUsd)) return bad("A max loss is required");
  if (!pos(b.amountUsd)) return bad("An amount is required");
  if (kind === "real") {
    if (!pos(b.entryPrice)) return bad("Entry price is required for a real trade");
    if (!b.entryTime || Number.isNaN(Date.parse(b.entryTime))) return bad("Entry time is required for a real trade");
  }

  // Fresh scan so checks and the paper fill price are current.
  const { scans } = await scanTokens([b.mint], { rpcUrl: rpcUrl(), preset: s.preset, source: "site", settings: s.settings, db: s.db, userId: s.user.id, force: new Set([b.mint]) });
  const scan = scans.get(b.mint)!;
  await saveScans(s.db, s.user.id, [scan]);
  const lines = await evaluateGuardrails(s.db, s.user.id, s.settings, { kind, mint: b.mint, sizeUsd: Number(b.amountUsd), scan });
  const triggered = lines.filter((l) => l.state === "triggered");

  const overrideText = String(b.overrideText ?? "").trim();
  const failedLine = triggered.find((l) => l.id === "requiredFail");
  let tags = triggered.map((l) => l.tag!).filter(Boolean);

  const row: Record<string, unknown> = {
    user_id: s.user.id, kind, mint: b.mint, symbol: scan.metrics.symbol ?? b.symbol ?? null, status: "open",
    reason: String(b.reason).trim(), target: Number(b.target), stop: Number(b.stop), max_loss_usd: Number(b.maxLossUsd),
    amount_usd: Number(b.amountUsd), entry_checks: scan.evaluation,
  };

  if (kind === "paper") {
    const blocks = triggered.filter((l) => l.blocksPaper);
    if (blocks.length) return NextResponse.json({ error: "Paper trading guardrail", blocked: blocks, lines }, { status: 409 });
    if (failedLine && !OVERRIDE_PREFIX.test(overrideText))
      return NextResponse.json({ error: "A required check failed. Type \"I'm overriding: …\" with your reason to continue.", needsOverride: true, lines }, { status: 409 });
    if (scan.metrics.priceUsd == null) return NextResponse.json({ error: "No scanned price available for this token right now." }, { status: 502 });
    const e = paperEntry(Number(b.amountUsd), scan.metrics.priceUsd, s.settings.paper);
    Object.assign(row, { scan_price: scan.metrics.priceUsd, entry_price: e.fillPrice, qty: e.qty, fees_usd: e.feeUsd, entry_time: scan.scannedAt });
  } else {
    Object.assign(row, { entry_price: Number(b.entryPrice), entry_time: new Date(b.entryTime).toISOString(), scan_price: scan.metrics.priceUsd });
  }

  if (tags.length) {
    tags = [...new Set([...tags, OVERRIDE_TAG])];
    if (overrideText) row.override_text = overrideText;
  }
  row.tags = tags;
  row.followed_rules = tags.length === 0;

  const { data, error } = await s.db.from("trades").insert(row).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ trade: data, lines });
}

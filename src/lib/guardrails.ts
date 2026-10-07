import type { SupabaseClient } from "@supabase/supabase-js";
import type { Settings, TokenScan } from "@shared/types.ts";

export type GuardId = "cooldown" | "requiredFail" | "dailyTrades" | "dailyMaxLoss" | "sizeLimit" | "noReview";
export interface GuardLine {
  id: GuardId;
  label: string;
  state: "ok" | "triggered" | "not_set" | "off";
  detail: string;
  tag: string | null; // recorded on the trade when triggered
  blocksPaper: boolean;
}

export const TAG_FOR: Record<GuardId, string> = {
  cooldown: "Cooldown",
  requiredFail: "Required check failed",
  dailyTrades: "Daily trade limit",
  dailyMaxLoss: "Daily max loss",
  sizeLimit: "Size over limit",
  noReview: "No checklist review",
};
export const OVERRIDE_TAG = "Rule override";
export const ALL_TAGS = [...Object.values(TAG_FOR), OVERRIDE_TAG];

function tzOffsetMs(ts: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}

/** Start of the user's current day, as a UTC instant. */
export function startOfDay(now: number, tz: string): Date {
  let zone = tz;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { zone = "UTC"; }
  const off = tzOffsetMs(now, zone);
  const local = new Date(now + off);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnightLocal - tzOffsetMs(midnightLocal - off, zone));
}

export async function evaluateGuardrails(
  db: SupabaseClient,
  userId: string,
  settings: Settings,
  p: { kind: "paper" | "real"; mint: string; sizeUsd: number | null; scan: TokenScan | null; now?: number },
): Promise<GuardLine[]> {
  const now = p.now ?? Date.now();
  const g = settings.guardrails;
  const dayStart = startOfDay(now, settings.timezone).toISOString();
  const [{ data: view }, { data: today }] = await Promise.all([
    db.from("checklist_views").select("first_opened_at").eq("user_id", userId).eq("mint", p.mint).maybeSingle(),
    db.from("trades").select("status,pnl_usd,exit_time,created_at").eq("user_id", userId).eq("kind", p.kind).or(`created_at.gte.${dayStart},exit_time.gte.${dayStart}`),
  ]);
  const lines: GuardLine[] = [];

  // Checklist review + cooldown
  if (!view) {
    lines.push({ id: "noReview", label: "Checklist review", state: "triggered", detail: "This token's checklist has not been opened first.", tag: TAG_FOR.noReview, blocksPaper: true });
  } else {
    lines.push({ id: "noReview", label: "Checklist review", state: "ok", detail: "Checklist was opened before logging.", tag: null, blocksPaper: true });
  }
  if (!g.cooldown.on) lines.push({ id: "cooldown", label: "Cooldown", state: "off", detail: "Switched off in Settings.", tag: null, blocksPaper: true });
  else {
    const waitMs = view ? new Date(view.first_opened_at).getTime() + g.cooldown.minutes * 60_000 - now : 0;
    lines.push(waitMs > 0
      ? { id: "cooldown", label: "Cooldown", state: "triggered", detail: `${Math.ceil(waitMs / 60_000)} min left of the ${g.cooldown.minutes}-min cooldown after first opening this checklist.`, tag: TAG_FOR.cooldown, blocksPaper: true }
      : { id: "cooldown", label: "Cooldown", state: "ok", detail: `${g.cooldown.minutes}-min cooldown has passed.`, tag: null, blocksPaper: true });
  }

  // Failed required check
  const failed = p.scan?.evaluation.checks.filter((c) => c.status === "FAIL") ?? [];
  if (!g.failedRequired.on) lines.push({ id: "requiredFail", label: "Required checks", state: "off", detail: "Switched off in Settings.", tag: null, blocksPaper: false });
  else lines.push(failed.length
    ? { id: "requiredFail", label: "Required checks", state: "triggered", detail: `Failed: ${failed.map((c) => c.label).join(", ")}. A typed override is recorded.`, tag: TAG_FOR.requiredFail, blocksPaper: false }
    : { id: "requiredFail", label: "Required checks", state: "ok", detail: "No required check failed in the latest scan.", tag: null, blocksPaper: false });

  // Daily limits
  const opened = (today ?? []).filter((t) => t.created_at >= dayStart).length;
  if (!g.dailyTrades.on) lines.push({ id: "dailyTrades", label: "Daily trades", state: "off", detail: "Switched off in Settings.", tag: null, blocksPaper: true });
  else lines.push(opened >= g.dailyTrades.max
    ? { id: "dailyTrades", label: "Daily trades", state: "triggered", detail: `${opened} of ${g.dailyTrades.max} trades already logged today.`, tag: TAG_FOR.dailyTrades, blocksPaper: true }
    : { id: "dailyTrades", label: "Daily trades", state: "ok", detail: `${opened} of ${g.dailyTrades.max} logged today.`, tag: null, blocksPaper: true });

  const net = (today ?? []).filter((t) => t.status === "closed" && t.exit_time >= dayStart).reduce((a, t) => a + Number(t.pnl_usd ?? 0), 0);
  const lost = Math.max(0, -net);
  if (!g.dailyMaxLoss.on) lines.push({ id: "dailyMaxLoss", label: "Daily max loss", state: "off", detail: "Switched off in Settings.", tag: null, blocksPaper: true });
  else if (g.dailyMaxLoss.usd == null) lines.push({ id: "dailyMaxLoss", label: "Daily max loss", state: "not_set", detail: "Not set. Add a limit in Settings.", tag: null, blocksPaper: true });
  else lines.push(lost >= g.dailyMaxLoss.usd
    ? { id: "dailyMaxLoss", label: "Daily max loss", state: "triggered", detail: `Realized loss today $${lost.toFixed(2)} has reached your $${g.dailyMaxLoss.usd} limit.`, tag: TAG_FOR.dailyMaxLoss, blocksPaper: true }
    : { id: "dailyMaxLoss", label: "Daily max loss", state: "ok", detail: `Realized loss today $${lost.toFixed(2)} of $${g.dailyMaxLoss.usd}.`, tag: null, blocksPaper: true });

  // Size limit (real trades only)
  if (p.kind === "real") {
    if (!g.sizeLimit.on) lines.push({ id: "sizeLimit", label: "Size limit", state: "off", detail: "Switched off in Settings.", tag: null, blocksPaper: false });
    else if (g.sizeLimit.usd == null) lines.push({ id: "sizeLimit", label: "Size limit", state: "not_set", detail: "Not set. Add a limit in Settings.", tag: null, blocksPaper: false });
    else lines.push(p.sizeUsd != null && p.sizeUsd > g.sizeLimit.usd
      ? { id: "sizeLimit", label: "Size limit", state: "triggered", detail: `$${p.sizeUsd} is over your $${g.sizeLimit.usd} limit.`, tag: TAG_FOR.sizeLimit, blocksPaper: false }
      : { id: "sizeLimit", label: "Size limit", state: "ok", detail: `Within your $${g.sizeLimit.usd} limit.`, tag: null, blocksPaper: false });
  }
  return lines;
}

export const OVERRIDE_PREFIX = /^\s*I['’]m overriding:\s*(\S.{2,})$/i;

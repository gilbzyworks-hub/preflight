export { fmtUsd, fmtHours } from "@shared/engine.ts";

export const fmtPrice = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: 12 });

export const fmtPct = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

export const clock = (iso: string | number | Date): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const stamp = (iso: string | number | Date): string =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function ago(iso: string | number | Date, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "<1m ago";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

export const short = (mint: string) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

import type { Settings } from "./types.ts";

export interface PaperEntry {
  fillPrice: number;
  qty: number;
  feeUsd: number;
}

export function paperEntry(sizeUsd: number, scanPrice: number, p: Settings["paper"]): PaperEntry {
  const fillPrice = scanPrice * (1 + p.slippagePct / 100);
  const feeUsd = sizeUsd * (p.feePct / 100);
  return { fillPrice, feeUsd, qty: (sizeUsd - feeUsd) / fillPrice };
}

export function paperExit(qty: number, amountUsd: number, scanPrice: number, p: Settings["paper"]) {
  const fillPrice = scanPrice * (1 - p.slippagePct / 100);
  const gross = qty * fillPrice;
  const feeUsd = gross * (p.feePct / 100);
  return { fillPrice, feeUsd, pnl: gross - feeUsd - amountUsd };
}

export const PAPER_CLOSE_NOTE = "Closed at periodic-scan price; real fills may differ.";

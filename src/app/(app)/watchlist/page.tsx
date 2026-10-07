import { Suspense } from "react";
import Watchlist from "./Watchlist";

export default function Page() {
  return <Suspense fallback={<div className="p-6 text-sm text-muted">Loading…</div>}><Watchlist /></Suspense>;
}

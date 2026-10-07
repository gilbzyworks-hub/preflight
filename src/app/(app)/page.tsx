import { Suspense } from "react";
import Scanner from "./Scanner";

export default function Page() {
  return <Suspense fallback={<div className="p-6 text-sm text-muted">Loading…</div>}><Scanner /></Suspense>;
}

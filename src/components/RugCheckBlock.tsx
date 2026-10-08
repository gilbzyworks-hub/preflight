import { clock } from "@/lib/format";
import type { RugCheckResult } from "@shared/rugcheck.ts";

const LEVEL_LABEL = (l: string) => l.toLowerCase();

/** RugCheck's three outcomes, always distinct. "No items" is never styled as a pass or shown in green. */
export function RugCheckBlock({ rc, loading, busy, onAsk }: { rc: RugCheckResult | null; loading: boolean; busy: boolean; onAsk: () => void }) {
  if (!rc) {
    return (
      <div className="flex items-center gap-3">
        <button className="btn btn-sm" disabled={loading} onClick={onAsk}>{busy ? "Loading…" : "Show RugCheck summary"}</button>
        <span className="label">RugCheck&apos;s own list of risk items. Their opinion, not ours.</span>
      </div>
    );
  }
  const at = clock(rc.fetchedAt);
  return (
    <div className="text-sm" role="status">
      <div className="font-medium">RugCheck summary</div>
      {rc.status === "items" && (
        <>
          <p className="mt-1 text-xs text-muted">RugCheck reported {rc.risks.length} item{rc.risks.length === 1 ? "" : "s"}, fetched {at}. Their opinion, not ours; it can be wrong or incomplete.</p>
          <ul className="mt-2 flex flex-col gap-2 text-xs">
            {rc.risks.map((r, i) => (
              <li key={`${r.name}-${i}`}>
                <span className={`tag ${LEVEL_LABEL(r.level) === "info" ? "" : "tag-warn"}`}>{LEVEL_LABEL(r.level) === "info" ? "i" : "!"} {LEVEL_LABEL(r.level)}</span>{" "}
                <span className="font-medium">{r.name}</span>{r.value ? <span className="text-muted"> · {r.value}</span> : null}
                {r.description && <div className="text-muted">{r.description}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      {rc.status === "none" && (
        <p className="mt-1 text-xs text-muted">
          RugCheck reported no risk items (fetched {at}). That only describes RugCheck&apos;s list. It is not an endorsement, and an empty list can sit alongside real risks.
        </p>
      )}
      {rc.status === "unavailable" && (
        <p className="mt-1 text-xs text-warn">! RugCheck data unavailable ({rc.reason}) as of {at}.</p>
      )}
      <button className="btn btn-sm mt-2" disabled={loading} onClick={onAsk}>{busy ? "Loading…" : "Refresh RugCheck"}</button>
    </div>
  );
}


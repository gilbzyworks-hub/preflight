import { EXTERNAL_CAPTION, externalLinks } from "@/lib/external-links";
import { short } from "@/lib/format";

/** Buttons that open third-party checkers for a mint in a new tab. Renders nothing for an invalid address. */
export function ExternalLinks({ mint, compact = false, caption = !compact }: { mint: string; compact?: boolean; caption?: boolean }) {
  const links = externalLinks(mint);
  if (!links) return null;
  return (
    <div>
      <div className={`flex flex-wrap items-center ${compact ? "gap-x-3 gap-y-1 text-xs" : "gap-2"}`}>
        {compact && <span className="label">Check elsewhere:</span>}
        {links.map((l) => (
          <a
            key={l.id}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            title={l.note}
            aria-label={`Open ${l.label} for ${short(mint)} in a new tab: ${l.note}`}
            className={compact ? "underline hover:text-ink" : "btn btn-sm"}
          >
            {l.label} ↗
          </a>
        ))}
      </div>
      {caption && <p className="label mt-2">{EXTERNAL_CAPTION}</p>}
    </div>
  );
}

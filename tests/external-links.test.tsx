import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExternalLinks } from "@/components/ExternalLinks";
import { RugCheckBlock } from "@/components/RugCheckBlock";
import { CHECKERS, EXTERNAL_CAPTION, externalLinks } from "@/lib/external-links";
import type { RugCheckResult } from "@shared/rugcheck.ts";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const AIO = "FAopSovS2WFJK5qEAmcuwAVH98CvmBwT6Lpq4EK2pump";
const ANT = "7ypCq2CJ4fnbtS3z2B1W1UT2he5E3u7Md6Gy1ri7uGrQ";

describe("external checker links", () => {
  it("builds the verified URL format for each checker from the mint alone", () => {
    for (const mint of [BONK, AIO, ANT]) {
      const hrefs = Object.fromEntries(externalLinks(mint)!.map((l) => [l.id, l.href]));
      expect(hrefs.rugcheck).toBe(`https://rugcheck.xyz/tokens/${mint}`);
      expect(hrefs.solscan).toBe(`https://solscan.io/token/${mint}`);
      expect(hrefs.bubblemaps).toBe(`https://app.bubblemaps.io/sol/token/${mint}`);
    }
    expect(CHECKERS.map((c) => c.id)).toEqual(["rugcheck", "solscan", "bubblemaps"]);
  });

  it.each([
    ["empty", ""],
    ["a symbol", "BONK"],
    ["too short (29 characters)", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6"],
    ["too long (45 characters)", BONK + "A"],
    ["not base58 (contains 0, O, I, l)", "0ezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],
    ["path injection", `${BONK}/../../evil`],
    ["query injection", `${BONK}?ref=evil`],
    ["fragment injection", `${BONK}#x`],
    ["a URL", "https://evil.example/" + BONK],
    ["javascript scheme", "javascript:alert(1)"],
    ["whitespace", ` ${BONK}`],
    ["valid base58 but not 32 bytes", "1".repeat(44)],
  ])("builds no links for %s", (_n, v) => {
    expect(externalLinks(v)).toBeNull();
  });

  it("renders new-tab links with rel=noopener noreferrer, and the caption", () => {
    const html = renderToStaticMarkup(<ExternalLinks mint={BONK} />);
    const anchors = html.match(/<a [^>]*>/g)!;
    expect(anchors).toHaveLength(3);
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
      expect(a).toMatch(/href="https:\/\/(rugcheck\.xyz|solscan\.io|app\.bubblemaps\.io)\//);
    }
    expect(html.replace(/&#x27;/g, "'")).toContain(EXTERNAL_CAPTION);
    expect(EXTERNAL_CAPTION).toBe("Each site runs its own analysis. Their results can be wrong or incomplete, and are not part of Preflight's checks.");
  });

  it("renders nothing for an invalid address, and no iframe or embed ever", () => {
    expect(renderToStaticMarkup(<ExternalLinks mint="BONK" />)).toBe("");
    const html = renderToStaticMarkup(<ExternalLinks mint={BONK} />);
    expect(html).not.toMatch(/<(iframe|embed|object|script)/i);
  });

  it("compact rows (watchlist, journal) have the three links and no repeated caption", () => {
    const html = renderToStaticMarkup(<ExternalLinks mint={AIO} compact />);
    expect((html.match(/<a /g) ?? []).length).toBe(3);
    expect(html).not.toContain("Each site runs its own analysis");
  });
});

describe("RugCheck status wording", () => {
  const at = "2026-10-07T14:05:00.000Z";
  const none: RugCheckResult = { status: "none", fetchedAt: at };
  const down: RugCheckResult = { status: "unavailable", fetchedAt: at, reason: "request timed out" };
  const items: RugCheckResult = { status: "items", fetchedAt: at, risks: [
    { name: "Mutable metadata", level: "warn", description: "Token metadata can be changed by the owner", value: null },
    { name: "Top holders", level: "danger", description: null, value: "35%" },
    { name: "Creator history", level: "info", description: null, value: null },
  ] };
  const html = (rc: RugCheckResult | null) => renderToStaticMarkup(<RugCheckBlock rc={rc} loading={false} busy={false} onAsk={() => {}} />);

  it("empty list says RugCheck reported no risk items, with no PASS styling, no green and no checkmark", () => {
    const h = html(none);
    expect(h).toContain("RugCheck reported no risk items");
    expect(h).not.toMatch(/PASS|text-ok|✓|green/i);
    expect(h).toContain("not an endorsement");
  });

  it("a failed call says data unavailable with the reason and time, and never says no risk items", () => {
    const h = html(down);
    expect(h).toContain("RugCheck data unavailable (request timed out) as of");
    expect(h).not.toContain("no risk items");
    expect(h).toContain("text-warn");
  });

  it("items are listed with RugCheck's own level word and the fetch time; never styled as passing", () => {
    const h = html(items);
    expect(h).toContain("RugCheck reported 3 items");
    expect(h).toContain("fetched");
    for (const level of ["warn", "danger", "info"]) expect(h).toContain(level);
    expect(h).toContain("Mutable metadata");
    expect(h).not.toMatch(/text-fail|text-ok|PASS/);
  });

  it("before it is requested it makes no claim either way", () => {
    const h = html(null);
    expect(h).toContain("Show RugCheck summary");
    expect(h).not.toMatch(/no risk items|unavailable/);
  });
});

describe("wording guard", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
  it('never uses "safe", "real-time", "live" or "buy signal" in app source', () => {
    const bad = /\b(safe|safer|real-time|realtime|live|buy signal)\b/i;
    const hits = [...walk("src"), ...walk("supabase/functions")].filter((f) => bad.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

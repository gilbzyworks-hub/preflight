"use client";
import { useEffect, useState } from "react";
import { DISCLAIMER } from "@/components/Shell";
import { useScan } from "@/components/ScanProvider";
import { DEFS } from "@shared/engine.ts";
import { DEFAULT_PRESET } from "@shared/defaults.ts";
import type { CheckId, ExtensionRuleKey, Preset, Settings, Severity } from "@shared/types.ts";

/** Text-backed number input: lets you type "0." and blank means "not set" (null). */
function Num({ id, value, onChange, placeholder, width = "w-28" }: { id?: string; value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; width?: string }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => { setText((t) => (Number(t) === value || (t === "" && value == null) ? t : value == null ? "" : String(value))); }, [value]);
  return (
    <input id={id} className={`field num ${width}`} inputMode="decimal" placeholder={placeholder} value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (v.trim() === "") onChange(null);
        else if (Number.isFinite(Number(v))) onChange(Number(v));
      }} />
  );
}

const UNITS: Record<CheckId, string> = {
  age: "hours", liquidity: "USD", fdv: "USD", volume24h: "USD", mintAuthority: "", freezeAuthority: "", top10: "% adjusted, max",
  poolSplit: "% in main pool, min", tokenProgram: "", creatorHolding: "% of supply, max", earlyBuyers: "% bought in first 3 slots, max",
};
const HAS_MIN: CheckId[] = ["age", "liquidity", "fdv", "volume24h", "poolSplit"];
const HAS_MAX: CheckId[] = ["age", "fdv", "top10", "creatorHolding", "earlyBuyers"];
const EXT_ROWS: { key: ExtensionRuleKey; label: string; note: string; failAbove?: boolean }[] = [
  { key: "nonTransferable", label: "Non-transferable", note: "Cannot be transferred or sold" },
  { key: "permanentDelegate", label: "Permanent delegate", note: "A delegate can move or burn anyone's tokens" },
  { key: "defaultAccountState", label: "Default account state", note: "Fails when new accounts start frozen" },
  { key: "transferFeeConfig", label: "Transfer fee", note: "Warning; fails above this fee", failAbove: true },
  { key: "transferHook", label: "Transfer hook", note: "Custom code runs on every transfer" },
  { key: "pausableConfig", label: "Pausable", note: "A currently paused token always fails" },
  { key: "mintCloseAuthority", label: "Mint close authority", note: "Authority can close the mint" },
  { key: "other", label: "Any other extension", note: "Unrecognised extensions" },
];

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="panel p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      <div className="mt-3 flex flex-col gap-3 text-sm">{children}</div>
    </section>
  );
}
const Row = ({ label, children, htmlFor }: { label: string; children: React.ReactNode; htmlFor?: string }) => (
  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
    <label className="min-w-44 text-muted" htmlFor={htmlFor}>{label}</label>
    {children}
  </div>
);

export default function SettingsForm() {
  const { settings, saveSettings, ready } = useScan();
  const [d, setD] = useState<Settings>(settings);
  const [msg, setMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (ready) { setD(settings); setDirty(false); } }, [ready, settings]);

  const upd = (fn: (s: Settings) => void) => {
    const next = JSON.parse(JSON.stringify(d)) as Settings;
    fn(next);
    setD(next);
    setDirty(true);
    setMsg(null);
  };
  const preset = d.presets.find((p) => p.id === d.activePresetId) ?? d.presets[0];
  const editPreset = (fn: (p: Preset) => void) => upd((s) => fn(s.presets.find((p) => p.id === s.activePresetId)!));

  async function save() {
    const err = await saveSettings(d);
    setMsg(err ? `! Could not save: ${err}` : "Saved.");
    if (!err) setDirty(false);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-base font-semibold">Settings</h1>
        <div className="flex items-center gap-3">
          {msg && <span className="text-sm text-muted" role="status">{msg}</span>}
          <button className="btn btn-primary" onClick={save} disabled={!dirty}>Save changes</button>
        </div>
      </div>

      <Section title="Presets and thresholds" hint="Each check can be Required, Warning or Off. Missing data is always shown as UNKNOWN and treated as a warning.">
        <Row label="Active preset" htmlFor="ap">
          <select id="ap" className="field w-auto" value={d.activePresetId} onChange={(e) => upd((s) => { s.activePresetId = e.target.value; })}>
            {d.presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Row>
        <Row label="Preset name" htmlFor="pn"><input id="pn" className="field max-w-md flex-1" value={preset.name} onChange={(e) => editPreset((p) => { p.name = e.target.value; })} /></Row>
        {preset.subtitle && <p className="text-xs text-muted">{preset.subtitle}</p>}
        <div className="flex flex-col">
          <div className="label hidden grid-cols-[minmax(0,1fr)_9rem_6rem_6rem] gap-3 pb-1 sm:grid"><span>Check</span><span>Severity</span><span>Min</span><span>Max</span></div>
          {DEFS.map((def) => {
            const r = preset.rules[def.id];
            return (
              <div key={def.id} className="grid gap-2 border-t border-line py-3 sm:grid-cols-[minmax(0,1fr)_9rem_6rem_6rem] sm:items-center sm:gap-3">
                <div>{def.label} {UNITS[def.id] && <span className="label">({UNITS[def.id]})</span>}</div>
                <label className="flex items-center gap-2 sm:block">
                  <span className="label w-16 sm:hidden">Severity</span>
                  <select aria-label={`${def.label} severity`} className="field !min-h-9 w-auto sm:w-full" value={r.severity} onChange={(e) => editPreset((p) => { p.rules[def.id].severity = e.target.value as Severity; })}>
                    <option value="required" disabled={def.warnOnly}>Required</option><option value="warning">Warning</option><option value="off">Off</option>
                  </select>
                </label>
                {HAS_MIN.includes(def.id) ? (
                  <label className="flex items-center gap-2 sm:block"><span className="label w-16 sm:hidden">Min</span><Num width="w-24 sm:w-full" value={r.min} onChange={(v) => editPreset((p) => { p.rules[def.id].min = v; })} /></label>
                ) : <span className="label hidden sm:block">—</span>}
                {HAS_MAX.includes(def.id) ? (
                  <label className="flex items-center gap-2 sm:block"><span className="label w-16 sm:hidden">Max</span><Num width="w-24 sm:w-full" value={r.max} onChange={(v) => editPreset((p) => { p.rules[def.id].max = v; })} /></label>
                ) : <span className="label hidden sm:block">—</span>}
              </div>
            );
          })}
        </div>
        <Row label="Early buyers sharing a funder" htmlFor="eb"><Num id="eb" width="w-20" value={preset.rules.earlyBuyers.maxShared} onChange={(v) => editPreset((p) => { p.rules.earlyBuyers.maxShared = v; })} /><span className="text-muted">or more triggers a warning. Early-buyer clustering and creator holding can only ever warn.</span></Row>
        <h3 className="mt-2 text-sm font-medium">Token-2022 extensions</h3>
        <p className="-mt-2 text-xs text-muted">Each extension found on a token gets its own checklist row. Classic tokens have none.</p>
        <div className="flex flex-col">
          <div className="label hidden grid-cols-[minmax(0,1fr)_9rem_8rem] gap-3 pb-1 sm:grid"><span>Extension</span><span>Severity</span><span>Fail above (%)</span></div>
          {EXT_ROWS.map((x) => {
            const r = preset.extensions[x.key];
            return (
              <div key={x.key} className="grid gap-2 border-t border-line py-3 sm:grid-cols-[minmax(0,1fr)_9rem_8rem] sm:items-center sm:gap-3">
                <div>{x.label} <span className="label">{x.note}</span></div>
                <label className="flex items-center gap-2 sm:block">
                  <span className="label w-16 sm:hidden">Severity</span>
                  <select aria-label={`${x.label} severity`} className="field !min-h-9 w-auto sm:w-full" value={r.severity} onChange={(e) => editPreset((p) => { p.extensions[x.key].severity = e.target.value as Severity; })}>
                    <option value="required">Required</option><option value="warning">Warning</option><option value="off">Off</option>
                  </select>
                </label>
                {x.failAbove ? (
                  <label className="flex items-center gap-2 sm:block"><span className="label w-16 sm:hidden">Fail above</span><Num width="w-24 sm:w-full" value={r.failAbove} onChange={(v) => editPreset((p) => { p.extensions[x.key].failAbove = v; })} /></label>
                ) : <span className="label hidden sm:block">—</span>}
              </div>
            );
          })}
        </div>
        <Row label="Unknown data" htmlFor="ud">
          <select id="ud" className="field w-auto" value={preset.unknownData} onChange={(e) => editPreset((p) => { p.unknownData = e.target.value as "warning" | "off"; })}>
            <option value="warning">Warning</option><option value="off">Off</option>
          </select>
        </Row>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm" onClick={() => upd((s) => {
            const base = s.presets.find((p) => p.id === s.activePresetId)!;
            const copy: Preset = JSON.parse(JSON.stringify(base));
            copy.id = `p-${Date.now().toString(36)}`;
            copy.name = `${base.name} (copy)`;
            copy.subtitle = undefined;
            s.presets.push(copy);
            s.activePresetId = copy.id;
          })}>Save as new preset</button>
          <button className="btn btn-sm" disabled={d.presets.length < 2} onClick={() => upd((s) => {
            s.presets = s.presets.filter((p) => p.id !== s.activePresetId);
            s.activePresetId = s.presets[0].id;
          })}>Delete this preset</button>
          <button className="btn btn-sm" onClick={() => upd((s) => {
            if (!s.presets.some((p) => p.id === DEFAULT_PRESET.id)) s.presets.unshift(JSON.parse(JSON.stringify(DEFAULT_PRESET)));
            else s.presets = s.presets.map((p) => (p.id === DEFAULT_PRESET.id ? JSON.parse(JSON.stringify(DEFAULT_PRESET)) : p));
            s.activePresetId = DEFAULT_PRESET.id;
          })}>Reset default preset</button>
        </div>
      </Section>

      <Section title="Alerts" hint="In-site only, for watchlist tokens. Every alert is saved to the inbox; quiet hours and the hourly cap only limit the banner shown while the site is open.">
        <Row label="Quiet hours" htmlFor="qs">
          <input id="qs" type="time" className="field w-auto" value={d.alerts.quietStart} onChange={(e) => upd((s) => { s.alerts.quietStart = e.target.value; })} />
          <span className="text-muted">to</span>
          <input aria-label="Quiet hours end" type="time" className="field w-auto" value={d.alerts.quietEnd} onChange={(e) => upd((s) => { s.alerts.quietEnd = e.target.value; })} />
        </Row>
        <Row label="Max banners per hour" htmlFor="mh"><Num id="mh" width="w-20" value={d.alerts.maxPerHour} onChange={(v) => upd((s) => { s.alerts.maxPerHour = v ?? 4; })} /></Row>
        <Row label="Default liquidity drop" htmlFor="ld"><Num id="ld" width="w-20" value={d.alerts.liquidityDropPct} onChange={(v) => upd((s) => { s.alerts.liquidityDropPct = v ?? 30; })} /><span className="text-muted">% since last scan</span></Row>
      </Section>

      <Section title="Guardrails" hint="Paper trades enforce these. Real trades are always recordable: triggered guardrails are tagged on the entry, never blocked.">
        <Row label="Cooldown">
          <label className="flex items-center gap-2"><input type="checkbox" checked={d.guardrails.cooldown.on} onChange={(e) => upd((s) => { s.guardrails.cooldown.on = e.target.checked; })} /> On</label>
          <Num width="w-20" value={d.guardrails.cooldown.minutes} onChange={(v) => upd((s) => { s.guardrails.cooldown.minutes = v ?? 5; })} /><span className="text-muted">min after first opening a checklist</span>
        </Row>
        <Row label="Failed required check">
          <label className="flex items-center gap-2"><input type="checkbox" checked={d.guardrails.failedRequired.on} onChange={(e) => upd((s) => { s.guardrails.failedRequired.on = e.target.checked; })} /> On</label>
          <span className="text-muted">typed “I’m overriding: …” and a Rule override tag</span>
        </Row>
        <Row label="Trades per day">
          <label className="flex items-center gap-2"><input type="checkbox" checked={d.guardrails.dailyTrades.on} onChange={(e) => upd((s) => { s.guardrails.dailyTrades.on = e.target.checked; })} /> On</label>
          <Num width="w-20" value={d.guardrails.dailyTrades.max} onChange={(v) => upd((s) => { s.guardrails.dailyTrades.max = v ?? 3; })} />
        </Row>
        <Row label="Daily max loss (USD)">
          <label className="flex items-center gap-2"><input type="checkbox" checked={d.guardrails.dailyMaxLoss.on} onChange={(e) => upd((s) => { s.guardrails.dailyMaxLoss.on = e.target.checked; })} /> On</label>
          <Num width="w-28" placeholder="Not set" value={d.guardrails.dailyMaxLoss.usd} onChange={(v) => upd((s) => { s.guardrails.dailyMaxLoss.usd = v; })} />
          {d.guardrails.dailyMaxLoss.usd == null && <span className="text-muted">Not set — checks show “Not set” until you add one</span>}
        </Row>
        <Row label="Real-trade size limit (USD)">
          <label className="flex items-center gap-2"><input type="checkbox" checked={d.guardrails.sizeLimit.on} onChange={(e) => upd((s) => { s.guardrails.sizeLimit.on = e.target.checked; })} /> On</label>
          <Num width="w-28" placeholder="Not set" value={d.guardrails.sizeLimit.usd} onChange={(v) => upd((s) => { s.guardrails.sizeLimit.usd = v; })} />
          {d.guardrails.sizeLimit.usd == null && <span className="text-muted">Not set</span>}
        </Row>
      </Section>

      <Section title="Paper-trading simulation">
        <Row label="Starting balance (USD)"><Num width="w-28" value={d.paper.startingBalance} onChange={(v) => upd((s) => { s.paper.startingBalance = v ?? 1000; })} /></Row>
        <Row label="Adverse slippage per side"><Num width="w-20" value={d.paper.slippagePct} onChange={(v) => upd((s) => { s.paper.slippagePct = v ?? 3; })} /><span className="text-muted">%</span></Row>
        <Row label="Fee per side"><Num width="w-20" value={d.paper.feePct} onChange={(v) => upd((s) => { s.paper.feePct = v ?? 1; })} /><span className="text-muted">%</span></Row>
        <Row label="Default size"><Num width="w-20" value={d.paper.defaultSizePct} onChange={(v) => upd((s) => { s.paper.defaultSizePct = v ?? 2; })} /><span className="text-muted">% of paper balance</span></Row>
        <p className="text-xs text-muted">Paper fills use the last scanned price. Stops and targets close at the next periodic-scan price after being hit, so real fills may differ.</p>
      </Section>

      <Section title="Data freshness" hint="Scanning is a periodic scan (~every 2 min). Data older than this is labelled STALE and always shows its own “as of” time.">
        <Row label="Stale after" htmlFor="st"><Num id="st" width="w-20" value={d.staleMinutes} onChange={(v) => upd((s) => { s.staleMinutes = v && v > 0 ? v : 6; })} /><span className="text-muted">minutes without a successful background scan</span></Row>
        <Row label="Time zone (for “today”)" htmlFor="tz"><input id="tz" className="field max-w-xs" value={d.timezone} onChange={(e) => upd((s) => { s.timezone = e.target.value; })} /></Row>
      </Section>

      <Section title="Outcome tracking" hint="Every token the scanner shows is logged with its check results, then re-checked about 1 hour, 24 hours and 7 days later. Records are never overwritten, so changing a rule here does not change past results.">
        <Row label="Likely-rug estimate" htmlFor="rug"><Num id="rug" width="w-20" value={d.outcomes.rugLiquidityDropPct} onChange={(v) => upd((s) => { s.outcomes.rugLiquidityDropPct = v && v > 0 && v <= 100 ? v : 90; })} /><span className="text-muted">% liquidity drop from first appearance (or no pair returned)</span></Row>
        <p className="text-xs text-muted">This is a rough heuristic, shown as “estimate”. Only you can mark a token as a verified rug, with a source note.</p>
      </Section>

      <Section title="Data provider budget" hint="Each scan can use a limited number of on-chain requests. When a budget runs out, the remaining checks show NOT RUN (not UNKNOWN) and are tried again on later scans. Creator and early-buyer results are saved once found.">
        <Row label="Basic checks per scan" htmlFor="rb1"><Num id="rb1" width="w-24" value={d.rpcBudget.cheapPerScan} onChange={(v) => upd((s) => { s.rpcBudget.cheapPerScan = v && v > 0 ? Math.round(v) : 150; })} /><span className="text-muted">requests (about 5 per token)</span></Row>
        <Row label="Creator and early-buyer checks per scan" htmlFor="rb2"><Num id="rb2" width="w-24" value={d.rpcBudget.expensivePerScan} onChange={(v) => upd((s) => { s.rpcBudget.expensivePerScan = v && v > 0 ? Math.round(v) : 300; })} /><span className="text-muted">requests (up to ~110 per token, once)</span></Row>
        <Row label="History pages to search" htmlFor="rb3"><Num id="rb3" width="w-20" value={d.rpcBudget.creatorPageBudget} onChange={(v) => upd((s) => { s.rpcBudget.creatorPageBudget = v && v > 0 ? Math.round(v) : 10; })} /><span className="text-muted">pages of 1,000 transactions when looking for a token&apos;s creation</span></Row>
      </Section>

      <Section title="Disclaimer">
        <p>{DISCLAIMER}</p>
        <p className="text-muted">Preflight uses public data only, has no wallet connection, and never places, signs or automates a trade. It does not connect to Fomo.</p>
      </Section>
    </div>
  );
}

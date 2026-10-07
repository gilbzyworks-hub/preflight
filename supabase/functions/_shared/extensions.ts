import { KNOWN_BENIGN_EXTENSIONS } from "./solana-config.ts";
import type { CheckRule, ExtensionInfo, ExtensionRuleKey } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** RPC jsonParsed extension name -> preset rule key. Anything not here and not benign is "other" (unrecognised). */
export const EXT_RULE_KEY: Record<string, ExtensionRuleKey> = {
  nonTransferable: "nonTransferable",
  permanentDelegate: "permanentDelegate",
  defaultAccountState: "defaultAccountState",
  transferFeeConfig: "transferFeeConfig",
  transferHook: "transferHook",
  pausableConfig: "pausableConfig",
  mintCloseAuthority: "mintCloseAuthority",
};

export const EXT_LABEL: Record<ExtensionRuleKey, string> = {
  nonTransferable: "Non-transferable",
  permanentDelegate: "Permanent delegate",
  defaultAccountState: "Default account state",
  transferFeeConfig: "Transfer fee",
  transferHook: "Transfer hook",
  pausableConfig: "Pausable",
  mintCloseAuthority: "Mint close authority",
  other: "Unrecognised extension",
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Read the `extensions` array of a jsonParsed Token-2022 mint. Returns null if the shape is not what we expect. */
export function parseExtensions(parsedInfo: Any): ExtensionInfo[] | null {
  const list = parsedInfo?.extensions;
  if (list === undefined) return []; // a Token-2022 mint with no extensions omits the field
  if (!Array.isArray(list)) return null;
  const out: ExtensionInfo[] = [];
  for (const e of list) {
    const name = e?.extension;
    if (typeof name !== "string") return null;
    const st = e?.state ?? {};
    switch (name) {
      case "transferFeeConfig": {
        const o = st.olderTransferFee ?? {};
        const n = st.newerTransferFee ?? {};
        out.push({
          name,
          authority: str(st.transferFeeConfigAuthority),
          details: {
            olderFeeBps: num(o.transferFeeBasisPoints), newerFeeBps: num(n.transferFeeBasisPoints),
            olderMaxFee: num(o.maximumFee), newerMaxFee: num(n.maximumFee), newerEpoch: num(n.epoch),
            withdrawAuthority: str(st.withdrawWithheldAuthority),
          },
        });
        break;
      }
      case "permanentDelegate": out.push({ name, authority: str(st.delegate), details: {} }); break;
      case "mintCloseAuthority": out.push({ name, authority: str(st.closeAuthority), details: {} }); break;
      case "transferHook": out.push({ name, authority: str(st.authority), details: { programId: str(st.programId) } }); break;
      case "pausableConfig": out.push({ name, authority: str(st.authority), details: { paused: st.paused === true } }); break;
      case "defaultAccountState": out.push({ name, authority: null, details: { state: String(st.accountState ?? "").toLowerCase() || null } }); break;
      default: out.push({ name, authority: str(st.authority), details: {} });
    }
  }
  return out;
}

export interface ExtRow {
  key: ExtensionRuleKey;
  name: string;
  label: string;
  status: "PASS" | "WARN" | "FAIL" | "UNKNOWN" | "OFF";
  severity: CheckRule["severity"];
  value: string;
  threshold: string;
  explanation: string;
  notes: string[];
}

// u64::MAX style caps arrive as huge floats; say "no practical cap" instead of printing 19 digits.
const maxFeeText = (v: number | null) => (v === null ? "" : v >= 1e15 ? "No practical cap on the fee per transfer." : `Max fee per transfer: ${v} raw units.`);
const who = (a: string | null) => (a ? a : "none");
const bpsPct = (b: number) => `${+(b / 100).toFixed(2)}%`;

/** One checklist row per relevant extension. Benign ones (metadata, groups, account-level) get no row. */
export function extensionRows(exts: ExtensionInfo[], rules: Record<ExtensionRuleKey, CheckRule>): ExtRow[] {
  const rows: ExtRow[] = [];
  for (const e of exts) {
    if (KNOWN_BENIGN_EXTENSIONS.has(e.name)) continue;
    const key = EXT_RULE_KEY[e.name] ?? "other";
    const rule = rules[key] ?? rules.other;
    const base = { key, name: e.name, severity: rule.severity, notes: [] as string[] };
    const row = (status: ExtRow["status"], value: string, threshold: string, explanation: string, label = EXT_LABEL[key], notes: string[] = []): ExtRow =>
      ({ ...base, label, status: rule.severity === "off" ? "OFF" : status, value, threshold, explanation, notes });
    // A row that "fails" is only a FAIL when its rule is Required (or promoted); otherwise it is a warning.
    const bad = (): ExtRow["status"] => (rule.severity === "required" ? "FAIL" : "WARN");

    switch (key) {
      case "nonTransferable":
        rows.push(row(bad(), "Present", "Absent", "Tokens cannot be transferred, so they cannot be sold."));
        break;
      case "permanentDelegate":
        rows.push(row(bad(), `Delegate: ${who(e.authority)}`, "Absent", "A permanent delegate can move or burn any holder's tokens."));
        break;
      case "defaultAccountState": {
        const st = e.details.state;
        if (st === "frozen") rows.push(row(bad(), "Frozen", "Initialized", "New holder accounts start frozen and cannot transfer until the freeze authority thaws them."));
        else if (st === "initialized") rows.push(row("PASS", "Initialized", "Initialized", "New holder accounts start usable."));
        else rows.push(row("UNKNOWN", "Not readable", "Initialized", "The default account state could not be read, so it is treated as a warning, not a pass."));
        break;
      }
      case "transferFeeConfig": {
        const older = num(e.details.olderFeeBps), newer = num(e.details.newerFeeBps);
        const vals = [older, newer].filter((x): x is number => x !== null);
        if (!vals.length) { rows.push(row("UNKNOWN", "Not readable", "—", "The transfer fee could not be read, so it is treated as a warning, not a pass.")); break; }
        const hi = Math.max(...vals);
        const failAbove = rule.failAbove ?? null;
        const over = failAbove !== null && hi / 100 > failAbove;
        const feeNote = `Fee authority: ${who(e.authority)} (it can change the fee later, effective from epoch ${e.details.newerEpoch ?? "?"}). ${maxFeeText(num(e.details.newerMaxFee ?? e.details.olderMaxFee))}`;
        const val = `${bpsPct(hi)} (current ${older === null ? "?" : bpsPct(older)}, scheduled ${newer === null ? "?" : bpsPct(newer)})`;
        rows.push(row(over ? "FAIL" : "WARN", val, failAbove === null ? "Warning" : `Warning; fail above ${failAbove}%`, "A fee is taken on every transfer, including sells.", undefined, [feeNote]));
        break;
      }
      case "transferHook": {
        const prog = e.details.programId;
        rows.push(row("WARN", prog ? `Program: ${prog}` : "No program set", "Absent", "Custom code runs on every transfer and can block or alter it.", undefined, [`Hook authority: ${who(e.authority)}`]));
        break;
      }
      case "pausableConfig": {
        const paused = e.details.paused === true;
        rows.push(row(paused ? "FAIL" : "WARN", paused ? `Paused now; authority ${who(e.authority)}` : `Authority: ${who(e.authority)}`, "Absent", paused ? "Transfers, mints and burns are paused right now." : "The authority can pause all transfers."));
        break;
      }
      case "mintCloseAuthority":
        rows.push(row("WARN", `Authority: ${who(e.authority)}`, "Absent", "The authority can close the mint account once supply is zero."));
        break;
      default:
        rows.push(row("WARN", "Present", "Absent", `Unrecognised extension: ${e.name}. Check what it does before relying on this token.`, `Unrecognised extension: ${e.name}`));
    }
  }
  return rows;
}

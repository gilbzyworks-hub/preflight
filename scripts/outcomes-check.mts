// Acceptance check for outcome capture against a LOCAL Supabase stack (never point this at production).
// Usage: URL=... ANON=... SERVICE=... SOLANA_RPC_URL=... npx tsx scripts/outcomes-check.mts
import { createClient } from "@supabase/supabase-js";
import { scanCandidates } from "../supabase/functions/_shared/scan.ts";
import { runFollowUps } from "../supabase/functions/_shared/outcomes.ts";
import { DEFAULT_PRESET } from "../supabase/functions/_shared/defaults.ts";

const { URL, ANON, SERVICE } = process.env as Record<string, string>;
if (!/127\.0\.0\.1|localhost/.test(URL)) throw new Error("Refusing to run against a non-local URL");
const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, extra?: string) => { results.push([name, ok, extra]); console.log(ok ? "PASS" : "FAIL", name, extra ?? ""); };

const email = `t${Date.now()}@example.com`;
const { data: u, error: ue } = await svc.auth.admin.createUser({ email, password: "pw-" + Date.now(), email_confirm: true });
if (ue) throw ue;
const userId = u.user.id;
const user = createClient(URL, ANON, { auth: { persistSession: false } });
await user.auth.signInWithPassword({ email, password: u.user.user_metadata?.pw ?? "" }).catch(() => {});
// sign in properly
const pw = "pw-" + Math.random();
await svc.auth.admin.updateUserById(userId, { password: pw });
const { error: se } = await user.auth.signInWithPassword({ email, password: pw });
if (se) throw se;

// 1. feed scan as the signed-in user (RLS path)
const ctx = { rpcUrl, preset: DEFAULT_PRESET, source: "site" as const };
const r1 = await scanCandidates(user, userId, ctx);
const { data: obs1 } = await svc.from("observations").select("*").eq("user_id", userId);
const shown = (obs1 ?? []).filter((o) => o.shown), unshown = (obs1 ?? []).filter((o) => !o.shown);
check("feed scan wrote observations", (obs1?.length ?? 0) > 0, `${obs1?.length} obs, ${shown.length} shown, ${unshown.length} not shown, errors=${r1.errors.length}`);
check("shown candidates all recorded", shown.length === r1.scans.length, `${shown.length}/${r1.scans.length}`);
check("not-shown (failed-check) tokens recorded with full check results", unshown.length > 0 && unshown.every((o) => o.checks.length >= 11));
check("new observations are schema version 2 with pools stored", (obs1 ?? []).every((o) => o.schema_version === 2 && Array.isArray(o.pools) && o.pools.length > 0));
check("tokens skipped before on-chain checks show NOT_RUN, not UNKNOWN, for chain checks", unshown.every((o) => ["mintAuthority", "top10", "tokenProgram"].every((id) => o.checks.find((c: any) => c.id === id)?.status === "NOT_RUN")));
check("shown tokens store raw/adjusted holders and the RPC budget used", shown.length > 0 && shown.every((o) => o.holders?.rawTop10Pct !== undefined && o.rpc_budget?.calls > 0), shown.map((o) => `${o.holders?.rawTop10Pct?.toFixed(0)}/${o.holders?.adjustedTop10Pct?.toFixed(0)}`).join(" "));
check("expensive checks are NOT_RUN or have a reason, never silently missing", shown.every((o) => ["creatorHolding", "earlyBuyers"].every((id) => ["NOT_RUN", "UNKNOWN", "PASS", "WARN"].includes(o.checks.find((c: any) => c.id === id)?.status))));
check("failed required checks are present in stored results", (obs1 ?? []).some((o) => o.checks.some((c: any) => c.status === "FAIL")));
check("sources + paid promotion stored", (obs1 ?? []).every((o) => o.sources.length > 0) && (obs1 ?? []).some((o) => o.paid_promotion), `${(obs1 ?? []).filter((o) => o.paid_promotion).length} boosted`);
check("market + chain data stored", (obs1 ?? []).every((o) => "liquidityUsd" in o.metrics && "top10Share" in o.chain));
const { data: cov } = await svc.from("coverage_log").select("*").eq("user_id", userId).eq("kind", "feed");
check("coverage log has sources, counts", cov?.length === 1 && cov[0].sources.length === 4 && cov[0].tokens_returned > 0, JSON.stringify(cov?.[0] && { returned: cov[0].tokens_returned, withData: cov[0].tokens_with_data, shown: cov[0].tokens_shown, written: cov[0].observations_written }));
const { data: coh1 } = await svc.from("cohorts").select("*").eq("user_id", userId);
check("one cohort per token for the preset version", coh1?.length === new Set(obs1?.map((o) => o.mint)).size);

// 2. second scan: shown tokens get new observations; no token ever gets a second cohort or a repeat not-shown row
await scanCandidates(user, userId, ctx);
const { data: obs2 } = await svc.from("observations").select("id,mint,shown").eq("user_id", userId);
const { data: coh2 } = await svc.from("cohorts").select("id,mint").eq("user_id", userId);
const dupCohort = coh2!.length !== new Set(coh2!.map((c) => c.mint)).size;
const shownMints = new Set(obs2!.filter((o) => o.shown).map((o) => o.mint));
const unshownCounts = new Map<string, number>();
for (const o of obs2!) if (!o.shown && !shownMints.has(o.mint)) unshownCounts.set(o.mint, (unshownCounts.get(o.mint) ?? 0) + 1);
check("repeat appearances logged as observations", (obs2?.length ?? 0) > (obs1?.length ?? 0), `obs ${obs1?.length}->${obs2?.length}, cohorts ${coh1?.length}->${coh2?.length} (new tokens appeared: ${coh2!.length - coh1!.length})`);
check("never more than one cohort per token and preset version", !dupCohort);
check("repeat scan does not re-log tokens that were not shown", [...unshownCounts.values()].every((n) => n === 1));

// 3. editing the preset leaves past results untouched
const before = JSON.stringify((await svc.from("observations").select("id,preset_version_id,checks").eq("user_id", userId).order("id")).data);
const edited = { ...DEFAULT_PRESET, rules: { ...DEFAULT_PRESET.rules, liquidity: { severity: "required" as const, min: 10_000, max: null } } };
await scanCandidates(user, userId, { ...ctx, preset: edited });
const after = JSON.stringify((await svc.from("observations").select("id,preset_version_id,checks").eq("user_id", userId).order("id").limit(obs2!.length)).data);
const { data: pv } = await svc.from("preset_versions").select("id,preset").eq("user_id", userId);
const { data: coh3 } = await svc.from("cohorts").select("id").eq("user_id", userId);
check("editing a preset creates a new version", pv?.length === 2);
check("past observations unchanged after edit", before === after);
check("old version keeps the old threshold", pv!.some((p) => p.preset.rules.liquidity.min === 50_000));
check("new version opens new cohorts", (coh3?.length ?? 0) > (coh2?.length ?? 0));

// 4. follow-ups: seed backdated cohorts (insert-only) and run the job
const prev = pv![0].id;
const seed = async (mint: string, minsAgo: number) => {
  const at = new Date(Date.now() - minsAgo * 60_000).toISOString();
  const { data: o } = await svc.from("observations").insert({ user_id: userId, observed_at: at, mint, sources: ["manual"], shown: false, preset_version_id: prev, metrics: { liquidityUsd: 100000 }, chain: {}, checks: [], counts: {} }).select("id").single();
  const { data: c } = await svc.from("cohorts").insert({ user_id: userId, mint, preset_version_id: prev, entered_at: at, entry_observation_id: o!.id }).select("id").single();
  return c!.id as string;
};
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const GHOST = "11111111111111111111111111111112"; // valid address, no trading pair
const cDue = await seed(BONK, 65);       // 1h due, inside window
const cLate = await seed(GHOST, 120);    // 1h window closed
const cGhost = await seed(GHOST.replace(/2$/, "3"), 62);
const fu = await runFollowUps(svc);
const snap = async (id: string) => (await svc.from("snapshots").select("*").eq("cohort_id", id)).data ?? [];
const sDue = await snap(cDue), sLate = await snap(cLate), sGhost = await snap(cGhost);
check("+1h snapshot taken with price/liquidity", sDue.length === 1 && sDue[0].status === "ok" && sDue[0].price_usd > 0 && sDue[0].liquidity_usd > 0, JSON.stringify(fu));
check("missed window stored as missed with a reason, no values", sLate.length === 1 && sLate[0].status === "missed" && !!sLate[0].reason && sLate[0].price_usd === null);
check("no pair returned stored as not_returned, not guessed", sGhost.length === 1 && sGhost[0].pair_status === "not_returned" && sGhost[0].price_usd === null);
const fu2 = await runFollowUps(svc);
check("job is idempotent (no duplicate snapshots)", (await snap(cDue)).length === 1 && fu2.taken === 0);

// 5. append-only + access
const upd = await svc.from("observations").update({ shown: true }).eq("user_id", userId);
check("updates are blocked even for the service role", !!upd.error, upd.error?.message);
const del = await user.from("observations").delete().eq("user_id", userId);
const stillThere = await svc.from("observations").select("id", { count: "exact", head: true }).eq("user_id", userId);
check("signed-in user cannot delete", !!del.error || (stillThere.count ?? 0) > 0, del.error?.message);
const insSnap = await user.from("snapshots").insert({ cohort_id: cDue, user_id: userId, horizon: "24h", due_at: new Date().toISOString(), status: "ok" });
check("signed-in user cannot write snapshots", !!insSnap.error, insSnap.error?.message);
const noSource = await user.from("outcome_notes").insert({ cohort_id: cDue, kind: "verified_rug", note: " " });
check("verified rug needs a source note", !!noSource.error, noSource.error?.message);
const okNote = await user.from("outcome_notes").insert({ cohort_id: cDue, kind: "verified_rug", note: "Explorer shows pool drained" });
check("verified rug with a note is accepted", !okNote.error, okNote.error?.message);

await svc.auth.admin.deleteUser(userId);
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

-- Outcome data collection (v1). Append-only: rows are inserted, never updated.
-- Corrections are added as new rows in outcome_notes. Updates are blocked by trigger for every role,
-- and signed-in users have no UPDATE/DELETE grants.

-- Immutable copy of the preset (rules + thresholds) in effect when something was observed.
-- Editing a preset creates a new version (new hash); old observations keep pointing at the old one.
create table public.preset_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  content_hash text not null,
  preset jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, content_hash)
);

-- One row per candidate appearance (feed, watchlist refresh, manual lookup).
create table public.observations (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  observed_at timestamptz not null,
  mint text not null,
  pair_address text,
  sources text[] not null check (sources <@ array['profiled','boosted','watchlist','manual']),
  paid_promotion boolean not null default false,  -- appeared in DEX Screener's boosts list / has active boosts
  shown boolean not null,                          -- true if it was listed in the scanner feed
  on_watchlist boolean not null default false,     -- on the watchlist when observed
  preset_version_id uuid not null references public.preset_versions,
  metrics jsonb not null,                          -- price, liquidity, FDV, volume, change windows, buys/sells, age
  chain jsonb not null,                            -- mint/freeze authority, top-10 share, errors
  checks jsonb not null,                           -- every check: id, status, severity, value, threshold
  counts jsonb not null
);
create index observations_user_mint on public.observations (user_id, mint, observed_at desc);
create index observations_user_time on public.observations (user_id, observed_at desc);

-- First time a token is shown under a preset version. Only cohorts get follow-up snapshots.
create table public.cohorts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  mint text not null,
  preset_version_id uuid not null references public.preset_versions,
  entered_at timestamptz not null,
  entry_observation_id bigint not null references public.observations,
  unique (user_id, mint, preset_version_id)
);
create index cohorts_entered on public.cohorts (entered_at);

-- +1h / +24h / +7d after cohort entry. Written by the background job (service role) only.
create table public.snapshots (
  id bigserial primary key,
  cohort_id uuid not null references public.cohorts on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  horizon text not null check (horizon in ('1h','24h','7d')),
  due_at timestamptz not null,
  taken_at timestamptz not null default now(),
  status text not null check (status in ('ok','missed')),
  pair_status text check (pair_status in ('active','not_returned')),
  pair_address text,
  price_usd numeric,
  liquidity_usd numeric,
  fdv numeric,
  volume_24h numeric,
  reason text,                                      -- required explanation when status = 'missed'
  unique (cohort_id, horizon),
  check (status = 'ok' or reason is not null)
);
create index snapshots_user on public.snapshots (user_id, taken_at desc);

-- Manual notes. 'verified_rug' needs a source note; 'unverify_rug' withdraws a mistaken verification (latest of the
-- two wins); 'correction' amends an earlier record without overwriting it.
create table public.outcome_notes (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  cohort_id uuid not null references public.cohorts on delete cascade,
  kind text not null check (kind in ('verified_rug','unverify_rug','correction','note')),
  note text not null check (length(btrim(note)) >= 3),
  created_at timestamptz not null default now()
);
create index outcome_notes_cohort on public.outcome_notes (cohort_id);

-- What was scanned and what could not be: sources queried, counts, errors, rate-limit gaps.
create table public.coverage_log (
  id bigserial primary key,
  user_id uuid references auth.users on delete cascade,
  logged_at timestamptz not null default now(),
  kind text not null check (kind in ('feed','watchlist','manual','followup')),
  sources jsonb not null default '[]',              -- [{name, ok, returned, error}]
  tokens_returned int not null default 0,
  tokens_with_data int not null default 0,
  tokens_shown int not null default 0,
  observations_written int not null default 0,
  errors text[] not null default '{}',
  rate_limited boolean not null default false
);
create index coverage_log_user on public.coverage_log (user_id, logged_at desc);

create function public.block_updates() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only; add a new row instead of updating', tg_table_name;
end $$;
do $$
declare t text;
begin
  foreach t in array array['preset_versions','observations','cohorts','snapshots','outcome_notes','coverage_log'] loop
    execute format('create trigger no_update before update on public.%I for each row execute function public.block_updates()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "read own" on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
  end loop;
  foreach t in array array['preset_versions','observations','cohorts','outcome_notes'] loop
    execute format('create policy "insert own" on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;
-- A signed-in user may log coverage for their own scans.
create policy "insert own" on public.coverage_log for insert to authenticated with check (user_id = (select auth.uid()));

-- Whether the user watched / paper-traded / real-traded a cohort token (derived, so history is never edited).
create view public.cohort_actions with (security_invoker = true) as
select c.id as cohort_id,
  exists (select 1 from public.observations o where o.user_id = c.user_id and o.mint = c.mint and o.on_watchlist) as watched,
  exists (select 1 from public.trades t where t.user_id = c.user_id and t.mint = c.mint and t.kind = 'paper' and t.created_at >= c.entered_at) as paper_traded,
  exists (select 1 from public.trades t where t.user_id = c.user_id and t.mint = c.mint and t.kind = 'real' and t.created_at >= c.entered_at) as real_traded
from public.cohorts c;

grant select, insert on public.preset_versions, public.observations, public.cohorts,
  public.outcome_notes, public.coverage_log to authenticated;
grant select on public.snapshots, public.cohort_actions to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant all on public.preset_versions, public.observations, public.cohorts, public.snapshots,
  public.outcome_notes, public.coverage_log to service_role;
grant usage, select on all sequences in schema public to service_role;

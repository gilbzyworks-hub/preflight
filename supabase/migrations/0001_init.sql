-- Preflight schema. Single-user app; every row is scoped to auth.uid() via RLS.

create table public.settings (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  mint text not null,
  symbol text,
  name text,
  added_at timestamptz not null default now(),
  added_price numeric,
  added_checks jsonb,
  rules jsonb not null default '{"priceLevel":null,"liqDropOn":true,"liqDropPct":null,"requiredFailOn":true}'::jsonb,
  last_state jsonb,
  unique (user_id, mint)
);

-- Latest scan per token (what the UI shows, with its own "as of" time).
create table public.token_scans (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  mint text not null,
  data jsonb not null,
  scanned_at timestamptz not null,
  source text not null check (source in ('background','site')),
  primary key (user_id, mint)
);

create table public.checklist_views (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  mint text not null,
  first_opened_at timestamptz not null default now(),
  primary key (user_id, mint)
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  mint text not null,
  symbol text,
  kind text not null check (kind in ('price_cross','liquidity_drop','required_fail')),
  message text not null,
  scan_at timestamptz not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index alerts_user_created on public.alerts (user_id, created_at desc);

create table public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null check (kind in ('paper','real')),
  mint text not null,
  symbol text,
  status text not null default 'open' check (status in ('open','closed')),
  reason text not null,
  target numeric not null,
  stop numeric not null,
  max_loss_usd numeric not null,
  amount_usd numeric not null,
  scan_price numeric,            -- paper: last scanned price used for the fill
  entry_price numeric not null,  -- paper: after slippage
  qty numeric,                   -- paper: token quantity
  entry_time timestamptz not null,
  entry_checks jsonb,
  tags text[] not null default '{}',
  followed_rules boolean not null default true,
  override_text text,
  exit_price numeric,
  exit_time timestamptz,
  exit_reason text,              -- stop | target | max_loss | manual
  exit_note text,
  fees_usd numeric not null default 0,
  pnl_usd numeric,
  created_at timestamptz not null default now()
);
create index trades_user_kind on public.trades (user_id, kind, status);

create table public.scan_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','ok','error')),
  error text,
  detail jsonb
);
create index scan_runs_started on public.scan_runs (started_at desc);

alter table public.settings enable row level security;
alter table public.watchlist enable row level security;
alter table public.token_scans enable row level security;
alter table public.checklist_views enable row level security;
alter table public.alerts enable row level security;
alter table public.trades enable row level security;
alter table public.scan_runs enable row level security;

do $$
declare t text;
begin
  foreach t in array array['settings','watchlist','token_scans','checklist_views','alerts','trades'] loop
    execute format('create policy "own rows" on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- Background job runs are written by the service role; signed-in users can read them.
create policy "read runs" on public.scan_runs for select to authenticated using (true);

-- API access (RLS above still restricts rows). New projects do not grant this automatically.
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.settings, public.watchlist, public.token_scans,
  public.checklist_views, public.alerts, public.trades to authenticated;
grant select on public.scan_runs to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

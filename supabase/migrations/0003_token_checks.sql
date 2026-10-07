-- Richer token checks: holders (raw/adjusted), pools, Token-2022 extensions, creator, early-buyer clustering.
-- Additive. Old observations keep schema_version 1 and show the new fields as "not collected at the time".

alter table public.observations
  add column holders jsonb,
  add column pools jsonb,
  add column extensions jsonb,
  add column creator jsonb,
  add column clustering jsonb,
  add column rpc_budget jsonb,
  add column schema_version int not null default 1;

alter table public.coverage_log
  add column rpc_calls int not null default 0,
  add column budget_hit boolean not null default false;

-- Facts about a mint that never change once known (the creator, the launch's early buying). Cached so they are
-- computed once. A column can be filled in later but never changed once set.
create table public.token_facts (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  mint text not null,
  creator jsonb,
  clustering jsonb,
  -- Deterministic misses (e.g. creation transaction too far back to reach). Retried after a day, so a watched token
  -- does not repeat an expensive failed search every scan. Unlike creator/clustering these may be overwritten.
  creator_miss jsonb,
  clustering_miss jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, mint)
);
create function public.token_facts_immutable() returns trigger language plpgsql as $$
begin
  if old.creator is not null and new.creator is distinct from old.creator then
    raise exception 'token_facts.creator is immutable once set';
  end if;
  if old.clustering is not null and new.clustering is distinct from old.clustering then
    raise exception 'token_facts.clustering is immutable once set';
  end if;
  return new;
end $$;
create trigger facts_immutable before update on public.token_facts for each row execute function public.token_facts_immutable();
alter table public.token_facts enable row level security;
create policy "own rows" on public.token_facts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update on public.token_facts to authenticated;
grant all on public.token_facts to service_role;

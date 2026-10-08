-- Which RugCheck outcome occurred when an observation was taken: items | none | unavailable (+ reason, items, fetch time).
-- Null means RugCheck was not requested for that observation. Additive; observations stay append-only.
alter table public.observations add column rugcheck jsonb;

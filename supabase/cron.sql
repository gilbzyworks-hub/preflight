-- Run ONCE in the Supabase SQL editor after deploying the `scan` edge function.
-- 1) Set the function secrets first (CLI):
--      supabase secrets set CRON_SECRET=<long random string> SOLANA_RPC_URL=<your RPC provider URL>
-- 2) Replace the two placeholders below (same CRON_SECRET value; your project URL).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'preflight_project_url');
select vault.create_secret('SAME-VALUE-AS-CRON_SECRET', 'preflight_cron_secret');

select cron.schedule(
  'preflight-scan',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'preflight_project_url') || '/functions/v1/scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'preflight_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
-- Stop it:  select cron.unschedule('preflight-scan');

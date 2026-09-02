-- Phase 2: schedule the run-alerts Edge Function every 10 minutes.
--
-- pg_cron + pg_net call the function over HTTP. The function URL and the
-- shared secret are read from Vault so nothing sensitive lives in this file.
-- Before this migration is useful, store the two secrets once:
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<random 32+ char string>',           'cron_secret');
--
-- and set the same value as an Edge Function secret:
--
--   supabase secrets set CRON_SECRET=<same random string>

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.invoke_run_alerts()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  project_url text;
  cron_secret text;
begin
  select decrypted_secret into project_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into cron_secret from vault.decrypted_secrets where name = 'cron_secret';

  if project_url is null or cron_secret is null then
    raise notice 'invoke_run_alerts: vault secrets project_url / cron_secret not set, skipping';
    return;
  end if;

  perform net.http_post(
    url     := project_url || '/functions/v1/run-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', cron_secret
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

select cron.schedule(
  'run-alerts-every-10-min',
  '*/10 * * * *',
  $$ select public.invoke_run_alerts(); $$
);

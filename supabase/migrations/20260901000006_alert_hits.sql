-- Alert hits (what actually fired, so the client/inbox has history)
create table if not exists public.alert_hits (
  id uuid primary key default gen_random_uuid(),
  alert_rule_id uuid not null references public.alert_rules(id) on delete cascade,
  driver_id uuid not null references auth.users(id) on delete cascade,
  load_id uuid not null references public.loads(id) on delete cascade,
  matched_at timestamptz not null default now(),
  seen boolean not null default false,
  -- run-alerts sweeps every few minutes; without this a matching load
  -- would produce a fresh hit on every sweep.
  unique (alert_rule_id, load_id)
);

create index if not exists alert_hits_driver_unseen_idx
  on public.alert_hits (driver_id, matched_at desc) where not seen;

-- Realtime: the client subscribes to INSERTs on this table filtered by driver_id.
alter publication supabase_realtime add table public.alert_hits;

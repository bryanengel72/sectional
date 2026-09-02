-- Alert rules
create table if not exists public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users(id) on delete cascade,
  rule_type text not null check (rule_type in (
    'pay_per_mile', 'net_per_day', 'origin_radius', 'backhaul_available', 'goal_completable'
  )),
  params jsonb not null default '{}'::jsonb,   -- e.g. {"min_pay_per_mile": 2.00}
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists alert_rules_driver_id_idx on public.alert_rules (driver_id);
create index if not exists alert_rules_active_idx on public.alert_rules (active) where active;

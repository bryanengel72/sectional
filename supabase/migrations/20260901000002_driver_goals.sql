-- Weekly goal state (drivers change this often, keep separate from settings)
create table if not exists public.driver_goals (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users(id) on delete cascade,
  weekly_net_goal numeric not null,
  days_available integer not null check (days_available between 1 and 7),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists driver_goals_driver_id_idx on public.driver_goals (driver_id);

-- Only one active goal per driver at a time.
create unique index if not exists driver_goals_one_active_idx
  on public.driver_goals (driver_id) where active;

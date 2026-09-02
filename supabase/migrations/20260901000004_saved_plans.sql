-- A driver's saved / bookmarked loads and computed plans
create table if not exists public.saved_plans (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users(id) on delete cascade,
  name text,
  load_ids uuid[] not null,
  projected_net numeric,
  projected_expenses numeric,
  days_used numeric,
  created_at timestamptz not null default now()
);

create index if not exists saved_plans_driver_id_idx on public.saved_plans (driver_id);

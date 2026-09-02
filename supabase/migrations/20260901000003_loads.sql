-- Loads: a shared board, not scoped to a single driver.
-- Phase 1: manual entry / CSV import via the import-loads function.
-- Phase 2+: API / email adapters land in the same function.
create table if not exists public.loads (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'manual' check (source in ('manual', 'csv', 'api', 'email')),
  order_number text,
  status text,
  cdl_required boolean,
  terminal text,
  origin_city text not null,
  origin_state text not null,
  dest_city text not null,
  dest_state text not null,
  load_date date,
  miles numeric not null check (miles > 0),
  deadhead_miles numeric not null default 0 check (deadhead_miles >= 0),
  towable boolean,
  pay numeric not null check (pay >= 0),
  est_days numeric not null check (est_days > 0),
  return_cost_estimate numeric not null default 0,
  is_backhaul boolean not null default false,
  raw_payload jsonb,        -- original row from CSV/API, kept for re-parsing when a feed's format changes
  imported_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger loads_set_updated_at
  before update on public.loads
  for each row execute function public.set_updated_at();

create index if not exists loads_created_at_idx on public.loads (created_at desc);
create index if not exists loads_load_date_idx on public.loads (load_date);
create index if not exists loads_origin_idx on public.loads (origin_state, origin_city);

-- Re-importing the same feed row must not create a duplicate load.
create unique index if not exists loads_source_order_number_idx
  on public.loads (source, order_number) where order_number is not null;

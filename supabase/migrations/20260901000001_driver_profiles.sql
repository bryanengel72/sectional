-- Driver profile / settings (1:1 with auth.users)
create table if not exists public.driver_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  starting_location text,
  cdl_class text,
  towable boolean default true,
  mpg numeric default 9.5,
  fuel_type text default 'diesel' check (fuel_type in ('diesel', 'unleaded')),
  hotel_budget numeric default 95,
  food_budget numeric default 45,
  transport_budget numeric default 200,
  max_expense_per_load numeric default 450,
  max_weekly_expense numeric default 1400,
  min_net_per_day numeric default 750,
  min_net_per_load numeric default 400,
  min_net_per_mile numeric default 0.75,
  max_deadhead_pct numeric default 15,
  preferred_min_miles integer default 250,
  preferred_max_miles integer default 900,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Generic updated_at trigger, reused by later migrations.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger driver_profiles_set_updated_at
  before update on public.driver_profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row when a driver signs up so the client never
-- has to special-case "profile missing" on first login.
create or replace function public.handle_new_driver()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.driver_profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_driver();

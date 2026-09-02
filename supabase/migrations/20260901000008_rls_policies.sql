-- Row Level Security: on for everything from day one.
alter table public.driver_profiles enable row level security;
alter table public.driver_goals    enable row level security;
alter table public.saved_plans     enable row level security;
alter table public.alert_rules     enable row level security;
alter table public.alert_hits      enable row level security;
alter table public.subscriptions   enable row level security;
alter table public.loads           enable row level security;

-- Driver-scoped tables: full access to own rows.
-- `with check` mirrors `using` so a driver cannot insert/update a row that
-- points at a different driver_id.
create policy "own profile" on public.driver_profiles
  for all to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy "own goals" on public.driver_goals
  for all to authenticated
  using ((select auth.uid()) = driver_id)
  with check ((select auth.uid()) = driver_id);

create policy "own plans" on public.saved_plans
  for all to authenticated
  using ((select auth.uid()) = driver_id)
  with check ((select auth.uid()) = driver_id);

create policy "own alert rules" on public.alert_rules
  for all to authenticated
  using ((select auth.uid()) = driver_id)
  with check ((select auth.uid()) = driver_id);

-- Hits are written by run-alerts (service role). Drivers can read them and
-- flip `seen`; they cannot fabricate or delete hits.
create policy "own alert hits" on public.alert_hits
  for select to authenticated
  using ((select auth.uid()) = driver_id);

create policy "mark own alert hits seen" on public.alert_hits
  for update to authenticated
  using ((select auth.uid()) = driver_id)
  with check ((select auth.uid()) = driver_id);

create policy "own subscription" on public.subscriptions
  for select to authenticated
  using ((select auth.uid()) = driver_id);

-- Shared load board: readable by any signed-in driver. No insert/update/delete
-- policy for anon/authenticated; writes go through import-loads with the
-- service role key, which bypasses RLS.
create policy "loads readable by authenticated drivers" on public.loads
  for select to authenticated
  using (true);

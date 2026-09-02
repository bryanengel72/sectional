-- Subscriptions (Phase 3 billing). Written only by the stripe-webhook function.
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('driver', 'driver_pro', 'fleet')),
  stripe_customer_id text,
  stripe_subscription_id text unique,
  status text check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'unpaid')),
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_driver_id_idx on public.subscriptions (driver_id);
create index if not exists subscriptions_stripe_customer_idx on public.subscriptions (stripe_customer_id);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

# Sectional — Supabase backend

Backend for the Sectional driver load-planning app. Persistence, ingestion, and
anything that must run with the app closed live here; the fuel / hotel / food /
net / match-score math stays client-side and is shared with the Edge Functions
through one module.

```
supabase/
  config.toml                       local stack + per-function JWT settings
  seed.sql                          GENERATED demo dataset (see sample-data/)
  .env.example                      function secrets (copy to supabase/.env)
  migrations/
    ..01_driver_profiles.sql        profile table, updated_at trigger, auto-create on signup
    ..02_driver_goals.sql
    ..03_loads.sql                  shared board; unique (source, order_number)
    ..04_saved_plans.sql
    ..05_alert_rules.sql
    ..06_alert_hits.sql             unique (rule, load); added to realtime publication
    ..07_subscriptions.sql
    ..08_rls_policies.sql
    ..09_cron_run_alerts.sql        pg_cron + pg_net -> run-alerts every 10 min (Phase 2)
  functions/
    _shared/profit-calc.ts          THE math. web/ imports it directly.
    _shared/profit-calc.test.ts     deno test
    _shared/supabase.ts             admin client, caller lookup, CORS/json helpers
    import-loads/                   CSV / JSON -> loads (service role); normalize.ts is tested
                                    against sample-data/terminal-board.csv
    run-alerts/                     cron sweep -> alert_hits (+ push hook)
    ai-dispatcher/                  Claude-backed plan recommendation
    stripe-webhook/                 Stripe -> subscriptions
```

## Demo client (localhost)

`web/` is a small Vite + TypeScript client that runs the whole MVP on the
generated fixtures with no backend: load board with match scores and expense
receipts, the week-as-highway plan builder, alerts inbox, live settings, and a
CSV import that runs the same normalizer and alert rules the Edge Functions use.

```bash
cd web && npm install && npm run dev      # http://localhost:5180
```

Live at https://sectional-ten.vercel.app; every push to `main` deploys there.

Switch drivers with the buttons in the masthead. Drop `sample-data/terminal-board.csv`
on "Import board (CSV)" to watch new loads land and alerts fire. When the
hosted Supabase project exists, the JSON imports in `web/src/main.ts` are the
seams to replace with `supabase-js` queries.

## Demo data

`sample-data/generate.ts` is the single source for every demo file. It uses
the real `profit-calc.ts`, so alert hits and saved-plan totals in the seed are
exactly what the app computes.

| File | Use |
|---|---|
| `supabase/seed.sql` | Applied by `supabase db reset`. Three drivers, 78 loads over the next two weeks, goals, alert rules, computed alert hits, saved plans, subscriptions. Idempotent. |
| `sample-data/loads.json` | Same loads with absolute dates, for a client demo with no backend. |
| `sample-data/drivers.json` | Profiles, goals, rules, plans, hits per driver, for the same purpose. |
| `sample-data/terminal-board.csv` | A partner-style board export with different header names than our schema. Drop it on `import-loads` to demo CSV ingestion. |

Demo logins (password `sectional-demo` for all):

| Driver | Home | Setup | Shows off |
|---|---|---|---|
| marcus@sectional.demo | Kansas City, MO | CDL-A, tows | The full picture: pay/mile alerts, backhaul alerts, goal-completable alerts, Pro subscription |
| dee@sectional.demo | Dallas, TX | No CDL, tows, unleaded van | CDL hard-fails on the big trucks, origin-radius alerts for TX/OK, trial subscription |
| rob@sectional.demo | Denver, CO | CDL-B, does not tow | Return-transport costs biting into net, long-run chains |

Regenerate after changing the generator or the math:

```bash
cd sample-data && deno run --allow-read --allow-write generate.ts
```

Dates in `seed.sql` are relative to `current_date`, so the board is always
"the next two weeks". The JSON files carry absolute dates from generation time.

## Local dev

```bash
supabase start                 # needs Docker
supabase db reset              # applies migrations + seed.sql
cp supabase/.env.example supabase/.env   # fill in secrets
supabase functions serve       # all functions, hot reload
deno test supabase/functions/_shared/profit-calc.test.ts
```

## Deploy

```bash
supabase link --project-ref <ref>
supabase db push
supabase secrets set --env-file supabase/.env
supabase functions deploy
```

Then, once, so the cron job can reach the function:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<same value as CRON_SECRET>', 'cron_secret');
```

## Phase map

| Phase | Ship |
|---|---|
| 1 — MVP | migrations 01–04 + 08, Auth, client reads/writes its own rows. No functions needed. `import-loads` is optional for manual entry. |
| 2 — chaining, backhauls, alerts | migrations 05, 06, 09; `import-loads` (CSV), `run-alerts`; client subscribes to `alert_hits` via Realtime. |
| 3 — AI dispatcher, partners, billing | migration 07; `ai-dispatcher`, `stripe-webhook`; `import-loads` gains API/email adapters. |

All migrations are safe to apply up front; unused tables are harmless.

## Client wiring

Load the shared math from the same file the functions use so the two can
never drift:

```ts
import { calcLoad, matchScore, summarizePlan } from "../supabase/functions/_shared/profit-calc.ts";
```

Realtime alerts (app open):

```js
supabase
  .channel("alert-hits")
  .on("postgres_changes",
    { event: "INSERT", schema: "public", table: "alert_hits", filter: `driver_id=eq.${driverId}` },
    (payload) => showAlertToast(payload.new))
  .subscribe();
```

Calling functions:

```js
// CSV import
await supabase.functions.invoke("import-loads", { body: csvText, headers: { "Content-Type": "text/csv" } });
// or JSON
await supabase.functions.invoke("import-loads", { body: { loads: [{ origin_city: "Kansas City", ... }] } });

// AI dispatcher
const { data } = await supabase.functions.invoke("ai-dispatcher", {
  body: { request: "Get me home by Friday with at least $2,500 net", load_ids: optionalSubset },
});
```

## Reconciling profit-calc.ts

The existing client calculator was not on hand when this module was written, so
the formulas are the plain reading of the profile fields:

| Line | Formula |
|---|---|
| fuel | (miles + deadhead) / mpg × fuel price (default diesel 3.85 / unleaded 3.30, override via `fuelPrice`) |
| hotel | (ceil(est_days) − 1) nights × hotel_budget |
| food | ceil(est_days) × food_budget |
| return | 0 if backhaul, or if the load is towable and the driver tows (they drive their own car home); else return_cost_estimate, else transport_budget |
| net | pay − (fuel + hotel + food + return) |
| OVER BUDGET | expenses > max_expense_per_load |
| match score | 100 minus weighted deductions (budget 25, net/day 20, net/load 20, net/mile 15, deadhead 10, mileage band 10); a CDL the driver lacks zeroes it |

Before Phase 2, diff these against the client's current numbers and change
**this file**, then delete the client copy. Every alert rule runs through the
same `matchesRule()` and refuses to fire on an OVER BUDGET or hard-fail load.

## Deviations from the spec

- Shared module lives at `functions/_shared/` (the Supabase CLI bundles imports
  from there; a top-level `supabase/shared/` is outside the bundle root).
- `alert_hits` has `unique (alert_rule_id, load_id)`; without it the sketch
  re-inserts every match on every sweep.
- `loads` has a partial unique index on `(source, order_number)` so re-importing
  a feed upserts instead of duplicating.
- Drivers get an `update` policy on `alert_hits` so the client can mark hits `seen`.
- `run-alerts` and `stripe-webhook` set `verify_jwt = false` and authenticate
  with a cron secret / the Stripe signature respectively.
- A trigger on `auth.users` creates the `driver_profiles` row at signup.

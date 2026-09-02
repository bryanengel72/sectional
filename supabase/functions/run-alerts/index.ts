/**
 * run-alerts
 *
 * Scheduled by pg_cron (see migrations/20260901000009_cron_run_alerts.sql),
 * every 10 minutes. Checks recent loads against every active alert rule using
 * the SAME math the dashboard uses (_shared/profit-calc.ts), records hits, and
 * hands new hits to the push layer.
 *
 * Auth: this function has verify_jwt = false (cron is not a user). It requires
 * the x-cron-secret header to match the CRON_SECRET function secret instead.
 */
import { adminClient, json } from "../_shared/supabase.ts";
import {
  type AlertRule,
  type DriverGoal,
  type DriverProfile,
  type Load,
  matchesRule,
  PROFILE_DEFAULTS,
} from "../_shared/profit-calc.ts";

const LOAD_WINDOW = 200;

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabase = adminClient();

  const [{ data: rules, error: rulesErr }, { data: loads, error: loadsErr }] = await Promise.all([
    supabase.from("alert_rules").select("id, driver_id, rule_type, params").eq("active", true),
    supabase.from("loads").select("*").order("created_at", { ascending: false }).limit(LOAD_WINDOW),
  ]);
  if (rulesErr) return json({ error: rulesErr.message }, 500);
  if (loadsErr) return json({ error: loadsErr.message }, 500);
  if (!rules?.length || !loads?.length) return json({ rules: rules?.length ?? 0, loads: loads?.length ?? 0, hits: 0 });

  // One profile + active goal lookup per driver, not per rule.
  const driverIds = [...new Set(rules.map((r) => r.driver_id as string))];
  const [{ data: profiles }, { data: goals }] = await Promise.all([
    supabase.from("driver_profiles").select("*").in("id", driverIds),
    supabase.from("driver_goals").select("driver_id, weekly_net_goal, days_available").eq("active", true).in("driver_id", driverIds),
  ]);
  const profileById = new Map<string, DriverProfile>();
  for (const p of profiles ?? []) profileById.set(p.id, { ...PROFILE_DEFAULTS, ...p });
  const goalById = new Map<string, DriverGoal>();
  for (const g of goals ?? []) goalById.set(g.driver_id, g);

  const fuelPrice = Number(Deno.env.get("FUEL_PRICE_DIESEL")) || undefined;

  // ---- evaluate -------------------------------------------------------
  const candidates: Array<{ alert_rule_id: string; driver_id: string; load_id: string }> = [];
  for (const rule of rules as Array<AlertRule & { id: string; driver_id: string }>) {
    const profile = profileById.get(rule.driver_id);
    if (!profile) continue;
    const ctx = { profile, goal: goalById.get(rule.driver_id) ?? null, fuelPrice };
    for (const load of loads as Array<Load & { id: string }>) {
      if (matchesRule(rule, load, ctx)) {
        candidates.push({ alert_rule_id: rule.id, driver_id: rule.driver_id, load_id: load.id });
      }
    }
  }
  if (candidates.length === 0) return json({ rules: rules.length, loads: loads.length, hits: 0 });

  // ---- record ---------------------------------------------------------
  // unique (alert_rule_id, load_id) + ignoreDuplicates means only genuinely
  // new hits come back, so a load never re-alerts on the next sweep.
  const { data: inserted, error: insertErr } = await supabase
    .from("alert_hits")
    .upsert(candidates, { onConflict: "alert_rule_id,load_id", ignoreDuplicates: true })
    .select("id, driver_id, load_id, alert_rule_id");
  if (insertErr) return json({ error: insertErr.message }, 500);

  // ---- notify ---------------------------------------------------------
  // Realtime covers the app-open case automatically (alert_hits is in the
  // supabase_realtime publication). App-closed needs APNs/FCM: wire it here.
  await Promise.all((inserted ?? []).map((hit) => sendPush(hit.driver_id, hit.load_id)));

  return json({ rules: rules.length, loads: loads.length, candidates: candidates.length, hits: inserted?.length ?? 0 });
});

async function sendPush(driverId: string, loadId: string): Promise<void> {
  // TODO(phase 2): look up the driver's device tokens and call APNs/FCM.
  console.log(`push: driver=${driverId} load=${loadId}`);
  await Promise.resolve();
}

/**
 * ai-dispatcher  (Phase 3)
 *
 * Takes a driver's freeform request ("get me home by Friday with $2,500 net"),
 * their profile, active goal, and the available loads, and returns a
 * recommended plan as structured JSON.
 *
 *   POST /functions/v1/ai-dispatcher
 *   Authorization: Bearer <driver session JWT>
 *   { "request": string, "load_ids"?: string[], "max_loads"?: number }
 *
 * The Anthropic key never leaves this function. Every dollar figure in the
 * response is recomputed here with _shared/profit-calc.ts after the model
 * picks the loads, so the numbers the driver sees are the dashboard's numbers,
 * not the model's arithmetic.
 */
import Anthropic from "npm:@anthropic-ai/sdk@0.123.0";
import { betaZodOutputFormat } from "npm:@anthropic-ai/sdk@0.123.0/helpers/beta/zod";
import { z } from "npm:zod@4";
import { adminClient, callerUserId, corsHeaders, json } from "../_shared/supabase.ts";
import {
  type DriverGoal,
  type DriverProfile,
  type Load,
  matchScore,
  PROFILE_DEFAULTS,
  summarizePlan,
} from "../_shared/profit-calc.ts";

const MODEL = "claude-opus-5";
const DEFAULT_MAX_LOADS = 60;

const PlanSchema = z.object({
  summary: z.string().describe("Two or three sentences the driver can read on a phone."),
  plan: z.array(
    z.object({
      load_id: z.string(),
      order: z.number().int().describe("1-based position in the route."),
      reason: z.string(),
    }),
  ).describe("Ordered loads to take. Empty if nothing fits the request."),
  warnings: z.array(z.string()).describe("Anything the driver should know: tight timing, deadhead, budget pressure."),
  alternatives: z.array(
    z.object({ load_id: z.string(), why: z.string() }),
  ).describe("Up to three loads worth a second look that did not make the plan."),
});

const SYSTEM = `You are Sectional's dispatcher for independent driveaway drivers.

You receive the driver's profile, their weekly goal, a plain-language request, and a list of
available loads. Each load already carries the economics computed by the app (net, net per day,
net per mile, expenses, deadhead percent, match score, and flags). Trust those numbers; do not
recompute them.

Build the best route that satisfies the request:
- Chain loads so each one starts near where the previous one ends (same or adjacent state) and
  dates are in order. A backhaul (is_backhaul=true) toward the driver's starting location is the
  cheapest way home.
- Never include a load flagged OVER_BUDGET or CDL_REQUIRED.
- A towable load (towable=true) means the driver tows their own car and drives home, so its
  return cost is already zero; a non-towable load's expenses already include the ride home.
- Keep total days within the goal's days_available unless the request says otherwise.
- Prefer higher net per day over higher total pay.
- If nothing fits, say so plainly and return an empty plan with alternatives.

Refer to loads only by their load_id. Write for a driver, not an analyst.`;

interface Body {
  request?: string;
  load_ids?: string[];
  max_loads?: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const request = body.request?.trim();
  if (!request) return json({ error: "request is required" }, 400);

  // ---- gather ---------------------------------------------------------
  const supabase = adminClient();
  const maxLoads = Math.min(Math.max(body.max_loads ?? DEFAULT_MAX_LOADS, 1), 150);

  let loadsQuery = supabase.from("loads").select("*").order("load_date", { ascending: true, nullsFirst: false }).limit(maxLoads);
  if (body.load_ids?.length) loadsQuery = loadsQuery.in("id", body.load_ids);
  else loadsQuery = loadsQuery.or(`load_date.gte.${new Date().toISOString().slice(0, 10)},load_date.is.null`);

  const [{ data: profileRow, error: profileErr }, { data: goalRow }, { data: loadRows, error: loadsErr }] =
    await Promise.all([
      supabase.from("driver_profiles").select("*").eq("id", userId).maybeSingle(),
      supabase.from("driver_goals").select("weekly_net_goal, days_available").eq("driver_id", userId).eq("active", true).maybeSingle(),
      loadsQuery,
    ]);
  if (profileErr) return json({ error: profileErr.message }, 500);
  if (loadsErr) return json({ error: loadsErr.message }, 500);

  const profile: DriverProfile = { ...PROFILE_DEFAULTS, ...(profileRow ?? {}) };
  const goal: DriverGoal | null = goalRow ?? null;
  const loads = (loadRows ?? []) as Array<Load & { id: string }>;
  if (loads.length === 0) return json({ error: "no loads available" }, 404);

  const fuelPrice = Number(Deno.env.get("FUEL_PRICE_DIESEL")) || undefined;
  const scored = loads.map((load) => {
    const m = matchScore(load, profile, { fuelPrice });
    return {
      load_id: load.id,
      route: `${load.origin_city}, ${load.origin_state} -> ${load.dest_city}, ${load.dest_state}`,
      load_date: load.load_date ?? null,
      miles: load.miles,
      deadhead_miles: load.deadhead_miles ?? 0,
      est_days: load.est_days,
      pay: load.pay,
      is_backhaul: load.is_backhaul ?? false,
      towable: load.towable ?? null,
      cdl_required: load.cdl_required ?? null,
      net: m.economics.net,
      net_per_day: m.economics.netPerDay,
      net_per_mile: m.economics.netPerMile,
      expenses: m.economics.totalExpenses,
      deadhead_pct: m.economics.deadheadPct,
      match_score: m.score,
      flags: m.flags,
    };
  });

  const context = {
    driver: {
      starting_location: profile.starting_location ?? null,
      cdl_class: profile.cdl_class ?? null,
      towable: profile.towable ?? true,
      min_net_per_day: profile.min_net_per_day,
      min_net_per_load: profile.min_net_per_load,
      max_expense_per_load: profile.max_expense_per_load,
      max_weekly_expense: profile.max_weekly_expense,
      preferred_miles: [profile.preferred_min_miles, profile.preferred_max_miles],
    },
    goal,
    today: new Date().toISOString().slice(0, 10),
    loads: scored,
  };

  // ---- ask Claude -----------------------------------------------------
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

  let message;
  try {
    message = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Driver request: ${request}\n\nContext (JSON):\n${JSON.stringify(context)}`,
        },
      ],
      output_format: betaZodOutputFormat(PlanSchema),
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error("anthropic", err.status, err.message);
      return json({ error: "dispatcher unavailable" }, 502);
    }
    throw err;
  }

  if (message.stop_reason === "refusal") {
    return json({ error: "The dispatcher could not process that request. Try rewording it." }, 422);
  }
  const plan = message.parsed_output;
  if (!plan) return json({ error: "dispatcher returned an unreadable plan" }, 502);

  // ---- verify with the real math --------------------------------------
  const byId = new Map(loads.map((l) => [l.id, l]));
  const ordered = [...plan.plan].sort((a, b) => a.order - b.order);
  const chosen = ordered.map((p) => byId.get(p.load_id)).filter((l): l is Load & { id: string } => !!l);
  const dropped = ordered.filter((p) => !byId.has(p.load_id)).map((p) => p.load_id);
  const summary = summarizePlan(chosen, profile, goal, { fuelPrice });

  return json({
    summary: plan.summary,
    plan: ordered.filter((p) => byId.has(p.load_id)),
    warnings: [
      ...plan.warnings,
      ...(summary.overWeeklyBudget ? ["Projected expenses exceed your weekly expense cap."] : []),
      ...(summary.meetsGoal === false ? ["This plan does not reach your weekly net goal."] : []),
      ...(dropped.length ? [`Ignored unknown load ids: ${dropped.join(", ")}`] : []),
    ],
    alternatives: plan.alternatives.filter((a) => byId.has(a.load_id)),
    projected_net: summary.projectedNet,
    projected_expenses: summary.projectedExpenses,
    days_used: summary.daysUsed,
    meets_goal: summary.meetsGoal,
    loads: summary.loads.map(({ load, economics }) => ({ load_id: load.id, ...economics })),
    model: message.model,
  });
});

/**
 * Sectional — shared profit / match-score math.
 *
 * Single source of truth for fuel, hotel, food, return-transport, net profit,
 * per-day / per-mile figures, match score, and alert-rule matching. Imported by
 * the browser bundle AND by the run-alerts / ai-dispatcher Edge Functions so an
 * alert can never fire for a load the dashboard itself flags OVER BUDGET.
 *
 * Dependency-free, plain TypeScript: runs in Deno, Node, and the browser.
 *
 * NOTE: the client-side calculator this was written to mirror was not available
 * when this file was created, so the formulas below are the straightforward
 * reading of the profile fields in the schema. Reconcile against the existing
 * client math before Phase 2 (see README "Reconciling profit-calc.ts").
 */

export type FuelType = "diesel" | "unleaded";

/** Mirrors public.driver_profiles (snake_case to match the DB row). */
export interface DriverProfile {
  id?: string;
  starting_location?: string | null;
  cdl_class?: string | null;
  towable?: boolean | null;
  mpg: number;
  fuel_type: FuelType;
  hotel_budget: number;
  food_budget: number;
  transport_budget: number;
  max_expense_per_load: number;
  max_weekly_expense: number;
  min_net_per_day: number;
  min_net_per_load: number;
  min_net_per_mile: number;
  max_deadhead_pct: number;
  preferred_min_miles: number;
  preferred_max_miles: number;
}

/** Mirrors public.loads (only the fields the math needs). */
export interface Load {
  id?: string;
  origin_city: string;
  origin_state: string;
  dest_city: string;
  dest_state: string;
  load_date?: string | null;
  miles: number;
  deadhead_miles?: number | null;
  towable?: boolean | null;
  cdl_required?: boolean | null;
  pay: number;
  est_days: number;
  return_cost_estimate?: number | null;
  is_backhaul?: boolean | null;
}

/** Mirrors public.driver_goals. */
export interface DriverGoal {
  weekly_net_goal: number;
  days_available: number;
}

export interface CalcOptions {
  /** $/gallon. Defaults to DEFAULT_FUEL_PRICE[profile.fuel_type]. */
  fuelPrice?: number;
}

/** Fallback pump prices when the caller has no live fuel price. */
export const DEFAULT_FUEL_PRICE: Record<FuelType, number> = {
  diesel: 3.85,
  unleaded: 3.3,
};

export const PROFILE_DEFAULTS: DriverProfile = {
  towable: true,
  mpg: 9.5,
  fuel_type: "diesel",
  hotel_budget: 95,
  food_budget: 45,
  transport_budget: 200,
  max_expense_per_load: 450,
  max_weekly_expense: 1400,
  min_net_per_day: 750,
  min_net_per_load: 400,
  min_net_per_mile: 0.75,
  max_deadhead_pct: 15,
  preferred_min_miles: 250,
  preferred_max_miles: 900,
};

export interface LoadEconomics {
  fuelCost: number;
  hotelCost: number;
  foodCost: number;
  returnCost: number;
  totalExpenses: number;
  net: number;
  netPerDay: number;
  netPerMile: number;
  payPerMile: number;
  deadheadPct: number;
  /** Total miles including deadhead. */
  drivenMiles: number;
  overBudget: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Fuel, hotel, food, return transport, and net for one load against one profile. */
export function calcLoad(
  load: Load,
  profile: DriverProfile,
  opts: CalcOptions = {},
): LoadEconomics {
  const deadhead = load.deadhead_miles ?? 0;
  const drivenMiles = load.miles + deadhead;
  const fuelPrice = opts.fuelPrice ?? DEFAULT_FUEL_PRICE[profile.fuel_type];
  const mpg = profile.mpg > 0 ? profile.mpg : PROFILE_DEFAULTS.mpg;

  const fuelCost = (drivenMiles / mpg) * fuelPrice;

  // Nights on the road = whole days minus the last one you drive home / to the next load.
  const days = Math.max(load.est_days, 0);
  const hotelNights = Math.max(0, Math.ceil(days) - 1);
  const hotelCost = hotelNights * profile.hotel_budget;
  const foodCost = Math.ceil(days) * profile.food_budget;

  // Getting back. A backhaul covers it. A towable load means the driver tows
  // their own car behind the delivered vehicle and simply drives home, so a
  // towing driver pays nothing. Otherwise use the load's own estimate, falling
  // back to the driver's standing transport budget.
  const towsHome = load.towable === true && profile.towable !== false;
  const returnCost = load.is_backhaul || towsHome
    ? 0
    : (load.return_cost_estimate ?? 0) > 0
      ? (load.return_cost_estimate as number)
      : profile.transport_budget;

  const totalExpenses = fuelCost + hotelCost + foodCost + returnCost;
  const net = load.pay - totalExpenses;

  return {
    fuelCost: round2(fuelCost),
    hotelCost: round2(hotelCost),
    foodCost: round2(foodCost),
    returnCost: round2(returnCost),
    totalExpenses: round2(totalExpenses),
    net: round2(net),
    netPerDay: round2(days > 0 ? net / days : net),
    netPerMile: round2(load.miles > 0 ? net / load.miles : 0),
    payPerMile: round2(load.miles > 0 ? load.pay / load.miles : 0),
    deadheadPct: round2(load.miles > 0 ? (deadhead / load.miles) * 100 : 0),
    drivenMiles,
    overBudget: totalExpenses > profile.max_expense_per_load,
  };
}

export type MatchFlag =
  | "OVER_BUDGET"
  | "LOW_NET_PER_DAY"
  | "LOW_NET_PER_LOAD"
  | "LOW_NET_PER_MILE"
  | "HIGH_DEADHEAD"
  | "OUTSIDE_PREFERRED_MILES"
  | "CDL_REQUIRED";

export interface MatchResult {
  /** 0-100. */
  score: number;
  flags: MatchFlag[];
  economics: LoadEconomics;
}

/**
 * Weighted 0-100 match score. A CDL the driver does not hold is a hard fail
 * and zeroes the score; everything else deducts its weight when missed.
 */
export function matchScore(
  load: Load,
  profile: DriverProfile,
  opts: CalcOptions = {},
): MatchResult {
  const e = calcLoad(load, profile, opts);
  const flags: MatchFlag[] = [];

  const checks: Array<[MatchFlag, boolean, number]> = [
    ["OVER_BUDGET", !e.overBudget, 25],
    ["LOW_NET_PER_DAY", e.netPerDay >= profile.min_net_per_day, 20],
    ["LOW_NET_PER_LOAD", e.net >= profile.min_net_per_load, 20],
    ["LOW_NET_PER_MILE", e.netPerMile >= profile.min_net_per_mile, 15],
    ["HIGH_DEADHEAD", e.deadheadPct <= profile.max_deadhead_pct, 10],
    [
      "OUTSIDE_PREFERRED_MILES",
      load.miles >= profile.preferred_min_miles && load.miles <= profile.preferred_max_miles,
      10,
    ],
  ];

  let score = 100;
  for (const [flag, ok, weight] of checks) {
    if (!ok) {
      flags.push(flag);
      score -= weight;
    }
  }

  // Hard fail: the driver cannot legally drive the vehicle.
  if (load.cdl_required === true && !profile.cdl_class) {
    flags.push("CDL_REQUIRED");
    score = 0;
  }

  return { score: Math.max(0, score), flags, economics: e };
}

/* ---------------------------------------------------------------------- */
/* Alert rules                                                              */
/* ---------------------------------------------------------------------- */

export type AlertRuleType =
  | "pay_per_mile"
  | "net_per_day"
  | "origin_radius"
  | "backhaul_available"
  | "goal_completable";

export interface AlertRule {
  id?: string;
  driver_id?: string;
  rule_type: AlertRuleType;
  params: Record<string, unknown>;
}

export interface RuleContext {
  profile: DriverProfile;
  /** The driver's active goal, if any (needed by goal_completable). */
  goal?: DriverGoal | null;
  fuelPrice?: number;
}

const num = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim().toUpperCase()) : [];

/**
 * Does `load` satisfy `rule` for this driver? Uses the same calcLoad() as the
 * dashboard so the two can never disagree.
 *
 * params by rule_type:
 *   pay_per_mile        { min_pay_per_mile: number }
 *   net_per_day         { min_net_per_day?: number }           (defaults to profile.min_net_per_day)
 *   origin_radius       { states?: string[], cities?: string[] } (Phase 2: swap for lat/lng + radius_miles)
 *   backhaul_available  { dest_states?: string[] }             (defaults to the state in profile.starting_location)
 *   goal_completable    {}                                      (uses the active driver_goal)
 *
 * Every rule also requires the load to clear the driver's OVER BUDGET line and
 * not be a CDL hard fail, so a hit is always something the driver could take.
 */
export function matchesRule(rule: AlertRule, load: Load, ctx: RuleContext): boolean {
  const { profile } = ctx;
  const m = matchScore(load, profile, { fuelPrice: ctx.fuelPrice });
  if (m.score === 0 || m.economics.overBudget) return false;
  const e = m.economics;
  const p = rule.params ?? {};

  switch (rule.rule_type) {
    case "pay_per_mile":
      return e.payPerMile >= num(p.min_pay_per_mile, Infinity);

    case "net_per_day":
      return e.netPerDay >= num(p.min_net_per_day, profile.min_net_per_day);

    case "origin_radius": {
      const states = strList(p.states);
      const cities = strList(p.cities);
      if (states.length === 0 && cities.length === 0) return false;
      const stateOk = states.length === 0 || states.includes(load.origin_state.trim().toUpperCase());
      const cityOk = cities.length === 0 || cities.includes(load.origin_city.trim().toUpperCase());
      return stateOk && cityOk;
    }

    case "backhaul_available": {
      if (!load.is_backhaul) return false;
      const wanted = strList(p.dest_states);
      const home = stateFromLocation(profile.starting_location);
      const targets = wanted.length ? wanted : home ? [home] : [];
      return targets.length === 0 || targets.includes(load.dest_state.trim().toUpperCase());
    }

    case "goal_completable": {
      const goal = ctx.goal;
      if (!goal || goal.days_available <= 0) return false;
      const requiredPerDay = goal.weekly_net_goal / goal.days_available;
      return load.est_days <= goal.days_available && e.netPerDay >= requiredPerDay;
    }

    default:
      return false;
  }
}

/** "Kansas City, MO" -> "MO". Returns null when no 2-letter state is present. */
export function stateFromLocation(location?: string | null): string | null {
  if (!location) return null;
  const match = location.trim().match(/\b([A-Za-z]{2})\s*$/);
  return match ? match[1].toUpperCase() : null;
}

/* ---------------------------------------------------------------------- */
/* Plans (multi-load, 1-7 day)                                              */
/* ---------------------------------------------------------------------- */

export interface PlanSummary {
  loads: Array<{ load: Load; economics: LoadEconomics }>;
  projectedNet: number;
  projectedExpenses: number;
  daysUsed: number;
  /** Against profile.max_weekly_expense. */
  overWeeklyBudget: boolean;
  /** Against the goal, when one is supplied. */
  meetsGoal: boolean | null;
}

/** Sum a set of loads into the numbers saved_plans stores. */
export function summarizePlan(
  loads: Load[],
  profile: DriverProfile,
  goal?: DriverGoal | null,
  opts: CalcOptions = {},
): PlanSummary {
  const rows = loads.map((load) => ({ load, economics: calcLoad(load, profile, opts) }));
  const projectedNet = round2(rows.reduce((s, r) => s + r.economics.net, 0));
  const projectedExpenses = round2(rows.reduce((s, r) => s + r.economics.totalExpenses, 0));
  const daysUsed = round2(rows.reduce((s, r) => s + r.load.est_days, 0));
  return {
    loads: rows,
    projectedNet,
    projectedExpenses,
    daysUsed,
    overWeeklyBudget: projectedExpenses > profile.max_weekly_expense,
    meetsGoal: goal ? projectedNet >= goal.weekly_net_goal && daysUsed <= goal.days_available : null,
  };
}

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
  /** Estimated tolls, $ per driven mile (IFTA/permits/parking can be folded in here). */
  toll_per_mile: number;
  /** Any other fixed cost the driver attaches to every load. */
  other_per_load: number;
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
  /** Number of profitable loads picking up near this load's destination (next-load opportunity). */
  nextLoads?: number;
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
  toll_per_mile: 0.03,
  other_per_load: 0,
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
  tollCost: number;
  otherCost: number;
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

  const tollCost = drivenMiles * (profile.toll_per_mile ?? 0);
  const otherCost = profile.other_per_load ?? 0;
  const totalExpenses = fuelCost + hotelCost + foodCost + tollCost + otherCost + returnCost;
  const net = load.pay - totalExpenses;

  return {
    fuelCost: round2(fuelCost),
    hotelCost: round2(hotelCost),
    foodCost: round2(foodCost),
    tollCost: round2(tollCost),
    otherCost: round2(otherCost),
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

/** Ed's classification buckets. */
export type LoadTier = "TOP_PICK" | "GOOD" | "REVIEW" | "OVER_BUDGET" | "LOW_NET";

export interface MatchResult {
  /** Profit Match Score, 0-100. */
  score: number;
  tier: LoadTier;
  flags: MatchFlag[];
  economics: LoadEconomics;
  /** Each weighted factor's contribution, for explaining the score. */
  factors: Record<MatchFactor, number>;
}

export type MatchFactor =
  | "net"
  | "netPerDay"
  | "expenseEfficiency"
  | "payPerMile"
  | "deadhead"
  | "nextLoad"
  | "returnTransport";

/** Weights from the product brief (sum to 100). */
export const MATCH_WEIGHTS: Record<MatchFactor, number> = {
  net: 30,
  netPerDay: 25,
  expenseEfficiency: 15,
  payPerMile: 10,
  deadhead: 10,
  nextLoad: 5,
  returnTransport: 5,
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Profit Match Score: how well a load fits THIS driver's financial objective,
 * not merely how much it pays. Each factor scores 0-1 against the driver's own
 * thresholds, then takes its weight. A CDL the driver does not hold zeroes the
 * score; an over-budget load is capped so it can never read as a pick.
 */
export function matchScore(
  load: Load,
  profile: DriverProfile,
  opts: CalcOptions = {},
): MatchResult {
  const e = calcLoad(load, profile, opts);
  const flags: MatchFlag[] = [];

  if (e.overBudget) flags.push("OVER_BUDGET");
  if (e.netPerDay < profile.min_net_per_day) flags.push("LOW_NET_PER_DAY");
  if (e.net < profile.min_net_per_load) flags.push("LOW_NET_PER_LOAD");
  if (e.netPerMile < profile.min_net_per_mile) flags.push("LOW_NET_PER_MILE");
  if (e.deadheadPct > profile.max_deadhead_pct) flags.push("HIGH_DEADHEAD");
  if (load.miles < profile.preferred_min_miles || load.miles > profile.preferred_max_miles) flags.push("OUTSIDE_PREFERRED_MILES");

  // 0-1 per factor. "Full marks" sit comfortably above the driver's minimums so
  // a load that merely scrapes the bar does not read as a top pick.
  const raw: Record<MatchFactor, number> = {
    net: clamp01(e.net / (profile.min_net_per_load * 2.5)),
    netPerDay: clamp01(e.netPerDay / (profile.min_net_per_day * 1.5)),
    // Margin: what share of the pay the driver keeps. Zero once the load blows the per-load cap.
    expenseEfficiency: e.overBudget || load.pay <= 0 ? 0 : clamp01(1 - e.totalExpenses / load.pay),
    payPerMile: clamp01((e.payPerMile - 1.5) / 1.75),
    deadhead: clamp01(1 - e.deadheadPct / Math.max(profile.max_deadhead_pct, 1)),
    nextLoad: clamp01((opts.nextLoads ?? 0) / 3),
    returnTransport: e.returnCost === 0 ? 1 : clamp01(1 - e.returnCost / (profile.transport_budget * 2)),
  };
  const factors = Object.fromEntries(
    (Object.keys(MATCH_WEIGHTS) as MatchFactor[]).map((k) => [k, round2(raw[k] * MATCH_WEIGHTS[k])]),
  ) as Record<MatchFactor, number>;

  let score = Math.round(Object.values(factors).reduce((a, b) => a + b, 0));
  if (e.overBudget) score = Math.min(score, 35);
  if (load.cdl_required === true && !profile.cdl_class) {
    flags.push("CDL_REQUIRED");
    score = 0;
  }

  const tier: LoadTier = score === 0 || e.overBudget
    ? "OVER_BUDGET"
    : e.net < profile.min_net_per_load
      ? "LOW_NET"
      : score >= 85
        ? "TOP_PICK"
        : score >= 65
          ? "GOOD"
          : "REVIEW";

  return { score, tier, flags, economics: e, factors };
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
  grossPay: number;
  totalMiles: number;
  deadheadMiles: number;
  deadheadPct: number;
  projectedNet: number;
  projectedExpenses: number;
  daysUsed: number;
  netPerDay: number;
  netPerMile: number;
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
  const grossPay = round2(rows.reduce((s, r) => s + r.load.pay, 0));
  const totalMiles = rows.reduce((s, r) => s + r.load.miles, 0);
  const deadheadMiles = rows.reduce((s, r) => s + (r.load.deadhead_miles ?? 0), 0);
  const projectedNet = round2(rows.reduce((s, r) => s + r.economics.net, 0));
  const projectedExpenses = round2(rows.reduce((s, r) => s + r.economics.totalExpenses, 0));
  const daysUsed = round2(rows.reduce((s, r) => s + r.load.est_days, 0));
  return {
    loads: rows,
    grossPay,
    totalMiles,
    deadheadMiles,
    deadheadPct: round2(totalMiles > 0 ? (deadheadMiles / totalMiles) * 100 : 0),
    projectedNet,
    projectedExpenses,
    daysUsed,
    netPerDay: round2(daysUsed > 0 ? projectedNet / daysUsed : 0),
    netPerMile: round2(totalMiles > 0 ? projectedNet / totalMiles : 0),
    overWeeklyBudget: projectedExpenses > profile.max_weekly_expense,
    meetsGoal: goal ? projectedNet >= goal.weekly_net_goal && daysUsed <= goal.days_available : null,
  };
}

/* ---------------------------------------------------------------------- */
/* Route chains, 1-7 day planner, strategies                               */
/* ---------------------------------------------------------------------- */

export interface ChainOptions {
  /** Two-letter state the driver starts from (and ideally returns to). */
  homeState: string;
  /** Hard cap on total est_days. */
  maxDays: number;
  /** Max loads in one chain. Default 4. */
  maxLoads?: number;
  /** Candidates kept per hop, by net/day. Default 6. */
  beam?: number;
  fuelPrice?: number;
}

export interface Chain {
  loads: Load[];
  summary: PlanSummary;
  endsHome: boolean;
}

const addDays = (iso: string, days: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Enumerate multi-load chains from home: each load picks up in the state the
 * previous one delivered to, on or after the day that delivery finishes.
 * Over-budget and CDL-fail loads are never chained (the optimizer respects the
 * driver's limits). Returns every chain explored, shortest first.
 */
export function searchChains(loads: Load[], profile: DriverProfile, opts: ChainOptions): Chain[] {
  const beam = opts.beam ?? 6;
  const maxLoads = opts.maxLoads ?? 4;
  const calc = new Map<Load, LoadEconomics>();
  const usable = loads.filter((l) => {
    const m = matchScore(l, profile, { fuelPrice: opts.fuelPrice });
    if (m.score === 0 || m.economics.overBudget) return false;
    calc.set(l, m.economics);
    return true;
  });
  const out: Chain[] = [];
  const walk = (at: string, earliest: string | null, chain: Load[], days: number) => {
    if (chain.length >= maxLoads) return;
    const cands = usable
      .filter((l) => l.origin_state.toUpperCase() === at && !chain.includes(l) && days + l.est_days <= opts.maxDays &&
        (!earliest || !l.load_date || l.load_date >= earliest))
      .sort((a, b) => calc.get(b)!.netPerDay - calc.get(a)!.netPerDay)
      .slice(0, beam);
    for (const next of cands) {
      const nextChain = [...chain, next];
      const summary = summarizePlan(nextChain, profile, null, { fuelPrice: opts.fuelPrice });
      const dest = next.dest_state.toUpperCase();
      out.push({ loads: nextChain, summary, endsHome: dest === opts.homeState.toUpperCase() });
      walk(dest, next.load_date ? addDays(next.load_date, Math.ceil(next.est_days)) : earliest, nextChain, days + next.est_days);
    }
  };
  walk(opts.homeState.toUpperCase(), null, [], 0);
  return out;
}

export interface DayOption {
  days: number;
  requiredPerDay: number;
  best: Chain | null;
  projectedNet: number;
  status: "met" | "short" | "none";
  recommended: boolean;
}

/**
 * The 1-7 Day Profit Planner: for each number of days out, the best chain
 * that fits and whether it clears the weekly goal. "Recommended" is the
 * fewest days that meet the goal.
 */
export function dayPlanner(chains: Chain[], goal: DriverGoal): DayOption[] {
  const rows: DayOption[] = [];
  for (let n = 1; n <= 7; n++) {
    const fits = chains.filter((c) => c.summary.daysUsed <= n);
    const best = fits.length ? fits.reduce((a, b) => (b.summary.projectedNet > a.summary.projectedNet ? b : a)) : null;
    const projectedNet = best?.summary.projectedNet ?? 0;
    rows.push({
      days: n,
      requiredPerDay: round2(goal.weekly_net_goal / n),
      best,
      projectedNet,
      status: !best ? "none" : projectedNet >= goal.weekly_net_goal ? "met" : "short",
      recommended: false,
    });
  }
  const first = rows.find((r) => r.status === "met");
  if (first) first.recommended = true;
  return rows;
}

export type StrategyKey = "max_net" | "lowest_cost" | "best_balance";
export interface Strategy { key: StrategyKey; label: string; why: string; chain: Chain | null }

/** Option A / B / C from the brief, chosen from chains that fit the goal's days. */
export function strategies(chains: Chain[], profile: DriverProfile, goal: DriverGoal): Strategy[] {
  const fits = chains.filter((c) => c.summary.daysUsed <= goal.days_available);
  const byNet = [...fits].sort((a, b) => b.summary.projectedNet - a.summary.projectedNet);
  const maxNet = byNet[0] ?? null;

  const reaching = fits.filter((c) => c.summary.projectedNet >= goal.weekly_net_goal);
  const lowestCost = (reaching.length ? reaching : byNet.slice(0, 10))
    .reduce<Chain | null>((a, b) => (!a || b.summary.projectedExpenses < a.summary.projectedExpenses ? b : a), null);

  const topNet = maxNet?.summary.projectedNet || 1;
  const topNpd = Math.max(...fits.map((c) => c.summary.netPerDay), 1);
  const maxExp = Math.max(...fits.map((c) => c.summary.projectedExpenses), 1);
  const balance = (c: Chain) =>
    0.35 * (c.summary.projectedNet / topNet) +
    0.25 * (c.summary.netPerDay / topNpd) +
    0.15 * (1 - c.summary.projectedExpenses / maxExp) +
    0.1 * clamp01(1 - c.summary.deadheadPct / 30) +
    0.15 * (c.endsHome ? 1 : 0);
  const bestBalance = fits.reduce<Chain | null>((a, b) => (!a || balance(b) > balance(a) ? b : a), null);

  return [
    { key: "max_net", label: "Maximum net", why: `Highest projected net within ${goal.days_available} days.`, chain: maxNet },
    { key: "lowest_cost", label: "Lowest cost", why: reaching.length ? `Cheapest week that still clears ${"$" + goal.weekly_net_goal.toLocaleString("en-US")}.` : "Nothing clears the goal; this is the cheapest of the strongest weeks.", chain: lowestCost },
    { key: "best_balance", label: "Best balance", why: "Profit, expenses, deadhead, days, and getting home, weighed together.", chain: bestBalance },
  ];
}

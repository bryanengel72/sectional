// deno test supabase/functions/_shared/profit-calc.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { calcLoad, dayPlanner, matchScore, matchesRule, PROFILE_DEFAULTS, searchChains, stateFromLocation, strategies, summarizePlan } from "./profit-calc.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;
const profile = { ...PROFILE_DEFAULTS, starting_location: "Kansas City, MO", cdl_class: "A", toll_per_mile: 0 };
const kcToDallas = {
  origin_city: "Kansas City", origin_state: "MO", dest_city: "Dallas", dest_state: "TX",
  miles: 555, deadhead_miles: 40, pay: 1450, est_days: 1.5, towable: true, cdl_required: true,
};

Deno.test("calcLoad adds fuel, hotel, food, and return transport", () => {
  const e = calcLoad({ ...kcToDallas, towable: false }, profile, { fuelPrice: 4 });
  assertEquals(e.fuelCost, 250.53);   // 595 / 9.5 * 4
  assertEquals(e.hotelCost, 95);      // ceil(1.5) - 1 = 1 night
  assertEquals(e.foodCost, 90);       // 2 days * 45
  assertEquals(e.returnCost, 200);    // not towable, no backhaul, no estimate -> transport_budget
  assertEquals(e.totalExpenses, 635.53);
  assertEquals(e.net, 814.47);
  assert(e.overBudget);               // 635 > 450
});

Deno.test("backhaul zeroes the return cost", () => {
  const e = calcLoad({ ...kcToDallas, towable: false, is_backhaul: true }, profile, { fuelPrice: 4 });
  assertEquals(e.returnCost, 0);
});

Deno.test("towable load + towing driver: drives home, no return cost", () => {
  assertEquals(calcLoad(kcToDallas, profile, { fuelPrice: 4 }).returnCost, 0);
  assertEquals(calcLoad(kcToDallas, { ...profile, towable: false }, { fuelPrice: 4 }).returnCost, 200);
  assertEquals(calcLoad({ ...kcToDallas, towable: false, return_cost_estimate: 140 }, profile, { fuelPrice: 4 }).returnCost, 140);
});

Deno.test("tolls and other costs are expense lines", () => {
  const e = calcLoad(kcToDallas, { ...profile, toll_per_mile: 0.05, other_per_load: 25 }, { fuelPrice: 4 });
  assertEquals(e.tollCost, 29.75);   // 595 driven miles * 0.05
  assertEquals(e.otherCost, 25);
  assertEquals(e.totalExpenses, 250.53 + 95 + 90 + 29.75 + 25);
});

Deno.test("CDL mismatch zeroes the score; towing mismatch only costs money", () => {
  const m = matchScore({ ...kcToDallas, cdl_required: true }, { ...profile, cdl_class: null });
  assertEquals(m.score, 0);
  assertEquals(m.tier, "OVER_BUDGET");
  assert(matchScore(kcToDallas, { ...profile, towable: false }).score > 0);
});

Deno.test("Profit Match Score follows the brief's weights and tiers", () => {
  const m = matchScore(kcToDallas, profile, { fuelPrice: 4, nextLoads: 3 });
  const sum = Object.values(m.factors).reduce((a, b) => a + b, 0);
  assertEquals(m.score, Math.round(sum));
  assertEquals(m.factors.nextLoad, 5);
  assertEquals(m.factors.returnTransport, 5);      // tows home
  assertEquals(m.tier, "GOOD");                    // $676/day against a $750 bar: good, not top
  const strong = matchScore({ ...kcToDallas, pay: 1900 }, profile, { fuelPrice: 4, nextLoads: 3 });
  assert(strong.score >= 85, `expected a top pick, got ${strong.score}`);
  assertEquals(strong.tier, "TOP_PICK");
  const over = matchScore({ ...kcToDallas, towable: false }, profile, { fuelPrice: 4 });
  assertEquals(over.tier, "OVER_BUDGET");
  assert(over.score <= 35);
  const weak = matchScore({ ...kcToDallas, pay: 700 }, profile, { fuelPrice: 4 });
  assertEquals(weak.tier, "LOW_NET");
});

Deno.test("chains connect state to state and respect the day cap", () => {
  const board = [
    { ...kcToDallas, id: "a", load_date: "2026-09-03" },
    { ...kcToDallas, id: "b", origin_city: "Dallas", origin_state: "TX", dest_city: "Kansas City", dest_state: "MO", load_date: "2026-09-05", is_backhaul: true },
    { ...kcToDallas, id: "c", origin_city: "Dallas", origin_state: "TX", dest_city: "Kansas City", dest_state: "MO", load_date: "2026-09-04" }, // too early: a ends 09-05
  ];
  const chains = searchChains(board, { ...profile, max_expense_per_load: 900 }, { homeState: "MO", maxDays: 4, fuelPrice: 4 });
  const keys = chains.map((c) => c.loads.map((l) => (l as { id: string }).id).join(">"));
  assert(keys.includes("a"));
  assert(keys.includes("a>b"));
  assert(!keys.includes("a>c"));
  assert(chains.find((c) => keys[chains.indexOf(c)] === "a>b")!.endsHome);
  const capped = searchChains(board, { ...profile, max_expense_per_load: 900 }, { homeState: "MO", maxDays: 2, fuelPrice: 4 });
  assertEquals(capped.map((c) => c.loads.length).sort().join(","), "1");
});

Deno.test("day planner recommends the fewest days that meet the goal", () => {
  const board = [
    { ...kcToDallas, load_date: "2026-09-03" },
    { ...kcToDallas, origin_city: "Dallas", origin_state: "TX", dest_city: "Kansas City", dest_state: "MO", load_date: "2026-09-05", is_backhaul: true },
  ];
  const chains = searchChains(board, profile, { homeState: "MO", maxDays: 7, fuelPrice: 4 });
  const plan = dayPlanner(chains, { weekly_net_goal: 1500, days_available: 5 });
  assertEquals(plan.length, 7);
  assertEquals(plan[0].requiredPerDay, 1500);
  assertEquals(plan[0].status, "none");            // a 1.5-day load doesn't fit in 1 day
  assertEquals(plan[1].status, "short");           // one load: $1,014 < $1,500
  assertEquals(plan.find((p) => p.recommended)!.days, 3);
  const s = strategies(chains, profile, { weekly_net_goal: 1500, days_available: 5 });
  assertEquals(s.map((x) => x.key), ["max_net", "lowest_cost", "best_balance"]);
  assert(s[0].chain!.summary.projectedNet >= s[1].chain!.summary.projectedNet);
});

Deno.test("alerts never fire for an over-budget load", () => {
  const rule = { rule_type: "pay_per_mile" as const, params: { min_pay_per_mile: 1 } };
  const flyHome = { ...kcToDallas, towable: false };   // 635.53 expenses > 450 cap
  assertEquals(matchesRule(rule, flyHome, { profile, fuelPrice: 4 }), false);
  assertEquals(matchesRule(rule, flyHome, { profile: { ...profile, max_expense_per_load: 900 }, fuelPrice: 4 }), true);
});

Deno.test("goal_completable uses the active goal", () => {
  const ctx = { profile: { ...profile, max_expense_per_load: 900 }, goal: { weekly_net_goal: 2500, days_available: 5 }, fuelPrice: 4 };
  assertEquals(matchesRule({ rule_type: "goal_completable", params: {} }, kcToDallas, ctx), true);   // 543/day >= 500
  assertEquals(matchesRule({ rule_type: "goal_completable", params: {} }, kcToDallas, { ...ctx, goal: null }), false);
});

Deno.test("stateFromLocation", () => {
  assertEquals(stateFromLocation("Kansas City, MO"), "MO");
  assertEquals(stateFromLocation("Denver"), null);
});

Deno.test("summarizePlan totals", () => {
  const s = summarizePlan([kcToDallas, { ...kcToDallas, is_backhaul: true }], profile, { weekly_net_goal: 1500, days_available: 4 }, { fuelPrice: 4 });
  assertEquals(s.daysUsed, 3);
  assertEquals(s.projectedNet, 1014.47 * 2);      // both tow home: no return cost
  assertEquals(s.grossPay, 2900);
  assertEquals(s.netPerDay, round2(2028.94 / 3));
  assertEquals(s.meetsGoal, true);
});

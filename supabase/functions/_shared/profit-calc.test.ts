// deno test supabase/functions/_shared/profit-calc.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { calcLoad, matchScore, matchesRule, PROFILE_DEFAULTS, stateFromLocation, summarizePlan } from "./profit-calc.ts";

const profile = { ...PROFILE_DEFAULTS, starting_location: "Kansas City, MO", cdl_class: "A" };
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

Deno.test("CDL mismatch zeroes the score; towing mismatch only costs money", () => {
  assertEquals(matchScore({ ...kcToDallas, cdl_required: true }, { ...profile, cdl_class: null }).score, 0);
  assert(matchScore(kcToDallas, { ...profile, towable: false }).score > 0);
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
  assertEquals(s.meetsGoal, true);
});

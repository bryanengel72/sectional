/**
 * Sectional demo dataset generator.
 *
 *   deno run --allow-write generate.ts
 *
 * Emits, from ONE deterministic source of truth:
 *   ../supabase/seed.sql          full demo DB: 3 drivers, ~75 loads, goals, rules, plans, hits, subscriptions
 *   loads.json                    the same loads, for a client demo with no backend
 *   drivers.json                  profiles + goals + alert rules + saved plans
 *   terminal-board.csv            a "partner feed" export to demo import-loads
 *
 * Alert hits and saved-plan totals are computed with the real profit-calc
 * module, so what the seed shows is exactly what the app would compute.
 */
import {
  type AlertRule,
  type DriverProfile,
  type Load,
  matchesRule,
  matchScore,
  PROFILE_DEFAULTS,
  searchChains,
  strategies,
} from "../supabase/functions/_shared/profit-calc.ts";

// ---------------------------------------------------------------- rng ----
let seed = 20260901;
const rand = () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a: number, b: number) => a + rand() * (b - a);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;
const r2 = (n: number) => Math.round(n * 100) / 100;
const uuid = () => {
  const h = () => Math.floor(rand() * 16).toString(16);
  const s = Array.from({ length: 32 }, h);
  s[12] = "4"; s[16] = pick(["8", "9", "a", "b"]);
  return `${s.slice(0, 8).join("")}-${s.slice(8, 12).join("")}-${s.slice(12, 16).join("")}-${s.slice(16, 20).join("")}-${s.slice(20).join("")}`;
};

// -------------------------------------------------------------- cities ----
const CITIES = {
  "Kansas City": ["MO", 39.10, -94.58], "Dallas": ["TX", 32.78, -96.80], "Denver": ["CO", 39.74, -104.99],
  "Chicago": ["IL", 41.88, -87.63], "Atlanta": ["GA", 33.75, -84.39], "Nashville": ["TN", 36.16, -86.78],
  "Indianapolis": ["IN", 39.77, -86.16], "Oklahoma City": ["OK", 35.47, -97.52], "St. Louis": ["MO", 38.63, -90.20],
  "Memphis": ["TN", 35.15, -90.05], "Phoenix": ["AZ", 33.45, -112.07], "Salt Lake City": ["UT", 40.76, -111.89],
  "Columbus": ["OH", 39.96, -83.00], "Houston": ["TX", 29.76, -95.37], "Minneapolis": ["MN", 44.98, -93.27],
  "Omaha": ["NE", 41.26, -95.94], "Little Rock": ["AR", 34.75, -92.29], "Albuquerque": ["NM", 35.08, -106.65],
  "Louisville": ["KY", 38.25, -85.76], "Des Moines": ["IA", 41.59, -93.62], "San Antonio": ["TX", 29.42, -98.49],
  "Charlotte": ["NC", 35.23, -80.84], "Cincinnati": ["OH", 39.10, -84.51], "Tulsa": ["OK", 36.15, -95.99],
} as const;
type City = keyof typeof CITIES;
const TERMINALS: City[] = ["Kansas City", "Dallas", "Denver", "Chicago", "Indianapolis", "Oklahoma City", "Atlanta", "St. Louis", "Houston", "Memphis"];
const HOMES: City[] = ["Atlanta", "Dallas", "Denver"];

function roadMiles(a: City, b: City): number {
  const [, la1, lo1] = CITIES[a]; const [, la2, lo2] = CITIES[b];
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(la2 - la1), dLon = toRad(lo2 - lo1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLon / 2) ** 2;
  const great = 3958.8 * 2 * Math.asin(Math.sqrt(h));
  return Math.round(great * 1.19);
}

// ------------------------------------------------------------ vehicles ----
const VEHICLES = [
  { name: "2024 Freightliner Cascadia", cdl: "A", customers: ["Penske", "Ryder", "Rush Truck Centers"] },
  { name: "2023 Kenworth T680", cdl: "A", customers: ["Penske", "MHC Kenworth"] },
  { name: "2024 Peterbilt 579", cdl: "A", customers: ["Rush Truck Centers", "Ryder"] },
  { name: "2023 Volvo VNL 860", cdl: "A", customers: ["Penske", "Ryder"] },
  { name: "2024 International LT", cdl: "A", customers: ["Ryder", "Navistar Fleet"] },
  { name: "2024 Ford F-650 box truck", cdl: "B", customers: ["Enterprise Truck Rental", "U-Haul"] },
  { name: "2023 Isuzu NPR-HD", cdl: "B", customers: ["Enterprise Truck Rental", "Penske"] },
  { name: "2024 Hino L6 box truck", cdl: "B", customers: ["Ryder", "Enterprise Truck Rental"] },
  { name: "2024 Ford Transit 350 cargo", cdl: null, customers: ["Amazon DSP", "Enterprise Truck Rental"] },
  { name: "2024 Mercedes Sprinter 2500", cdl: null, customers: ["Amazon DSP", "Hertz"] },
  { name: "2023 Ram ProMaster 3500", cdl: null, customers: ["U-Haul", "Enterprise Truck Rental"] },
  { name: "2024 Winnebago View 24D", cdl: null, customers: ["Camping World", "La Mesa RV"] },
  { name: "2023 Thor Four Winds 28A", cdl: null, customers: ["Camping World", "General RV"] },
  { name: "2024 Ford F-350 service body", cdl: null, customers: ["Sunbelt Rentals", "Enterprise Truck Rental"] },
] as const;

// -------------------------------------------------------------- loads ----
interface DemoLoad extends Load {
  id: string;
  source: "csv" | "manual";
  order_number: string;
  status: "available" | "pending" | "assigned";
  terminal: string;
  day_offset: number;
  raw_payload: Record<string, unknown>;
}

const today = new Date(); today.setUTCHours(0, 0, 0, 0);
const iso = (offset: number) => new Date(today.getTime() + offset * 86400000).toISOString().slice(0, 10);

const loads: DemoLoad[] = [];
let seq = 417;
for (let i = 0; i < 78; i++) {
  const origin = pick(TERMINALS);
  let dest: City = origin;
  // A third of loads run toward one of the demo drivers' home cities so
  // backhauls and out-and-back chains exist.
  while (dest === origin || roadMiles(origin, dest) < 150 || roadMiles(origin, dest) > 1350) {
    dest = chance(0.35) ? pick(HOMES) : pick(Object.keys(CITIES) as City[]);
  }
  const miles = roadMiles(origin, dest);
  const v = pick(VEHICLES);
  const cdlRequired = v.cdl !== null;
  const towable = v.cdl === "A" ? chance(0.85) : v.cdl === "B" ? chance(0.6) : chance(0.35);
  const headingHome = HOMES.includes(dest) && !HOMES.includes(origin);
  const isBackhaul = headingHome ? chance(0.6) : HOMES.includes(dest) ? chance(0.25) : false;

  // Pay: ~$2.35/mi base, CDL-A premium, long hauls slightly leaner, some duds.
  let ppm = 2.35 + between(-0.45, 0.7) + (v.cdl === "A" ? 0.25 : 0) - (miles > 900 ? 0.2 : 0);
  if (chance(0.1)) ppm = between(1.35, 1.7);          // deliberately bad loads so flags show
  if (isBackhaul) ppm -= 0.3;                           // backhauls pay less, but no return cost
  const pay = Math.round((miles * ppm) / 5) * 5;

  const estDays = Math.max(1, Math.round((miles / 480) * 2) / 2);
  const deadhead = chance(0.15) ? Math.round(between(80, 160)) : Math.round(between(0, 55));
  const returnCost = towable ? 0 : chance(0.6) ? Math.round(between(90, 330)) : 0;
  const dayOffset = Math.floor(between(0, 14));
  const status = chance(0.84) ? "available" : chance(0.7) ? "pending" : "assigned";
  const source = chance(0.72) ? "csv" : "manual";
  const unit = `${pick(["PNK", "RYD", "ENT", "UHL", "RSH", "CWD", "AMZ"])}-${Math.floor(between(10000, 99999))}`;

  loads.push({
    id: uuid(),
    source,
    order_number: `DA-${seq++}`,
    status,
    cdl_required: cdlRequired,
    terminal: `${origin} Terminal`,
    origin_city: origin, origin_state: CITIES[origin][0],
    dest_city: dest, dest_state: CITIES[dest][0],
    load_date: iso(dayOffset), day_offset: dayOffset,
    miles, deadhead_miles: deadhead, towable,
    pay, est_days: estDays,
    return_cost_estimate: returnCost,
    is_backhaul: isBackhaul,
    raw_payload: {
      vehicle: v.name, unit, customer: pick(v.customers),
      cdl_class: v.cdl, pickup_window: pick(["07:00-10:00", "08:00-12:00", "10:00-14:00", "13:00-17:00"]),
      notes: pick(["", "", "", "Keys at guard shack", "Call dispatch 30 min out", "Fuel card provided", "No weekend delivery", "DOT inspection on file"]),
    },
  });
}
// The brief's own worked example (section 6): Atlanta -> Dallas -> Chicago -> Atlanta,
// priced so the chain lands near its projected ~$3,300 net in four days.
const featured: Array<[City, City, number, number, number, number, string, string]> = [
  // origin, dest, miles, deadhead, pay, est_days, vehicle, customer
  ["Atlanta", "Dallas", 780, 20, 1650, 1.5, "2024 Freightliner Cascadia", "Penske"],
  ["Dallas", "Chicago", 925, 30, 1900, 1.5, "2024 Peterbilt 579", "Rush Truck Centers"],
  ["Chicago", "Atlanta", 715, 15, 1250, 1, "2023 Volvo VNL 860", "Ryder"],
];
featured.forEach(([origin, dest, miles, dh, pay, days, vehicle, customer], i) => {
  loads.push({
    id: uuid(), source: "manual", order_number: `DA-${1001 + i}`, status: "available", cdl_required: true,
    terminal: `${origin} Terminal`, origin_city: origin, origin_state: CITIES[origin][0], dest_city: dest, dest_state: CITIES[dest][0],
    load_date: iso(1 + i * 2), day_offset: 1 + i * 2, miles, deadhead_miles: dh, towable: true, pay, est_days: days,
    return_cost_estimate: 0, is_backhaul: dest === "Atlanta",
    raw_payload: { vehicle, unit: `PNK-${41000 + i}`, customer, cdl_class: "A", pickup_window: "07:00-10:00", notes: i === 2 ? "Fuel card provided" : "" },
  });
});

loads.sort((a, b) => a.day_offset - b.day_offset || a.origin_city.localeCompare(b.origin_city));

// ------------------------------------------------------------ drivers ----
interface DemoDriver {
  id: string; email: string; password: string;
  profile: DriverProfile & { display_name: string; starting_location: string; cdl_class: string | null; towable: boolean };
  goal: { id: string; weekly_net_goal: number; days_available: number };
  rules: Array<AlertRule & { id: string }>;
  subscription: { plan: "driver" | "driver_pro" | "fleet"; status: string; days_left: number } | null;
}

const drivers: DemoDriver[] = [
  {
    id: "11111111-1111-4111-8111-111111111111", email: "edward@sectional.demo", password: "sectional-demo",
    profile: { ...PROFILE_DEFAULTS, display_name: "Edward Senter", starting_location: "Atlanta, GA", cdl_class: "A", towable: true,
      mpg: 9.5, fuel_type: "diesel", hotel_budget: 95, food_budget: 45, transport_budget: 200, max_expense_per_load: 650,
      max_weekly_expense: 1400, min_net_per_day: 750, min_net_per_load: 400, min_net_per_mile: 0.75, max_deadhead_pct: 15,
      preferred_min_miles: 250, preferred_max_miles: 900 },
    goal: { id: uuid(), weekly_net_goal: 3000, days_available: 4 },   // the worked example from the brief
    rules: [
      { id: uuid(), rule_type: "pay_per_mile", params: { min_pay_per_mile: 2.75 } },
      { id: uuid(), rule_type: "backhaul_available", params: {} },
      { id: uuid(), rule_type: "goal_completable", params: {} },
    ],
    subscription: { plan: "driver_pro", status: "active", days_left: 19 },
  },
  {
    id: "22222222-2222-4222-8222-222222222222", email: "dee@sectional.demo", password: "sectional-demo",
    profile: { ...PROFILE_DEFAULTS, display_name: "Dee Alvarado", starting_location: "Dallas, TX", cdl_class: null, towable: true,
      mpg: 14, fuel_type: "unleaded", hotel_budget: 80, food_budget: 35, transport_budget: 160, max_expense_per_load: 450,
      max_weekly_expense: 1100, min_net_per_day: 500, min_net_per_load: 300, min_net_per_mile: 0.6, max_deadhead_pct: 20,
      preferred_min_miles: 200, preferred_max_miles: 700 },
    goal: { id: uuid(), weekly_net_goal: 2200, days_available: 4 },
    rules: [
      { id: uuid(), rule_type: "origin_radius", params: { states: ["TX", "OK"] } },
      { id: uuid(), rule_type: "net_per_day", params: { min_net_per_day: 600 } },
    ],
    subscription: { plan: "driver", status: "trialing", days_left: 9 },
  },
  {
    id: "33333333-3333-4333-8333-333333333333", email: "rob@sectional.demo", password: "sectional-demo",
    profile: { ...PROFILE_DEFAULTS, display_name: "Rob Okafor", starting_location: "Denver, CO", cdl_class: "B", towable: false,
      mpg: 11, fuel_type: "diesel", hotel_budget: 110, food_budget: 50, transport_budget: 260, max_expense_per_load: 750,
      max_weekly_expense: 1800, min_net_per_day: 650, min_net_per_load: 450, min_net_per_mile: 0.7, max_deadhead_pct: 12,
      preferred_min_miles: 400, preferred_max_miles: 1100 },
    goal: { id: uuid(), weekly_net_goal: 2800, days_available: 6 },
    rules: [
      { id: uuid(), rule_type: "net_per_day", params: {} },
      { id: uuid(), rule_type: "backhaul_available", params: { dest_states: ["CO", "UT"] } },
    ],
    subscription: null,
  },
];

// --------------------------------------------------------- alert hits ----
interface Hit { id: string; alert_rule_id: string; driver_id: string; load_id: string; minutes_ago: number; seen: boolean }
const hits: Hit[] = [];
for (const d of drivers) {
  const ctx = { profile: d.profile, goal: d.goal };
  for (const rule of d.rules) {
    for (const load of loads) {
      if (load.status !== "available") continue;
      if (matchesRule(rule, load, ctx)) {
        hits.push({ id: uuid(), alert_rule_id: rule.id, driver_id: d.id, load_id: load.id, minutes_ago: Math.floor(between(5, 2880)), seen: chance(0.4) });
      }
    }
  }
}

// -------------------------------------------------------- saved plans ----
interface Plan { id: string; driver_id: string; name: string; load_ids: string[]; projected_net: number; projected_expenses: number; days_used: number }
const plans: Plan[] = [];
// Saved plans come straight from the shared strategy engine, so the seed shows
// exactly what the app's Strategies panel would propose.
for (const d of drivers) {
  const chains = searchChains(loads.filter((l) => l.status === "available"), d.profile, { homeState: d.profile.starting_location.slice(-2), maxDays: 7 });
  const seen = new Set<string>();
  for (const s of strategies(chains, d.profile, d.goal)) {
    if (!s.chain) continue;
    const ids = s.chain.loads.map((l) => (l as DemoLoad).id);
    if (seen.has(ids.join())) continue;
    seen.add(ids.join());
    const sm = s.chain.summary;
    plans.push({ id: uuid(), driver_id: d.id, name: s.label, load_ids: ids, projected_net: sm.projectedNet, projected_expenses: sm.projectedExpenses, days_used: sm.daysUsed });
  }
}

// --------------------------------------------------------------- emit ----
const q = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `array[${v.map(q).join(",")}]::uuid[]`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

let sql = `-- Sectional demo seed. GENERATED by sample-data/generate.ts — edit that, not this.
-- Applied by \`supabase db reset\`. Safe to re-run (truncates demo rows first).
--
-- Demo logins (password for all: sectional-demo)
${drivers.map((d) => `--   ${d.email.padEnd(26)} ${d.profile.display_name.padEnd(14)} ${d.profile.starting_location}`).join("\n")}

begin;

-- Wipe previous demo rows so the seed is idempotent.
delete from public.loads where source in ('csv','manual') and order_number like 'DA-%';
delete from auth.users where email like '%@sectional.demo';

-- ---------------------------------------------------------------- users --
-- Inserting into auth.users directly is the standard local-dev pattern; the
-- on_auth_user_created trigger builds the driver_profiles row for us.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change, email_change_token_new)
values
${drivers.map((d) => `  (${q(d.id)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${q(d.email)},
   extensions.crypt(${q(d.password)}, extensions.gen_salt('bf')), now() - interval '40 days',
   '{"provider":"email","providers":["email"]}'::jsonb, ${q({ display_name: d.profile.display_name })}, now() - interval '40 days', now(), '', '', '', '')`).join(",\n")};

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
values
${drivers.map((d) => `  (${q(uuid())}, ${q(d.id)}, ${q(d.id)}, 'email', ${q({ sub: d.id, email: d.email, email_verified: true })}, now() - interval '1 day', now() - interval '40 days', now())`).join(",\n")};

-- ------------------------------------------------------------- profiles --
${drivers.map((d) => {
  const p = d.profile;
  return `update public.driver_profiles set
  display_name=${q(p.display_name)}, starting_location=${q(p.starting_location)}, cdl_class=${q(p.cdl_class)}, towable=${p.towable},
  mpg=${p.mpg}, fuel_type=${q(p.fuel_type)}, hotel_budget=${p.hotel_budget}, food_budget=${p.food_budget}, transport_budget=${p.transport_budget},
  toll_per_mile=${p.toll_per_mile}, other_per_load=${p.other_per_load},
  max_expense_per_load=${p.max_expense_per_load}, max_weekly_expense=${p.max_weekly_expense}, min_net_per_day=${p.min_net_per_day},
  min_net_per_load=${p.min_net_per_load}, min_net_per_mile=${p.min_net_per_mile}, max_deadhead_pct=${p.max_deadhead_pct},
  preferred_min_miles=${p.preferred_min_miles}, preferred_max_miles=${p.preferred_max_miles}
where id=${q(d.id)};`;
}).join("\n")}

-- ---------------------------------------------------------------- goals --
insert into public.driver_goals (id, driver_id, weekly_net_goal, days_available, active) values
${drivers.map((d) => `  (${q(d.goal.id)}, ${q(d.id)}, ${d.goal.weekly_net_goal}, ${d.goal.days_available}, true)`).join(",\n")};

-- ---------------------------------------------------------------- loads --
insert into public.loads (id, source, order_number, status, cdl_required, terminal, origin_city, origin_state, dest_city, dest_state,
  load_date, miles, deadhead_miles, towable, pay, est_days, return_cost_estimate, is_backhaul, raw_payload, imported_by, created_at) values
${loads.map((l) => `  (${q(l.id)}, ${q(l.source)}, ${q(l.order_number)}, ${q(l.status)}, ${l.cdl_required}, ${q(l.terminal)}, ${q(l.origin_city)}, ${q(l.origin_state)}, ${q(l.dest_city)}, ${q(l.dest_state)}, current_date + ${l.day_offset}, ${l.miles}, ${l.deadhead_miles}, ${l.towable}, ${l.pay}, ${l.est_days}, ${l.return_cost_estimate}, ${l.is_backhaul}, ${q(l.raw_payload)}, ${q(drivers[0].id)}, now() - interval '${Math.floor(between(1, 72))} hours')`).join(",\n")};

-- ---------------------------------------------------------- alert rules --
insert into public.alert_rules (id, driver_id, rule_type, params, active) values
${drivers.flatMap((d) => d.rules.map((r) => `  (${q(r.id)}, ${q(d.id)}, ${q(r.rule_type)}, ${q(r.params)}, true)`)).join(",\n")};

-- ----------------------------------------------------------- alert hits --
-- Computed with profit-calc.matchesRule(), the same code run-alerts uses.
insert into public.alert_hits (id, alert_rule_id, driver_id, load_id, matched_at, seen) values
${hits.map((h) => `  (${q(h.id)}, ${q(h.alert_rule_id)}, ${q(h.driver_id)}, ${q(h.load_id)}, now() - interval '${h.minutes_ago} minutes', ${h.seen})`).join(",\n")};

-- ---------------------------------------------------------- saved plans --
insert into public.saved_plans (id, driver_id, name, load_ids, projected_net, projected_expenses, days_used) values
${plans.map((p) => `  (${q(p.id)}, ${q(p.driver_id)}, ${q(p.name)}, ${q(p.load_ids)}, ${p.projected_net}, ${p.projected_expenses}, ${p.days_used})`).join(",\n")};

-- -------------------------------------------------------- subscriptions --
insert into public.subscriptions (driver_id, plan, stripe_customer_id, stripe_subscription_id, status, current_period_end) values
${drivers.filter((d) => d.subscription).map((d) => `  (${q(d.id)}, ${q(d.subscription!.plan)}, 'cus_demo_${d.profile.display_name.split(" ")[0].toLowerCase()}', 'sub_demo_${d.profile.display_name.split(" ")[0].toLowerCase()}', ${q(d.subscription!.status)}, now() + interval '${d.subscription!.days_left} days')`).join(",\n")};

commit;
`;

await Deno.writeTextFile("../supabase/seed.sql", sql);

const loadsJson = loads;
await Deno.writeTextFile("loads.json", JSON.stringify(loadsJson, null, 2) + "\n");

await Deno.writeTextFile("drivers.json", JSON.stringify(drivers.map((d) => ({
  id: d.id, email: d.email, password: d.password, profile: d.profile, goal: d.goal, alert_rules: d.rules,
  saved_plans: plans.filter((p) => p.driver_id === d.id),
  alert_hits: hits.filter((h) => h.driver_id === d.id).map(({ minutes_ago, ...h }) => ({ ...h, matched_at: new Date(Date.now() - minutes_ago * 60000).toISOString() })),
  subscription: d.subscription,
})), null, 2) + "\n");

// CSV in a plausible "partner terminal board" layout: different header names
// than our schema on purpose, so the import-loads alias mapping is exercised.
const csvRows = loads.filter((l) => l.source === "csv").map((l) => [
  l.order_number, l.status.toUpperCase(), l.raw_payload.vehicle, l.raw_payload.customer, l.raw_payload.cdl_class ?? "NONE",
  l.terminal, l.origin_city, l.origin_state, l.dest_city, l.dest_state, iso(l.day_offset),
  l.miles, l.deadhead_miles, l.towable ? "Y" : "N", `$${l.pay.toLocaleString("en-US")}`, l.est_days, l.return_cost_estimate || "", l.is_backhaul ? "Y" : "N", l.raw_payload.notes,
]);
const csvHeader = ["Order #", "Status", "Vehicle", "Customer", "CDL", "Terminal", "Pickup City", "Pickup State", "Delivery City", "Delivery State", "Pickup Date", "Loaded Miles", "DH", "Tow", "Rate", "Days", "Return Cost", "Backhaul", "Notes"];
const csvEscape = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
await Deno.writeTextFile("terminal-board.csv", [csvHeader, ...csvRows].map((r) => r.map(csvEscape).join(",")).join("\n") + "\n");

// ------------------------------------------------------------ summary ----
console.log(`loads: ${loads.length} (${loads.filter((l) => l.status === "available").length} available, ${loads.filter((l) => l.is_backhaul).length} backhauls, ${loads.filter((l) => l.source === "csv").length} in CSV)`);
for (const d of drivers) {
  const scores = loads.filter((l) => l.status === "available").map((l) => matchScore(l, d.profile));
  const tiers = scores.reduce<Record<string, number>>((acc, s) => ((acc[s.tier] = (acc[s.tier] ?? 0) + 1), acc), {});
  console.log(`${d.profile.display_name.padEnd(14)} hits=${hits.filter((h) => h.driver_id === d.id).length}  plans=${plans.filter((p) => p.driver_id === d.id).length}  ${JSON.stringify(tiers)}`);
  for (const p of plans.filter((p) => p.driver_id === d.id)) console.log(`   ${p.name}: ${p.load_ids.length} loads, net $${p.projected_net}, ${p.days_used} days`);
}

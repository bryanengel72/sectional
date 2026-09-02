import loadsData from "../../sample-data/loads.json";
import driversData from "../../sample-data/drivers.json";
import {
  type AlertRule, type AlertRuleType, calcLoad, type Chain, dayPlanner, DEFAULT_FUEL_PRICE, type DriverGoal,
  type DriverProfile, type Load, type LoadEconomics, type LoadTier, MATCH_WEIGHTS, type MatchFactor, type MatchFlag,
  matchesRule, matchScore, type MatchResult, PROFILE_DEFAULTS, searchChains, stateFromLocation, strategies, summarizePlan,
} from "../../supabase/functions/_shared/profit-calc.ts";
import { normalize } from "../../supabase/functions/import-loads/normalize.ts";
import { parseCsv } from "./csv.ts";

/* ------------------------------------------------------------------ types */
interface BoardLoad extends Load {
  id: string; source: string; order_number: string | null; status: string; terminal: string | null;
  load_date: string | null; raw_payload: Record<string, unknown>; imported?: boolean;
}
interface Hit { id: string; alert_rule_id: string; load_id: string; matched_at: string; seen: boolean }
interface SavedPlan { id: string; name: string; load_ids: string[]; projected_net: number; projected_expenses: number; days_used: number }
interface Driver {
  id: string; email: string; profile: Partial<DriverProfile> & { display_name: string; starting_location: string };
  goal: DriverGoal; alert_rules: Array<AlertRule & { id: string }>; saved_plans: SavedPlan[]; alert_hits: Hit[];
  subscription: { plan: string; status: string } | null;
}
type Profile = DriverProfile & { display_name: string; starting_location: string };

const DRIVERS = driversData as unknown as Driver[];

/* ------------------------------------------------------------------ state */
const state = {
  driverIdx: 0,
  loads: (loadsData as unknown as BoardLoad[]).map((l) => ({ ...l })),
  profile: { ...PROFILE_DEFAULTS, ...DRIVERS[0].profile } as Profile,
  goal: { ...DRIVERS[0].goal },
  hits: [] as Hit[],
  savedPlans: [] as SavedPlan[],
  fuelPrice: undefined as number | undefined,
  plan: [] as string[],
  planLabel: "" as string,
  expanded: null as string | null,
  tab: "plan" as "plan" | "alerts" | "settings",
  filters: { minScore: 0, tier: "all" as "all" | "picks", backhaulOnly: false, availableOnly: true, sort: "score" as "score" | "date" | "net" | "netPerDay" | "pay" },
};

/* ---------------------------------------------------------------- helpers */
const $ = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement;
const money = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
const money2 = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtDate = (iso: string | null | undefined) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "—";
const ago = (iso: string) => { const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const opts = () => ({ fuelPrice: state.fuelPrice });
const loadById = (id: string) => state.loads.find((l) => l.id === id);
const homeState = () => stateFromLocation(state.profile.starting_location) ?? "";
const addDays = (iso: string, d: number) => { const x = new Date(iso + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };

const FLAG_LABEL: Record<MatchFlag, string> = {
  OVER_BUDGET: "Over budget", LOW_NET_PER_DAY: "Low net/day", LOW_NET_PER_LOAD: "Low net", LOW_NET_PER_MILE: "Low net/mi",
  HIGH_DEADHEAD: "Deadhead", OUTSIDE_PREFERRED_MILES: "Off-range miles", CDL_REQUIRED: "CDL needed",
};
const tierOf = (m: MatchResult) => m.flags.includes("CDL_REQUIRED") ? { label: "CDL needed", cls: "low" } : TIER[m.tier];
const TIER: Record<LoadTier, { label: string; cls: string }> = {
  TOP_PICK: { label: "Top pick", cls: "top" }, GOOD: { label: "Good", cls: "good" }, REVIEW: { label: "Review", cls: "review" },
  OVER_BUDGET: { label: "Over budget", cls: "over" }, LOW_NET: { label: "Low net", cls: "low" },
};
const FACTOR_LABEL: Record<MatchFactor, string> = {
  net: "Projected net", netPerDay: "Net per day", expenseEfficiency: "Expense efficiency", payPerMile: "Pay per mile",
  deadhead: "Deadhead", nextLoad: "Next-load opportunity", returnTransport: "Return transportation",
};
function ruleLabel(r: AlertRule): string {
  const p = r.params as Record<string, unknown>;
  switch (r.rule_type as AlertRuleType) {
    case "pay_per_mile": return `Pay ≥ $${Number(p.min_pay_per_mile).toFixed(2)}/mi`;
    case "net_per_day": return `Net ≥ ${money(Number(p.min_net_per_day ?? state.profile.min_net_per_day))}/day`;
    case "origin_radius": return `Pickup in ${(p.states as string[] ?? []).join(", ") || "your area"}`;
    case "backhaul_available": return `Backhaul toward ${(p.dest_states as string[] ?? []).join("/") || "home"}`;
    case "goal_completable": return "Clears your weekly goal";
  }
}

/* --------------------------------------------------------------- analysis */
interface Analysis {
  scored: Map<string, MatchResult>;
  nextLoads: (load: BoardLoad) => BoardLoad[];
  chains: Chain[];
  planner: ReturnType<typeof dayPlanner>;
  strats: ReturnType<typeof strategies>;
}
function analyze(): Analysis {
  const avail = state.loads.filter((l) => l.status === "available");
  // Next-load opportunity: profitable pickups in the delivery state after delivery.
  const usable = new Set(avail.filter((l) => { const m = matchScore(l, state.profile, opts()); return m.score > 0 && !m.economics.overBudget; }));
  const nextLoads = (load: BoardLoad) => {
    const after = load.load_date ? addDays(load.load_date, Math.ceil(load.est_days)) : null;
    return avail
      .filter((l) => l !== load && usable.has(l) && l.origin_state === load.dest_state && (!after || !l.load_date || l.load_date >= after))
      .sort((a, b) => calcLoad(b, state.profile, opts()).netPerDay - calcLoad(a, state.profile, opts()).netPerDay);
  };
  const scored = new Map(state.loads.map((l) => [l.id, matchScore(l, state.profile, { ...opts(), nextLoads: nextLoads(l).length })]));
  const chains = searchChains(avail, state.profile, { homeState: homeState(), maxDays: 7, beam: 8, fuelPrice: state.fuelPrice });
  return { scored, nextLoads, chains, planner: dayPlanner(chains, state.goal), strats: strategies(chains, state.profile, state.goal) };
}

function switchDriver(i: number) {
  const d = DRIVERS[i];
  state.driverIdx = i;
  state.profile = { ...PROFILE_DEFAULTS, ...d.profile } as Profile;
  state.goal = { ...d.goal };
  state.hits = d.alert_hits.map((h) => ({ ...h }));
  state.savedPlans = d.saved_plans.map((p) => ({ ...p }));
  state.expanded = null;
  // Open on the balanced strategy so the dashboard always has a projection.
  const best = strategies(searchChains(state.loads.filter((l) => l.status === "available"), state.profile, { homeState: homeState(), maxDays: 7 }), state.profile, state.goal)
    .find((s) => s.key === "best_balance")?.chain;
  usePlan(best ? best.loads.map((l) => (l as BoardLoad).id) : [], best ? "Best balance" : "");
}
function usePlan(ids: string[], label: string) {
  state.plan = ids.filter((id) => loadById(id));
  state.planLabel = label;
}
switchDriver(0);

/* ----------------------------------------------------------------- render */
function render() {
  const d = DRIVERS[state.driverIdx];
  const profile = state.profile;
  const a = analyze();
  const f = state.filters;

  let rows = state.loads.map((load) => ({ load, m: a.scored.get(load.id)! })).filter(({ load, m }) =>
    (!f.availableOnly || load.status === "available") &&
    m.score >= f.minScore &&
    (f.tier !== "picks" || m.tier === "TOP_PICK" || m.tier === "GOOD") &&
    (!f.backhaulOnly || load.is_backhaul));
  rows.sort((x, y) => {
    switch (f.sort) {
      case "date": return (x.load.load_date ?? "").localeCompare(y.load.load_date ?? "");
      case "net": return y.m.economics.net - x.m.economics.net;
      case "netPerDay": return y.m.economics.netPerDay - x.m.economics.netPerDay;
      case "pay": return y.load.pay - x.load.pay;
      default: return y.m.score - x.m.score || y.m.economics.netPerDay - x.m.economics.netPerDay;
    }
  });
  const picks = state.loads.filter((l) => l.status === "available").map((load) => ({ load, m: a.scored.get(load.id)! }))
    .filter(({ m }) => m.tier === "TOP_PICK" || m.tier === "GOOD").sort((x, y) => y.m.score - x.m.score).slice(0, 5);

  const planLoads = state.plan.map(loadById).filter((l): l is BoardLoad => !!l);
  const plan = summarizePlan(planLoads, profile, state.goal, opts());
  const unseen = state.hits.filter((h) => !h.seen).length;
  const terminals = new Set(state.loads.map((l) => l.origin_city)).size;
  const requiredPerDay = state.goal.weekly_net_goal / state.goal.days_available;
  const gap = state.goal.weekly_net_goal - plan.projectedNet;

  $("#app").innerHTML = `
    <div class="shell">
      <header class="masthead">
        <div class="wordmark"><strong>Sectional</strong><span>Driveaway Profit Optimizer</span><em>Analyze. Plan. Drive. Earn more.</em></div>
        <nav class="drivers" aria-label="Demo driver">
          ${DRIVERS.map((dr, i) => `<button class="driver-btn" data-driver="${i}" aria-pressed="${i === state.driverIdx}">${esc(dr.profile.display_name)}<small>${esc(dr.profile.starting_location)}</small></button>`).join("")}
        </nav>
      </header>

      <section class="strip" aria-label="Goal status">
        <div class="cell"><span class="lbl">Weekly goal</span><span class="val num">${money(state.goal.weekly_net_goal)}</span></div>
        <div class="cell"><span class="lbl">Days out</span><span class="val num">${state.goal.days_available}</span></div>
        <div class="cell"><span class="lbl">Required net/day</span><span class="val num">${money(requiredPerDay)}</span></div>
        <div class="cell"><span class="lbl">Projected net</span><span class="val num ${plan.projectedNet < 0 ? "neg" : ""}">${planLoads.length ? money(plan.projectedNet) : "—"}</span></div>
        <div class="cell"><span class="lbl">Projected expenses</span><span class="val num ${plan.overWeeklyBudget ? "neg" : ""}">${planLoads.length ? money(plan.projectedExpenses) : "—"}</span></div>
        <div class="cell status ${!planLoads.length ? "" : plan.meetsGoal ? "met" : "short"}"><span class="lbl">Goal status</span><span class="val">${!planLoads.length ? "No plan yet" : plan.meetsGoal ? "Goal met" : `${money(gap)} short`}</span></div>
      </section>

      <div class="top-row">
        <section class="panel planner-panel" aria-label="1 to 7 day profit planner">
          <div class="panel-head"><h2>1–7 day profit planner</h2><span class="sub">Best route from ${esc(profile.starting_location)} for each number of days out. Tap a day to plan it.</span></div>
          ${renderPlanner(a, planLoads, plan)}
        </section>
        <section class="panel strat-panel" aria-label="Strategies">
          <div class="panel-head"><h2>Strategies</h2><span class="sub">${state.goal.days_available} days, ${money(state.goal.weekly_net_goal)} goal</span></div>
          <div class="strats">${renderStrategies(a)}</div>
        </section>
      </div>

      <section class="picks-row" aria-label="Top recommended loads">
        <div class="picks-head"><h2>Top recommended loads</h2><span class="sub">Highest Profit Match Score for ${esc(d.profile.display_name.split(" ")[0])}'s numbers, not the highest pay.</span></div>
        <div class="picks">${picks.length ? picks.map(({ load, m }) => renderPick(load, m)).join("") : `<div class="empty">Nothing on the board clears your bar right now. Loosen a limit in Settings or import more loads.</div>`}</div>
      </section>

      <div class="cols">
        <section class="panel board-panel" aria-label="Loads">
          <div class="panel-head">
            <h2>Load board</h2>
            <span class="sub">${state.loads.length} loads, ${terminals} terminals, next two weeks</span>
            <span class="spacer"></span>
            <label class="btn quiet" for="csv">Import board (CSV)</label>
            <input id="csv" type="file" accept=".csv,text/csv" hidden />
          </div>
          <div class="filters">
            <label>Sort <select id="sort">
              ${[["score", "Match score"], ["netPerDay", "Net per day"], ["net", "Net"], ["pay", "Pay"], ["date", "Pickup date"]].map(([v, t]) => `<option value="${v}" ${f.sort === v ? "selected" : ""}>${t}</option>`).join("")}
            </select></label>
            <button class="chip" data-filter="availableOnly" aria-pressed="${f.availableOnly}">Available only</button>
            <button class="chip" data-tier="picks" aria-pressed="${f.tier === "picks"}">Top picks &amp; good</button>
            <button class="chip" data-filter="backhaulOnly" aria-pressed="${f.backhaulOnly}">Backhauls</button>
            <span class="muted">${rows.length} shown</span>
          </div>
          <div class="table-wrap"><table class="board">
            <thead><tr>
              <th></th><th>Route</th><th class="hide-m">Pickup</th><th class="r">Miles</th><th class="r hide-m">DH</th><th class="r">Pay</th><th class="r">Net</th><th class="r">Net/day</th><th>Match</th>
            </tr></thead>
            <tbody>
              ${rows.length ? rows.map(({ load, m }) => renderRow(load, m, a)).join("") : `<tr><td colspan="9" class="empty">Nothing matches these filters. Loosen the score or turn off a filter.</td></tr>`}
            </tbody>
          </table></div>
        </section>

        <aside class="rail">
          <div class="panel">
            <div class="tabs" role="tablist">
              <button role="tab" data-tab="plan" aria-selected="${state.tab === "plan"}">Plan${state.plan.length ? `<span class="count" style="background:var(--blue)">${state.plan.length}</span>` : ""}</button>
              <button role="tab" data-tab="alerts" aria-selected="${state.tab === "alerts"}">Alerts${unseen ? `<span class="count">${unseen}</span>` : ""}</button>
              <button role="tab" data-tab="settings" aria-selected="${state.tab === "settings"}">Settings</button>
            </div>
            <div class="rail-body">
              ${state.tab === "plan" ? renderPlan(planLoads, plan) : state.tab === "alerts" ? renderAlerts(a) : renderSettings()}
            </div>
          </div>
        </aside>
      </div>
    </div>
    <div class="toasts" id="toasts"></div>`;
}

function renderPlanner(a: Analysis, planLoads: BoardLoad[], plan: ReturnType<typeof summarizePlan>) {
  const span = 7;
  const pct = (d: number) => (d / span) * 100;
  let cursor = 0;
  const segs = plan.loads.map(({ load, economics }) => {
    const left = pct(cursor); const width = pct(load.est_days); cursor += load.est_days;
    const cls = cursor > state.goal.days_available ? "over" : economics.netPerDay < state.profile.min_net_per_day ? "thin" : "";
    return `<div class="seg ${cls}" style="left:${left}%;width:calc(${width}% - 2px)" title="${esc(load.origin_city)} → ${esc(load.dest_city)}: ${money(economics.net)} net over ${load.est_days} days">${esc(load.origin_state)}→${esc(load.dest_state)} <span class="n">${money(economics.net)}</span></div>`;
  }).join("");
  const limit = pct(state.goal.days_available);
  const cols = a.planner.map((row) => {
    const cls = [row.recommended ? "rec" : "", row.days === state.goal.days_available ? "limit" : "", row.status].join(" ");
    const status = row.status === "met" ? "Met" : row.status === "short" ? "Short" : "No route";
    return `<button class="day-col ${cls}" data-day="${row.days}" ${row.best ? "" : "disabled"} aria-label="${row.days} days: ${status}, ${money(row.projectedNet)} projected">
      <span class="plate">${row.recommended ? `<small>EXIT</small>` : ""}${row.days}</span>
      <span class="req"><b class="num">${money(row.requiredPerDay)}</b><small>needed per day</small></span>
      <span class="proj num">${row.best ? money(row.projectedNet) : "—"}</span>
      <span class="st">${row.recommended ? "Recommended" : status}${row.best ? ` · ${row.best.loads.length} load${row.best.loads.length === 1 ? "" : "s"}` : ""}</span>
    </button>`;
  }).join("");
  const rec = a.planner.find((r) => r.recommended);
  const avail = state.goal.days_available;
  const note = !rec
    ? `No route from ${esc(state.profile.starting_location)} reaches ${money(state.goal.weekly_net_goal)} in 7 days within your limits. The best week nets ${money(Math.max(...a.planner.map((r) => r.projectedNet)))}.`
    : rec.days < avail
      ? `You don't need ${avail} days: the optimizer projects <b>${money(rec.projectedNet)}</b> in <b>${rec.days} day${rec.days === 1 ? "" : "s"}</b>, ${avail - rec.days} under your limit.`
      : rec.days === avail
        ? `Your ${avail} days are enough: the optimizer projects <b>${money(rec.projectedNet)}</b> against the ${money(state.goal.weekly_net_goal)} goal.`
        : `Reaching ${money(state.goal.weekly_net_goal)} takes <b>${rec.days} days</b>, ${rec.days - avail} more than your limit. In ${avail} days the best route nets ${money(a.planner[avail - 1].projectedNet)}.`;
  return `
    <div class="highway">
      <div class="road">${planLoads.length ? "" : `<div class="empty">Pick a strategy or a day below to lay out the week.</div>`}</div>
      <div class="lane">${segs}</div>
      <div class="limit-line" style="left:${limit}%" title="${state.goal.days_available} days out"></div>
    </div>
    <div class="days">${cols}</div>
    <div class="planner-note">${note}</div>`;
}

/** Strategies that land on the same route collapse into one card ("A · B"). */
function renderStrategies(a: Analysis) {
  const groups: Array<{ letters: string[]; s: Analysis["strats"][number] }> = [];
  a.strats.forEach((s, i) => {
    const key = s.chain ? s.chain.loads.map((l) => (l as BoardLoad).id).join() : `none-${i}`;
    const g = groups.find((x) => (x.s.chain ? x.s.chain.loads.map((l) => (l as BoardLoad).id).join() : "") === key && s.chain);
    if (g) g.letters.push("ABC"[i]); else groups.push({ letters: ["ABC"[i]], s });
  });
  return groups.map(({ letters, s }) => renderStrategy(
    letters.length > 1 ? { ...s, label: letters.length === 3 ? "All three agree" : `${s.label} + ${letters.map((l) => a.strats["ABC".indexOf(l)].label.toLowerCase()).slice(1).join(", ")}`, why: letters.length === 3 ? "Maximum net, lowest cost, and best balance all land on this route." : s.why } : s,
    letters.join(" · "),
  )).join("");
}

function renderStrategy(s: Analysis["strats"][number], letter: string) {
  const c = s.chain;
  const active = c && c.loads.map((l) => (l as BoardLoad).id).join() === state.plan.join();
  if (!c) return `<div class="strat"><div class="strat-head"><span class="letter">${letter}</span><b>${s.label}</b></div><div class="empty">${esc(s.why)}</div></div>`;
  const sm = c.summary;
  return `<div class="strat ${active ? "active" : ""}">
    <div class="strat-head"><span class="letter">${letter}</span><b>${s.label}</b><span class="num net ${sm.projectedNet >= state.goal.weekly_net_goal ? "pos" : ""}">${money(sm.projectedNet)}</span></div>
    <div class="why">${esc(s.why)}</div>
    <div class="route">${c.loads.map((l) => `${esc(l.origin_state)}`).join(" → ")} → ${esc(c.loads[c.loads.length - 1].dest_state)}${c.endsHome ? "" : ` <span class="tag warn">not home</span>`}</div>
    <div class="strat-nums num"><span>${money(sm.grossPay)} gross</span><span>${money(sm.projectedExpenses)} exp</span><span>${sm.daysUsed}d</span><span>${money(sm.netPerDay)}/day</span></div>
    <button class="btn ${active ? "quiet" : "primary"} small" data-strategy="${s.key}">${active ? "In plan" : "Use this plan"}</button>
  </div>`;
}

function renderPick(load: BoardLoad, m: MatchResult) {
  const e = m.economics; const t = tierOf(m);
  return `<button class="pick" data-open="${load.id}">
    <span class="pick-top"><span class="tier ${t.cls}">${t.label}</span><span class="score num ${m.score === 0 ? "zero" : ""}" style="--w:${m.score}%"><span>${m.score}</span></span></span>
    <span class="pick-route">${esc(load.origin_city)}, ${esc(load.origin_state)} → ${esc(load.dest_city)}, ${esc(load.dest_state)}</span>
    <span class="pick-sub">${fmtDate(load.load_date)} · ${load.miles.toLocaleString()} mi · ${load.est_days}d${load.is_backhaul ? " · backhaul" : ""}</span>
    <span class="pick-nums num"><b>${money(e.net)}</b> net <span class="muted">${money(e.netPerDay)}/day</span></span>
  </button>`;
}

function renderRow(load: BoardLoad, m: MatchResult, a: Analysis) {
  const e = m.economics; const inPlan = state.plan.includes(load.id); const open = state.expanded === load.id;
  const veh = load.raw_payload?.vehicle as string | undefined; const t = tierOf(m);
  const tags = [
    ...(load.is_backhaul ? [`<span class="tag ok">Backhaul</span>`] : []),
    ...(load.status !== "available" ? [`<span class="tag warn">${esc(load.status)}</span>`] : []),
    ...(load.imported ? [`<span class="tag info">Imported</span>`] : []),
    ...m.flags.filter((fl) => fl !== "OVER_BUDGET" && fl !== "LOW_NET_PER_LOAD").map((fl) => `<span class="tag">${FLAG_LABEL[fl]}</span>`),
  ].join("");
  return `
    <tr class="row ${m.score === 0 ? "dim" : ""}" data-load="${load.id}" aria-expanded="${open}">
      <td><button class="plus" data-add="${load.id}" aria-pressed="${inPlan}" aria-label="${inPlan ? "Remove from plan" : "Add to plan"}" ${m.score === 0 ? "disabled" : ""}>${inPlan ? "✓" : "+"}</button></td>
      <td><div class="route">${esc(load.origin_city)}, ${esc(load.origin_state)}<span class="arrow">→</span>${esc(load.dest_city)}, ${esc(load.dest_state)}</div>
          <div class="veh">${esc(veh ?? "")}${load.cdl_required ? " · CDL" : ""}${load.towable ? " · tow" : ""}</div>
          <div class="tags">${tags}</div></td>
      <td class="date hide-m">${fmtDate(load.load_date)}<div class="muted">${load.est_days}d</div></td>
      <td class="r num">${load.miles.toLocaleString()}</td>
      <td class="r num hide-m ${e.deadheadPct > state.profile.max_deadhead_pct ? "neg" : "muted"}">${load.deadhead_miles ?? 0}</td>
      <td class="r num">${money(load.pay)}<div class="muted">$${e.payPerMile.toFixed(2)}/mi</div></td>
      <td class="r num ${e.net < 0 ? "neg" : ""}"><b>${money(e.net)}</b></td>
      <td class="r num ${e.netPerDay >= state.profile.min_net_per_day ? "pos" : ""}">${money(e.netPerDay)}</td>
      <td><div class="match"><span class="score num ${m.score === 0 ? "zero" : ""}" style="--w:${m.score}%"><span>${m.score}</span></span><span class="tier ${t.cls}">${t.label}</span></div></td>
    </tr>
    ${open ? `<tr class="drawer"><td colspan="9">${renderReceipt(load, m, a)}</td></tr>` : ""}`;
}

function renderReceipt(load: BoardLoad, m: MatchResult, a: Analysis) {
  const e = m.economics; const rp = load.raw_payload ?? {};
  const line = (lbl: string, v: string, cls = "") => `<div class="line ${cls}"><span class="lbl">${lbl}</span><span class="dots"></span><span>${v}</span></div>`;
  const fuel = state.fuelPrice ?? DEFAULT_FUEL_PRICE[state.profile.fuel_type];
  const nights = Math.max(0, Math.ceil(load.est_days) - 1);
  const next = a.nextLoads(load).slice(0, 3);
  return `<div class="receipt">
    <div>
      <h3>Expenses</h3>
      ${line(`Fuel · ${e.drivenMiles} mi @ ${state.profile.mpg} mpg × $${fuel.toFixed(2)}`, money2(e.fuelCost))}
      ${line(`Hotel · ${nights} night${nights === 1 ? "" : "s"}`, money2(e.hotelCost))}
      ${line(`Food · ${Math.ceil(load.est_days)} day${Math.ceil(load.est_days) === 1 ? "" : "s"}`, money2(e.foodCost))}
      ${line(`Tolls · ${e.drivenMiles} mi × $${state.profile.toll_per_mile.toFixed(2)}`, money2(e.tollCost))}
      ${e.otherCost ? line("Other", money2(e.otherCost)) : ""}
      ${line(load.is_backhaul ? "Return · backhaul" : e.returnCost === 0 ? "Return · tow car home" : (load.return_cost_estimate ?? 0) > 0 ? "Return · quoted ride home" : "Return · your ride-home budget", money2(e.returnCost))}
      ${line("Total expenses", money2(e.totalExpenses), "total")}
      ${line("Pay", money2(load.pay))}
      ${line("Net", money2(e.net), "total")}
    </div>
    <div>
      <h3>Profit Match Score · ${m.score}</h3>
      <div class="factors">${(Object.keys(MATCH_WEIGHTS) as MatchFactor[]).map((k) => `<div class="factor"><span>${FACTOR_LABEL[k]}</span><span class="bar"><i style="width:${(m.factors[k] / MATCH_WEIGHTS[k]) * 100}%"></i></span><span class="num">${m.factors[k].toFixed(0)}/${MATCH_WEIGHTS[k]}</span></div>`).join("")}</div>
      <dl class="facts">
        <div><dt>Order</dt><dd class="num">${esc(load.order_number ?? "—")}</dd></div>
        <div><dt>Vehicle</dt><dd>${esc(rp.vehicle ?? "—")}${rp.customer ? ` · ${esc(rp.customer)}` : ""}</dd></div>
        <div><dt>Pickup</dt><dd>${esc(load.terminal ?? "")} · ${fmtDate(load.load_date)} ${esc(rp.pickup_window ?? "")}</dd></div>
        ${rp.notes ? `<div><dt>Notes</dt><dd>${esc(rp.notes)}</dd></div>` : ""}
      </dl>
    </div>
    <div class="next">
      <h3>Next loads near ${esc(load.dest_city)}, ${esc(load.dest_state)}</h3>
      ${next.length ? next.map((n) => { const ne = calcLoad(n, state.profile, opts()); return `<div class="next-row"><div><b>${esc(n.origin_city)} → ${esc(n.dest_city)}, ${esc(n.dest_state)}</b>${n.dest_state === homeState() ? ` <span class="tag ok">home</span>` : ""}<div class="muted">${fmtDate(n.load_date)} · ${n.miles} mi · ${money(ne.net)} net · ${money(ne.netPerDay)}/day</div></div><button class="btn small quiet" data-add="${n.id}">${state.plan.includes(n.id) ? "Added" : "Add"}</button></div>`; }).join("")
        : `<div class="empty">Nothing profitable picks up in ${esc(load.dest_state)} after this delivery. You'd deadhead or ride home.</div>`}
    </div>
    <div class="actions"><button class="btn primary" data-add="${load.id}">${state.plan.includes(load.id) ? "Remove from plan" : "Add to plan"}</button></div>
  </div>`;
}

function renderPlan(planLoads: BoardLoad[], plan: ReturnType<typeof summarizePlan>) {
  const items = plan.loads.map(({ load, economics }, i) => {
    const prev = plan.loads[i - 1]?.load;
    const gap = prev && prev.dest_state !== load.origin_state ? `<div class="gap">Gap: ends in ${esc(prev.dest_city)}, starts in ${esc(load.origin_city)}</div>` : "";
    const late = prev && prev.load_date && load.load_date && load.load_date < addDays(prev.load_date, Math.ceil(prev.est_days)) ? `<div class="gap">Picks up before the previous delivery finishes</div>` : "";
    return `${gap}${late}<li><span class="idx">${i + 1}</span><div><div class="rt">${esc(load.origin_city)} → ${esc(load.dest_city)}</div><div class="sub">${fmtDate(load.load_date)} · ${load.est_days}d · ${money(economics.net)} net</div></div><button class="btn small quiet" data-add="${(load as BoardLoad).id}">Remove</button></li>`;
  }).join("");
  const last = planLoads[planLoads.length - 1];
  const endsHome = last ? last.dest_state === homeState() : null;
  return `
    ${state.planLabel ? `<div class="plan-label">${esc(state.planLabel)}</div>` : ""}
    <ul class="plan-list">${items || `<li class="empty">Pick a strategy, tap a day in the planner, or add loads from the board.</li>`}</ul>
    ${planLoads.length ? `
    <div class="totals">
      <div class="line"><span>Gross pay</span><span class="num">${money(plan.grossPay)}</span></div>
      <div class="line"><span>Expenses</span><span class="num ${plan.overWeeklyBudget ? "neg" : ""}">${money(plan.projectedExpenses)}</span></div>
      <div class="line"><span>Miles · deadhead</span><span class="num">${plan.totalMiles.toLocaleString()} · ${plan.deadheadPct}%</span></div>
      <div class="line"><span>Days used</span><span class="num">${plan.daysUsed} of ${state.goal.days_available}</span></div>
      <div class="line"><span>Net per day · per mile</span><span class="num">${money(plan.netPerDay)} · $${plan.netPerMile.toFixed(2)}</span></div>
      <div class="line big"><span>Net</span><span class="num ${plan.projectedNet < 0 ? "neg" : ""}">${money(plan.projectedNet)}</span></div>
    </div>
    ${plan.meetsGoal ? `<div class="note good">Clears the ${money(state.goal.weekly_net_goal)} goal with ${money(plan.projectedNet - state.goal.weekly_net_goal)} to spare.</div>` : `<div class="note">${money(state.goal.weekly_net_goal - plan.projectedNet)} short of the goal${plan.daysUsed > state.goal.days_available ? ` and ${plan.daysUsed - state.goal.days_available} day(s) over` : ""}.</div>`}
    ${plan.overWeeklyBudget ? `<div class="note bad">Expenses exceed the ${money(state.profile.max_weekly_expense)} weekly cap.</div>` : ""}
    ${endsHome === false ? `<div class="note">Ends in ${esc(last.dest_city)}, not home. Open that load for backhauls toward ${esc(homeState())}.</div>` : ""}
    <div class="rail-actions"><button class="btn primary" id="savePlan">Save plan</button><button class="btn quiet" id="clearPlan">Clear</button></div>` : ""}
    <div class="saved">
      <h3>Saved plans</h3>
      ${state.savedPlans.length ? state.savedPlans.map((p) => `<button data-open-plan="${p.id}"><b>${esc(p.name)}</b><span>${p.load_ids.length} loads · ${money(p.projected_net)} net · ${p.days_used}d</span></button>`).join("") : `<div class="empty">No saved plans yet.</div>`}
    </div>`;
}

function renderAlerts(a: Analysis) {
  const rules = DRIVERS[state.driverIdx].alert_rules;
  const hits = [...state.hits].sort((x, y) => Number(x.seen) - Number(y.seen) || y.matched_at.localeCompare(x.matched_at));
  return `
    <div class="alerts">
      <div style="display:flex;gap:8px;align-items:center"><span class="muted" style="flex:1">${hits.filter((h) => !h.seen).length} new</span><button class="btn small quiet" id="markRead">Mark all read</button></div>
      ${hits.length ? hits.slice(0, 40).map((h) => {
        const load = loadById(h.load_id); const rule = rules.find((r) => r.id === h.alert_rule_id);
        if (!load || !rule) return "";
        const e = a.scored.get(load.id)!.economics;
        return `<div class="alert ${h.seen ? "" : "unseen"}"><span class="dot"></span><div><div class="rule">${esc(ruleLabel(rule))}</div><div><b>${esc(load.origin_city)} → ${esc(load.dest_city)}</b> · ${money(load.pay)} · ${money(e.net)} net</div><div class="when">${fmtDate(load.load_date)} · ${ago(h.matched_at)}</div></div><button class="btn small quiet" data-add="${load.id}">${state.plan.includes(load.id) ? "Added" : "Add"}</button></div>`;
      }).join("") : `<div class="empty">No alerts yet. New loads that clear a rule below will show up here.</div>`}
      <h3>Your rules</h3>
      ${rules.map((r) => `<div class="alert"><span class="dot" style="background:var(--blue)"></span><div>${esc(ruleLabel(r))}</div></div>`).join("")}
    </div>`;
}

function renderSettings() {
  const p = state.profile;
  const field = (key: keyof DriverProfile, label: string, step = "1") => `<label>${label}<input type="number" step="${step}" data-set="${key}" value="${p[key] ?? ""}" /></label>`;
  return `<div class="settings">
    <h3>Rig</h3>
    <div class="grid">
      ${field("mpg", "MPG", "0.5")}
      <label>Fuel<select data-set="fuel_type"><option value="diesel" ${p.fuel_type === "diesel" ? "selected" : ""}>Diesel</option><option value="unleaded" ${p.fuel_type === "unleaded" ? "selected" : ""}>Unleaded</option></select></label>
      <label>Fuel price $/gal<input type="number" step="0.05" data-set="fuelPrice" value="${state.fuelPrice ?? ""}" placeholder="${DEFAULT_FUEL_PRICE[p.fuel_type].toFixed(2)}" /></label>
      <label>Tows a car<select data-set="towable"><option value="true" ${p.towable ? "selected" : ""}>Yes</option><option value="false" ${!p.towable ? "selected" : ""}>No</option></select></label>
    </div>
    <h3>Expenses</h3>
    <div class="grid">${field("hotel_budget", "Hotel / night")}${field("food_budget", "Food / day")}${field("toll_per_mile", "Tolls / mile", "0.01")}${field("other_per_load", "Other / load")}${field("transport_budget", "Ride home")}${field("max_expense_per_load", "Max per load")}${field("max_weekly_expense", "Weekly expense cap")}</div>
    <h3>Your bar</h3>
    <div class="grid">${field("min_net_per_day", "Min net / day")}${field("min_net_per_load", "Min net / load")}${field("min_net_per_mile", "Min net / mile", "0.05")}${field("max_deadhead_pct", "Max deadhead %")}${field("preferred_min_miles", "Miles from")}${field("preferred_max_miles", "Miles to")}</div>
    <h3>Goal</h3>
    <div class="grid"><label>Weekly net goal<input type="number" step="100" data-goal="weekly_net_goal" value="${state.goal.weekly_net_goal}" /></label><label>Days available<input type="number" min="1" max="7" data-goal="days_available" value="${state.goal.days_available}" /></label></div>
    <div class="note">Every number on this page recalculates as you change these. Same math the alert sweep uses.</div>
  </div>`;
}

/* ----------------------------------------------------------------- toasts */
function toast(html: string) {
  const el = document.createElement("div"); el.className = "toast"; el.innerHTML = html;
  $("#toasts").appendChild(el); setTimeout(() => el.remove(), 6000);
}

/* ----------------------------------------------------------------- events */
document.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const btn = t.closest("[data-driver],[data-add],[data-filter],[data-tier],[data-tab],[data-open-plan],[data-strategy],[data-day],[data-open],#savePlan,#clearPlan,#markRead,tr.row") as HTMLElement | null;
  if (!btn) return;
  if (btn.dataset.driver) { switchDriver(Number(btn.dataset.driver)); return render(); }
  if (btn.dataset.add) {
    const id = btn.dataset.add;
    const ids = state.plan.includes(id) ? state.plan.filter((x) => x !== id) : [...state.plan, id];
    ids.sort((x, y) => (loadById(x)?.load_date ?? "").localeCompare(loadById(y)?.load_date ?? ""));
    usePlan(ids, "Your plan"); return render();
  }
  if (btn.dataset.strategy) {
    const s = analyze().strats.find((x) => x.key === btn.dataset.strategy);
    if (s?.chain) usePlan(s.chain.loads.map((l) => (l as BoardLoad).id), s.label); state.tab = "plan"; return render();
  }
  if (btn.dataset.day) {
    const row = analyze().planner.find((r) => r.days === Number(btn.dataset.day));
    if (row?.best) usePlan(row.best.loads.map((l) => (l as BoardLoad).id), `${row.days}-day plan`); state.tab = "plan"; return render();
  }
  if (btn.dataset.open) { state.expanded = btn.dataset.open; render(); $(`tr[data-load="${btn.dataset.open}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
  if (btn.dataset.filter) { const k = btn.dataset.filter as "backhaulOnly" | "availableOnly"; state.filters[k] = !state.filters[k]; return render(); }
  if (btn.dataset.tier) { state.filters.tier = state.filters.tier === "picks" ? "all" : "picks"; return render(); }
  if (btn.dataset.tab) { state.tab = btn.dataset.tab as typeof state.tab; return render(); }
  if (btn.dataset.openPlan) {
    const p = state.savedPlans.find((x) => x.id === btn.dataset.openPlan)!;
    usePlan(p.load_ids, p.name); state.tab = "plan"; return render();
  }
  if (btn.id === "savePlan") {
    const loads = state.plan.map(loadById).filter((l): l is BoardLoad => !!l);
    const s = summarizePlan(loads, state.profile, state.goal, opts());
    const name = `${loads[0].origin_city} → ${loads[loads.length - 1].dest_city}${loads.length > 2 ? ` +${loads.length - 2}` : loads.length === 2 ? ` via ${loads[0].dest_city}` : ""}`;
    state.savedPlans.unshift({ id: crypto.randomUUID(), name, load_ids: [...state.plan], projected_net: s.projectedNet, projected_expenses: s.projectedExpenses, days_used: s.daysUsed });
    toast(`Saved <b>${esc(name)}</b> · ${money(s.projectedNet)} net`); return render();
  }
  if (btn.id === "clearPlan") { usePlan([], ""); return render(); }
  if (btn.id === "markRead") { state.hits.forEach((h) => (h.seen = true)); return render(); }
  if (btn.matches("tr.row")) { const id = btn.dataset.load!; state.expanded = state.expanded === id ? null : id; return render(); }
});

document.addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement | HTMLSelectElement;
  if (t.id === "sort") { state.filters.sort = t.value as typeof state.filters.sort; return render(); }
  if (t.dataset.set) {
    const k = t.dataset.set;
    if (k === "fuelPrice") state.fuelPrice = t.value === "" ? undefined : Number(t.value);
    else if (k === "fuel_type") state.profile.fuel_type = t.value as DriverProfile["fuel_type"];
    else if (k === "towable") state.profile.towable = t.value === "true";
    else (state.profile as unknown as Record<string, number>)[k] = Number(t.value);
    return render();
  }
  if (t.dataset.goal) { (state.goal as unknown as Record<string, number>)[t.dataset.goal] = Math.max(1, Number(t.value)); return render(); }
  if (t.id === "csv" && (t as HTMLInputElement).files?.[0]) importCsv((t as HTMLInputElement).files![0]);
});

async function importCsv(file: File) {
  const rows = parseCsv(await file.text());
  const d = DRIVERS[state.driverIdx];
  let added = 0, refreshed = 0, skipped = 0; const newHits: Hit[] = [];
  for (const raw of rows) {
    let row; try { row = normalize(raw, "csv", d.id); } catch { skipped++; continue; }
    const existing = state.loads.find((l) => l.order_number && l.order_number === row.order_number);
    const load: BoardLoad = { ...(existing ?? { id: crypto.randomUUID() }), ...row, imported: true } as BoardLoad;
    if (existing) { Object.assign(existing, load); refreshed++; } else { state.loads.unshift(load); added++; }
    if (!existing) for (const rule of d.alert_rules) {
      if (matchesRule(rule, load, { profile: state.profile, goal: state.goal, fuelPrice: state.fuelPrice })) newHits.push({ id: crypto.randomUUID(), alert_rule_id: rule.id, load_id: load.id, matched_at: new Date().toISOString(), seen: false });
    }
  }
  state.hits.unshift(...newHits);
  render();
  toast(`Imported <b>${added} new</b>, refreshed ${refreshed}${skipped ? `, skipped ${skipped}` : ""}.`);
  if (newHits.length) setTimeout(() => toast(`<b>${newHits.length} alert${newHits.length === 1 ? "" : "s"}</b> fired on the new loads. Same rules the cron sweep runs.`), 400);
  ($("#csv") as HTMLInputElement).value = "";
}

render();

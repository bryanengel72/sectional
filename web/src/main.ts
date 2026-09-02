import loadsData from "../../sample-data/loads.json";
import driversData from "../../sample-data/drivers.json";
import {
  type AlertRule, type AlertRuleType, calcLoad, DEFAULT_FUEL_PRICE, type DriverGoal, type DriverProfile,
  type Load, type LoadEconomics, type MatchFlag, matchesRule, matchScore, summarizePlan,
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
  id: string; email: string; profile: DriverProfile & { display_name: string; starting_location: string };
  goal: DriverGoal; alert_rules: Array<AlertRule & { id: string }>; saved_plans: SavedPlan[]; alert_hits: Hit[];
  subscription: { plan: string; status: string } | null;
}

const DRIVERS = driversData as unknown as Driver[];

/* ------------------------------------------------------------------ state */
const state = {
  driverIdx: 0,
  loads: (loadsData as unknown as BoardLoad[]).map((l) => ({ ...l })),
  profile: { ...DRIVERS[0].profile },
  goal: { ...DRIVERS[0].goal },
  hits: DRIVERS[0].alert_hits.map((h) => ({ ...h })),
  savedPlans: DRIVERS[0].saved_plans.map((p) => ({ ...p })),
  fuelPrice: undefined as number | undefined,
  plan: [] as string[],
  expanded: null as string | null,
  tab: "plan" as "plan" | "alerts" | "settings",
  filters: { minScore: 0, hideOver: false, backhaulOnly: false, availableOnly: true, sort: "score" as "score" | "date" | "net" | "netPerDay" | "pay" },
};

function switchDriver(i: number) {
  const d = DRIVERS[i];
  state.driverIdx = i;
  state.profile = { ...d.profile };
  state.goal = { ...d.goal };
  state.hits = d.alert_hits.map((h) => ({ ...h }));
  state.savedPlans = d.saved_plans.map((p) => ({ ...p }));
  state.plan = d.saved_plans[0]?.load_ids.filter((id) => state.loads.some((l) => l.id === id)) ?? [];
  state.expanded = null;
}
switchDriver(0);

/* ---------------------------------------------------------------- helpers */
const $ = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement;
const money = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
const money2 = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtDate = (iso: string | null | undefined) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "—";
const ago = (iso: string) => { const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const opts = () => ({ fuelPrice: state.fuelPrice });
const loadById = (id: string) => state.loads.find((l) => l.id === id);
const FLAG_LABEL: Record<MatchFlag, string> = {
  OVER_BUDGET: "Over budget", LOW_NET_PER_DAY: "Low net/day", LOW_NET_PER_LOAD: "Low net", LOW_NET_PER_MILE: "Low net/mi",
  HIGH_DEADHEAD: "Deadhead", OUTSIDE_PREFERRED_MILES: "Off-range miles", CDL_REQUIRED: "CDL needed",
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

/* ----------------------------------------------------------------- render */
function render() {
  const d = DRIVERS[state.driverIdx];
  const profile = state.profile;
  const scored = state.loads.map((load) => ({ load, m: matchScore(load, profile, opts()) }));
  const f = state.filters;
  let rows = scored.filter(({ load, m }) =>
    (!f.availableOnly || load.status === "available") &&
    m.score >= f.minScore &&
    (!f.hideOver || !m.economics.overBudget) &&
    (!f.backhaulOnly || load.is_backhaul));
  rows.sort((a, b) => {
    switch (f.sort) {
      case "date": return (a.load.load_date ?? "").localeCompare(b.load.load_date ?? "");
      case "net": return b.m.economics.net - a.m.economics.net;
      case "netPerDay": return b.m.economics.netPerDay - a.m.economics.netPerDay;
      case "pay": return b.load.pay - a.load.pay;
      default: return b.m.score - a.m.score || b.m.economics.netPerDay - a.m.economics.netPerDay;
    }
  });

  const planLoads = state.plan.map(loadById).filter((l): l is BoardLoad => !!l);
  const plan = summarizePlan(planLoads, profile, state.goal, opts());
  const unseen = state.hits.filter((h) => !h.seen).length;
  const terminals = new Set(state.loads.map((l) => l.origin_city)).size;

  $("#app").innerHTML = `
    <div class="shell">
      <header class="masthead">
        <div class="wordmark"><strong>Sectional</strong><span>Load board</span></div>
        <nav class="drivers" aria-label="Demo driver">
          ${DRIVERS.map((dr, i) => `<button class="driver-btn" data-driver="${i}" aria-pressed="${i === state.driverIdx}">${esc(dr.profile.display_name)}<small>${esc(dr.profile.starting_location)}</small></button>`).join("")}
        </nav>
      </header>

      <section class="week" aria-label="This week">
        <div class="week-head">
          <h1>${esc(d.profile.display_name)}'s week</h1>
          <div class="driver-meta">Home <b>${esc(profile.starting_location)}</b> · ${profile.cdl_class ? `CDL-${esc(profile.cdl_class)}` : "No CDL"} · ${profile.towable ? "Tows a car home" : "Rides home"} · ${profile.mpg} mpg ${esc(profile.fuel_type)}</div>
          <div class="goal-line">Goal <strong class="num">${money(state.goal.weekly_net_goal)}</strong> net in <strong class="num">${state.goal.days_available}</strong> days</div>
        </div>
        ${renderHighway(planLoads, plan)}
      </section>

      <div class="cols">
        <section class="panel board-panel" aria-label="Loads">
          <div class="panel-head">
            <h2>Loads</h2>
            <span class="sub">${state.loads.length} out of ${terminals} terminals, next two weeks</span>
            <span class="spacer"></span>
            <label class="btn quiet" for="csv">Import board (CSV)</label>
            <input id="csv" type="file" accept=".csv,text/csv" hidden />
          </div>
          <div class="filters">
            <label>Sort <select id="sort">
              ${[["score", "Match score"], ["netPerDay", "Net per day"], ["net", "Net"], ["pay", "Pay"], ["date", "Pickup date"]].map(([v, t]) => `<option value="${v}" ${f.sort === v ? "selected" : ""}>${t}</option>`).join("")}
            </select></label>
            <label>Score ≥ <input id="minScore" type="number" min="0" max="100" step="10" value="${f.minScore}" style="width:64px" /></label>
            <button class="chip" data-filter="availableOnly" aria-pressed="${f.availableOnly}">Available only</button>
            <button class="chip" data-filter="hideOver" aria-pressed="${f.hideOver}">Within budget</button>
            <button class="chip" data-filter="backhaulOnly" aria-pressed="${f.backhaulOnly}">Backhauls</button>
            <span class="muted">${rows.length} shown</span>
          </div>
          <table class="board">
            <thead><tr>
              <th></th><th>Route</th><th class="hide-m">Pickup</th><th class="r">Miles</th><th class="r hide-m">DH</th><th class="r">Pay</th><th class="r">Net</th><th class="r">Net/day</th><th>Match</th>
            </tr></thead>
            <tbody>
              ${rows.length ? rows.map(({ load, m }) => renderRow(load, m)).join("") : `<tr><td colspan="9" class="empty">Nothing matches these filters. Loosen the score or turn off a filter.</td></tr>`}
            </tbody>
          </table>
        </section>

        <aside class="rail">
          <div class="panel">
            <div class="tabs" role="tablist">
              <button role="tab" data-tab="plan" aria-selected="${state.tab === "plan"}">Plan${state.plan.length ? `<span class="count" style="background:var(--blue)">${state.plan.length}</span>` : ""}</button>
              <button role="tab" data-tab="alerts" aria-selected="${state.tab === "alerts"}">Alerts${unseen ? `<span class="count">${unseen}</span>` : ""}</button>
              <button role="tab" data-tab="settings" aria-selected="${state.tab === "settings"}">Settings</button>
            </div>
            <div class="rail-body">
              ${state.tab === "plan" ? renderPlan(planLoads, plan) : state.tab === "alerts" ? renderAlerts() : renderSettings()}
            </div>
          </div>
        </aside>
      </div>
    </div>
    <div class="toasts" id="toasts"></div>`;
}

function renderHighway(planLoads: BoardLoad[], plan: ReturnType<typeof summarizePlan>) {
  const days = state.goal.days_available;
  const span = Math.max(days, plan.daysUsed);
  const pct = (d: number) => (d / span) * 100;
  let cursor = 0;
  const segs = plan.loads.map(({ load, economics }) => {
    const left = pct(cursor); const width = pct(load.est_days); cursor += load.est_days;
    const cls = cursor > days ? "over" : economics.netPerDay < state.profile.min_net_per_day ? "thin" : "";
    return `<div class="seg ${cls}" style="left:${left}%;width:calc(${width}% - 2px)" title="${esc(load.origin_city)} → ${esc(load.dest_city)}: ${money(economics.net)} net over ${load.est_days} days">${esc(load.origin_state)}→${esc(load.dest_state)} <span class="n">${money(economics.net)}</span></div>`;
  }).join("");
  const markers = Array.from({ length: days }, (_, i) => `<div class="marker" style="left:${pct(i + 1)}%"><div class="post"></div><div class="plate">${i + 1}</div></div>`).join("");
  const endPct = pct(Math.min(cursor, span));
  const total = planLoads.length ? `<div class="total ${endPct < 40 ? "lead" : ""}" style="left:${endPct}%">${money(plan.projectedNet)} net · ${plan.daysUsed}d</div>` : "";
  const exitCls = plan.meetsGoal ? "hit" : "miss";
  return `<div class="highway" role="img" aria-label="${planLoads.length} loads planned, ${money(plan.projectedNet)} net over ${plan.daysUsed} of ${days} days">
    <div class="road">${planLoads.length ? "" : `<div class="empty">Add loads from the board to lay out the week.</div>`}</div>
    <div style="position:absolute;left:0;right:120px;top:0;height:100%">${segs}${markers}${total}</div>
    <div class="exit ${exitCls}"><small>EXIT</small><span class="num">${money(state.goal.weekly_net_goal)}</span><small>${plan.meetsGoal ? "GOAL MET" : planLoads.length ? money(Math.max(0, state.goal.weekly_net_goal - plan.projectedNet)) + " TO GO" : "GOAL"}</small></div>
  </div>`;
}

function renderRow(load: BoardLoad, m: ReturnType<typeof matchScore>) {
  const e = m.economics; const inPlan = state.plan.includes(load.id); const open = state.expanded === load.id;
  const veh = load.raw_payload?.vehicle as string | undefined;
  const tags = [
    ...(load.is_backhaul ? [`<span class="tag ok">Backhaul</span>`] : []),
    ...(load.status !== "available" ? [`<span class="tag warn">${esc(load.status)}</span>`] : []),
    ...(load.source === "csv" && load.imported ? [`<span class="tag info">Imported</span>`] : []),
    ...m.flags.map((fl) => `<span class="tag">${FLAG_LABEL[fl]}</span>`),
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
      <td><span class="score num ${m.score === 0 ? "zero" : ""}" style="--w:${m.score}%"><span>${m.score}</span></span></td>
    </tr>
    ${open ? `<tr class="drawer"><td colspan="9">${renderReceipt(load, e)}</td></tr>` : ""}`;
}

function renderReceipt(load: BoardLoad, e: LoadEconomics) {
  const rp = load.raw_payload ?? {};
  const line = (lbl: string, v: string, cls = "") => `<div class="line ${cls}"><span class="lbl">${lbl}</span><span class="dots"></span><span>${v}</span></div>`;
  const fuel = state.fuelPrice ?? DEFAULT_FUEL_PRICE[state.profile.fuel_type];
  return `<div class="receipt">
    <div>
      <h3>Expenses</h3>
      ${line(`Fuel · ${e.drivenMiles} mi @ ${state.profile.mpg} mpg × $${fuel.toFixed(2)}`, money2(e.fuelCost))}
      ${line(`Hotel · ${Math.max(0, Math.ceil(load.est_days) - 1)} night${Math.ceil(load.est_days) - 1 === 1 ? "" : "s"}`, money2(e.hotelCost))}
      ${line(`Food · ${Math.ceil(load.est_days)} day${Math.ceil(load.est_days) === 1 ? "" : "s"}`, money2(e.foodCost))}
      ${line(load.is_backhaul ? "Return · backhaul" : e.returnCost === 0 ? "Return · tow car home" : "Return · ride home", money2(e.returnCost))}
      ${line("Total expenses", money2(e.totalExpenses), "total")}
      ${line("Pay", money2(load.pay))}
      ${line("Net", money2(e.net), "total")}
    </div>
    <dl class="facts">
      <h3>Load</h3>
      <div><dt>Order</dt><dd class="num">${esc(load.order_number ?? "—")}</dd></div>
      <div><dt>Vehicle</dt><dd>${esc(rp.vehicle ?? "—")}</dd></div>
      <div><dt>Customer</dt><dd>${esc(rp.customer ?? "—")}</dd></div>
      <div><dt>Terminal</dt><dd>${esc(load.terminal ?? "—")}</dd></div>
      <div><dt>Pickup</dt><dd>${fmtDate(load.load_date)} ${esc(rp.pickup_window ?? "")}</dd></div>
      <div><dt>Deadhead</dt><dd class="num">${load.deadhead_miles ?? 0} mi (${e.deadheadPct}%)</dd></div>
      <div><dt>Net/mile</dt><dd class="num">$${e.netPerMile.toFixed(2)}</dd></div>
      ${rp.notes ? `<div><dt>Notes</dt><dd>${esc(rp.notes)}</dd></div>` : ""}
    </dl>
    <div class="actions"><button class="btn primary" data-add="${load.id}">${state.plan.includes(load.id) ? "Remove from plan" : "Add to plan"}</button></div>
  </div>`;
}

function renderPlan(planLoads: BoardLoad[], plan: ReturnType<typeof summarizePlan>) {
  const items = plan.loads.map(({ load, economics }, i) => {
    const prev = plan.loads[i - 1]?.load;
    const gap = prev && prev.dest_state !== load.origin_state ? `<div class="gap">Gap: ends in ${esc(prev.dest_city)}, starts in ${esc(load.origin_city)}</div>` : "";
    const late = prev && prev.load_date && load.load_date && load.load_date < prev.load_date ? `<div class="gap">Pickup is before the previous load's date</div>` : "";
    return `${gap}${late}<li><span class="idx">${i + 1}</span><div><div class="rt">${esc(load.origin_city)} → ${esc(load.dest_city)}</div><div class="sub">${fmtDate(load.load_date)} · ${load.est_days}d · ${money(economics.net)} net</div></div><button class="btn small quiet" data-add="${load.id}">Remove</button></li>`;
  }).join("");
  const home = state.profile.starting_location.slice(-2);
  const last = planLoads[planLoads.length - 1];
  const endsHome = last ? last.dest_state === home : null;
  return `
    <ul class="plan-list">${items || `<li class="empty">Add loads from the board to see how the week nets out.</li>`}</ul>
    ${planLoads.length ? `
    <div class="totals">
      <div class="line"><span>Expenses</span><span class="num ${plan.overWeeklyBudget ? "neg" : ""}">${money(plan.projectedExpenses)}</span></div>
      <div class="line"><span>Days used</span><span class="num">${plan.daysUsed} of ${state.goal.days_available}</span></div>
      <div class="line big"><span>Net</span><span class="num ${plan.projectedNet < 0 ? "neg" : ""}">${money(plan.projectedNet)}</span></div>
    </div>
    ${plan.meetsGoal ? `<div class="note good">Clears the ${money(state.goal.weekly_net_goal)} goal with ${money(plan.projectedNet - state.goal.weekly_net_goal)} to spare.</div>` : `<div class="note">${money(state.goal.weekly_net_goal - plan.projectedNet)} short of the goal${plan.daysUsed > state.goal.days_available ? ` and ${plan.daysUsed - state.goal.days_available} day(s) over` : ""}.</div>`}
    ${plan.overWeeklyBudget ? `<div class="note bad">Expenses exceed the ${money(state.profile.max_weekly_expense)} weekly cap.</div>` : ""}
    ${endsHome === false ? `<div class="note">Ends in ${esc(last.dest_city)}, not home. Look for a backhaul toward ${esc(home)}.</div>` : ""}
    <div class="rail-actions"><button class="btn primary" id="savePlan">Save plan</button><button class="btn quiet" id="clearPlan">Clear</button></div>` : ""}
    <div class="saved">
      <h3>Saved plans</h3>
      ${state.savedPlans.length ? state.savedPlans.map((p) => `<button data-open-plan="${p.id}"><b>${esc(p.name)}</b><span>${p.load_ids.length} loads · ${money(p.projected_net)} net · ${p.days_used}d</span></button>`).join("") : `<div class="empty">No saved plans yet.</div>`}
    </div>`;
}

function renderAlerts() {
  const d = DRIVERS[state.driverIdx];
  const rules = d.alert_rules;
  const hits = [...state.hits].sort((a, b) => Number(a.seen) - Number(b.seen) || b.matched_at.localeCompare(a.matched_at));
  return `
    <div class="alerts">
      <div style="display:flex;gap:8px;align-items:center"><span class="muted" style="flex:1">${hits.filter((h) => !h.seen).length} new</span><button class="btn small quiet" id="markRead">Mark all read</button></div>
      ${hits.length ? hits.slice(0, 40).map((h) => {
        const load = loadById(h.load_id); const rule = rules.find((r) => r.id === h.alert_rule_id);
        if (!load || !rule) return "";
        const e = calcLoad(load, state.profile, opts());
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
    <h3>Daily budgets</h3>
    <div class="grid">${field("hotel_budget", "Hotel / night")}${field("food_budget", "Food / day")}${field("transport_budget", "Ride home")}${field("max_expense_per_load", "Max per load")}</div>
    <h3>Your bar</h3>
    <div class="grid">${field("min_net_per_day", "Min net / day")}${field("min_net_per_load", "Min net / load")}${field("min_net_per_mile", "Min net / mile", "0.05")}${field("max_deadhead_pct", "Max deadhead %")}${field("preferred_min_miles", "Miles from")}${field("preferred_max_miles", "Miles to")}${field("max_weekly_expense", "Weekly expense cap")}</div>
    <h3>Goal</h3>
    <div class="grid"><label>Weekly net goal<input type="number" step="100" data-goal="weekly_net_goal" value="${state.goal.weekly_net_goal}" /></label><label>Days available<input type="number" min="1" max="7" data-goal="days_available" value="${state.goal.days_available}" /></label></div>
    <div class="note">Every number on the board recalculates as you change these. Same math the alert sweep uses.</div>
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
  const btn = t.closest("[data-driver],[data-add],[data-filter],[data-tab],[data-open-plan],#savePlan,#clearPlan,#markRead,tr.row") as HTMLElement | null;
  if (!btn) return;
  if (btn.dataset.driver) { switchDriver(Number(btn.dataset.driver)); return render(); }
  if (btn.dataset.add) {
    const id = btn.dataset.add;
    state.plan = state.plan.includes(id) ? state.plan.filter((x) => x !== id) : [...state.plan, id];
    if (!state.plan.includes(id)) return render();
    // Keep the chain in date order so the highway reads left to right.
    state.plan.sort((a, b) => (loadById(a)?.load_date ?? "").localeCompare(loadById(b)?.load_date ?? ""));
    return render();
  }
  if (btn.dataset.filter) { const k = btn.dataset.filter as "hideOver" | "backhaulOnly" | "availableOnly"; state.filters[k] = !state.filters[k]; return render(); }
  if (btn.dataset.tab) { state.tab = btn.dataset.tab as typeof state.tab; return render(); }
  if (btn.dataset.openPlan) {
    const p = state.savedPlans.find((x) => x.id === btn.dataset.openPlan)!;
    state.plan = p.load_ids.filter((id) => loadById(id)); state.tab = "plan"; return render();
  }
  if (btn.id === "savePlan") {
    const loads = state.plan.map(loadById).filter((l): l is BoardLoad => !!l);
    const s = summarizePlan(loads, state.profile, state.goal, opts());
    const name = `${loads[0].origin_city} → ${loads[loads.length - 1].dest_city}${loads.length > 2 ? ` +${loads.length - 2}` : loads.length === 2 ? ` via ${loads[0].dest_city}` : ""}`;
    state.savedPlans.unshift({ id: crypto.randomUUID(), name, load_ids: [...state.plan], projected_net: s.projectedNet, projected_expenses: s.projectedExpenses, days_used: s.daysUsed });
    toast(`Saved <b>${esc(name)}</b> · ${money(s.projectedNet)} net`); return render();
  }
  if (btn.id === "clearPlan") { state.plan = []; return render(); }
  if (btn.id === "markRead") { state.hits.forEach((h) => (h.seen = true)); return render(); }
  if (btn.matches("tr.row")) { const id = btn.dataset.load!; state.expanded = state.expanded === id ? null : id; return render(); }
});

document.addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement | HTMLSelectElement;
  if (t.id === "sort") { state.filters.sort = t.value as typeof state.filters.sort; return render(); }
  if (t.id === "minScore") { state.filters.minScore = Number(t.value) || 0; return render(); }
  if (t.dataset.set) {
    const k = t.dataset.set;
    if (k === "fuelPrice") state.fuelPrice = t.value === "" ? undefined : Number(t.value);
    else if (k === "fuel_type") state.profile.fuel_type = t.value as DriverProfile["fuel_type"];
    else if (k === "towable") state.profile.towable = t.value === "true";
    else (state.profile as unknown as Record<string, number>)[k] = Number(t.value);
    return render();
  }
  if (t.dataset.goal) { (state.goal as unknown as Record<string, number>)[t.dataset.goal] = Number(t.value); return render(); }
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

/** Maps a raw CSV row / JSON object onto the public.loads schema. Pure; tested. */

export type Source = "manual" | "csv" | "api" | "email";

export interface LoadRow {
  source: Source;
  order_number: string | null;
  status: string | null;
  cdl_required: boolean | null;
  terminal: string | null;
  origin_city: string;
  origin_state: string;
  dest_city: string;
  dest_state: string;
  load_date: string | null;
  miles: number;
  deadhead_miles: number;
  towable: boolean | null;
  pay: number;
  est_days: number;
  return_cost_estimate: number;
  is_backhaul: boolean;
  raw_payload: Record<string, unknown>;
  imported_by: string;
}

/** Header aliases -> canonical column. Keys are lower-cased, non-alphanumerics stripped. */
const HEADER_ALIASES: Record<string, keyof LoadRow> = {
  ordernumber: "order_number", order: "order_number", orderno: "order_number", loadid: "order_number", loadnumber: "order_number",
  status: "status",
  cdlrequired: "cdl_required", cdl: "cdl_required",
  terminal: "terminal",
  origincity: "origin_city", origin: "origin_city", pickupcity: "origin_city", fromcity: "origin_city",
  originstate: "origin_state", pickupstate: "origin_state", fromstate: "origin_state",
  destcity: "dest_city", destinationcity: "dest_city", destination: "dest_city", tocity: "dest_city", deliverycity: "dest_city",
  deststate: "dest_state", destinationstate: "dest_state", tostate: "dest_state", deliverystate: "dest_state",
  loaddate: "load_date", date: "load_date", pickupdate: "load_date",
  miles: "miles", distance: "miles", loadedmiles: "miles",
  deadheadmiles: "deadhead_miles", deadhead: "deadhead_miles", dh: "deadhead_miles",
  towable: "towable", tow: "towable",
  pay: "pay", rate: "pay", amount: "pay", totalpay: "pay",
  estdays: "est_days", days: "est_days", duration: "est_days",
  returncostestimate: "return_cost_estimate", returncost: "return_cost_estimate",
  isbackhaul: "is_backhaul", backhaul: "is_backhaul",
};

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(s)) return true;
  if (["false", "f", "no", "n", "0"].includes(s)) return false;
  return null;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** CDL column may be boolean-ish ("yes") or a class letter ("A", "B", "NONE"). */
function toCdl(v: unknown): boolean | null {
  const b = toBool(v);
  if (b !== null) return b;
  if (v == null || v === "") return null;
  const s = String(v).trim().toUpperCase();
  if (["NONE", "N/A", "NA", "-"].includes(s)) return false;
  return /^[ABC]$/.test(s) ? true : null;
}

function toDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const str = (v: unknown): string | null => (v == null || String(v).trim() === "" ? null : String(v).trim());

/** Map one raw record (CSV row or JSON object) onto the loads schema. Throws with a readable reason. */
export function normalize(raw: Record<string, unknown>, source: Source, userId: string): LoadRow {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const canonical = HEADER_ALIASES[normKey(k)] ?? (k in HEADER_ALIASES ? k : null);
    if (canonical) r[canonical] = v;
  }

  const required = (key: string) => {
    const s = str(r[key]);
    if (!s) throw new Error(`missing ${key}`);
    return s;
  };
  const requiredNum = (key: string) => {
    const n = toNum(r[key]);
    if (n == null) throw new Error(`missing or non-numeric ${key}`);
    return n;
  };

  const miles = requiredNum("miles");
  const estDays = requiredNum("est_days");
  if (miles <= 0) throw new Error("miles must be > 0");
  if (estDays <= 0) throw new Error("est_days must be > 0");

  return {
    source,
    order_number: str(r.order_number),
    status: str(r.status)?.toLowerCase() ?? null,
    cdl_required: toCdl(r.cdl_required),
    terminal: str(r.terminal),
    origin_city: required("origin_city"),
    origin_state: required("origin_state").toUpperCase(),
    dest_city: required("dest_city"),
    dest_state: required("dest_state").toUpperCase(),
    load_date: toDate(r.load_date),
    miles,
    deadhead_miles: toNum(r.deadhead_miles) ?? 0,
    towable: toBool(r.towable),
    pay: requiredNum("pay"),
    est_days: estDays,
    return_cost_estimate: toNum(r.return_cost_estimate) ?? 0,
    is_backhaul: toBool(r.is_backhaul) ?? false,
    raw_payload: raw,
    imported_by: userId,
  };
}

// deno test supabase/functions/import-loads/normalize.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/csv@1";
import { normalize } from "./normalize.ts";

const csv = await Deno.readTextFile(new URL("../../../sample-data/terminal-board.csv", import.meta.url));
const rows = parse(csv, { skipFirstRow: true, trimLeadingSpace: true }) as Record<string, unknown>[];

Deno.test("every row of the demo terminal board imports", () => {
  assert(rows.length > 30);
  const errors: string[] = [];
  const out = rows.flatMap((r, i) => {
    try { return [normalize(r, "csv", "driver-1")]; } catch (e) { errors.push(`row ${i + 1}: ${(e as Error).message}`); return []; }
  });
  assertEquals(errors, []);
  assertEquals(out.length, rows.length);

  const first = out[0];
  assertEquals(first.order_number, String(rows[0]["Order #"]));
  assertEquals(first.origin_city, rows[0]["Pickup City"]);
  assertEquals(typeof first.pay, "number");
  assert(first.pay > 100, "rate with $ and commas parsed");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(first.load_date ?? ""), "pickup date normalized");
  assertEquals(first.raw_payload, rows[0], "original row preserved");
});

Deno.test("CDL column: class letters -> required, NONE -> not required", () => {
  const base = { "Pickup City": "Dallas", "Pickup State": "tx", "Delivery City": "Tulsa", "Delivery State": "OK", "Loaded Miles": "282", Rate: "$1,250", Days: "1" };
  assertEquals(normalize({ ...base, CDL: "A" }, "csv", "u").cdl_required, true);
  assertEquals(normalize({ ...base, CDL: "NONE" }, "csv", "u").cdl_required, false);
  assertEquals(normalize({ ...base, CDL: "yes" }, "csv", "u").cdl_required, true);
  assertEquals(normalize({ ...base, CDL: "" }, "csv", "u").cdl_required, null);
  assertEquals(normalize(base, "csv", "u").origin_state, "TX");
  assertEquals(normalize(base, "csv", "u").pay, 1250);
});

Deno.test("missing required fields are reported by name", () => {
  let msg = "";
  try { normalize({ "Pickup City": "Dallas" }, "manual", "u"); } catch (e) { msg = (e as Error).message; }
  assert(msg.includes("miles"), msg);
});

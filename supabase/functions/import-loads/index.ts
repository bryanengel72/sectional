/**
 * import-loads
 *
 * Accepts loads from an authenticated driver and writes them to the shared
 * board with the service role key (drivers have no direct write policy).
 *
 *   POST /functions/v1/import-loads
 *   Authorization: Bearer <driver session JWT>
 *
 *   Content-Type: text/csv            -> body is the CSV file
 *   Content-Type: application/json    -> { "csv": "<csv text>" }
 *                                     -> { "loads": [ {origin_city, ...}, ... ], "source"?: "manual"|"api" }
 *
 * Phase 2 (CSV) and Phase 3 (partner API / email) all land here: same
 * normalizer, different input adapters.
 */
import { parse as parseCsv } from "jsr:@std/csv@1";
import { adminClient, callerUserId, corsHeaders, json } from "../_shared/supabase.ts";
import { type LoadRow, normalize, type Source } from "./normalize.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  // ---- input adapters -------------------------------------------------
  let records: Record<string, unknown>[] = [];
  let source: Source = "manual";
  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("text/csv")) {
      records = parseCsv(await req.text(), { skipFirstRow: true, trimLeadingSpace: true }) as Record<string, unknown>[];
      source = "csv";
    } else {
      const body = await req.json();
      if (typeof body?.csv === "string") {
        records = parseCsv(body.csv, { skipFirstRow: true, trimLeadingSpace: true }) as Record<string, unknown>[];
        source = "csv";
      } else if (Array.isArray(body?.loads)) {
        records = body.loads;
        source = body.source === "api" ? "api" : "manual";
      } else {
        return json({ error: "expected text/csv body, {csv: string}, or {loads: [...]}" }, 400);
      }
    }
  } catch (err) {
    return json({ error: `could not parse input: ${(err as Error).message}` }, 400);
  }

  if (records.length === 0) return json({ error: "no rows" }, 400);
  if (records.length > 2000) return json({ error: "max 2000 rows per import" }, 413);

  // ---- normalize ------------------------------------------------------
  const rows: LoadRow[] = [];
  const errors: Array<{ row: number; error: string }> = [];
  records.forEach((raw, i) => {
    try {
      rows.push(normalize(raw, source, userId));
    } catch (err) {
      errors.push({ row: i + 1, error: (err as Error).message });
    }
  });

  if (rows.length === 0) return json({ imported: 0, skipped: 0, errors }, 422);

  // ---- write (service role; RLS bypassed) -----------------------------
  // Rows with an order_number upsert on (source, order_number) so re-importing
  // a feed refreshes existing loads instead of duplicating them.
  const supabase = adminClient();
  const keyed = rows.filter((r) => r.order_number);
  const unkeyed = rows.filter((r) => !r.order_number);

  let imported = 0;
  if (keyed.length) {
    const { data, error } = await supabase
      .from("loads")
      .upsert(keyed, { onConflict: "source,order_number" })
      .select("id");
    if (error) return json({ error: error.message, errors }, 500);
    imported += data?.length ?? 0;
  }
  if (unkeyed.length) {
    const { data, error } = await supabase.from("loads").insert(unkeyed).select("id");
    if (error) return json({ error: error.message, errors }, 500);
    imported += data?.length ?? 0;
  }

  return json({ imported, skipped: errors.length, errors });
});

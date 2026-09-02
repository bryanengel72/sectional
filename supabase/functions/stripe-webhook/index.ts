/**
 * stripe-webhook  (Phase 3)
 *
 * Receives Stripe events, verifies the signature, and mirrors subscription
 * state into public.subscriptions. verify_jwt = false (Stripe has no Supabase
 * session); the Stripe signature is the auth.
 *
 * Handled: checkout.session.completed, customer.subscription.updated,
 *          customer.subscription.deleted
 *
 * Mapping a Stripe customer to a driver: Checkout sessions must be created
 * with client_reference_id = <driver auth uid> (and ideally
 * subscription_data.metadata.driver_id as well) so both the checkout and the
 * later subscription events can find the driver.
 */
import Stripe from "npm:stripe@22";
import { adminClient, json } from "../_shared/supabase.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);
const cryptoProvider = Stripe.createSubtleCryptoProvider();

/** Stripe price id -> plan name. Set STRIPE_PRICE_MAP='{"price_123":"driver","price_456":"driver_pro"}'. */
const PRICE_MAP: Record<string, "driver" | "driver_pro" | "fleet"> =
  JSON.parse(Deno.env.get("STRIPE_PRICE_MAP") ?? "{}");

function planFor(sub: Stripe.Subscription): "driver" | "driver_pro" | "fleet" {
  const priceId = sub.items.data[0]?.price?.id;
  return (priceId && PRICE_MAP[priceId]) || "driver";
}

function periodEnd(sub: Stripe.Subscription): string | null {
  const ts = sub.items.data[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const signature = req.headers.get("stripe-signature");
  if (!signature) return json({ error: "missing stripe-signature" }, 400);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      signature,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    return json({ error: `signature verification failed: ${(err as Error).message}` }, 400);
  }

  const supabase = adminClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const driverId = session.client_reference_id;
      if (!driverId || !session.subscription) break;

      const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);

      const { error } = await supabase.from("subscriptions").upsert(
        {
          driver_id: driverId,
          plan: planFor(sub),
          stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
          stripe_subscription_id: sub.id,
          status: sub.status,
          current_period_end: periodEnd(sub),
        },
        { onConflict: "stripe_subscription_id" },
      );
      if (error) return json({ error: error.message }, 500);
      break;
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const patch = {
        plan: planFor(sub),
        status: event.type === "customer.subscription.deleted" ? "canceled" : sub.status,
        current_period_end: periodEnd(sub),
      };

      const { data: updated, error } = await supabase
        .from("subscriptions")
        .update(patch)
        .eq("stripe_subscription_id", sub.id)
        .select("id");
      if (error) return json({ error: error.message }, 500);

      // Subscription created outside Checkout (dashboard, API): fall back to metadata.
      if (!updated?.length && sub.metadata?.driver_id) {
        const { error: insErr } = await supabase.from("subscriptions").insert({
          driver_id: sub.metadata.driver_id,
          stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
          stripe_subscription_id: sub.id,
          ...patch,
        });
        if (insErr) return json({ error: insErr.message }, 500);
      }
      break;
    }

    default:
      // Acknowledge everything else so Stripe stops retrying.
      break;
  }

  return json({ received: true });
});

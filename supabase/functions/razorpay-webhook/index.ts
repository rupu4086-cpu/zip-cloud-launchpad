// TechnoTrade Academy — Razorpay webhook + Checkout verification.
//
// Two server-side paths, one shared activation step (create/extend the
// subscription, update-then-insert — subscriptions has NO unique constraint
// on user_id, so never upsert on user_id; same as the admin panel's
// createSubscription):
//
//  1. WEBHOOK (primary): Razorpay Dashboard -> Settings -> Webhooks posts
//     payment.captured events here. Verified with HMAC-SHA256 of the RAW
//     request body using the webhook secret shown in the Razorpay dashboard
//     when the webhook was created (RAZORPAY_WEBHOOK_SECRET). This is the
//     reliable path — it fires even if the learner closes the browser
//     mid-payment, and it is the server-side source of truth.
//
//  2. VERIFY (secondary): the learner website calls POST .../verify with
//     {razorpay_order_id, razorpay_payment_id, razorpay_signature} after a
//     successful Checkout. Verified with HMAC-SHA256 of
//     "order_id|payment_id" (or just "payment_id" when no order was created)
//     using the Razorpay Key Secret (RAZORPAY_KEY_SECRET). Non-fatal for the
//     website — if this function is not deployed yet, the website falls back
//     to its payments-row check and manual admin confirmation.
//
// Secrets (set in Lovable dashboard -> Functions -> razorpay-webhook ->
// Secrets; NEVER in the repo, the admin panel, or browser code):
//   RAZORPAY_WEBHOOK_SECRET, RAZORPAY_KEY_SECRET,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// The Key Secret is never the webhook secret and vice versa — Razorpay
// signs webhooks with the webhook secret, and Checkout handler signatures
// with the Key Secret.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLAN_DAYS: Record<string, number> = { monthly: 30, yearly: 365 };

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function createSubscription(supabase: any, userId: string, planId: string): Promise<void> {
  const days = PLAN_DAYS[planId];
  if (!days) throw new Error("Unknown plan: " + planId);
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  const payload = { user_id: userId, plan_id: planId, status: "active", expires_at: expires };
  // Update-then-insert (mirrors the admin panel): no unique constraint on
  // user_id, so an upsert on user_id would fail with 42P10.
  const updated = await supabase.from("subscriptions").update(payload).eq("user_id", userId).select("user_id");
  if (updated.error) throw updated.error;
  if (updated.data && updated.data.length) return;
  const inserted = await supabase.from("subscriptions").insert(payload);
  if (inserted.error) throw inserted.error;
}

// Activates the subscription for a verified captured payment. Returns true
// when the subscription was (or already had been) activated.
async function activatePayment(supabase: any, payId: string): Promise<boolean> {
  const { data: payment, error } = await supabase.from("payments").select("*").eq("id", payId).maybeSingle();
  if (error) throw error;
  if (!payment) return false;
  if (payment.status === "confirmed") return true;
  if (payment.status !== "captured") return false;
  if (!payment.user_id || !payment.plan_id) return false;
  await createSubscription(supabase, payment.user_id, payment.plan_id);
  const { error: markError } = await supabase
    .from("payments")
    .update({ status: "confirmed" })
    .eq("id", payId);
  if (markError) throw markError;
  return true;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const url = new URL(req.url);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    console.error("razorpay-webhook: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY secret missing");
    return json({ ok: false }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // ---- Path 2: Checkout handler-signature verification (website calls this) ----
  if (url.pathname.endsWith("/verify")) {
    if (req.method !== "POST") return json({ ok: false }, 405);
    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET") || "";
    if (!keySecret) {
      console.error("razorpay-webhook: RAZORPAY_KEY_SECRET secret missing");
      return json({ ok: false }, 500);
    }
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false }, 400);
    }
    const orderId = String(body?.razorpay_order_id || "");
    const payId = String(body?.razorpay_payment_id || "");
    const signature = String(body?.razorpay_signature || "");
    if (!payId || !signature) return json({ ok: false }, 400);
    // Checkout handler signature: HMAC-SHA256(secret, "order_id|payment_id");
    // without an order it is HMAC-SHA256(secret, "payment_id").
    const message = orderId ? orderId + "|" + payId : payId;
    const expected = await hmacHex(keySecret, message);
    if (!timingSafeEqual(expected, signature.toLowerCase())) return json({ ok: false }, 400);
    try {
      const activated = await activatePayment(supabase, payId);
      return json({ ok: true, activated });
    } catch (e) {
      console.error("razorpay-webhook: verify activation failed", e);
      return json({ ok: false }, 500);
    }
  }

  // ---- Path 1: Razorpay dashboard webhook (payment.captured) ----
  if (req.method !== "POST") return json({ ok: false }, 405);
  const webhookSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") || "";
  if (!webhookSecret) {
    console.error("razorpay-webhook: RAZORPAY_WEBHOOK_SECRET secret missing");
    return json({ ok: false }, 500);
  }
  const signature = req.headers.get("x-razorpay-signature") || "";
  const rawBody = await req.text();
  if (!signature) return json({ ok: false }, 400);
  const expected = await hmacHex(webhookSecret, rawBody);
  if (!timingSafeEqual(expected, signature.toLowerCase())) return json({ ok: false }, 400);

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: false }, 400);
  }
  if (event?.event !== "payment.captured") {
    return json({ ok: true, ignored: event?.event || "unknown" });
  }
  const entity = event?.payload?.payment?.entity;
  const payId = entity?.id;
  if (!payId) return json({ ok: false }, 400);

  // The website inserts the payments row at Checkout success; the webhook
  // only needs to fill the gap when that insert never happened (browser
  // closed mid-payment). Notes carry plan_id / user_id from Checkout.
  const { data: existing, error: readError } = await supabase
    .from("payments")
    .select("*")
    .eq("id", payId)
    .maybeSingle();
  if (readError) {
    console.error("razorpay-webhook: payments read failed", readError);
    return json({ ok: false }, 500);
  }
  if (!existing) {
    const planId = String(entity?.notes?.plan_id || "");
    let userId = String(entity?.notes?.user_id || "") || null;
    if (!userId && entity?.email) {
      const { data: user } = await supabase
        .from("users")
        .select("id")
        .ilike("email", String(entity.email).trim())
        .limit(1)
        .maybeSingle();
      if (user) userId = user.id;
    }
    const { error: insertError } = await supabase.from("payments").insert({
      id: payId,
      user_id: userId,
      plan_id: planId,
      amount: typeof entity?.amount === "number" ? entity.amount : 0,
      status: "captured",
    });
    if (insertError) {
      console.error("razorpay-webhook: payments insert failed", insertError);
      return json({ ok: false }, 500);
    }
  }
  try {
    const activated = await activatePayment(supabase, payId);
    return json({ ok: true, activated });
  } catch (e) {
    console.error("razorpay-webhook: webhook activation failed", e);
    return json({ ok: false }, 500);
  }
});

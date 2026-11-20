// TechnoTrade Academy — Razorpay webhook + Checkout verification + ₹1 trial.
//
// Trial model (Rupu, 2026-11-16 — FINAL): ₹1 for 1 DAY, then ONE automatic
// charge of ₹399, 1 month access, then it ends. No recurring subscription,
// no cancel flow. Mechanism: a Razorpay Subscription with total_count = 1,
// start_at = trial start + 24 h (a future start date IS Razorpay's trial
// mechanism), and an upfront ₹1 addon collected at authorisation.
//
// DEPLOY IS BLOCKED (2026-11-16): the live function URL 404s and Lovable has
// no manual deploy button. This code is written and committed, but NO trial
// endpoint exists until a deploy path is confirmed — do not claim trial
// billing works end-to-end until the function actually serves. See
// replica/build-log.md and replica/architecture.md § "Blocked / needs Rupu".
// UPDATE 2026-11-20: the ₹399/month Razorpay Plan now EXISTS
// (plan_U2UnYfLgRuZLOL) and is wired in below as the default; the deploy
// block above is the only thing still keeping the trial endpoints dark.
//
// Server-side paths (one shared activation step — create/extend the
// subscription, update-then-insert; subscriptions has NO unique constraint
// on user_id, so never upsert on user_id; same as the admin panel's
// createSubscription):
//
//  1. WEBHOOK (primary): Razorpay Dashboard -> Settings -> Webhooks posts
//     payment.captured + subscription.* events here. Verified with
//     HMAC-SHA256 of the RAW request body using the webhook secret
//     (RAZORPAY_WEBHOOK_SECRET). Every event is claimed in webhook_events
//     first (UNIQUE(provider, event_id)) — replays are no-ops. This is the
//     reliable path — it fires even if the learner closes the browser
//     mid-payment, and it is the server-side source of truth.
//
//  2. VERIFY (secondary): the learner website calls POST .../verify with
//     {razorpay_order_id, razorpay_payment_id, razorpay_signature} after a
//     successful one-time Checkout. Verified with HMAC-SHA256 of
//     "order_id|payment_id" (or just "payment_id" when no order was created)
//     using the Razorpay Key Secret (RAZORPAY_KEY_SECRET). Non-fatal for the
//     website — if this function is not deployed yet, the website falls back
//     to its payments-row check and manual admin confirmation.
//
//  3. TRIAL (new): POST .../trial/create (signed-in user, JWT) creates the
//     single-cycle Razorpay subscription and the trial_subscriptions row;
//     POST .../trial/verify verifies the subscription-Checkout signature —
//     NOTE the field order is the REVERSE of the one-time formula:
//     HMAC-SHA256(secret, "payment_id|subscription_id"); copying the old
//     formula rejects every genuine trial payment.
//     POST .../trial/reconcile fetches the live subscription from Razorpay
//     and syncs the local row (the fallback when a webhook is missed).
//     There is NO /trial/stop-charge route: the stop-upcoming-charge
//     control is a pending micro-decision (Rupu deciding) — hook only,
//     schema columns exist, no client button calls anything.
//
//  4. CONVERSION creates the subscriptions row ONLY. The referral system
//     was REMOVED ENTIRELY (redirect 2026-11-16): no referral call, no
//     referrer reward, no ₹200/₹500, no ₹5,000 milestone — anywhere.
//
// Secrets (set in Lovable dashboard -> Functions -> razorpay-webhook ->
// Secrets; NEVER in the repo, the admin panel, or browser code):
//   RAZORPAY_WEBHOOK_SECRET, RAZORPAY_KEY_SECRET,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//   RAZORPAY_TRIAL_PLAN_ID is an OPTIONAL override only: the ₹399/month
//   plan (plan_U2UnYfLgRuZLOL, created in the Razorpay Dashboard
//   2026-11-20) is the server-side default — see TRIAL_RAZORPAY_PLAN_ID
//   below. RAZORPAY_KEY_ID is likewise optional: Razorpay REST calls
//   resolve the public Key ID from payment_config (see apiKeyId()).
// The Key Secret is never the webhook secret and vice versa — Razorpay
// signs webhooks with the webhook secret, and Checkout handler signatures
// with the Key Secret.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLAN_DAYS: Record<string, number> = { monthly: 30, yearly: 365 };

// Trial constants (Rupu, 2026-11-16 — final; ₹399 is trial-conversion ONLY).
const TRIAL_FEE_PAISE = 100; // ₹1 upfront addon, collected at authorisation
const TRIAL_CONVERSION_PAISE = 39900; // ₹399 single auto-charge
const TRIAL_DURATION_MS = 24 * 3600 * 1000; // exactly 24 hours
const TRIAL_PLAN_ID = "monthly"; // the trial converts to Monthly only
// The Razorpay Plan the trial subscription is created on: "TechnoTrade
// academy", ₹399 every 1 month, created in the Razorpay Dashboard
// 2026-11-20. A Plan ID is an identifier, not a secret — safe as a
// server-side constant; it never leaves this function (Checkout receives
// only the subscription id + the public Key ID). The
// RAZORPAY_TRIAL_PLAN_ID secret, when set, overrides this default.
const TRIAL_RAZORPAY_PLAN_ID = "plan_U2UnYfLgRuZLOL";

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
// REFUSES kind='trial_fee' rows: the ₹1 trial fee never activates anything.
// (Trial conversion goes through convertTrial(), never through here.)
async function activatePayment(supabase: any, payId: string): Promise<boolean> {
  const { data: payment, error } = await supabase.from("payments").select("*").eq("id", payId).maybeSingle();
  if (error) throw error;
  if (!payment) return false;
  if (payment.status === "confirmed") return true;
  if (payment.status !== "captured") return false;
  if (payment.kind === "trial_fee") return false;
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

// ---- Razorpay REST (server-side only; Basic auth with Key ID + Key Secret) ----
async function razorpayRequest(
  keyId: string,
  keySecret: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const res = await fetch("https://api.razorpay.com/v1" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(keyId + ":" + keySecret),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Authenticate a browser caller: the JWT in the Authorization header.
// Returns the user id, or null when there is no valid session.
async function authedUserId(supabase: any, req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user.id as string;
}

// The public Key ID the browser needs for Checkout. Read from
// payment_config (admin panel) first; fall back to the RAZORPAY_KEY_ID
// secret. Never the Key Secret — that never leaves this function.
async function publicKeyId(supabase: any): Promise<string> {
  try {
    const { data } = await supabase.from("payment_config").select("key_id").limit(1).maybeSingle();
    if (data && data.key_id) return String(data.key_id);
  } catch { /* fall through to the env fallback */ }
  return Deno.env.get("RAZORPAY_KEY_ID") || "";
}

// ---- Trial helpers ----

// Flip created -> trial_active exactly once (conditional update, so the
// /trial/verify fast path and the subscription.authenticated webhook can
// both run — the second writer is a no-op). Sets the 24 h window from the
// authorisation moment and records the ₹1 trial_fee payment row.
async function activateTrial(
  supabase: any,
  trialRow: any,
  authAtMs: number,
  feePaymentId: string | null,
): Promise<any> {
  const started = new Date(authAtMs);
  const ends = new Date(authAtMs + TRIAL_DURATION_MS);
  const { data, error } = await supabase
    .from("trial_subscriptions")
    .update({
      status: "trial_active",
      razorpay_status: "authenticated",
      trial_started_at: started.toISOString(),
      trial_ends_at: ends.toISOString(),
      charge_at: ends.toISOString(),
      trial_fee_payment_id: feePaymentId,
    })
    .eq("id", trialRow.id)
    .eq("status", "created")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  const row = data || trialRow;
  if (feePaymentId) {
    // The ₹1 fee row is kind='trial_fee' — it can NEVER activate a plan
    // (activatePayment refuses it; the website's checkMyPayment must too).
    await supabase.from("payments").upsert({
      id: feePaymentId,
      user_id: trialRow.user_id,
      plan_id: TRIAL_PLAN_ID,
      amount: TRIAL_FEE_PAISE,
      status: "captured",
      kind: "trial_fee",
      trial_subscription_id: trialRow.id,
    }, { onConflict: "id" });
  }
  // Pre-charge reminder, delivered to the in-app inbox on next open
  // (audience 'trial' — the admin panel + audienceMatches() must learn it).
  // Best effort: a failed insert never blocks trial activation.
  try {
    await supabase.from("admin_notifications").insert({
      title: "Your ₹399 charge is tomorrow",
      message: "Your ₹1 trial ends " + ends.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) +
        ". ₹399 will be charged automatically then for 1 month of access. After that your access ends — no further charge.",
      audience: "trial",
    });
  } catch { /* reminder is best effort */ }
  return row;
}

// Convert a trial on the ₹399 charge: record the trial_charge payment and
// create the subscriptions row (30 days from the ACTUAL charge timestamp —
// a retry that succeeds on day 3 still gives a full month, just later).
// Creates the subscriptions row ONLY — no referral call: the referral
// system is REMOVED (redirect 2026-11-16).
async function convertTrial(
  supabase: any,
  trialRow: any,
  chargePaymentId: string,
  chargeAtMs: number,
): Promise<any> {
  const { data: existing } = await supabase
    .from("trial_subscriptions")
    .select("*")
    .eq("id", trialRow.id)
    .maybeSingle();
  const row = existing || trialRow;
  if (row.status === "converted") return row;
  await supabase.from("payments").upsert({
    id: chargePaymentId,
    user_id: row.user_id,
    plan_id: TRIAL_PLAN_ID,
    amount: TRIAL_CONVERSION_PAISE,
    status: "captured",
    kind: "trial_charge",
    trial_subscription_id: row.id,
  }, { onConflict: "id" });
  const expires = new Date(chargeAtMs + 30 * 86400000).toISOString();
  // Update-then-insert (same pattern as createSubscription): no unique
  // constraint on user_id in subscriptions.
  const subPayload = {
    user_id: row.user_id,
    plan_id: TRIAL_PLAN_ID,
    status: "active",
    expires_at: expires,
    trial_subscription_id: row.id,
  };
  const updated = await supabase.from("subscriptions").update(subPayload).eq("user_id", row.user_id).select("id");
  let subId: string | null = null;
  if (updated.error) throw updated.error;
  if (updated.data && updated.data.length) {
    subId = updated.data[0].id;
  } else {
    const inserted = await supabase.from("subscriptions").insert(subPayload).select("id").maybeSingle();
    if (inserted.error) throw inserted.error;
    subId = inserted.data ? inserted.data.id : null;
  }
  const { data, error } = await supabase
    .from("trial_subscriptions")
    .update({
      status: "converted",
      razorpay_status: "completed",
      charge_payment_id: chargePaymentId,
      subscription_id: subId,
    })
    .eq("id", row.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data || row;
}

// Sync a local trial row from Razorpay's live subscription state (the
// /trial/reconcile fallback and the subscription.completed handler share
// it). Returns the synced row, or null when Razorpay has no such sub.
async function syncTrialFromRazorpay(
  supabase: any,
  keyId: string,
  keySecret: string,
  trialRow: any,
): Promise<any | null> {
  const { status, data: sub } = await razorpayRequest(
    keyId, keySecret, "GET", "/subscriptions/" + encodeURIComponent(trialRow.razorpay_subscription_id),
  );
  if (status !== 200 || !sub || !sub.id) return null;
  const rzStatus = String(sub.status || "");
  const patch: Record<string, unknown> = { razorpay_status: rzStatus };
  if (rzStatus === "authenticated" && trialRow.status === "created") {
    // Mandate authorised but the verify/webhook flip never landed: the
    // authorisation time is the subscription's start... Razorpay reports
    // current_start/current_end for the cycle; the trial clock runs from
    // authorisation, which is start_at - 24 h for a future-start sub.
    const authMs = sub.start_at ? (Number(sub.start_at) - 24 * 3600) * 1000 : Date.now();
    const row = await activateTrial(supabase, trialRow, authMs, sub.payment_id || null);
    return row;
  }
  if (rzStatus === "pending" && trialRow.status !== "charge_pending" && trialRow.status !== "converted") {
    patch.status = "charge_pending";
  } else if (rzStatus === "halted" && trialRow.status !== "converted") {
    patch.status = "charge_failed";
    patch.last_charge_error = "Mandate charge failed after Razorpay retries.";
  } else if (rzStatus === "completed") {
    // The single charge happened. Find its payment via the subscription's
    // invoices, then convert (idempotent — convertTrial no-ops if done).
    if (trialRow.status !== "converted") {
      const inv = await razorpayRequest(
        keyId, keySecret, "GET",
        "/invoices?subscription_id=" + encodeURIComponent(trialRow.razorpay_subscription_id),
      );
      const items = Array.isArray(inv.data && inv.data.items) ? inv.data.items : [];
      const paid = items.find((i: any) => i && i.status === "paid" && i.payment_id);
      if (paid) {
        const chargeMs = paid.created_at ? Number(paid.created_at) * 1000 : Date.now();
        return await convertTrial(supabase, trialRow, String(paid.payment_id), chargeMs);
      }
      // Completed but no paid invoice found yet — record the mirror status
      // and let the next reconcile/webhook finish it.
      patch.status = "charge_pending";
    }
  }
  const { data, error } = await supabase
    .from("trial_subscriptions")
    .update(patch)
    .eq("id", trialRow.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data || trialRow;
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
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET") || "";
  const keyId = Deno.env.get("RAZORPAY_KEY_ID") || "";
  // Razorpay REST calls use the public Key ID as the Basic-auth username.
  // The canonical copy lives in payment_config (saved from the admin
  // panel — the same value Checkout uses), so resolve it from there
  // instead of requiring a separate RAZORPAY_KEY_ID secret.
  let apiKeyIdCache = "";
  const apiKeyId = async (): Promise<string> => {
    if (!apiKeyIdCache) apiKeyIdCache = keyId || (await publicKeyId(supabase));
    return apiKeyIdCache;
  };

  // ---- Trial routes (browser calls these with the user's JWT) ----
  if (url.pathname.endsWith("/trial/create")) {
    if (req.method !== "POST") return json({ ok: false }, 405);
    if (!keySecret) return json({ ok: false, error: "server_not_configured" }, 500);
    const userId = await authedUserId(supabase, req);
    if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
    // Env override wins; otherwise the ₹399 plan created 2026-11-20.
    const trialPlanId = Deno.env.get("RAZORPAY_TRIAL_PLAN_ID") || TRIAL_RAZORPAY_PLAN_ID;
    // One trial per user EVER: an existing row is returned, never a new mandate.
    const { data: existing } = await supabase
      .from("trial_subscriptions")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (existing) {
      return json({
        ok: true, existing: true, status: existing.status,
        subscription_id: existing.razorpay_subscription_id,
        trial_ends_at: existing.trial_ends_at, charge_at: existing.charge_at,
      });
    }
    // A user with an active paid plan does not need a trial.
    const { data: activeSub } = await supabase
      .from("subscriptions")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle();
    if (activeSub) return json({ ok: false, error: "already_subscribed" }, 409);
    const startAtSec = Math.floor(Date.now() / 1000) + 24 * 3600;
    const { status, data: sub } = await razorpayRequest(await apiKeyId(), keySecret, "POST", "/subscriptions", {
      plan_id: trialPlanId,
      total_count: 1, // single billing cycle — Razorpay itself ends it after one charge
      quantity: 1,
      start_at: startAtSec, // future start = the 24 h trial
      addons: [{ item: { name: "Trial fee", amount: TRIAL_FEE_PAISE, currency: "INR" } }],
      notes: { user_id: userId, plan_id: TRIAL_PLAN_ID, conversion_amount_paise: TRIAL_CONVERSION_PAISE },
      customer_notify: 1,
    });
    if (status !== 200 && status !== 201 || !sub || !sub.id) {
      console.error("razorpay-webhook: subscription create failed", status, sub);
      return json({ ok: false, error: "razorpay_create_failed" }, 502);
    }
    const chargeAt = new Date(startAtSec * 1000).toISOString();
    const { data: row, error: insErr } = await supabase
      .from("trial_subscriptions")
      .insert({
        user_id: userId,
        razorpay_subscription_id: String(sub.id),
        razorpay_plan_id: trialPlanId,
        plan_id: TRIAL_PLAN_ID,
        status: "created",
        razorpay_status: String(sub.status || "created"),
        trial_fee_paise: TRIAL_FEE_PAISE,
        conversion_amount_paise: TRIAL_CONVERSION_PAISE,
        charge_at: chargeAt,
      })
      .select("*")
      .maybeSingle();
    if (insErr) {
      // Lost a race with a concurrent create (UNIQUE(user_id)): return the
      // row that won instead of failing.
      const { data: raced } = await supabase.from("trial_subscriptions").select("*").eq("user_id", userId).maybeSingle();
      if (raced) {
        return json({
          ok: true, existing: true, status: raced.status,
          subscription_id: raced.razorpay_subscription_id,
          trial_ends_at: raced.trial_ends_at, charge_at: raced.charge_at,
        });
      }
      console.error("razorpay-webhook: trial row insert failed", insErr);
      return json({ ok: false, error: "trial_row_failed" }, 500);
    }
    return json({
      ok: true, existing: false, status: "created",
      subscription_id: String(sub.id),
      key_id: await publicKeyId(supabase),
      trial_ends_at: chargeAt, charge_at: chargeAt,
    });
  }

  if (url.pathname.endsWith("/trial/verify")) {
    if (req.method !== "POST") return json({ ok: false }, 405);
    if (!keySecret) return json({ ok: false, error: "server_not_configured" }, 500);
    const userId = await authedUserId(supabase, req);
    if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
    let body: any;
    try { body = await req.json(); } catch { return json({ ok: false }, 400); }
    const payId = String(body?.razorpay_payment_id || "");
    const subId = String(body?.razorpay_subscription_id || "");
    const signature = String(body?.razorpay_signature || "");
    if (!payId || !subId || !signature) return json({ ok: false }, 400);
    // Subscription Checkout signs payment_id|subscription_id — the REVERSE
    // of the one-time order formula. Do not merge the two verify paths.
    const expected = await hmacHex(keySecret, payId + "|" + subId);
    if (!timingSafeEqual(expected, signature.toLowerCase())) return json({ ok: false }, 400);
    const { data: row } = await supabase
      .from("trial_subscriptions")
      .select("*")
      .eq("razorpay_subscription_id", subId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!row) return json({ ok: false, error: "trial_not_found" }, 404);
    try {
      const activated = await activateTrial(supabase, row, Date.now(), payId);
      return json({ ok: true, status: activated.status || "trial_active", trial_ends_at: activated.trial_ends_at });
    } catch (e) {
      console.error("razorpay-webhook: trial verify activation failed", e);
      return json({ ok: false }, 500);
    }
  }

  if (url.pathname.endsWith("/trial/reconcile")) {
    if (req.method !== "POST") return json({ ok: false }, 405);
    if (!keySecret) return json({ ok: false, error: "server_not_configured" }, 500);
    const userId = await authedUserId(supabase, req);
    if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
    let body: any;
    try { body = await req.json(); } catch { return json({ ok: false }, 400); }
    const trialId = String(body?.trial_subscription_id || "");
    if (!trialId) return json({ ok: false }, 400);
    const { data: row } = await supabase
      .from("trial_subscriptions")
      .select("*")
      .eq("id", trialId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!row) return json({ ok: false, error: "trial_not_found" }, 404);
    try {
      const synced = await syncTrialFromRazorpay(supabase, await apiKeyId(), keySecret, row);
      if (!synced) return json({ ok: false, error: "razorpay_not_found" }, 502);
      return json({ ok: true, status: synced.status, charge_at: synced.charge_at, charge_payment_id: synced.charge_payment_id || null });
    } catch (e) {
      console.error("razorpay-webhook: trial reconcile failed", e);
      return json({ ok: false }, 500);
    }
  }

  // ---- Path 2: Checkout handler-signature verification (website calls this) ----
  if (url.pathname.endsWith("/verify")) {
    if (req.method !== "POST") return json({ ok: false }, 405);
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

  // ---- Path 1: Razorpay dashboard webhook ----
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
  const eventId = req.headers.get("x-razorpay-event-id") || "";
  const eventType = String(event?.event || "unknown");
  // Claim the event FIRST: Razorpay redelivers 2-5x; a replay is a no-op.
  if (eventId) {
    const { error: claimErr } = await supabase.from("webhook_events").insert({
      provider: "razorpay", event_id: eventId, event_type: eventType, payload: event,
    });
    if (claimErr) {
      // 23505 = already claimed (replay). Any other insert failure is fatal.
      if (String((claimErr as any).code || "") === "23505") {
        return json({ ok: true, ignored: "duplicate" });
      }
      console.error("razorpay-webhook: webhook_events claim failed", claimErr);
      return json({ ok: false }, 500);
    }
  }
  const markProcessed = async (err?: string) => {
    if (!eventId) return;
    await supabase.from("webhook_events")
      .update({ processed_at: new Date().toISOString(), error: err || null })
      .eq("provider", "razorpay").eq("event_id", eventId);
  };

  // ---- Subscription events (trial lifecycle) ----
  if (eventType.startsWith("subscription.")) {
    const subEntity = event?.payload?.subscription?.entity;
    const subRzId = String(subEntity?.id || "");
    if (!subRzId) { await markProcessed("missing subscription id"); return json({ ok: false }, 400); }
    const { data: trialRow } = await supabase
      .from("trial_subscriptions")
      .select("*")
      .eq("razorpay_subscription_id", subRzId)
      .maybeSingle();
    if (!trialRow) {
      // Not one of our trials (e.g. a subscription created elsewhere) — ignore.
      await markProcessed();
      return json({ ok: true, ignored: "not_a_trial" });
    }
    try {
      if (eventType === "subscription.authenticated") {
        const authMs = event?.created_at ? Number(event.created_at) * 1000 : Date.now();
        const feePayId = String(subEntity?.payment_id || "") || null;
        await activateTrial(supabase, trialRow, authMs, feePayId);
      } else if (eventType === "subscription.charged") {
        const payEntity = event?.payload?.payment?.entity;
        const chargePayId = String(payEntity?.id || "");
        if (!chargePayId) { await markProcessed("missing charge payment id"); return json({ ok: false }, 400); }
        const chargeMs = payEntity?.created_at ? Number(payEntity.created_at) * 1000 : Date.now();
        await convertTrial(supabase, trialRow, chargePayId, chargeMs);
      } else if (eventType === "subscription.pending") {
        if (trialRow.status !== "converted") {
          await supabase.from("trial_subscriptions").update({ status: "charge_pending", razorpay_status: "pending" }).eq("id", trialRow.id);
        }
      } else if (eventType === "subscription.halted") {
        if (trialRow.status !== "converted") {
          await supabase.from("trial_subscriptions").update({
            status: "charge_failed", razorpay_status: "halted",
            last_charge_error: "The automatic ₹399 charge failed after Razorpay retries.",
          }).eq("id", trialRow.id);
        }
      } else if (eventType === "subscription.completed") {
        // Confirms the single charge is done and nothing further can ever
        // be charged. If the charged event was missed, sync from Razorpay.
        if (trialRow.status !== "converted") {
          await syncTrialFromRazorpay(supabase, await apiKeyId(), keySecret, trialRow);
        } else {
          await supabase.from("trial_subscriptions").update({ razorpay_status: "completed" }).eq("id", trialRow.id);
        }
      } else if (eventType === "subscription.cancelled") {
        // HOOK ONLY — no client control cancels a trial (Rupu deciding).
        // If Razorpay ever reports cancelled, mirror it as charge_stopped.
        if (trialRow.status !== "converted") {
          await supabase.from("trial_subscriptions").update({ status: "charge_stopped", razorpay_status: "cancelled" }).eq("id", trialRow.id);
        }
      }
      await markProcessed();
      return json({ ok: true });
    } catch (e) {
      console.error("razorpay-webhook: subscription event failed", eventType, e);
      await markProcessed(String((e as any)?.message || e));
      return json({ ok: false }, 500);
    }
  }

  // ---- payment.captured (existing one-time flow, unchanged) ----
  if (event?.event !== "payment.captured") {
    await markProcessed();
    return json({ ok: true, ignored: event?.event || "unknown" });
  }
  const entity = event?.payload?.payment?.entity;
  const payId = entity?.id;
  if (!payId) { await markProcessed("missing payment id"); return json({ ok: false }, 400); }

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
    await markProcessed(String(readError.message || readError));
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
      kind: "plan_purchase",
    });
    if (insertError) {
      console.error("razorpay-webhook: payments insert failed", insertError);
      await markProcessed(String(insertError.message || insertError));
      return json({ ok: false }, 500);
    }
  }
  try {
    const activated = await activatePayment(supabase, payId);
    await markProcessed();
    return json({ ok: true, activated });
  } catch (e) {
    console.error("razorpay-webhook: webhook activation failed", e);
    await markProcessed(String((e as any)?.message || e));
    return json({ ok: false }, 500);
  }
});

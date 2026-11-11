# Razorpay webhook — deploy steps

## 1. Add the Key ID column (do this FIRST)

Run this in the **Lovable SQL editor** (direct SQL, not a migration file):

```sql
ALTER TABLE public.payment_config ADD COLUMN IF NOT EXISTS key_id text;
```

The learner site reads `payment_config.key_id` and the admin panel saves to
it. Until this column exists, the admin panel's Save fails — so run the SQL
before publishing the site/admin changes.

## 2. Deploy this function

Lovable dashboard → Functions → `razorpay-webhook` → Deploy.
(Or from a terminal with the Supabase CLI: `supabase functions deploy razorpay-webhook`.)

## 3. Set the function secrets

Lovable dashboard → Functions → `razorpay-webhook` → Secrets. All four are
needed; none of them ever goes in the repo, the admin panel, or browser code:

- `RAZORPAY_WEBHOOK_SECRET` — from Razorpay Dashboard → Settings → Webhooks.
  It is shown once when the webhook (step 4) is created. This is NOT the
  Key Secret.
- `RAZORPAY_KEY_SECRET` — from Razorpay Dashboard → Settings → API Keys.
  Used only to verify Checkout handler signatures (`/verify` path).
- `SUPABASE_URL` — `https://kgoptzoxvcfianbrlpsz.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase project service-role key (bypasses
  RLS so the webhook can write subscriptions).

## 4. Register the webhook in Razorpay

Razorpay Dashboard → Settings → Webhooks → Add New Webhook:

- URL: `https://kgoptzoxvcfianbrlpsz.supabase.co/functions/v1/razorpay-webhook`
- Events: `payment.captured` only.
- Copy the webhook secret shown after creation into
  `RAZORPAY_WEBHOOK_SECRET` (step 3).

## 5. Test (₹1)

1. Paste the LIVE Key ID (`rzp_live_…`) in the admin panel → Razorpay tab →
   Save. (Only the Key ID goes in the panel — never the Key Secret.)
2. On the website, buy the Monthly plan and pay ₹1 via Checkout.
   The webhook marks the payment confirmed and activates the subscription
   automatically — no admin confirm needed.
3. Until the webhook is live, the admin confirms payments manually in the
   admin panel → Payments tab (that flow is unchanged).

## How it works

- **Webhook path** (`POST /razorpay-webhook`): Razorpay posts
  `payment.captured` events. The signature in the
  `x-razorpay-signature` header is HMAC-SHA256 of the raw request body
  with the **webhook secret**. On success the function activates the
  subscription (update-then-insert — subscriptions has no unique
  constraint on `user_id`) and marks the payment `confirmed`. A missing
  payments row is recreated from the event (plan/user from the Checkout
  notes); an already-confirmed payment is a no-op.
- **Verify path** (`POST /razorpay-webhook/verify`): the website calls this
  right after Checkout success with
  `{razorpay_order_id, razorpay_payment_id, razorpay_signature}`. The
  signature is HMAC-SHA256 of `order_id|payment_id` (or just `payment_id`
  when no order was created) with the **Key Secret**. This path is
  best-effort — the website falls back to its payments-row check and
  manual admin confirmation if the function is not deployed yet.

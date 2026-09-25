# TixWave.party setup

TixWave.party is a pure HTML/CSS/JS ticket marketplace for nightclub and live events. It uses Supabase for Auth, database storage, and Edge Functions, plus Stripe Checkout for payments.

## Files

- `index.html` — homepage, search, country filters, featured events from Supabase
- `event.html` — event details and ticket purchase flow
- `checkout-success.html` — post-payment ticket display with QR codes
- `my-tickets.html` — buyer login and ticket wallet
- `scanner.html` — mobile door scanner using device camera
- `admin.html` — simple PIN-protected event/order/commission admin panel
- `supabase-schema.sql` — database tables, indexes, policies, helper function, and seed demo events
- `supabase/functions/create-ticket-checkout/index.ts` — creates Stripe Checkout sessions
- `supabase/functions/ticket-webhook/index.ts` — handles `checkout.session.completed`, creates tickets, updates sales counts
- `supabase/functions/validate-ticket/index.ts` — validates and marks QR tickets as used

## 1. Run the database SQL

Open the Supabase SQL Editor for project:

```text
https://nmusxculduptvefgqfjn.supabase.co
```

Paste and run `supabase-schema.sql`.

The schema includes a `public_order_token` on `orders` so the checkout success page can display tickets immediately after Stripe redirects the buyer, without requiring login.

## 2. Deploy Edge Functions

Create these Supabase Edge Functions and paste each `index.ts` file into its matching folder/name:

```text
create-ticket-checkout
ticket-webhook
validate-ticket
```

Recommended Supabase CLI commands if you are deploying locally:

```bash
supabase functions deploy create-ticket-checkout
supabase functions deploy ticket-webhook --no-verify-jwt
supabase functions deploy validate-ticket --no-verify-jwt
```

Set these Supabase secrets:

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_or_test_xxx
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
supabase secrets set TIXWAVE_SITE_URL=https://tixwave.party
supabase secrets set SCANNER_PIN=2468
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are normally available automatically in Supabase Edge Functions. If your project does not inject them, add them as secrets too.

## 3. Stripe webhook setup

In Stripe Dashboard → Developers → Webhooks, add this endpoint:

```text
https://nmusxculduptvefgqfjn.supabase.co/functions/v1/ticket-webhook
```

Subscribe to:

```text
checkout.session.completed
```

Copy the webhook signing secret into Supabase as `STRIPE_WEBHOOK_SECRET`.

## 4. Supabase Auth setup

For magic-link login on `my-tickets.html`, add these redirect URLs in Supabase Auth URL configuration:

```text
https://tixwave.party/my-tickets.html
https://tixwave.party/
```

## 5. Domain deployment

Upload all HTML files in this folder to your static host and point `tixwave.party` to it. Make sure the deployed URLs are:

```text
https://tixwave.party/index.html
https://tixwave.party/event.html?id=EVENT_ID
https://tixwave.party/checkout-success.html
https://tixwave.party/my-tickets.html
https://tixwave.party/scanner.html
https://tixwave.party/admin.html
```

## 6. Important production notes

- Change `ADMIN_PIN` inside `admin.html` before publishing. The current value is `2468` for quick setup.
- The included admin panel is intentionally simple and client-side PIN protected. For production, move admin operations behind authenticated Supabase users or an admin Edge Function before opening access beyond trusted users.
- The scanner is protected by `SCANNER_PIN`; keep the scanner URL and PIN private for door staff.
- The checkout function currently creates Stripe line items dynamically in EUR. If you want country-specific currency later, add a `currency` column to `ticket_types` or `events`.

# Tixwave — testing preview

Static Cloudflare Pages site with Supabase Auth/database/Edge Functions and Stripe Checkout. Keep Stripe in test mode until the full flow has been verified. The public site labels itself as a testing preview.

## Production database

Apply `supabase/migrations/20261008_ticket_safety.sql` **once** to the existing project, not the original prototype schema. The original `supabase-schema.sql` is historical and contains unsafe prototype permissions; never run it on production. The migration preserves events and tickets, removes public admin access, and assigns the confirmed `sikadwaquophi20@gmail.com` user as administrator. Signup metadata never grants administrator access.

## Payment functions

Deploy `create-ticket-checkout`, `ticket-webhook`, `validate-ticket`, `promoter-connect`, and `release-promoter-funds`. JWT verification is handled by Supabase for user endpoints and additionally verified in each function. Webhooks verify Stripe signatures. Scanner requests require authorised event staff or an administrator, and a specific event ID.

Supabase secrets required:

- `STRIPE_SECRET_KEY`: the shared account's **test** key during testing.
- `STRIPE_MODE`: `test` by default. Change to `live` only with a live key at launch.
- `STRIPE_WEBHOOK_SECRET`: signing secret for the matching test/live Tixwave endpoint.
- `TIXWAVE_SITE_URL`: `https://tixwave.party`.
- `RESEND_API_KEY` and `TIXWAVE_EMAIL_FROM`: email key and a sender on a verified domain.

Never commit secret values. Browser key fields must be entered by the account owner.

Stripe webhook endpoint: `https://lantiwcpwkfjmqjgvhbg.supabase.co/functions/v1/ticket-webhook`. Subscribe to `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded`, and `charge.dispute.created`. Checkout events with no `platform=tixwave` metadata are ignored so Afro-Mkt transactions do not create Tixwave orders. Tixwave Checkout and PaymentIntent records carry platform, event and order metadata; transfers also carry Tixwave metadata.

## Promoters and funds

`promoter.html` accepts authenticated event submissions and sends promoters to Stripe Express onboarding. Administrator approves submissions from `admin.html`. Tixwave keeps 5% of gross paid ticket revenue; Stripe processing fees currently debit the platform account. The remainder is released by an administrator only after the recorded event end time and confirmation that the event finished. Promoter verification must be complete. Refunded/disputed orders are blocked; an ambiguous or in-progress transfer is paused for reconciliation rather than blindly retried. Stripe transfer does not guarantee immediate bank payout.

Delaying transfers does **not** remove platform chargeback liability. The shared Stripe balance may be debited for refunds/disputes. Review transfer status, payment disputes and refunds in Stripe before releasing funds. Stripe's funds-holding/cross-border eligibility rules still apply. No real transfer has been executed during development.

## Reservations and fulfilment

Stock is reserved under a database lock before Checkout is created. A reservation is released only after Stripe confirms session expiration/failure. Confirmed paid orders, tickets and sold inventory are updated in one transaction. Retries do not duplicate tickets. Ticket emails use an idempotency key. Network-ambiguous Checkout creation and transfer requests retain their reservation/claim for administrator reconciliation. Alert on pending orders with expired sessions and failed webhook deliveries; expire confirmed-open orphan sessions in Stripe before cancelling their reservations.

Door staff accounts are assigned in `event_staff` by an administrator; staff cannot admit another event's tickets. Do not share administrator credentials. The former scanner PIN is no longer used.

## Hosting and checks

Build: `node scripts/build.mjs`; output: `dist`. Only public HTML/assets/headers are copied. Do not publish backend source directories as static assets. Auth redirect URLs should include `/my-tickets.html` and `/reset-password.html`.

Tests: `node --test tests/*.test.mjs` with `@electric-sql/pglite` installed. Tests cover database access, reservations, payment amount checks, duplicate fulfilment, scans, webhook signatures and unpaid/expired sessions. Before launch, run a Stripe **test** purchase, receive the email, display its QR, scan once and confirm a second scan is rejected; test a refund and post-event release using test accounts. Complete legal/operator disclosures and confirm real event details before removing the preview notice. Demo seeds are excluded from the homepage without deleting them.

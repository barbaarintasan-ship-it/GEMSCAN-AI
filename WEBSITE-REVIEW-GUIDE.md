# GemScan AI — Website Review Guide

A new `web/` Next.js application has been scaffolded **alongside** the existing
mobile app. Nothing has been committed or merged. The mobile app was **not**
modified by the website work. Both frontends share the same Supabase backend.

---

## 1. What was built

A separate Next.js 15 (App Router) website using `@supabase/ssr`, decoupled from
the mobile app but pointing at the same Supabase project and Edge Functions.

### Responsibilities delivered
| Area | Route(s) |
| --- | --- |
| Authentication | `/login`, `/signup`, `/auth/confirm` (callback) |
| Email verification | `/verify-email` + `/auth/confirm` (verifies token) |
| Password reset | `/forgot-password`, `/update-password` |
| User profile | `/account` (display name, email, language) |
| Subscription management | `/account/subscription` |
| Stripe checkout | server action → `create-checkout-session` Edge Function |
| Mobile-money checkout | `/checkout/mobile-money` |
| Marketing home | `/` |
| Pricing | `/pricing` |
| FAQ | `/faq` |
| Privacy Policy | `/privacy` |
| Terms of Service | `/terms` |
| Download links (Android/iOS) | `/download` |

### Architecture (kept modular)
- **Pure frontend over the existing backend.** No backend logic is duplicated.
  The website calls the existing Edge Functions and reads/writes the same
  Supabase tables (subject to the existing RLS).
- **Payments only on the website.** Card checkout redirects to the hosted Stripe
  Checkout returned by `create-checkout-session`. The `subscriptions` table is
  only ever written by service-role webhooks (`stripe-webhook`,
  `mobile-money-webhook`) — the website never grants entitlement itself.
- **Session handling** via `web/middleware.ts` → `updateSession()` (refreshes
  Supabase cookies, guards `/account`).

---

## 2. How to run it locally

```bash
cd web
npm install          # already run
npm run dev          # http://localhost:3000
```

Environment lives in `web/.env.local` (already populated with the real Supabase
URL + publishable key). Optional/blank until you have them:
- `NEXT_PUBLIC_ANDROID_URL`, `NEXT_PUBLIC_IOS_URL` — store links for `/download`.
- `SUPABASE_FUNCTIONS_URL` — base URL of the Edge Functions (needed for real
  checkout). Without it, checkout shows a graceful "not configured" message.

Production build is verified: `npm run build` compiles all 18 routes with no
type errors.

---

## 3. Suggested review flow

1. **Marketing** — visit `/`, `/pricing`, `/faq`, `/download`, `/privacy`,
   `/terms`. Confirm copy, pricing ($0 / $25yr / $75 lifetime / custom), and the
   "not a certified appraisal" disclaimers read correctly.
2. **Sign up** — `/signup` → creates the Supabase user → lands on
   `/verify-email`. Check the confirmation email; its link hits `/auth/confirm`.
3. **Sign in** — `/login` → `/account`.
4. **Profile** — edit display name + language, save.
5. **Subscription** — `/account/subscription` shows your current tier and the
   upgrade options. "Pay by card" and "Pay by mobile money" are wired to the
   flows below.
6. **Password reset** — `/forgot-password` → email → `/update-password`.

---

## 4. Backend notes / gaps to confirm before go-live

These are **not** website bugs — they're integration points to confirm on the
backend side:

- **`SUPABASE_FUNCTIONS_URL`** must be set for real checkout to fire. The Stripe
  card flow reuses the existing `create-checkout-session` function (JWT-bearing
  POST `{ plan }`, returns `{ url }`), and its success/cancel URLs already match
  `/account/subscription?status=success` and `/pricing?status=canceled`.
- **Mobile-money initiation** posts to a `mobile-money-checkout` Edge Function
  (the counterpart to the existing `mobile-money-webhook`). If that function is
  not deployed yet, the page still works and shows a "pending" message — the
  webhook remains the only writer of `subscriptions`. Deploy the initiation
  function to make the prompt actually fire on the user's phone.
- Confirm the Supabase **Auth redirect allow-list** includes
  `http://localhost:3000/auth/confirm` (and later the production domain) so email
  links resolve.

---

## 5. What was NOT done (per your instructions)

- No commit, no merge, no branch pushed.
- `supabase/agent-skills` was **not** installed.
- The mobile app source was not modified for the website work.

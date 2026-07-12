# 05 — Monetization Strategy, Payments, Legal/Policy Risk

## Pricing (as specified)
- **Free** — 5 scans/day (Tier-1 single-model, per §03)
- **Premium** — $25/year
- **Lifetime** — $75
- **Professional** — custom/higher tier for jewelers: inventory management + PDF reports (recommend usage-based or per-seat add-on pricing given the multi-user org model in §04 — price this against the $1,500–12,450+ incumbents in §01, where GemScan AI can undercut dramatically while offering more)
- **Ask a Real Gemologist** — per-consult fee, on-demand human escalation (§03 §4) — a new transactional revenue line, not just a cost center.

## Additional commercial opportunities (from architecture self-review, §08)
- **B2B API/white-label licensing** — license the identification engine itself to the jeweler/pawn inventory incumbents named in §01 (Bravo, The Edge, Jewel360, Gem Logic), all of which are "appraisal-blind" today. Turns a competitive gap into a high-margin distribution channel with minimal added CAC.
- **Hardware-companion partnership** — Presidium and AuRACLE (the dominant professional testers) have no digital/reporting layer at all; positioning GemScan AI as their companion app for capturing readings and generating PDF reports is a concrete, unfilled partnership target.
- **Insurance-adjacent referral product** — fast, disclaimed provisional valuations as input to renters/homeowners jewelry insurance riders; a later-phase opportunity once the accuracy track record is established.
- **Aggregate/anonymized insights** — coarse (never precise-location, per the fuzzing policy below), regional trend data sold to geological surveys, tourism boards, or educational publishers.

## ✅ FINAL DECISION (locked, do not redesign)

Per explicit owner direction, the payment model is fixed as follows and all architecture/code follows this without exception:

- **All payments happen ONLY on the official website.**
- The mobile app **never** processes payments, **never** sells subscriptions, **never** implements Google Play Billing, **never** implements Apple In-App Purchase.
- The mobile app's only responsibilities regarding monetization are: user authentication, secure login, verifying subscription status from the backend, and unlocking premium features after successful server-side verification.
- The subscription backend is fully independent of any app store (Apple/Google are never a source of truth for entitlement).
- Website checkout supports: Stripe, Visa, Mastercard, Amex, PayPal, Apple Pay (web), Google Pay (web), EVC Plus, Zaad, Sahal, eDahab, bank transfer.

This is implemented in code as: (a) the mobile app bundle contains **zero** billing/IAP libraries — enforced by an automated dependency check (see §Implementation Notes below), and (b) every premium-gated feature in the app checks entitlement exclusively via a server-side `verify-subscription` call, never a local/cached flag alone.

## ⚠️ Documented policy implications (informational — the decision above stands regardless)

Because this is a firm decision, the purpose of this section is purely to make the real-world consequences visible so they can be planned around, not to reopen the choice.

**Apple App Store (iOS) — highest risk.** Guideline 3.1.1 requires apps that unlock digital content/subscriptions to sell that access via Apple's In-App Purchase, and 3.1.3(a)'s "Reader app" exemption (Netflix/Spotify-style login-only access) is narrowly scoped to magazines, newspapers, books, audio, music, and video apps. An AI identification/SaaS tool does not clearly qualify for that exemption, so **a version of GemScan AI that lets a user log in and unlock premium features purchased on the website, with no in-app purchase path at all, carries a real risk of App Store rejection or later removal.** The 2024–2026 "External Purchase Link" entitlement (post Epic v. Apple, plus EU DMA compliance) only helps in specific storefronts (US, EU, and a few narrower cases like Japan/South Korea/NL-dating-apps) and even there requires an approved entitlement, specific in-app disclosure UI, and Apple still takes a reduced commission on qualifying purchases — it does not create a universal safe harbor, and this product's requirement (no purchase link/CTA of any kind in-app) doesn't fully rely on that entitlement anyway since no external link is shown in-app either.

**Google Play (Android) — materially lower risk.** Google Play's policies are more permissive globally: apps can support external account/subscription systems more readily (a pattern closer to how many utility/B2B and "bring your own subscription" apps already ship), and Google has broader allowances for external payment links in various markets since 2024. This does not eliminate risk entirely, but Android is the safer of the two platforms for this exact model.

**Practical implication — plan for iOS review risk, don't redesign around it.** Given the decision above is final, the realistic ways to manage the iOS risk without changing the payment architecture are:
1. **Submit as-is and monitor review outcome.** Many "verify an external account" utility/B2B apps do pass App Store review without incident, particularly outside consumer-subscription-first categories — outcomes vary by reviewer and category framing, so this is a real possibility, not a guaranteed rejection.
2. **Position the iOS App Store listing carefully** (e.g., emphasize the free tier and utility/professional framing over subscription-selling language) to reduce the chance of being flagged under 3.1.1 during review, while keeping the actual entitlement logic identical to Android.
3. **If Apple rejects or removes the app**, the fallback distribution paths for iOS specifically (not required now, but documented so they're ready if needed) are: **Apple's own EU alternative distribution / marketplace framework** (available under the EU Digital Markets Act for EU users, allowing a compliant path outside the standard App Store review model), **a Progressive Web App (PWA)** version of the mobile experience (installable from Safari, fully outside App Store review entirely, since it's not a native binary), or **TestFlight/enterprise distribution** for professional-tier B2B customers (jewelers/pawn shops) who can be onboarded outside the public consumer App Store. None of these are being built now — they're documented contingencies, not part of the current implementation scope.
4. **Android and the website remain the primary, lowest-risk distribution channels** for this payment model; iOS is treated as "attempt App Store distribution, with PWA as the documented fallback if it's ever rejected."

## Implementation notes (how the separation is enforced in code, not just policy)
- The mobile app repository has **zero dependency** on `react-native-iap`, `expo-in-app-purchases`, `react-native-purchases` (RevenueCat), or any Google Play Billing / StoreKit wrapper. A CI/pre-commit check fails the build if any of these packages appear in `package.json` (see the mobile app's `scripts/check-no-billing-deps.js`).
- The only network calls the mobile app makes related to entitlement are to the backend's `verify-subscription` endpoint (reads current tier/status) — it never calls Stripe, PayPal, or any payment processor directly, and holds no payment API keys.
- All payment processor keys (Stripe secret key, PayPal client secret, mobile money gateway credentials) live only in the website/backend's server environment, never in the mobile app bundle.

## Payment rails (website checkout)
- **Cards/global:** Stripe (Visa/Mastercard/Amex), PayPal, Apple Pay & Google Pay **on the website** (both are fully compliant when used in a browser checkout, not inside the native app UI).
- **Somali mobile money:** Zaad (Telesom), EVC Plus (Hormuud), Sahal (Golis), eDahab — these are typically integrated via a payment aggregator/gateway (e.g., Hormuud's WaafiPay, or a similar licensed Somali payment gateway partner) rather than direct per-carrier integration; **recommend a dedicated technical/legal review with a Somali fintech integration partner before committing to a specific vendor**, since gateway availability and commercial terms in this market change and weren't verified as part of this research pass.
- **Bank transfer:** manual/semi-automated reconciliation for professional-tier B2B customers (common for jeweler SaaS deals per the incumbents in §01, several of which use custom-quote/invoice billing).

## Legal/compliance notes carried over from other sections
- **No output is a certified appraisal** — every result screen and PDF report must carry an explicit, unavoidable disclaimer (not buried in a ToS) that GemScan AI does not replace a certified gemologist appraisal, insurance valuation, or lab report (GIA/AGS/Gübelin/SSEF).
- **Data licensing audit trail** (§04 `source_attribution` field) exists specifically to defend commercial use of reference content if ever challenged by a data source.
- **Mindat partnership** should be pursued with a written commercial license before any Mindat-derived data or imagery ships in a paid product (§03).
- **GDPR/CCPA-style data rights** — right to access/export/delete scan history, collection, and inventory data; location data opt-in only.

## Additional legal/compliance items (from architecture self-review, §08)
- **Transactional-reliance liability.** Target users explicitly include pawn shops and gold traders who may use scan output to make real purchase/sale decisions — materially higher liability exposure than a hobbyist checking a rock. Terms of Service must explicitly disclaim reliance on the app for financial/transactional decisions; professional-tier contracts should carry a liability cap; evaluate E&O/product liability insurance before the professional tier launches.
- **Location-fuzzing policy.** Rare mineral find-sites have a documented real-world looting/poaching risk once precise coordinates leak. Full-precision location is retained only in the user's own private scan/collection record; any current or future public/shareable surface (community features, aggregate insights) shows only a coarse, fuzzed region by default.
- **Age-gating.** Students are a named target user, so under-13 users are plausible — add an age gate at signup and restrict data collection (location capture, chat history retention) accordingly for accounts under the relevant threshold (COPPA and equivalent regimes).
- **Trademark clearance for "GemScan AI"** has not been verified as part of this research — check before material marketing spend.

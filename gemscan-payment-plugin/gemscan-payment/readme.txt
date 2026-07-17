=== GemScan Payments ===
Version: 1.9.1
Requires: WordPress 5.5+
License: GPL-2.0+

The GemScan landing + pricing + payment page for your WordPress site
(e.g. https://barbaarintasan.com/gemscanpayment), plus the bridge that upgrades
a member's account after payment. It does NOT touch the mobile app.

== Install ==
1. WordPress admin → Plugins → Add New → Upload Plugin → choose gemscan-payment.zip → Install → Activate.
2. Go to Settings → GemScan and fill in:
   - Prices (Explorer, Gem Collector, credits) and currency.
   - Stripe Publishable Key (pk_live_…) and Stripe Secret Key (sk_live_…) for
     card payments. (The secret key is stored server-side and never displayed.)
     A Stripe Payment Link URL is still supported as a fallback if you leave the
     keys empty.
   - EVC Plus / eDahab / Zaad / Sahal numbers (Somalia).
   - Expert WhatsApp number (digits only, e.g. 252907790584).
   - Notify email (where mobile-money confirmations are sent).
   - App backend Functions URL:  https://znqkzgswvhbkhxldbbld.functions.supabase.co
   - Activation secret:  (the ACTIVATION_SECRET value you were given)
3. Create a Page called "GemScan Payment", set its permalink to "gemscanpayment",
   and put this shortcode in the content:

       [gemscan_payment]

   Publish. Your page is live at /gemscanpayment.
4. (Optional, recommended) To hide your theme's header/footer and show a
   clean GemScan-only page: edit the page → in the page settings sidebar
   set Template to "GemScan — Full page (no header/footer)" → Update.

== How payment + activation works ==
- The member enters their GemScan email, picks a plan, and pays:
  * International (Stripe keys): "Pay with Card" opens Stripe Checkout. When the
    payment succeeds, the plugin verifies it and upgrades the account
    AUTOMATICALLY — no manual step. The app shows Premium on next open.
  * Somalia (mobile money): the page shows clear numbered steps (in Somali &
    English) — send the exact plan amount to your EVC Plus / eDahab / Zaad /
    Sahal number, copy the Transaction ID (Tixraac Lambar) from the SMS receipt,
    and submit it with their name + GemScan email in the confirmation form. That
    emails you the details PLUS a one-click link to Settings → GemScan → Activate,
    so you can verify and open the account fast. Enter the member's email + plan
    and click Activate.
- Both paths call the app backend (activate-subscription) to set the member's
  subscription (Explorer → premium, Gem Collector → professional, +6 months).
- Deep Scan credit packs: buyer pays (card link or mobile money), then you add
  the credits with Settings → GemScan → "Add Deep Scan credits".

== Notes ==
- "Explorer" maps to the app's premium tier; "Gem Collector" to professional.
- Automatic Stripe activation (webhook → backend) can be added later; this
  version activates from the admin tool after you confirm payment.
- No mobile-app code is modified. This plugin is self-contained.
- Fully bilingual Somali / English — Somali is the default; a prominent language
  switcher at the top toggles to English.

== Changelog ==
= 1.9.1 =
* Deep Scan Credits section split into two clearly-labelled ways to buy:
  "Buy with Card (Stripe)" and "Buy with Mobile Money" (EVC Plus / Zaad /
  Sahal / eDahab). Each of the 3 packs now has its own mobile-money buy
  button that opens the pay section with the pack amount already filled into
  the USSD dial code, plus a receipt form that adds the credits after you
  confirm. The confirmation email routes credit purchases to the "Add Deep
  Scan credits" tool (subscriptions still go to "Activate an account").

= 1.9.0 =
* Monetization sync with the app's Deep Scan credit model:
  - Subscriptions billed per 6 MONTHS (was per year). Explorer $4.99, Gem
    Collector $14.99. Activation sets a 6-month period.
  - Plan features updated: "Standard AI scans", Explorer = 20 Deep Scans /
    6 months, Gem Collector = 100 Deep Scans / 6 months + Professional PDF
    Reports. Removed all "unlimited" wording.
  - Deep Scan credit packages: $0.99=5, $4.99=30, $9.99=100 (configurable;
    match the Supabase credit_packages table).
  - New admin tool "Add Deep Scan credits" → backend add_credits (grants
    purchased credits via add_deep_scan_credits RPC).

= 1.7.0 =
* Free plan feature text updated: "3 scans per day" (was 5).
* Per-line mobile money (EVC Plus / Zaad / Sahal / eDahab each with its own name,
  number and USSD code): EVC *712*, Zaad *880*, Sahal *883*, eDahab *110*.

= 1.6.4 =
* USSD pay codes no longer include the amount inline — the customer enters the
  plan price (4.99 / 14.99) when the phone prompts. Codes are now *CODE*{number}#.
* Sahal / Golis code corrected to *883* (was *884*).

= 1.6.2 =
* Removed the "Contact expert on WhatsApp" section and unused WhatsApp setting.
* USSD pay codes are now per-operator (each telco has its own code, and codes
  differ by currency — these are the USD ones). Verified Jul 2026:
  EVC Plus *712*, eDahab(USD) *880*, Sahal/Golis *884*. Zaad is left blank
  until Telesom's send-money code is confirmed (dial 151).

= 1.6.1 =
* Admin: "Activate an account" tool moved to the top of the settings page for
  faster daily use.
* Mobile money: each number is now shown once (services that share a number are
  grouped), with a tap-to-pay USSD dial code (e.g. *883*0907790584*4.99#) that
  auto-fills the number and the selected plan amount.
* New setting: "USSD dial-to-pay format" ({number} + {amount} placeholders).

= 1.6.0 =
* Somali is now the default language; larger, centred Somali/English switcher.
* Full Somali + English coverage on all on-page messages and alerts.
* Simpler, cleaner page layout.
* Account-email / "Check my current plan" box moved directly under the header.
* Mobile-money confirmation is now a single, prominent email form (the WhatsApp
  receipt-send option was removed).
* The confirmation email to the owner now includes a direct link to
  Settings → GemScan → Activate an account, to open the account quickly.

= 1.5.0 =
* Stripe Checkout, mobile money, admin activation tool.

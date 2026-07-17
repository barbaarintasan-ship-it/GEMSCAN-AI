=== GemScan Accounting ===
Version: 1.0.0
Requires at least: WordPress 5.5
Requires PHP: 7.2
License: GPL-2.0+

A standalone accounting & subscription-management module for GemScan, installed
on barbaarintasan.com. It records every payment made through the website,
provides a Salaam transfers ledger, dashboards, period reports (CSV / Excel /
PDF / Print), and an integration bridge that records sales from Stripe, PayPal,
Salaam, EVC Plus, Zaad and eDahab. It is fully self-contained and does NOT
modify any existing Barbaarintasan / GemScan Payments functionality.

== Install ==
1. Copy the `gemscan-accounting` folder to `wp-content/plugins/` (or upload the
   zip via Plugins → Add New → Upload).
2. Activate "GemScan Accounting". Two tables are created:
   - {prefix}gsa_payments
   - {prefix}gsa_salaam_ledger
3. Open GemScan → Settings and set a Default currency and a Webhook secret.

== Menu (Administrators only) ==
GemScan →
  - Dashboard      : revenue tiles (total / today / week / month / year),
                     totals by method / plan / country, active / expired /
                     renewals / refunds, revenue charts.
  - Payments       : searchable, filterable, sortable list; add / edit / delete;
                     bulk delete; CSV / Excel export; print. Click a customer's
                     email to open their profile.
  - Salaam Ledger  : received / transferred entries with running balance.
  - Reports        : daily / weekly / monthly / annual summaries with charts,
                     downloadable PDF and print.
  - Settings       : currency + integration webhook secret & docs.

== Security ==
- Every page and action requires the `manage_options` capability (Administrators).
- Every state-changing request is nonce-verified (check_admin_referer).
- Every database value is written/read through prepared statements (GSA_DB).
- The REST webhook is authenticated with a shared secret compared in constant time.

== Integration (auto-record payments) ==
Three equivalent ways to record a sale — all de-duplicated on (Transaction ID +
Method), so retried webhooks never create duplicates and the ledger stays in
sync with GemScan subscriptions:

1) REST webhook (external gateways):
   POST {site}/wp-json/gsa/v1/payment
   Header: X-GSA-Secret: <your webhook secret>
   Body (JSON):
   {
     "customer_name": "Aamina Yuusuf",
     "email": "aamina@example.com",
     "phone": "+2526...",
     "country": "Somalia",
     "plan": "professional",          // free | explorer | professional
     "amount": 14.99,
     "currency": "USD",
     "method": "evc",                 // stripe|paypal|salaam|evc|zaad|edahab|bank|cash|other
     "txn_id": "EVC123456",
     "status": "paid",                // pending|paid|failed|refunded|cancelled
     "start_date": "2026-07-17",
     "expiry_date": "2027-07-17"
   }

2) WordPress action (any PHP on the site — e.g. from a Stripe/PayPal handler):
   do_action( 'gsa_capture_payment', $data );

3) Direct function call:
   gsa_record_payment( $data );

Example wiring for the existing GemScan Payments plugin (add to your own code,
NOT to this plugin) — right after you confirm a payment / activate an account:

   if ( function_exists( 'gsa_record_payment' ) ) {
       gsa_record_payment( array(
           'customer_name' => $name,
           'email'         => $email,
           'plan'          => $plan_key,   // 'explorer' or 'professional'
           'amount'        => $amount,
           'currency'      => 'USD',
           'method'        => 'evc',       // or stripe/zaad/edahab/salaam...
           'txn_id'        => $reference,
           'status'        => 'paid',
           'start_date'    => gmdate( 'Y-m-d' ),
           'expiry_date'   => gmdate( 'Y-m-d', strtotime( '+1 year' ) ),
       ) );
   }

== Automatic recording from GemScan Payments (mobile money) ==
Mobile-money sales are verified by hand. When you approve a buyer with GemScan
Payments' "Activate an account" tool (Settings → GemScan), this plugin's bridge
(includes/class-gsa-bridge.php) detects that submission and records the sale into
accounting automatically — plan, price (read from GemScan Payments' own
settings), currency and method — with status "Paid". No change to the GemScan
Payments plugin is required; if it isn't installed, the bridge simply does
nothing. You can open the created record under GemScan → Payments to add the
customer's name / phone / country. Same-day re-activations de-duplicate; a
genuine later renewal creates a new record.

== Extending ==
- All persistence lives in `includes/class-gsa-db.php` (prepared statements).
- Reporting/aggregation lives in `includes/class-gsa-reports.php`.
- Add a payment method / plan / status by editing the enums in
  `includes/helpers.php` — the whole UI, filters and exports follow automatically.
- The PDF writer (`includes/class-gsa-pdf.php`) is intentionally minimal; to
  produce richer invoices, drop in Dompdf/FPDF and swap `GSA_Export::pdf_report()`.
- Hooks fired: `gsa_payment_recorded` ($id,$data) and `gsa_payment_synced`.

== Changelog ==
= 1.0.0 =
* Initial release: payments table, Salaam ledger, dashboard, reports,
  CSV/Excel/PDF/print exports, customer profiles, REST + action integration,
  administrator-only security with nonces and prepared statements.

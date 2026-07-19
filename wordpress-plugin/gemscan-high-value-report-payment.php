<?php
/**
 * Plugin Name: GemScan High-Value Report Payment (Placeholder)
 * Description: Renders the $5 High-Value Verification Report payment page the
 *              GemScan mobile app links to from its paywall screen. This is a
 *              PLACEHOLDER page only — it shows the two payment options
 *              (Mobile Pay / Card Pay) but does not charge anyone yet. Real
 *              payment processing (Stripe Checkout for Card Pay, a mobile
 *              money aggregator for Mobile Pay) still needs to be wired in —
 *              see the TODO markers below.
 * Version:     0.1.0
 *
 * How the app reaches this page:
 *   The paywall screen (mobile/app/(app)/scan/verify.tsx) opens
 *   https://<your-site>/gemscan-report-payment/?ref=<purchaseId>&method=mobile|card
 *   (base URL configured in mobile/lib/appLinks.ts as
 *   HIGH_VALUE_REPORT_PAYMENT_URL). Create a WordPress Page at that slug and
 *   add the [gemscan_high_value_report] shortcode to its content — this
 *   plugin renders everything else.
 *
 * Once a real gateway is chosen, wiring this up means:
 *   1. Card Pay button -> create a Stripe Checkout Session server-side
 *      (passing `ref` as client_reference_id) and redirect to its URL.
 *   2. Mobile Pay button -> redirect into the chosen mobile money
 *      aggregator's checkout flow (EVC Plus / Zaad / Sahal / eDahab),
 *      again passing `ref` through.
 *   3. On successful payment, POST to the Supabase Edge Function
 *      `high-value-report-webhook` with
 *      { purchaseId: ref, status: "success", paymentMethod, referenceId },
 *      signed with HMAC-SHA256(rawBody, HIGH_VALUE_REPORT_GATEWAY_SECRET) in
 *      an X-Gateway-Signature header, and set
 *      HIGH_VALUE_REPORT_GATEWAY_ENABLED=true in that function's env once
 *      this is live (it fail-closed-rejects everything until then).
 */

if (!defined('ABSPATH')) {
    exit; // No direct access.
}

function gemscan_high_value_report_shortcode() {
    $purchase_ref = isset($_GET['ref']) ? sanitize_text_field(wp_unslash($_GET['ref'])) : '';
    $requested_method = isset($_GET['method']) ? sanitize_text_field(wp_unslash($_GET['method'])) : '';
    $highlight_mobile = $requested_method === 'mobile';
    $highlight_card = $requested_method === 'card';

    ob_start();
    ?>
    <div class="gemscan-report-payment">
        <div class="gemscan-report-payment__card">
            <div class="gemscan-report-payment__brand">💎 GemScan</div>
            <h1 class="gemscan-report-payment__title">High-Value Expert Verification Report</h1>
            <p class="gemscan-report-payment__price">$5.00 USD &middot; one-time</p>

            <?php if ($purchase_ref !== '') : ?>
                <p class="gemscan-report-payment__ref">
                    Report reference: <code><?php echo esc_html($purchase_ref); ?></code>
                </p>
            <?php else : ?>
                <p class="gemscan-report-payment__warning">
                    Missing report reference — please return to the GemScan app and tap the payment
                    button again.
                </p>
            <?php endif; ?>

            <p class="gemscan-report-payment__body">
                Unlocks your full expert verification result: evidence score, identification,
                supporting and conflicting evidence, recommended next tests, and a downloadable PDF.
            </p>

            <div class="gemscan-report-payment__actions">
                <!--
                    TODO(payment): replace this placeholder with a real Stripe
                    Checkout redirect. Create the Checkout Session server-side
                    (e.g. a small admin-ajax or REST handler in this plugin),
                    set client_reference_id to $purchase_ref, and redirect the
                    button here to session.url.
                -->
                <a
                    href="#"
                    class="gemscan-report-payment__button gemscan-report-payment__button--card<?php echo $highlight_card ? ' gemscan-report-payment__button--highlighted' : ''; ?>"
                    data-gemscan-method="card"
                    data-gemscan-ref="<?php echo esc_attr($purchase_ref); ?>"
                >
                    Card Pay
                </a>

                <!--
                    TODO(payment): replace this placeholder with a real
                    redirect into whichever mobile money aggregator gets
                    chosen (EVC Plus / Zaad / Sahal / eDahab), again passing
                    $purchase_ref through so the webhook can match it back.
                -->
                <a
                    href="#"
                    class="gemscan-report-payment__button gemscan-report-payment__button--mobile<?php echo $highlight_mobile ? ' gemscan-report-payment__button--highlighted' : ''; ?>"
                    data-gemscan-method="mobile_money"
                    data-gemscan-ref="<?php echo esc_attr($purchase_ref); ?>"
                >
                    Mobile Pay
                </a>
            </div>

            <p class="gemscan-report-payment__note">
                Payment is not yet enabled on this page — this is a placeholder your GemScan team
                is still wiring up. Please check back soon.
            </p>
        </div>
    </div>

    <style>
        /*
         * !important throughout: this markup is embedded inside an unknown
         * theme's page template via a shortcode, and themes commonly ship
         * their own `h1 { color: ... }` / `a { color: ...; text-decoration:
         * underline; }` rules that otherwise win over these (a bare element
         * or pseudo-class selector like `a:link` outranks a single class
         * selector in specificity) — that's what made the title unreadable
         * and the buttons render as plain underlined theme-blue links.
         */
        .gemscan-report-payment { display: flex; justify-content: center; padding: 32px 16px; }
        .gemscan-report-payment__card {
            max-width: 420px; width: 100%; background: #0B0B0C !important; color: #F5F1E8 !important;
            border: 1px solid #C9A227; border-radius: 16px; padding: 28px; text-align: center;
        }
        .gemscan-report-payment__brand { font-weight: 800; font-size: 15px; color: #C9A227 !important; margin-bottom: 12px; }
        .gemscan-report-payment__title { font-size: 20px; margin: 0 0 6px; color: #F5F1E8 !important; }
        .gemscan-report-payment__price { color: #C9A227 !important; font-weight: 700; margin: 0 0 14px; }
        .gemscan-report-payment__ref { font-size: 12px; color: #C9C9CC !important; margin: 0 0 14px; word-break: break-all; }
        .gemscan-report-payment__ref code { color: #F5F1E8 !important; }
        .gemscan-report-payment__warning { font-size: 13px; color: #E8B33D !important; margin: 0 0 14px; }
        .gemscan-report-payment__body { font-size: 13.5px; line-height: 1.6; color: #C9C9CC !important; margin: 0 0 20px; }
        .gemscan-report-payment__actions { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
        .gemscan-report-payment__button {
            display: block; padding: 12px 20px; border-radius: 999px; font-weight: 700;
            text-decoration: none !important; border: 1px solid #C9A227; cursor: pointer;
        }
        .gemscan-report-payment__button--card { background: #C9A227 !important; color: #0B0B0C !important; }
        .gemscan-report-payment__button--mobile { background: transparent !important; color: #C9A227 !important; }
        .gemscan-report-payment__button--highlighted { box-shadow: 0 0 0 2px #C9A227; }
        .gemscan-report-payment__note { font-size: 11.5px; color: #8A8A8E !important; margin: 0; }
    </style>

    <script>
        // Placeholder click feedback: until a real gateway is wired in (see
        // the TODO markers above the buttons), href="#" would otherwise just
        // silently do nothing when clicked. This makes that explicit instead.
        document.querySelectorAll('.gemscan-report-payment__button').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                window.alert('Payment isn\'t enabled on this page yet — please check back soon.');
            });
        });
    </script>
    <?php
    return ob_get_clean();
}
add_shortcode('gemscan_high_value_report', 'gemscan_high_value_report_shortcode');

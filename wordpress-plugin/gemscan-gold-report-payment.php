<?php
/**
 * Plugin Name: GemScan Gold Report Payment
 * Description: The $5 Gold Verification Report payment page the GemScan
 *              mobile app links to from its Gold Verification paywall screen
 *              — Card Pay (Stripe Checkout) and Mobile Pay (EVC Plus / Zaad /
 *              Sahal / eDahab, manual confirmation), same pattern as the
 *              GemScan High-Value Report Payment plugin. Configure everything
 *              under Settings → GemScan Gold Report Payment. Completely
 *              separate from that plugin (and from the main GemScan Payments
 *              plugin) — this only ever unlocks ONE specific gold report
 *              purchase, identified by the `ref` query param the app
 *              supplies, never a whole account.
 * Version:     1.0.0
 *
 * How the app reaches this page:
 *   The paywall screen (mobile/app/(app)/scan/verify-gold.tsx) opens
 *   https://<your-site>/gemscan-gold-report-payment/?ref=<purchaseId>&method=mobile|card
 *   Create a WordPress Page at that slug and add the
 *   [gemscan_gold_verification_report] shortcode to its content.
 *
 * How a payment actually unlocks the report:
 *   Both paths (Card and Mobile) end by POSTing to the Supabase Edge Function
 *   `gold-report-webhook` with { purchaseId, status: "success",
 *   paymentMethod, referenceId }, signed with
 *   X-Gateway-Signature: hex(HMAC-SHA256(rawBody, gateway_secret)) — the
 *   exact scheme that function's GATEWAY_ENABLED/GATEWAY_SECRET check expects.
 *   That function marks the purchase paid and triggers the one deferred AI
 *   call for the final gold verdict.
 */

if (!defined('ABSPATH')) {
    exit; // No direct access.
}

define('GEMSCAN_GVR_OPT', 'gemscan_gvr_options');

function gemscan_gvr_defaults() {
    return array(
        'price_usd'         => '5.00',
        // Simplest option — a pre-made Stripe Payment Link: no API key
        // needed, `?client_reference_id={ref}` is appended so the Stripe
        // webhook can still match the payment back to the right purchase.
        // Preferred over stripe_sk below when both are set. Left blank
        // deliberately — enter your own link under Settings.
        'stripe_payment_link' => '',
        // Card (Stripe) — dynamic Checkout Session, mirrors the High-Value
        // Report Payment plugin's stripe_sk-based flow. Advanced
        // alternative, only used when no Payment Link is set above.
        'stripe_sk'         => '',
        // Stripe webhook signing secret (whsec_…) — enables automatic
        // unlocking even if the buyer never returns to the success_url.
        'stripe_webhook_secret' => '',
        // Owner's mobile-money numbers — same shape as the other GemScan
        // payment plugins.
        'evc_label'         => 'EVC Plus',
        'evc_number'        => '',
        'ussd_evc'          => '*712*{national}*{amount}#',
        'zaad_label'        => 'Zaad',
        'zaad_number'       => '',
        'ussd_zaad'         => '*880*{national}*{amount}#',
        'sahal_label'       => 'Sahal',
        'sahal_number'      => '',
        'ussd_sahal'        => '*883*{number}*{amount}#',
        'edahab_label'      => 'eDahab',
        'edahab_number'     => '',
        'ussd_edahab'       => '*110*{national}*{amount}#',
        'notify_email'      => get_option('admin_email'),
        // Connection to the app's backend.
        'functions_url'     => 'https://znqkzgswvhbkhxldbbld.functions.supabase.co',
        // Shared secret — MUST match GOLD_REPORT_GATEWAY_SECRET set on the
        // Supabase project (supabase secrets set ...). Left blank here
        // deliberately — enter it under Settings → GemScan Gold Report
        // Payment, never hardcode a live secret into this file.
        'gateway_secret'    => '',
    );
}

function gemscan_gvr_opts() {
    return wp_parse_args(get_option(GEMSCAN_GVR_OPT, array()), gemscan_gvr_defaults());
}

/* -------------------------------------------------------------------------
 * Turn a stored mobile-money number into the LOCAL dialling form (same
 * helper as the other GemScan payment plugins).
 * ---------------------------------------------------------------------- */
function gemscan_gvr_local_number($raw) {
    $d = preg_replace('/[^0-9]/', '', (string) $raw);
    if (strpos($d, '252') === 0) {
        $d = substr($d, 3);
    }
    $d = ltrim($d, '0');
    return $d === '' ? '' : '0' . $d;
}

/* -------------------------------------------------------------------------
 * Webhook call — the ONLY place this plugin ever tells the app backend a
 * gold report was paid for. Signed with HMAC-SHA256(rawBody, gateway_secret),
 * matching supabase/functions/gold-report-webhook exactly.
 * ---------------------------------------------------------------------- */
function gemscan_gvr_call_webhook($o, $purchase_id, $method, $reference_id) {
    if (empty($o['functions_url']) || empty($o['gateway_secret'])) {
        return array('ok' => false, 'msg' => 'Set the Functions URL and Gateway secret first (Settings → GemScan Gold Report Payment).');
    }
    $body = wp_json_encode(array(
        'purchaseId'  => $purchase_id,
        'status'      => 'success',
        'paymentMethod' => $method,
        'referenceId' => $reference_id,
    ));
    $signature = hash_hmac('sha256', $body, $o['gateway_secret']);

    $url = rtrim($o['functions_url'], '/') . '/gold-report-webhook';
    $res = wp_remote_post($url, array(
        'timeout' => 20,
        'headers' => array(
            'Content-Type'         => 'application/json',
            'X-Gateway-Signature'  => $signature,
        ),
        'body' => $body,
    ));
    if (is_wp_error($res)) {
        return array('ok' => false, 'msg' => $res->get_error_message());
    }
    $code = wp_remote_retrieve_response_code($res);
    $data = json_decode(wp_remote_retrieve_body($res), true);
    if ($code === 200 && !empty($data['received'])) {
        return array('ok' => true, 'msg' => 'Gold report unlocked (purchase ' . esc_html($purchase_id) . ').');
    }
    return array('ok' => false, 'msg' => isset($data['error']) ? $data['error'] : ('HTTP ' . $code));
}

/* -------------------------------------------------------------------------
 * Stripe Checkout — create a Session for the fixed report price, redirect.
 * ---------------------------------------------------------------------- */
function gemscan_gvr_stripe_create_session($o, $purchase_ref, $return_url) {
    if (empty($o['stripe_sk'])) {
        set_transient('gemscan_gvr_last_error', 'Stripe Secret Key is not set in Settings → GemScan Gold Report Payment.', 300);
        return '';
    }
    $amount = (int) round(floatval($o['price_usd']) * 100);
    if ($amount < 50) {
        set_transient('gemscan_gvr_last_error', 'Report price is too low for a card charge (minimum ~0.50).', 300);
        return '';
    }
    $sep = (strpos($return_url, '?') === false) ? '?' : '&';
    $success = $return_url . $sep . 'ref=' . rawurlencode($purchase_ref) . '&gemscan_gvr_success={CHECKOUT_SESSION_ID}';
    $cancel  = $return_url . $sep . 'ref=' . rawurlencode($purchase_ref);

    $res = wp_remote_post('https://api.stripe.com/v1/checkout/sessions', array(
        'timeout' => 25,
        'headers' => array(
            'Authorization' => 'Bearer ' . trim($o['stripe_sk']),
            'Content-Type'  => 'application/x-www-form-urlencoded',
        ),
        'body' => array(
            'mode'        => 'payment',
            'success_url' => $success,
            'cancel_url'  => $cancel,
            'client_reference_id' => $purchase_ref,
            'line_items[0][price_data][currency]'           => 'usd',
            'line_items[0][price_data][unit_amount]'        => (string) $amount,
            'line_items[0][price_data][product_data][name]' => 'GemScan Gold Verification Report',
            'line_items[0][quantity]'                        => '1',
            'metadata[gemscan_purchase_ref]' => $purchase_ref,
        ),
    ));
    if (is_wp_error($res)) {
        set_transient('gemscan_gvr_last_error', 'Network error: ' . $res->get_error_message(), 300);
        return '';
    }
    $data = json_decode(wp_remote_retrieve_body($res), true);
    if (!empty($data['url'])) {
        return $data['url'];
    }
    $msg = isset($data['error']['message']) ? $data['error']['message'] : 'Stripe returned an error.';
    set_transient('gemscan_gvr_last_error', 'Stripe: ' . $msg, 300);
    return '';
}

/* -------------------------------------------------------------------------
 * Stripe webhook — AUTOMATIC unlock, independent of whether the buyer ever
 * returns to success_url. Same contract as the other GemScan payment
 * plugins' REST routes: Stripe calls this after a successful Checkout, we
 * verify the Stripe-Signature header, then unlock the report identified by
 * client_reference_id (the purchase `ref`, not an email).
 * ---------------------------------------------------------------------- */
add_action('rest_api_init', function () {
    register_rest_route('gemscan-gvr/v1', '/stripe', array(
        'methods'             => 'POST',
        'callback'            => 'gemscan_gvr_stripe_webhook',
        'permission_callback' => '__return_true', // Verified by Stripe signature, not WP auth.
    ));
});

function gemscan_gvr_verify_stripe_sig($payload, $sig_header, $secret) {
    if (!$sig_header || !$secret) {
        return false;
    }
    $t = '';
    $v1 = array();
    foreach (explode(',', $sig_header) as $kv) {
        $pair = explode('=', trim($kv), 2);
        if (count($pair) !== 2) {
            continue;
        }
        if ('t' === $pair[0]) {
            $t = $pair[1];
        } elseif ('v1' === $pair[0]) {
            $v1[] = $pair[1];
        }
    }
    if ('' === $t || empty($v1)) {
        return false;
    }
    // Reject events older than 5 minutes (replay protection).
    if (abs(time() - (int) $t) > 300) {
        return false;
    }
    $expected = hash_hmac('sha256', $t . '.' . $payload, $secret);
    foreach ($v1 as $sig) {
        if (hash_equals($expected, $sig)) {
            return true;
        }
    }
    return false;
}

function gemscan_gvr_stripe_webhook(WP_REST_Request $request) {
    $o = gemscan_gvr_opts();
    $secret = isset($o['stripe_webhook_secret']) ? trim($o['stripe_webhook_secret']) : '';
    if ('' === $secret) {
        return new WP_REST_Response(array('error' => 'not_configured'), 400);
    }

    $payload = $request->get_body();
    $sig = isset($_SERVER['HTTP_STRIPE_SIGNATURE']) ? sanitize_text_field(wp_unslash($_SERVER['HTTP_STRIPE_SIGNATURE'])) : '';
    if (!gemscan_gvr_verify_stripe_sig($payload, $sig, $secret)) {
        return new WP_REST_Response(array('error' => 'bad_signature'), 400);
    }

    $event = json_decode($payload, true);
    if (!is_array($event) || empty($event['type'])) {
        return new WP_REST_Response(array('error' => 'bad_payload'), 400);
    }
    if ('checkout.session.completed' !== $event['type']) {
        return new WP_REST_Response(array('ignored' => $event['type']), 200);
    }

    $event_id = isset($event['id']) ? sanitize_text_field($event['id']) : '';
    if ($event_id && get_transient('gemscan_gvr_ev_' . $event_id)) {
        return new WP_REST_Response(array('duplicate' => true), 200); // Idempotency.
    }

    $session = isset($event['data']['object']) && is_array($event['data']['object']) ? $event['data']['object'] : array();
    $paid = (isset($session['payment_status']) && 'paid' === $session['payment_status'])
        || (isset($session['status']) && 'complete' === $session['status']);
    if (!$paid) {
        return new WP_REST_Response(array('unpaid' => true), 200);
    }

    $ref = isset($session['client_reference_id']) ? sanitize_text_field($session['client_reference_id']) : '';
    if (!$ref) {
        return new WP_REST_Response(array('error' => 'no_ref'), 200);
    }

    $result = gemscan_gvr_call_webhook($o, $ref, 'card', isset($session['id']) ? $session['id'] : '');

    if (!empty($o['notify_email'])) {
        $ok_txt = !empty($result['ok']) ? 'DONE' : 'FAILED';
        wp_mail(
            $o['notify_email'],
            'GemScan Gold Report — Stripe auto-unlock ' . $ok_txt . ' — ' . $ref,
            'Reference: ' . esc_html($ref) . "\n" . 'Result: ' . wp_json_encode($result)
        );
    }

    if ($event_id) {
        set_transient('gemscan_gvr_ev_' . $event_id, 1, 7 * DAY_IN_SECONDS);
    }
    return new WP_REST_Response($result, 200);
}

// Handle the "Pay with Card" submit BEFORE any output, so we can redirect.
add_action('init', function () {
    if (empty($_POST['gemscan_gvr_stripe']) || !isset($_POST['gemscan_gvr_stripe_nonce'])) return;
    if (!wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['gemscan_gvr_stripe_nonce'])), 'gemscan_gvr_stripe')) return;
    $o   = gemscan_gvr_opts();
    $ref = isset($_POST['gemscan_gvr_ref']) ? sanitize_text_field(wp_unslash($_POST['gemscan_gvr_ref'])) : '';
    $ret = isset($_POST['gemscan_gvr_return']) ? esc_url_raw(wp_unslash($_POST['gemscan_gvr_return'])) : home_url();
    if (!$ref) {
        wp_safe_redirect(add_query_arg('gemscan_gvr_err', 'ref', $ret));
        exit;
    }
    $url = gemscan_gvr_stripe_create_session($o, $ref, $ret);
    wp_redirect($url ? $url : add_query_arg('gemscan_gvr_err', 'stripe', $ret));
    exit;
});

// Verify a returned Stripe Checkout Session, then unlock the report.
function gemscan_gvr_stripe_finalize($o, $session_id, $expected_ref) {
    if (empty($o['stripe_sk'])) return '';
    $res = wp_remote_get('https://api.stripe.com/v1/checkout/sessions/' . rawurlencode($session_id), array(
        'timeout' => 25,
        'headers' => array('Authorization' => 'Bearer ' . $o['stripe_sk']),
    ));
    if (is_wp_error($res)) {
        return '<div class="gs-gvr-alert gs-gvr-error">Could not verify the payment. Please contact support.</div>';
    }
    $s = json_decode(wp_remote_retrieve_body($res), true);
    if (empty($s['payment_status']) || $s['payment_status'] !== 'paid') {
        return '<div class="gs-gvr-alert gs-gvr-error">Payment not completed.</div>';
    }
    $ref = isset($s['client_reference_id']) ? $s['client_reference_id'] : $expected_ref;
    $r = gemscan_gvr_call_webhook($o, $ref, 'card', $session_id);
    if ($r['ok']) {
        return '<div class="gs-gvr-alert gs-gvr-ok">✅ Payment received — your gold verification report is being prepared. Return to the GemScan app and tap "I\'ve paid — check status".</div>';
    }
    return '<div class="gs-gvr-alert gs-gvr-error">Payment received, but unlocking the report failed: ' . esc_html($r['msg']) . '. Please contact support.</div>';
}

/* -------------------------------------------------------------------------
 * Mobile-money confirmation form handler (front-end) — same pattern as the
 * other GemScan payment plugins: buyer submits a Transaction ID, owner gets
 * emailed a direct link to the admin "Unlock report" tool.
 * ---------------------------------------------------------------------- */
function gemscan_gvr_maybe_handle_form($o) {
    if (empty($_POST['gemscan_gvr_confirm']) || !isset($_POST['gemscan_gvr_nonce'])) {
        return '';
    }
    if (!wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['gemscan_gvr_nonce'])), 'gemscan_gvr_confirm')) {
        return '<div class="gs-gvr-alert gs-gvr-error">Security check failed. Please try again.</div>';
    }
    $ref  = isset($_POST['gemscan_gvr_ref']) ? sanitize_text_field(wp_unslash($_POST['gemscan_gvr_ref'])) : '';
    $txn  = isset($_POST['gemscan_gvr_txn']) ? sanitize_text_field(wp_unslash($_POST['gemscan_gvr_txn'])) : '';
    $note = isset($_POST['gemscan_gvr_note']) ? sanitize_text_field(wp_unslash($_POST['gemscan_gvr_note'])) : '';

    if (!$ref || !$txn) {
        return '<div class="gs-gvr-alert gs-gvr-error">Missing report reference or Transaction ID. Please return to the GemScan app and try again.</div>';
    }

    $admin_link = admin_url('options-general.php?page=gemscan-gvr-payment&gvr_ref=' . rawurlencode($ref) . '&gvr_txn=' . rawurlencode($txn));
    $body = '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#1c1c1e;line-height:1.6">'
          . '<h2 style="margin:0 0 12px">🥇 New GemScan Gold Verification Report payment (mobile money)</h2>'
          . '<table cellpadding="6" style="border-collapse:collapse;font-size:15px">'
          . '<tr><td><strong>Report reference</strong></td><td>' . esc_html($ref) . '</td></tr>'
          . '<tr><td><strong>Transaction ID</strong></td><td>' . esc_html($txn) . '</td></tr>'
          . '<tr><td><strong>Paid with</strong></td><td>' . esc_html($note) . '</td></tr>'
          . '</table>'
          . '<p style="margin:18px 0"><a href="' . esc_url($admin_link) . '" '
          . 'style="display:inline-block;background:#0F1E3A;color:#fff;text-decoration:none;'
          . 'font-weight:800;padding:12px 22px;border-radius:8px">Unlock this report →</a></p>'
          . '<p style="color:#888;font-size:12px">' . esc_url($admin_link) . '</p>'
          . '</div>';
    wp_mail($o['notify_email'], 'GemScan Gold Verification Report payment — ' . $ref, $body, array('Content-Type: text/html; charset=UTF-8'));

    return '<div class="gs-gvr-alert gs-gvr-ok">✅ Thank you! We received your details and are verifying your payment. '
         . 'Your report will unlock shortly — return to the GemScan app and tap "I\'ve paid — check status".</div>';
}

/* -------------------------------------------------------------------------
 * Front-end shortcode: [gemscan_gold_verification_report]
 * ---------------------------------------------------------------------- */
add_shortcode('gemscan_gold_verification_report', 'gemscan_gvr_render');

function gemscan_gvr_render() {
    $o = gemscan_gvr_opts();
    $purchase_ref = isset($_GET['ref']) ? sanitize_text_field(wp_unslash($_GET['ref'])) : '';

    ob_start();

    echo gemscan_gvr_maybe_handle_form($o); // phpcs:ignore

    if (isset($_GET['gemscan_gvr_success'])) {
        echo gemscan_gvr_stripe_finalize($o, sanitize_text_field(wp_unslash($_GET['gemscan_gvr_success'])), $purchase_ref); // phpcs:ignore
    }
    if (isset($_GET['gemscan_gvr_err'])) {
        $err = get_transient('gemscan_gvr_last_error');
        delete_transient('gemscan_gvr_last_error');
        echo '<div class="gs-gvr-alert gs-gvr-error">' . esc_html($err ? $err : 'Payment could not be started. Please try again.') . '</div>';
    }

    $has_momo = ($o['evc_number'] || $o['zaad_number'] || $o['sahal_number'] || $o['edahab_number']);
    $current_url = (is_ssl() ? 'https://' : 'http://') . sanitize_text_field($_SERVER['HTTP_HOST'] ?? '') . sanitize_text_field($_SERVER['REQUEST_URI'] ?? '');
    $return_url = strtok($current_url, '?'); // strip existing query args for the Stripe return URL base.
    ?>
    <div class="gs-gvr-wrap">
        <div class="gs-gvr-card">
            <div class="gs-gvr-brand">🥇 GemScan</div>
            <h1 class="gs-gvr-title">Gold Verification Report</h1>
            <p class="gs-gvr-price">$<?php echo esc_html($o['price_usd']); ?> USD &middot; one-time</p>

            <?php if ($purchase_ref !== '') : ?>
                <p class="gs-gvr-ref">Report reference: <code><?php echo esc_html($purchase_ref); ?></code></p>
            <?php else : ?>
                <p class="gs-gvr-warning">Missing report reference — please return to the GemScan app and tap the payment button again.</p>
            <?php endif; ?>

            <p class="gs-gvr-body">
                Unlocks your full gold verification result: evidence score, identification, possible gold type and
                purity range, supporting and conflicting evidence, recommended next tests, and a downloadable PDF.
            </p>

            <?php if ($purchase_ref !== '') : ?>

            <?php if (!empty($o['stripe_payment_link'])) : ?>
                <?php
                $sep = (strpos($o['stripe_payment_link'], '?') === false) ? '?' : '&';
                $link_url = $o['stripe_payment_link'] . $sep . 'client_reference_id=' . rawurlencode($purchase_ref);
                ?>
                <a href="<?php echo esc_url($link_url); ?>" class="gs-gvr-button gs-gvr-button--card" target="_blank" rel="noopener">💳 Card Pay</a>
            <?php elseif (!empty($o['stripe_sk'])) : ?>
            <form method="post" class="gs-gvr-stripe-form">
                <?php wp_nonce_field('gemscan_gvr_stripe', 'gemscan_gvr_stripe_nonce'); ?>
                <input type="hidden" name="gemscan_gvr_stripe" value="1">
                <input type="hidden" name="gemscan_gvr_ref" value="<?php echo esc_attr($purchase_ref); ?>">
                <input type="hidden" name="gemscan_gvr_return" value="<?php echo esc_url($return_url); ?>">
                <button type="submit" class="gs-gvr-button gs-gvr-button--card">💳 Card Pay</button>
            </form>
            <?php else : ?>
                <p class="gs-gvr-warning">Card payment isn't configured yet (Settings → GemScan Gold Report Payment → Stripe Payment Link or Secret Key).</p>
            <?php endif; ?>

            <?php if ($has_momo) : ?>
                <h3 class="gs-gvr-subhead">📱 Mobile Pay</h3>
                <ol class="gs-gvr-steps">
                    <li>Send exactly $<?php echo esc_html($o['price_usd']); ?> to ONE of the numbers below.</li>
                    <li>You'll get an SMS receipt with a Transaction ID.</li>
                    <li>Submit that Transaction ID in the form below.</li>
                </ol>
                <ul class="gs-gvr-momo">
                    <?php
                    $services = array(
                        array('label' => $o['evc_label'],    'num' => $o['evc_number'],    'ussd' => $o['ussd_evc']),
                        array('label' => $o['zaad_label'],   'num' => $o['zaad_number'],   'ussd' => $o['ussd_zaad']),
                        array('label' => $o['sahal_label'],  'num' => $o['sahal_number'],  'ussd' => $o['ussd_sahal']),
                        array('label' => $o['edahab_label'], 'num' => $o['edahab_number'], 'ussd' => $o['ussd_edahab']),
                    );
                    foreach ($services as $svc) {
                        if (!trim($svc['num'])) continue;
                        $local = gemscan_gvr_local_number($svc['num']);
                        $national = ltrim($local, '0');
                        // Whole-dollar amount only — mobile money USSD codes
                        // dial as plain digits (e.g. "5"), not "5.00" or a
                        // decimal-point-turned-into-a-star ("5*00"), which
                        // would dial as a broken extra menu level.
                        $amount_dial = (string) (int) round((float) $o['price_usd']);
                        $code = str_replace(array('{number}', '{national}', '{amount}'), array($local, $national, $amount_dial), $svc['ussd']);
                        // tel: link — tapping this on a phone opens the dialer
                        // with the USSD code already filled in.
                        $dial_href = 'tel:' . str_replace('#', '%23', $code);
                        echo '<li class="gs-gvr-momo-item">'
                           . '<div class="gs-gvr-momo-top"><strong>' . esc_html($svc['label']) . '</strong> <span>' . esc_html($local) . '</span></div>'
                           . '<a href="' . esc_attr($dial_href) . '" class="gs-gvr-button gs-gvr-button--dial">📞 ' . esc_html($code) . '</a>'
                           . '</li>';
                    }
                    ?>
                </ul>
                <form method="post" class="gs-gvr-confirm-form">
                    <?php wp_nonce_field('gemscan_gvr_confirm', 'gemscan_gvr_nonce'); ?>
                    <input type="hidden" name="gemscan_gvr_confirm" value="1">
                    <input type="hidden" name="gemscan_gvr_ref" value="<?php echo esc_attr($purchase_ref); ?>">
                    <label class="gs-gvr-label">Transaction ID</label>
                    <input type="text" name="gemscan_gvr_txn" placeholder="From your SMS receipt" required>
                    <label class="gs-gvr-label">Which service did you pay with? (optional)</label>
                    <input type="text" name="gemscan_gvr_note" placeholder="e.g. EVC Plus">
                    <button type="submit" class="gs-gvr-button gs-gvr-button--outline">I've paid — submit for verification</button>
                </form>
            <?php endif; ?>

            <?php endif; ?>
        </div>
    </div>

    <style>
        .gs-gvr-wrap { display: flex; justify-content: center; padding: 32px 16px; }
        .gs-gvr-card {
            max-width: 440px; width: 100%; background: #0B0B0C !important; color: #F5F1E8 !important;
            border: 1px solid #C9A227; border-radius: 16px; padding: 28px; text-align: center;
        }
        .gs-gvr-brand { font-weight: 800; font-size: 15px; color: #C9A227 !important; margin-bottom: 12px; }
        .gs-gvr-title { font-size: 20px; margin: 0 0 6px; color: #F5F1E8 !important; }
        .gs-gvr-price { color: #C9A227 !important; font-weight: 700; margin: 0 0 14px; }
        .gs-gvr-ref { font-size: 12px; color: #C9C9CC !important; margin: 0 0 14px; word-break: break-all; }
        .gs-gvr-ref code { color: #F5F1E8 !important; }
        .gs-gvr-warning { font-size: 13px; color: #E8B33D !important; margin: 0 0 14px; }
        .gs-gvr-body { font-size: 13.5px; line-height: 1.6; color: #C9C9CC !important; margin: 0 0 20px; }
        .gs-gvr-button {
            display: block; width: 100%; padding: 12px 20px; border-radius: 999px; font-weight: 700;
            text-decoration: none !important; border: 1px solid #C9A227; cursor: pointer; margin: 8px 0; font-size: 15px;
        }
        .gs-gvr-button--card { background: #C9A227 !important; color: #0B0B0C !important; }
        .gs-gvr-button--outline { background: transparent !important; color: #C9A227 !important; }
        .gs-gvr-subhead { font-size: 14px; margin: 20px 0 8px; color: #F5F1E8 !important; text-align: left; }
        .gs-gvr-steps { text-align: left; font-size: 12.5px; color: #C9C9CC !important; padding-left: 18px; }
        .gs-gvr-momo { list-style: none; padding: 0; margin: 10px 0; text-align: left; }
        .gs-gvr-momo-item { font-size: 13px; color: #F5F1E8 !important; padding: 10px 0; border-bottom: 1px solid #2a2a2c; }
        .gs-gvr-momo-top { display: flex; justify-content: space-between; margin-bottom: 6px; }
        .gs-gvr-momo-top span { color: #C9C9CC !important; }
        .gs-gvr-button--dial {
            background: transparent !important; color: #C9A227 !important; font-family: monospace;
            font-size: 13.5px; font-weight: 700; text-align: center; margin: 0;
        }
        .gs-gvr-confirm-form { text-align: left; margin-top: 12px; }
        .gs-gvr-label { display: block; font-size: 12px; color: #C9C9CC !important; margin: 10px 0 4px; }
        .gs-gvr-confirm-form input[type="text"] {
            width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #3a3a3c;
            background: #1a1a1c !important; color: #F5F1E8 !important; box-sizing: border-box;
        }
        .gs-gvr-alert { padding: 12px 16px; border-radius: 8px; margin-bottom: 14px; font-size: 13.5px; text-align: left; }
        .gs-gvr-alert.gs-gvr-ok { background: #123b1f; color: #a6e6b8 !important; }
        .gs-gvr-alert.gs-gvr-error { background: #3b1212; color: #f5b3b3 !important; }
    </style>
    <?php
    return ob_get_clean();
}

/* -------------------------------------------------------------------------
 * Admin settings page + "Unlock report" tool (for mobile-money confirmations)
 * ---------------------------------------------------------------------- */
add_action('admin_menu', function () {
    add_options_page('GemScan Gold Report Payment', 'GemScan Gold Report Payment', 'manage_options', 'gemscan-gvr-payment', 'gemscan_gvr_settings_page');
});

add_action('admin_init', function () {
    register_setting('gemscan_gvr_group', GEMSCAN_GVR_OPT, 'gemscan_gvr_sanitize');
});

function gemscan_gvr_sanitize($input) {
    $out = array();
    foreach (gemscan_gvr_defaults() as $k => $v) {
        $out[$k] = isset($input[$k]) ? sanitize_text_field($input[$k]) : $v;
    }
    return $out;
}

function gemscan_gvr_settings_page() {
    $o = gemscan_gvr_opts();
    $notice = '';

    if (!empty($_POST['gemscan_gvr_do_unlock']) && check_admin_referer('gemscan_gvr_unlock_now')) {
        $ref    = isset($_POST['unlock_ref']) ? sanitize_text_field(wp_unslash($_POST['unlock_ref'])) : '';
        $method = isset($_POST['unlock_method']) ? sanitize_text_field(wp_unslash($_POST['unlock_method'])) : 'mobile_money';
        $txn    = isset($_POST['unlock_txn']) ? sanitize_text_field(wp_unslash($_POST['unlock_txn'])) : '';
        $r = gemscan_gvr_call_webhook($o, $ref, $method, $txn);
        $notice = '<div class="notice ' . ($r['ok'] ? 'notice-success' : 'notice-error') . '"><p>' . esc_html($r['msg']) . '</p></div>';
    }

    $prefill_ref = isset($_GET['gvr_ref']) ? sanitize_text_field(wp_unslash($_GET['gvr_ref'])) : '';
    $prefill_txn = isset($_GET['gvr_txn']) ? sanitize_text_field(wp_unslash($_GET['gvr_txn'])) : '';

    $fields = array(
        'price_usd'      => 'Report price (USD)',
        'stripe_payment_link' => 'Stripe Payment Link (simplest — leave Secret Key below empty to use this)',
        'stripe_sk'      => 'Stripe Secret Key (advanced alternative — only used if no Payment Link above)',
        'stripe_webhook_secret' => 'Stripe Webhook signing secret (whsec_… — enables AUTOMATIC unlock even if the buyer never returns to this page)',
        'evc_label'      => '① EVC Plus — name',
        'evc_number'     => '① EVC Plus — number',
        'ussd_evc'       => '① EVC Plus — USSD code',
        'zaad_label'     => '② Zaad — name',
        'zaad_number'    => '② Zaad — number',
        'ussd_zaad'      => '② Zaad — USSD code',
        'sahal_label'    => '③ Sahal — name',
        'sahal_number'   => '③ Sahal — number',
        'ussd_sahal'     => '③ Sahal — USSD code',
        'edahab_label'   => '④ eDahab — name',
        'edahab_number'  => '④ eDahab — number',
        'ussd_edahab'    => '④ eDahab — USSD code',
        'notify_email'   => 'Notify email for mobile-money confirmations',
        'functions_url'  => 'App backend Functions URL',
        'gateway_secret' => 'Gateway secret (must match GOLD_REPORT_GATEWAY_SECRET on Supabase)',
    );
    echo $notice; // phpcs:ignore
    ?>
    <div class="wrap">
        <h1>GemScan Gold Report Payment</h1>

        <div style="background:#fff;border:1px solid #c9a227;border-left:4px solid #c9a227;border-radius:8px;padding:16px 20px;margin:14px 0 24px;max-width:760px">
            <h2 style="margin-top:0">✅ Unlock a report (after confirming a mobile-money payment)</h2>
            <p>After you've verified the buyer's Transaction ID against your mobile money account, enter the report reference (from their email) here.</p>
            <form method="post">
                <?php wp_nonce_field('gemscan_gvr_unlock_now'); ?>
                <input type="hidden" name="gemscan_gvr_do_unlock" value="1">
                <table class="form-table" role="presentation">
                    <tr><th>Report reference (ref)</th><td><input type="text" name="unlock_ref" class="regular-text" value="<?php echo esc_attr($prefill_ref); ?>" required></td></tr>
                    <tr><th>Method</th><td>
                        <select name="unlock_method">
                            <option value="mobile_money">Mobile money</option>
                            <option value="card">Card (manual override)</option>
                        </select>
                    </td></tr>
                    <tr><th>Transaction ID / reference</th><td><input type="text" name="unlock_txn" class="regular-text" value="<?php echo esc_attr($prefill_txn); ?>"></td></tr>
                </table>
                <?php submit_button('Unlock report', 'primary', 'submit', false); ?>
            </form>
        </div>

        <hr>
        <h2>Settings</h2>
        <p>Create a page with permalink <code>gemscan-gold-report-payment</code> containing this shortcode: <code>[gemscan_gold_verification_report]</code></p>
        <form method="post" action="options.php">
            <?php settings_fields('gemscan_gvr_group'); ?>
            <table class="form-table" role="presentation">
                <?php foreach ($fields as $k => $label) {
                    $type = in_array($k, array('stripe_sk', 'stripe_webhook_secret', 'gateway_secret'), true) ? 'password' : 'text';
                    printf(
                        '<tr><th scope="row"><label for="%1$s">%2$s</label></th><td><input type="%5$s" id="%1$s" name="%3$s[%1$s]" value="%4$s" class="regular-text"></td></tr>',
                        esc_attr($k), esc_html($label), esc_attr(GEMSCAN_GVR_OPT), esc_attr($o[$k]), esc_attr($type)
                    );
                } ?>
            </table>
            <?php submit_button('Save settings'); ?>
        </form>

        <hr>
        <h2>Enable automatic Stripe unlock (recommended)</h2>
        <p>Without this, Card Pay still works via the return-to-page check — but only if the buyer actually returns to this page after paying. The webhook below unlocks the report immediately regardless.</p>
        <ol>
            <li>Stripe Dashboard → Developers → Webhooks → <strong>Add endpoint</strong>.</li>
            <li>Endpoint URL: <code><?php echo esc_html(rest_url('gemscan-gvr/v1/stripe')); ?></code></li>
            <li>Event to send: <code>checkout.session.completed</code>.</li>
            <li>Copy the endpoint's <strong>Signing secret</strong> (<code>whsec_…</code>) into the <em>Stripe Webhook signing secret</em> field above, then Save settings.</li>
        </ol>
    </div>
    <?php
}

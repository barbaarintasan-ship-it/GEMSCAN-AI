<?php
/**
 * Plugin Name: GemScan Payments
 * Plugin URI:  https://barbaarintasan.com/gemscanpayment
 * Description: GemScan landing + pricing + payment page, and the bridge that upgrades a member's account after payment. Adds the [gemscan_payment] shortcode. Configure everything under Settings → GemScan.
 * Version:     1.6.7
 * Author:      GemScan
 * License:     GPL-2.0+
 * Text Domain: gemscan-payment
 */

if (!defined('ABSPATH')) {
    exit; // No direct access.
}

define('GEMSCAN_OPT', 'gemscan_payment_options');
define('GEMSCAN_VER', '1.6.7');
define('GEMSCAN_TPL', 'gemscan-fullpage.php'); // standalone page template slug

/* -------------------------------------------------------------------------
 * Full-page template — renders ONLY the GemScan page, with no theme header or
 * footer, so the payment page is a clean stand-alone GemScan screen.
 * Select it on the page: Page settings → Template → "GemScan — Full page".
 * ---------------------------------------------------------------------- */
add_filter('theme_page_templates', function ($templates) {
    $templates[GEMSCAN_TPL] = 'GemScan — Full page (no header/footer)';
    return $templates;
});

add_filter('template_include', function ($template) {
    if (is_page()) {
        $slug = get_page_template_slug(get_queried_object_id());
        if ($slug === GEMSCAN_TPL) {
            $file = plugin_dir_path(__FILE__) . 'templates/fullpage.php';
            if (file_exists($file)) {
                return $file;
            }
        }
    }
    return $template;
});

/* -------------------------------------------------------------------------
 * Options / defaults
 * ---------------------------------------------------------------------- */
function gemscan_defaults() {
    return array(
        'currency'          => 'USD',
        'explorer_price'    => '4.99',
        'collector_price'   => '14.99',
        'credits_price'     => '0.99',
        // Per-plan Stripe Payment Links (simplest — one link per plan).
        'stripe_link_explorer'  => 'https://buy.stripe.com/3cIbJ0dHw3Zo3Is5Pn4Vy04',
        'stripe_link_collector' => 'https://buy.stripe.com/3cIaEW9rg0Nc4MwdhP4Vy05',
        'stripe_link_credits'   => 'https://buy.stripe.com/8x28wOeLA2VkfrafpX4Vy06',
        // Advanced alternative: Stripe API keys (auto-activation). Used only if
        // no per-plan links are set above.
        'stripe_pk'         => '',
        'stripe_sk'         => '',
        // Owner's mobile-money numbers. 0907790584 is a Golis number used for
        // EVC Plus / Zaad / Sahal (grouped, shows the Sahal *883* code); eDahab is
        // 0667790584. Override any of these under Settings → GemScan.
        'evc_number'        => '0907790584',
        'edahab_number'     => '0667790584',
        'zaad_number'       => '0907790584',
        'sahal_number'      => '0907790584',
        // Per-operator USSD "dial to pay" templates. Placeholders:
        //   {number}   = local number WITH leading 0 (e.g. 0907790584)
        //   {national} = local number WITHOUT leading 0 (e.g. 667790584)
        //   {amount}   = plan price with the decimal typed as * (e.g. 4*99 / 14*99)
        // Owner-verified: Sahal/Golis *883*{number}*{amount}# (e.g. *883*0907790584*4*99#)
        //                 eDahab      *110*{national}*{amount}# (e.g. *110*667790584*4*99#)
        // EVC Plus / Zaad left blank — not used/confirmed here. If a number is shared
        // by several services, the first service with a code wins; keeping EVC/Zaad
        // blank makes a shared 090… (Golis) number correctly show the Sahal *883* code.
        'ussd_evc'          => '',
        'ussd_edahab'       => '*110*{national}*{amount}#',
        'ussd_zaad'         => '',
        'ussd_sahal'        => '*883*{number}*{amount}#',
        'notify_email'      => get_option('admin_email'),
        // Connection to the app's backend (for automatic account upgrade).
        'functions_url'     => '',   // e.g. https://xxxx.functions.supabase.co
        'activation_secret' => '',   // must match the ACTIVATION_SECRET on the server
    );
}

function gemscan_opts() {
    return wp_parse_args(get_option(GEMSCAN_OPT, array()), gemscan_defaults());
}

/* -------------------------------------------------------------------------
 * Activation bridge — upgrade an account by calling the backend function.
 * Returns array('ok'=>bool, 'msg'=>string).
 * ---------------------------------------------------------------------- */
function gemscan_activate($o, $email, $plan, $method = '', $reference = '') {
    if (empty($o['functions_url']) || empty($o['activation_secret'])) {
        return array('ok' => false, 'msg' => 'Set the Functions URL and Activation secret first.');
    }
    $url = rtrim($o['functions_url'], '/') . '/activate-subscription';
    $res = wp_remote_post($url, array(
        'timeout' => 20,
        'headers' => array('Content-Type' => 'application/json'),
        'body'    => wp_json_encode(array(
            'secret'    => $o['activation_secret'],
            'email'     => $email,
            'plan'      => $plan,
            'method'    => $method,
            'reference' => $reference,
        )),
    ));
    if (is_wp_error($res)) {
        return array('ok' => false, 'msg' => $res->get_error_message());
    }
    $code = wp_remote_retrieve_response_code($res);
    $data = json_decode(wp_remote_retrieve_body($res), true);
    if ($code === 200 && !empty($data['success'])) {
        return array('ok' => true, 'msg' => 'Activated ' . esc_html($email) . ' → ' . esc_html($data['tier']) . ' (until ' . esc_html(substr($data['expires'], 0, 10)) . ').');
    }
    return array('ok' => false, 'msg' => isset($data['error']) ? $data['error'] : ('HTTP ' . $code));
}

/* -------------------------------------------------------------------------
 * Account: look up a member's current plan by email (read-only).
 * ---------------------------------------------------------------------- */
function gemscan_status($o, $email) {
    if (empty($o['functions_url']) || empty($o['activation_secret'])) return null;
    $url = rtrim($o['functions_url'], '/') . '/activate-subscription';
    $res = wp_remote_post($url, array(
        'timeout' => 20,
        'headers' => array('Content-Type' => 'application/json'),
        'body'    => wp_json_encode(array(
            'secret' => $o['activation_secret'],
            'action' => 'status',
            'email'  => $email,
        )),
    ));
    if (is_wp_error($res)) return null;
    return json_decode(wp_remote_retrieve_body($res), true);
}

function gemscan_plan_label($tier) {
    if ($tier === 'professional') return 'Gem Collector';
    if ($tier === 'premium') return 'Explorer';
    return 'Free';
}

function gemscan_maybe_status($o) {
    if (empty($_POST['gemscan_status_check']) || !isset($_POST['gemscan_status_nonce'])) return '';
    if (!wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['gemscan_status_nonce'])), 'gemscan_status')) return '';
    $email = isset($_POST['gs_status_email']) ? sanitize_email(wp_unslash($_POST['gs_status_email'])) : '';
    if (!$email) return '';
    $s = gemscan_status($o, $email);
    if (!$s || empty($s['ok'])) {
        return '<div class="gs-alert gs-error">Hadda plan-kaaga lama hubin karo. Fadlan mar kale isku day.<br>'
             . 'Could not check your plan right now. Please try again.</div>';
    }
    if (empty($s['account'])) {
        return '<div class="gs-alert gs-error">Akoon lagama helin ' . esc_html($email) . '. Fadlan marka hore app-ka isku diiwaangeli.<br>'
             . 'No account found for ' . esc_html($email) . '. Please sign up in the app first.</div>';
    }
    $exp = !empty($s['expires']) ? ' (ilaa ' . esc_html(substr($s['expires'], 0, 10)) . ')' : '';
    return '<div class="gs-alert gs-ok">Plan-kaaga hadda: <strong>' . esc_html(gemscan_plan_label($s['tier'])) . '</strong>' . $exp
         . '. Hoos ka dooro plan si aad u beddesho ama u cusboonaysiiso.</div>';
}

/* -------------------------------------------------------------------------
 * Stripe Checkout (keys-based). Creates a Checkout Session server-side with the
 * secret key and returns the hosted-payment URL. Amount comes from the plan.
 * ---------------------------------------------------------------------- */
function gemscan_plan_amount_cents($o, $plan) {
    $price = (strtolower($plan) === 'gem collector') ? $o['collector_price'] : $o['explorer_price'];
    return (int) round(floatval($price) * 100);
}

function gemscan_stripe_create_session($o, $email, $plan, $return_url) {
    if (empty($o['stripe_sk'])) {
        set_transient('gemscan_last_error', 'Stripe secret key is not set in Settings → GemScan.', 300);
        return '';
    }
    $amount = gemscan_plan_amount_cents($o, $plan);
    if ($amount < 50) {
        set_transient('gemscan_last_error', 'Plan price is too low for a card charge (minimum ~0.50).', 300);
        return '';
    }
    // Stripe needs the LITERAL {CHECKOUT_SESSION_ID} in success_url — build it by
    // hand so it is NOT url-encoded (add_query_arg would encode the braces).
    $sep     = (strpos($return_url, '?') === false) ? '?' : '&';
    $success = $return_url . $sep . 'gemscan_success={CHECKOUT_SESSION_ID}';

    $res = wp_remote_post('https://api.stripe.com/v1/checkout/sessions', array(
        'timeout' => 25,
        'headers' => array(
            'Authorization' => 'Bearer ' . trim($o['stripe_sk']),
            'Content-Type'  => 'application/x-www-form-urlencoded',
        ),
        'body'    => array(
            'mode'            => 'payment',
            'success_url'     => $success,
            'cancel_url'      => $return_url,
            'customer_email'  => $email,
            'line_items[0][price_data][currency]'           => strtolower($o['currency']),
            'line_items[0][price_data][unit_amount]'        => (string) $amount,
            'line_items[0][price_data][product_data][name]' => 'GemScan ' . $plan . ' (1 year)',
            'line_items[0][quantity]'                       => '1',
            'metadata[gemscan_email]' => $email,
            'metadata[gemscan_plan]'  => $plan,
        ),
    ));
    if (is_wp_error($res)) {
        set_transient('gemscan_last_error', 'Network error: ' . $res->get_error_message(), 300);
        return '';
    }
    $code = wp_remote_retrieve_response_code($res);
    $data = json_decode(wp_remote_retrieve_body($res), true);
    if (!empty($data['url'])) {
        return $data['url'];
    }
    // Surface the real Stripe error so it can be fixed precisely.
    $msg = isset($data['error']['message']) ? $data['error']['message'] : ('Stripe returned HTTP ' . $code);
    set_transient('gemscan_last_error', 'Stripe: ' . $msg, 300);
    return '';
}

// Verify a returned Checkout Session was paid, then activate the account.
function gemscan_stripe_finalize($o, $session_id) {
    if (empty($o['stripe_sk'])) return '';
    $res = wp_remote_get('https://api.stripe.com/v1/checkout/sessions/' . rawurlencode($session_id), array(
        'timeout' => 25,
        'headers' => array('Authorization' => 'Bearer ' . $o['stripe_sk']),
    ));
    if (is_wp_error($res)) {
        return '<div class="gs-alert gs-error">Lacag-bixinta lama xaqiijin karin. Fadlan la xiriir taageerada.<br>'
             . 'Could not verify the payment. Please contact support.</div>';
    }
    $s = json_decode(wp_remote_retrieve_body($res), true);
    if (empty($s['payment_status']) || $s['payment_status'] !== 'paid') {
        return '<div class="gs-alert gs-error">Lacag-bixintu ma dhammaan. / Payment not completed.</div>';
    }
    $email = isset($s['metadata']['gemscan_email']) ? $s['metadata']['gemscan_email'] : ($s['customer_email'] ?? '');
    $plan  = isset($s['metadata']['gemscan_plan']) ? $s['metadata']['gemscan_plan'] : 'Explorer';
    $r = gemscan_activate($o, $email, $plan, 'stripe', $session_id);
    if ($r['ok']) {
        return '<div class="gs-alert gs-ok">✅ Lacagta waa la helay, akoonkaaguna hadda waa Premium. Fur app-ka si aad u aragto.<br>'
             . '✅ Payment received and your account is now Premium. Open the app to see it.</div>';
    }
    // Paid but activation failed — tell the user support will finish it.
    return '<div class="gs-alert gs-ok">✅ Lacagta waa la helay. Akoonkaaga waa la kordhin doonaa dhowaan.<br>'
         . '✅ Payment received. Your account will be upgraded shortly.</div>';
}

// Handle the "Pay with Card" submit BEFORE any output, so we can redirect.
add_action('init', function () {
    if (empty($_POST['gemscan_stripe']) || !isset($_POST['gemscan_stripe_nonce'])) return;
    if (!wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['gemscan_stripe_nonce'])), 'gemscan_stripe')) return;
    $o     = gemscan_opts();
    $email = isset($_POST['gs_email']) ? sanitize_email(wp_unslash($_POST['gs_email'])) : '';
    $plan  = isset($_POST['gs_plan']) ? sanitize_text_field(wp_unslash($_POST['gs_plan'])) : '';
    $ret   = isset($_POST['gs_return']) ? esc_url_raw(wp_unslash($_POST['gs_return'])) : home_url();
    if (!$email || !$plan) {
        wp_safe_redirect(add_query_arg('gemscan_err', 'email', $ret));
        exit;
    }
    $url = gemscan_stripe_create_session($o, $email, $plan, $ret);
    wp_redirect($url ? $url : add_query_arg('gemscan_err', 'stripe', $ret));
    exit;
});

/* -------------------------------------------------------------------------
 * Admin settings page
 * ---------------------------------------------------------------------- */
add_action('admin_menu', function () {
    add_options_page('GemScan Payments', 'GemScan', 'manage_options', 'gemscan-payment', 'gemscan_settings_page');
});

add_action('admin_init', function () {
    register_setting('gemscan_group', GEMSCAN_OPT, 'gemscan_sanitize');
});

function gemscan_sanitize($input) {
    $out = array();
    foreach (gemscan_defaults() as $k => $v) {
        $out[$k] = isset($input[$k]) ? sanitize_text_field($input[$k]) : $v;
    }
    return $out;
}

function gemscan_settings_page() {
    $o = gemscan_opts();

    // Handle the "activate an account" admin tool.
    $activation_notice = '';
    if (!empty($_POST['gemscan_do_activate']) && check_admin_referer('gemscan_activate_now')) {
        $email  = isset($_POST['act_email']) ? sanitize_email(wp_unslash($_POST['act_email'])) : '';
        $plan   = isset($_POST['act_plan']) ? sanitize_text_field(wp_unslash($_POST['act_plan'])) : '';
        $method = isset($_POST['act_method']) ? sanitize_text_field(wp_unslash($_POST['act_method'])) : '';
        $r = gemscan_activate($o, $email, $plan, $method);
        $activation_notice = '<div class="notice ' . ($r['ok'] ? 'notice-success' : 'notice-error') . '"><p>' . esc_html($r['msg']) . '</p></div>';
    }

    $fields = array(
        'currency'          => 'Currency code (e.g. USD)',
        'explorer_price'    => 'Explorer — yearly price',
        'collector_price'   => 'Gem Collector — yearly price',
        'credits_price'         => 'Extra credits — pack price',
        'stripe_link_explorer'  => 'Stripe Payment Link — Explorer',
        'stripe_link_collector' => 'Stripe Payment Link — Gem Collector',
        'stripe_link_credits'   => 'Stripe Payment Link — Credits',
        'stripe_pk'             => 'Stripe Publishable Key (optional — only if not using links above)',
        'stripe_sk'             => 'Stripe Secret Key (optional — kept server-side, never shown)',
        'evc_number'            => 'EVC Plus number',
        'edahab_number'     => 'eDahab number',
        'zaad_number'       => 'Zaad number',
        'sahal_number'      => 'Sahal number',
        'ussd_evc'          => 'USSD pay code — EVC Plus (e.g. *712*{number}*{amount}#). {number}=with 0, {national}=no 0, {amount}=comma price',
        'ussd_edahab'       => 'USSD pay code — eDahab (e.g. *110*{national}*{amount}#)',
        'ussd_zaad'         => 'USSD pay code — Zaad (leave blank until confirmed with Telesom)',
        'ussd_sahal'        => 'USSD pay code — Sahal / Golis (e.g. *883*{number}*{amount}#)',
        'notify_email'      => 'Notify email for payment confirmations',
        'functions_url'     => 'App backend Functions URL (e.g. https://xxxx.functions.supabase.co)',
        'activation_secret' => 'Activation secret (must match the server ACTIVATION_SECRET)',
    );
    echo $activation_notice; // phpcs:ignore
    ?>
    <div class="wrap">
        <h1>GemScan Payments</h1>

        <!-- Daily tool first: activate an account the moment a payment is confirmed. -->
        <div style="background:#fff;border:1px solid #c9a227;border-left:4px solid #c9a227;border-radius:8px;padding:16px 20px;margin:14px 0 24px;max-width:760px">
            <h2 style="margin-top:0">✅ Activate an account</h2>
            <p>After you have confirmed a payment (mobile money or Stripe), enter the member's GemScan email here to upgrade them instantly.</p>
            <form method="post">
                <?php wp_nonce_field('gemscan_activate_now'); ?>
                <input type="hidden" name="gemscan_do_activate" value="1">
                <table class="form-table" role="presentation">
                    <tr><th>Member email</th><td><input type="email" name="act_email" class="regular-text" required></td></tr>
                    <tr><th>Plan</th><td>
                        <select name="act_plan">
                            <option value="Explorer">Explorer</option>
                            <option value="Gem Collector">Gem Collector</option>
                        </select>
                    </td></tr>
                    <tr><th>Method</th><td>
                        <select name="act_method">
                            <option value="stripe">Stripe (card)</option>
                            <option value="mobile_money_evc">EVC Plus</option>
                            <option value="mobile_money_edahab">eDahab</option>
                            <option value="mobile_money_zaad">Zaad</option>
                            <option value="mobile_money_sahal">Sahal</option>
                        </select>
                    </td></tr>
                </table>
                <?php submit_button('Activate now', 'primary', 'submit', false); ?>
            </form>
        </div>

        <hr>
        <h2>Settings</h2>
        <p>Create a page (permalink <code>gemscanpayment</code>) containing this shortcode: <code>[gemscan_payment]</code></p>

        <form method="post" action="options.php">
            <?php settings_fields('gemscan_group'); ?>
            <table class="form-table" role="presentation">
                <?php foreach ($fields as $k => $label) {
                    $type = ($k === 'activation_secret' || $k === 'stripe_sk') ? 'password' : 'text';
                    printf(
                        '<tr><th scope="row"><label for="%1$s">%2$s</label></th><td><input type="%5$s" id="%1$s" name="%3$s[%1$s]" value="%4$s" class="regular-text"></td></tr>',
                        esc_attr($k),
                        esc_html($label),
                        esc_attr(GEMSCAN_OPT),
                        esc_attr($o[$k]),
                        esc_attr($type)
                    );
                } ?>
            </table>
            <?php submit_button('Save settings'); ?>
        </form>

        <hr>
        <h2>How it connects to the app</h2>
        <ol>
            <li>The member pays on your page (Stripe for cards, or mobile money).</li>
            <li>You confirm the payment, then use <em>Activate an account</em> at the top (or it can be automated with a Stripe webhook).</li>
            <li>This calls your app backend, which upgrades the member's subscription. The app shows Premium on their next open.</li>
        </ol>
    </div>
    <?php
}

/* -------------------------------------------------------------------------
 * Front-end assets
 * ---------------------------------------------------------------------- */
add_action('wp_enqueue_scripts', function () {
    wp_register_style('gemscan', plugins_url('assets/gemscan.css', __FILE__), array(), GEMSCAN_VER);
    wp_register_script('gemscan', plugins_url('assets/gemscan.js', __FILE__), array(), GEMSCAN_VER, true);
    // On the stand-alone full-page template, enqueue in the head (the shortcode
    // enqueues too, but the template needs the CSS ready before content).
    if (is_page() && get_page_template_slug(get_queried_object_id()) === GEMSCAN_TPL) {
        wp_enqueue_style('gemscan');
        wp_enqueue_script('gemscan');
    }
});

/* Bilingual helper (Somali default, toggle to EN client-side) */
function gs_t($en, $so) {
    return '<span class="gs-i18n" data-en="' . esc_attr($en) . '" data-so="' . esc_attr($so) . '">' . esc_html($so) . '</span>';
}

/* Plain-text bilingual helper for attribute contexts (placeholders, titles)
   where HTML/JS toggling can't run. Returns "Somali · English" so both readers
   get a hint regardless of the current toggle (Somali first — it is the default). */
function gs_t_raw($en, $so) {
    return $so . ' · ' . $en;
}

/* Turn any stored mobile-money number into the LOCAL dialling form used by the
   USSD pay code (drop the +252 country code, keep a single leading 0).
   e.g. +252907790584 → 0907790584 */
function gs_local_number($raw) {
    $d = preg_replace('/[^0-9]/', '', (string) $raw);
    if (strpos($d, '252') === 0) {
        $d = substr($d, 3);
    }
    $d = ltrim($d, '0');
    return $d === '' ? '' : '0' . $d;
}

/* -------------------------------------------------------------------------
 * Mobile-money confirmation form handler (front-end)
 * ---------------------------------------------------------------------- */
function gemscan_maybe_handle_form($o) {
    if (empty($_POST['gemscan_confirm']) || !isset($_POST['gemscan_nonce'])) {
        return '';
    }
    if (!wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['gemscan_nonce'])), 'gemscan_confirm')) {
        return '<div class="gs-alert gs-error">Security check failed. Please try again.</div>';
    }
    $name  = isset($_POST['gs_name']) ? sanitize_text_field(wp_unslash($_POST['gs_name'])) : '';
    $email = isset($_POST['gs_email']) ? sanitize_email(wp_unslash($_POST['gs_email'])) : '';
    $plan  = isset($_POST['gs_plan']) ? sanitize_text_field(wp_unslash($_POST['gs_plan'])) : '';
    $txn   = isset($_POST['gs_txn']) ? sanitize_text_field(wp_unslash($_POST['gs_txn'])) : '';
    $note  = isset($_POST['gs_note']) ? sanitize_text_field(wp_unslash($_POST['gs_note'])) : '';

    if (!$email || !$txn) {
        return '<div class="gs-alert gs-error">'
             . 'Fadlan gali email-ka GemScan iyo Tixraac Lambarka.<br>'
             . 'Please enter your GemScan email and the Transaction ID.'
             . '</div>';
    }

    // Direct link to the admin activation tool, so the owner can open the
    // account the moment they have verified the payment — one click from email.
    $admin_link = admin_url('options-general.php?page=gemscan-payment');

    $subject = 'GemScan payment — ' . $plan . ' — ' . $email;
    $body = '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#1c1c1e;line-height:1.6">'
          . '<h2 style="margin:0 0 12px">💎 New GemScan payment confirmation</h2>'
          . '<table cellpadding="6" style="border-collapse:collapse;font-size:15px">'
          . '<tr><td><strong>Name</strong></td><td>' . esc_html($name) . '</td></tr>'
          . '<tr><td><strong>Email</strong></td><td>' . esc_html($email) . '</td></tr>'
          . '<tr><td><strong>Plan</strong></td><td>' . esc_html($plan) . '</td></tr>'
          . '<tr><td><strong>Transaction ID</strong></td><td>' . esc_html($txn) . '</td></tr>'
          . '<tr><td><strong>Paid with</strong></td><td>' . esc_html($note) . '</td></tr>'
          . '</table>'
          . '<p style="margin:18px 0"><a href="' . esc_url($admin_link) . '" '
          . 'style="display:inline-block;background:#c9a227;color:#0b0b0c;text-decoration:none;'
          . 'font-weight:800;padding:12px 22px;border-radius:8px">Verify &amp; open this account →</a></p>'
          . '<p style="color:#555;font-size:13px">After verifying the payment, use the button above (Settings → GemScan → Activate an account), '
          . 'enter <strong>' . esc_html($email) . '</strong> and the plan, then click Activate now.</p>'
          . '<p style="color:#888;font-size:12px">' . esc_url($admin_link) . '</p>'
          . '</div>';
    $headers = array('Content-Type: text/html; charset=UTF-8');
    wp_mail($o['notify_email'], $subject, $body, $headers);

    // Rendered outside .gs-wrap, so the JS language toggle can't reach it —
    // show both languages so every reader understands (Somali first).
    return '<div class="gs-alert gs-ok">'
         . '✅ Mahadsanid! Xogtaada waan helnay, lacagtaadana waan xaqiijinaynaa. '
         . 'Akoonkaaga waa la kordhin doonaa dhowaan — fur app-ka si aad u aragto.<br><br>'
         . '✅ Thank you! We received your details and are verifying your payment. '
         . 'Your account will be upgraded shortly — open the app to see it.'
         . '</div>';
}

/* -------------------------------------------------------------------------
 * Shortcode: [gemscan_payment]
 * ---------------------------------------------------------------------- */
add_shortcode('gemscan_payment', 'gemscan_render');

function gemscan_render() {
    wp_enqueue_style('gemscan');
    wp_enqueue_script('gemscan');
    $o   = gemscan_opts();
    $cur = esc_html($o['currency']);

    ob_start();
    echo gemscan_maybe_handle_form($o); // phpcs:ignore
    echo gemscan_maybe_status($o); // phpcs:ignore
    // Stripe return: verify the session was paid and activate the account.
    if (isset($_GET['gemscan_success'])) {
        echo gemscan_stripe_finalize($o, sanitize_text_field(wp_unslash($_GET['gemscan_success']))); // phpcs:ignore
    }
    if (isset($_GET['gemscan_err'])) {
        $gs_err = get_transient('gemscan_last_error');
        delete_transient('gemscan_last_error');
        echo '<div class="gs-alert gs-error">' . esc_html($gs_err ? $gs_err : 'Lacag-bixinta lama bilaabin karin. Fadlan mar kale isku day. / Payment could not be started. Please try again.') . '</div>';
    }
    ?>
    <div class="gs-wrap">

        <div class="gs-lang-wrap">
            <div class="gs-lang" role="group" aria-label="Language">
                <button type="button" class="gs-lang-btn is-active" data-lang="so">🇸🇴 Soomaali</button>
                <button type="button" class="gs-lang-btn" data-lang="en">🇬🇧 English</button>
            </div>
        </div>

        <header class="gs-hero">
            <div class="gs-logo">💎 GemScan</div>
            <h1><?php echo gs_t('Expert gemstone, gold &amp; hallmark identification', 'Aqoonsi khibrad leh oo dhagxaan, dahab &amp; hallmark'); ?></h1>
            <p class="gs-sub"><?php echo gs_t('Scan any stone or precious item and get an instant identification, a market-value estimate, and a direct line to a gemstone expert.', 'Baar dhagax kasta ama shay qaali ah oo hel aqoonsi degdeg ah, qiyaas qiimaha suuqa, iyo xiriir toos ah oo khabiir dhagxaan ah.'); ?></p>
        </header>

        <form method="post" class="gs-account">
            <?php wp_nonce_field('gemscan_status', 'gemscan_status_nonce'); ?>
            <input type="hidden" name="gemscan_status_check" value="1">
            <label for="gs-email-main"><?php echo gs_t('Your GemScan account email', 'Email-ka akoonkaaga GemScan'); ?></label>
            <input type="email" id="gs-email-main" name="gs_status_email" placeholder="you@example.com" autocomplete="email" required>
            <small><?php echo gs_t('Use the same email you signed up with in the app, so we upgrade the right account.', 'Isticmaal email-ka aad app-ka ku isku diiwaangelisay, si aan akoonka saxda ah kor ugu qaadno.'); ?></small>
            <button type="submit" class="gs-status-btn"><?php echo gs_t('Check my current plan', 'Hubi plan-kaaga hadda'); ?></button>
        </form>

        <ul class="gs-values">
            <li>🔎 <?php echo gs_t('Trusted expert identification', 'Aqoonsi khibrad leh oo la aamini karo'); ?></li>
            <li>💰 <?php echo gs_t('Estimated market value', 'Qiimayn suuq'); ?></li>
            <li>🧑‍🔬 <?php echo gs_t('Contact a gemstone expert', 'La xiriir khabiir dhagxaan'); ?></li>
            <li>🌍 <?php echo gs_t('Somali &amp; English', 'Soomaali &amp; Ingiriisi'); ?></li>
        </ul>

        <section class="gs-plans">
            <div class="gs-plan">
                <h3><?php echo gs_t('Free', 'Bilaash'); ?></h3>
                <div class="gs-price">$0</div>
                <ul>
                    <li><?php echo gs_t('5 scans per day', '5 scan maalintii'); ?></li>
                    <li><?php echo gs_t('Instant identification', 'Aqoonsi degdeg ah'); ?></li>
                </ul>
                <div class="gs-plan-cta gs-muted"><?php echo gs_t('Already included', 'Horeba wuu ku jiraa'); ?></div>
            </div>

            <div class="gs-plan gs-popular">
                <div class="gs-badge"><?php echo gs_t('Most Popular', 'Ugu Caansan'); ?></div>
                <h3>Explorer</h3>
                <div class="gs-price"><?php echo $cur; ?> <?php echo esc_html($o['explorer_price']); ?><span>/<?php echo gs_t('year', 'sannad'); ?></span></div>
                <ul>
                    <li><?php echo gs_t('Unlimited standard scans', 'Scan caadi ah oo aan xad lahayn'); ?></li>
                    <li><?php echo gs_t('40 Deep Scans / year', '40 Deep Scan / sannad'); ?></li>
                    <li><?php echo gs_t('Full market value', 'Qiimayn buuxda'); ?></li>
                    <li><?php echo gs_t('Expert contact', 'Xiriir khabiir'); ?></li>
                </ul>
                <button type="button" class="gs-buy" data-plan="Explorer" data-price="<?php echo esc_attr($o['explorer_price']); ?>"><?php echo gs_t('Choose Explorer', 'Dooro Explorer'); ?></button>
            </div>

            <div class="gs-plan">
                <h3>Gem Collector</h3>
                <div class="gs-price"><?php echo $cur; ?> <?php echo esc_html($o['collector_price']); ?><span>/<?php echo gs_t('year', 'sannad'); ?></span></div>
                <ul>
                    <li><?php echo gs_t('Unlimited standard scans', 'Scan caadi ah oo aan xad lahayn'); ?></li>
                    <li><?php echo gs_t('200 Deep Scans / year', '200 Deep Scan / sannad'); ?></li>
                    <li><?php echo gs_t('PDF reports &amp; inventory', 'Warbixin PDF &amp; inventory'); ?></li>
                    <li><?php echo gs_t('Priority expert access', 'Xiriir khabiir mudnaan leh'); ?></li>
                </ul>
                <button type="button" class="gs-buy" data-plan="Gem Collector" data-price="<?php echo esc_attr($o['collector_price']); ?>"><?php echo gs_t('Choose Gem Collector', 'Dooro Gem Collector'); ?></button>
            </div>
        </section>

        <p class="gs-credits">➕ <?php echo gs_t('Need more Deep Scans?', 'Ma u baahan tahay Deep Scan dheeraad ah?'); ?>
            <strong><?php echo $cur; ?> <?php echo esc_html($o['credits_price']); ?></strong>
            <?php echo gs_t('for a credits pack.', 'oo credits ah.'); ?>
            <?php if ($o['stripe_link_credits']) : ?>
                <a class="gs-credits-link" href="<?php echo esc_url($o['stripe_link_credits']); ?>" target="_blank" rel="noopener"><?php echo gs_t('Buy credits', 'Iibso credits'); ?></a>
            <?php endif; ?>
        </p>

        <section class="gs-pay" id="gs-pay" style="display:none;">
            <h2><?php echo gs_t('Complete your payment', 'Dhammaystir lacag-bixinta'); ?> — <span id="gs-pay-plan"></span></h2>

            <?php if ($o['stripe_link_explorer'] || $o['stripe_link_collector']) : ?>
            <div class="gs-pay-group">
                <h4><?php echo gs_t('International (card)', 'Caalami (card)'); ?></h4>
                <a class="gs-pay-btn gs-stripe" id="gs-stripe" href="#" target="_blank" rel="noopener">💳 <?php echo gs_t('Pay with Card (Stripe)', 'Ku bixi Card (Stripe)'); ?></a>
                <p class="gs-momo-hint"><?php echo gs_t('You will be redirected to Stripe to pay securely by card.', 'Waxaa lagu gudbin doonaa Stripe si aad card ammaan ugu bixiso.'); ?></p>
            </div>
            <?php elseif ($o['stripe_pk'] && $o['stripe_sk']) : ?>
            <div class="gs-pay-group">
                <h4><?php echo gs_t('International (card)', 'Caalami (card)'); ?></h4>
                <form method="post" class="gs-stripe-form">
                    <?php wp_nonce_field('gemscan_stripe', 'gemscan_stripe_nonce'); ?>
                    <input type="hidden" name="gemscan_stripe" value="1">
                    <input type="hidden" name="gs_plan" id="gs-stripe-plan" value="">
                    <input type="hidden" name="gs_email" id="gs-stripe-email" value="">
                    <input type="hidden" name="gs_return" value="<?php echo esc_url(get_permalink()); ?>">
                    <button type="submit" class="gs-pay-btn gs-stripe">💳 <?php echo gs_t('Pay with Card (Stripe)', 'Ku bixi Card (Stripe)'); ?></button>
                </form>
            </div>
            <?php endif; ?>

            <?php if ($o['evc_number'] || $o['edahab_number'] || $o['zaad_number'] || $o['sahal_number']) : ?>
            <div class="gs-pay-group gs-momo-group">
                <h4><?php echo gs_t('Somalia — Mobile Money', 'Soomaaliya — Lacag Mobile'); ?></h4>

                <!-- Step-by-step instructions (numbered, plain text so the language
                     toggle can swap them cleanly). -->
                <ol class="gs-steps">
                    <li>
                        <?php echo gs_t(
                            'Send the exact plan amount to ONE of the numbers below, from your own phone.',
                            'Taleefankaaga uga dir qiimaha saxda ah ee plan-ka MID ka mid ah nambarrada hoose.'
                        ); ?>
                        <span class="gs-amt-line"><?php echo gs_t('Amount', 'Qiimaha'); ?>: <b class="gs-amt">—</b></span>
                    </li>
                    <li><?php echo gs_t(
                        'You will get an SMS receipt with a Transaction ID (reference number).',
                        'Waxaad heli doontaa fariin rasiid ah (SMS) oo leh Tixraac Lambar (Transaction ID).'
                    ); ?></li>
                    <li class="gs-step-key"><?php echo gs_t(
                        'Dial the pay code below — it already includes the number and the amount. Just confirm with your PIN. Then fill in the form below with your email and the Transaction ID.',
                        'Wac koodhka lacag-bixinta ee hoose — wuxuu hore u wataa nambarka iyo qiimaha. Kaliya ku xaqiiji PIN-kaaga. Kadibna buuxi foomka hoose adigoo gelinaya email-kaaga iyo Tixraac Lambarka.'
                    ); ?></li>
                </ol>

                <ul class="gs-momo">
                    <?php
                    // Group services that share the same number, so each number is
                    // shown only once. Build the USSD "dial to pay" code from the
                    // configured template ({number} = local number, {amount} = price).
                    $gs_momo = array(
                        'EVC Plus' => $o['evc_number'],
                        'eDahab'   => $o['edahab_number'],
                        'Zaad'     => $o['zaad_number'],
                        'Sahal'    => $o['sahal_number'],
                    );
                    // Group by the LOCAL number form, so services that share a
                    // number (e.g. EVC Plus / Zaad / Sahal → 0907790584) show once,
                    // whether the number was saved as +252… or 0….
                    $gs_by_num = array();
                    foreach ($gs_momo as $gs_svc => $gs_num) {
                        $gs_local = gs_local_number($gs_num);
                        if (!$gs_local) continue;
                        $gs_by_num[$gs_local][] = $gs_svc;
                    }
                    // Each operator has its own USSD send-money code.
                    $gs_ussd_map = array(
                        'EVC Plus' => $o['ussd_evc'],
                        'eDahab'   => $o['ussd_edahab'],
                        'Zaad'     => $o['ussd_zaad'],
                        'Sahal'    => $o['ussd_sahal'],
                    );
                    foreach ($gs_by_num as $gs_local => $gs_svcs) {
                        $gs_local = (string) $gs_local; // numeric-looking keys → string
                        $gs_label = implode(' / ', $gs_svcs);
                        // Use the USSD code of the first service in this group that
                        // has one configured (a number belongs to one operator).
                        $gs_ussd_tpl = '';
                        foreach ($gs_svcs as $gs_s) {
                            if (!empty($gs_ussd_map[$gs_s])) { $gs_ussd_tpl = $gs_ussd_map[$gs_s]; break; }
                        }
                        $gs_has_ussd = ($gs_ussd_tpl && (strpos($gs_ussd_tpl, '{number}') !== false || strpos($gs_ussd_tpl, '{national}') !== false));
                        // Fill the number now (with/without leading 0). The {amount}
                        // token stays until a plan is chosen — JS fills it with the
                        // comma-formatted price (e.g. 4,99).
                        $gs_national = ltrim($gs_local, '0');
                        $gs_code = $gs_has_ussd
                            ? str_replace(array('{number}', '{national}'), array($gs_local, $gs_national), $gs_ussd_tpl)
                            : '';
                        echo '<li class="gs-momo-item">'
                           . '<div class="gs-momo-top">'
                           . '<span class="gs-momo-svc">' . esc_html($gs_label) . '</span>'
                           . '<strong class="gs-momo-num">' . esc_html($gs_local) . '</strong>'
                           . '<button type="button" class="gs-copy" data-copy="' . esc_attr($gs_local) . '">'
                           . '<span class="gs-i18n" data-en="Copy" data-so="Koobi">Koobi</span></button>'
                           . '</div>';
                        if ($gs_has_ussd) {
                            echo '<div class="gs-momo-ussd">'
                               . '<span class="gs-ussd-label"><span class="gs-i18n" data-en="Tap to pay" data-so="Riix si aad u bixiso">Riix si aad u bixiso</span>:</span>'
                               . '<a class="gs-ussd-code" data-ussd="' . esc_attr($gs_code) . '" href="#">' . esc_html(str_replace('{amount}', '—', $gs_code)) . '</a>'
                               . '<button type="button" class="gs-copy gs-copy-ussd" data-ussd="' . esc_attr($gs_code) . '" data-copy="">'
                               . '<span class="gs-i18n" data-en="Copy" data-so="Koobi">Koobi</span></button>'
                               . '</div>';
                        }
                        echo '</li>';
                    }
                    ?>
                </ul>

                <!-- Payment confirmation form. The buyer's email + Transaction ID
                     are emailed to the owner, who verifies and opens the account. -->
                <div class="gs-confirm-box">
                    <p class="gs-confirm-title"><?php echo gs_t(
                        'After paying, send your details here to activate your account:',
                        'Ka dib markaad bixiso, xogtaada halkan noogu soo dir si akoonkaaga loo furo:'
                    ); ?></p>
                    <form method="post" class="gs-momo-form">
                        <?php wp_nonce_field('gemscan_confirm', 'gemscan_nonce'); ?>
                        <input type="hidden" name="gemscan_confirm" value="1">
                        <input type="hidden" name="gs_plan" id="gs-form-plan" value="">

                        <label class="gs-field-label"><?php echo gs_t('Your full name', 'Magacaaga oo dhan'); ?></label>
                        <input type="text" name="gs_name" placeholder="Aamina Yuusuf Cali">

                        <label class="gs-field-label"><?php echo gs_t('Your GemScan account email', 'Email-ka akoonka GemScan'); ?></label>
                        <input type="email" name="gs_email" id="gs-form-email" placeholder="you@example.com" autocomplete="email" required>

                        <label class="gs-field-label"><?php echo gs_t('Transaction ID — Reference number', 'Tixraac Lambar (Transaction ID)'); ?></label>
                        <input type="text" name="gs_txn" placeholder="<?php echo esc_attr(gs_t_raw('From your SMS receipt', 'Ka soo qaado fariinta rasiidka')); ?>" required>

                        <label class="gs-field-label"><?php echo gs_t('Which service did you pay with? (optional)', 'Adeeggee baad ku bixisay? (ikhtiyaari)'); ?></label>
                        <input type="text" name="gs_note" placeholder="<?php echo esc_attr(gs_t_raw('e.g. EVC Plus', 'tusaale: EVC Plus')); ?>">

                        <button type="submit" class="gs-pay-btn gs-confirm"><?php echo gs_t('I have paid — activate my account', 'Waan bixiyay lacagta — ii fur akoonka'); ?></button>
                    </form>
                </div>
            </div>
            <?php endif; ?>
        </section>

        <p class="gs-disclaimer"><?php echo gs_t('Market values shown in the app are estimates based on photographs and are not a professional appraisal.', 'Qiimayaasha suuqa ee app-ka waa qiyaas ku saleysan sawirro, mana aha qiimayn xirfadeed.'); ?></p>

        <script type="application/json" id="gs-config">
            <?php echo wp_json_encode(array(
                'currency' => $o['currency'],
                'links'    => array(
                    'Explorer'      => $o['stripe_link_explorer'],
                    'Gem Collector' => $o['stripe_link_collector'],
                ),
                'creditsLink' => $o['stripe_link_credits'],
            )); ?>
        </script>
    </div>
    <?php
    return ob_get_clean();
}

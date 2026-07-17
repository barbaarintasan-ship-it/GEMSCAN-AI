<?php
/**
 * Settings: default currency + webhook secret for the integration bridge.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$gsa_s        = gsa_settings();
$gsa_endpoint = rest_url( 'gsa/v1/payment' );
?>

<form method="post" action="<?php echo esc_url( admin_url( 'admin.php' ) ); ?>" class="gsa-form">
	<input type="hidden" name="page" value="gemscan-accounting-settings" />
	<input type="hidden" name="gsa_action" value="save_settings" />
	<?php wp_nonce_field( 'gsa_save_settings' ); ?>

	<h2><?php esc_html_e( 'Settings', 'gemscan-accounting' ); ?></h2>
	<table class="form-table" role="presentation">
		<tr>
			<th><label for="default_currency"><?php esc_html_e( 'Default currency', 'gemscan-accounting' ); ?></label></th>
			<td><input type="text" name="default_currency" id="default_currency" class="small-text" maxlength="8" value="<?php echo esc_attr( $gsa_s['default_currency'] ); ?>" /></td>
		</tr>
		<tr>
			<th><label for="webhook_secret"><?php esc_html_e( 'Integration webhook secret', 'gemscan-accounting' ); ?></label></th>
			<td>
				<input type="text" name="webhook_secret" id="webhook_secret" class="regular-text code" value="<?php echo esc_attr( $gsa_s['webhook_secret'] ); ?>" />
				<label style="margin-left:8px;"><input type="checkbox" name="gsa_regen_secret" value="1" /> <?php esc_html_e( 'Regenerate on save', 'gemscan-accounting' ); ?></label>
				<p class="description"><?php esc_html_e( 'Gateways/webhooks must send this value in the X-GSA-Secret header (or a "secret" body field) to record a payment.', 'gemscan-accounting' ); ?></p>
			</td>
		</tr>
	</table>

	<p class="submit"><button type="submit" class="button button-primary"><?php esc_html_e( 'Save settings', 'gemscan-accounting' ); ?></button></p>
</form>

<div class="gsa-card">
	<h2><?php esc_html_e( 'Integration', 'gemscan-accounting' ); ?></h2>
	<p><?php esc_html_e( 'Automatically record a sale from Stripe / PayPal / Salaam / EVC Plus / Zaad / eDahab by calling this endpoint after a successful payment:', 'gemscan-accounting' ); ?></p>
	<p><code><?php echo esc_html( 'POST ' . $gsa_endpoint ); ?></code></p>
	<p><?php esc_html_e( 'Header:', 'gemscan-accounting' ); ?> <code>X-GSA-Secret: <?php echo esc_html( $gsa_s['webhook_secret'] ? $gsa_s['webhook_secret'] : '(set a secret above)' ); ?></code></p>
	<p><?php esc_html_e( 'JSON body example:', 'gemscan-accounting' ); ?></p>
	<pre class="gsa-code">{
  "customer_name": "Aamina Yuusuf",
  "email": "aamina@example.com",
  "phone": "+2526...",
  "country": "Somalia",
  "plan": "professional",
  "amount": 14.99,
  "currency": "USD",
  "method": "evc",
  "txn_id": "EVC123456",
  "status": "paid",
  "start_date": "<?php echo esc_html( current_time( 'Y-m-d' ) ); ?>",
  "expiry_date": "<?php echo esc_html( gmdate( 'Y-m-d', strtotime( '+1 year', current_time( 'timestamp' ) ) ) ); // phpcs:ignore ?>"
}</pre>
	<p class="description"><?php esc_html_e( 'Or, from PHP on this site: do_action( "gsa_capture_payment", $data );  — or gsa_record_payment( $data );  Records are de-duplicated on (Transaction ID + Method).', 'gemscan-accounting' ); ?></p>
</div>

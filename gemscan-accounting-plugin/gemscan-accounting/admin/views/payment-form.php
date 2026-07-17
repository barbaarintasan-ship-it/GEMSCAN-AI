<?php
/**
 * Add / edit a payment.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$gsa_id  = isset( $_GET['id'] ) ? absint( $_GET['id'] ) : 0; // phpcs:ignore WordPress.Security.NonceVerification
$gsa_row = $gsa_id ? GSA_DB::get_payment( $gsa_id ) : null;
$gsa_def = array(
	'customer_name' => '',
	'email'         => '',
	'phone'         => '',
	'country'       => '',
	'user_id'       => '',
	'plan'          => 'explorer',
	'amount'        => '',
	'currency'      => gsa_settings()['default_currency'],
	'method'        => 'evc',
	'txn_id'        => '',
	'start_date'    => current_time( 'Y-m-d' ),
	'expiry_date'   => '',
	'status'        => 'paid',
	'notes'         => '',
);
$gsa_v      = wp_parse_args( (array) $gsa_row, $gsa_def );
$gsa_is_new = ! $gsa_id;
$gsa_back   = gsa_admin_url( array( 'page' => 'gemscan-accounting-payments' ) );

/** Small helper to render a labelled select. */
$gsa_select = function ( $name, $options, $selected ) {
	echo '<select name="' . esc_attr( $name ) . '" id="' . esc_attr( $name ) . '" class="regular-text">';
	foreach ( $options as $k => $lbl ) {
		printf( '<option value="%1$s"%2$s>%3$s</option>', esc_attr( $k ), selected( $selected, $k, false ), esc_html( $lbl ) );
	}
	echo '</select>';
};
?>

<h2><?php echo $gsa_is_new ? esc_html__( 'Add Payment', 'gemscan-accounting' ) : esc_html__( 'Edit Payment', 'gemscan-accounting' ) . ' #' . (int) $gsa_id; ?></h2>

<form method="post" action="<?php echo esc_url( admin_url( 'admin.php' ) ); ?>" class="gsa-form">
	<input type="hidden" name="page" value="gemscan-accounting-payments" />
	<input type="hidden" name="gsa_action" value="save_payment" />
	<input type="hidden" name="id" value="<?php echo (int) $gsa_id; ?>" />
	<?php wp_nonce_field( 'gsa_save_payment' ); ?>

	<table class="form-table" role="presentation">
		<tr>
			<th><label for="customer_name"><?php esc_html_e( 'Customer Name', 'gemscan-accounting' ); ?></label></th>
			<td><input type="text" name="customer_name" id="customer_name" class="regular-text" value="<?php echo esc_attr( $gsa_v['customer_name'] ); ?>" /></td>
		</tr>
		<tr>
			<th><label for="email"><?php esc_html_e( 'Email', 'gemscan-accounting' ); ?></label></th>
			<td><input type="email" name="email" id="email" class="regular-text" value="<?php echo esc_attr( $gsa_v['email'] ); ?>" required /></td>
		</tr>
		<tr>
			<th><label for="phone"><?php esc_html_e( 'Phone Number', 'gemscan-accounting' ); ?></label></th>
			<td><input type="text" name="phone" id="phone" class="regular-text" value="<?php echo esc_attr( $gsa_v['phone'] ); ?>" /></td>
		</tr>
		<tr>
			<th><label for="country"><?php esc_html_e( 'Country', 'gemscan-accounting' ); ?></label></th>
			<td><input type="text" name="country" id="country" class="regular-text" value="<?php echo esc_attr( $gsa_v['country'] ); ?>" /></td>
		</tr>
		<tr>
			<th><label for="user_id"><?php esc_html_e( 'User ID (optional)', 'gemscan-accounting' ); ?></label></th>
			<td><input type="number" name="user_id" id="user_id" class="small-text" value="<?php echo esc_attr( $gsa_v['user_id'] ); ?>" /></td>
		</tr>
		<tr>
			<th><label for="plan"><?php esc_html_e( 'Subscription Plan', 'gemscan-accounting' ); ?></label></th>
			<td><?php $gsa_select( 'plan', gsa_plans(), $gsa_v['plan'] ); ?></td>
		</tr>
		<tr>
			<th><label for="amount"><?php esc_html_e( 'Amount Paid', 'gemscan-accounting' ); ?></label></th>
			<td>
				<input type="number" step="0.01" min="0" name="amount" id="amount" class="small-text" value="<?php echo esc_attr( $gsa_v['amount'] ); ?>" />
				<input type="text" name="currency" id="currency" class="small-text" maxlength="8" value="<?php echo esc_attr( $gsa_v['currency'] ); ?>" style="width:70px;" />
			</td>
		</tr>
		<tr>
			<th><label for="method"><?php esc_html_e( 'Payment Method', 'gemscan-accounting' ); ?></label></th>
			<td><?php $gsa_select( 'method', gsa_methods(), $gsa_v['method'] ); ?></td>
		</tr>
		<tr>
			<th><label for="txn_id"><?php esc_html_e( 'Transaction ID', 'gemscan-accounting' ); ?></label></th>
			<td><input type="text" name="txn_id" id="txn_id" class="regular-text" value="<?php echo esc_attr( $gsa_v['txn_id'] ); ?>" /></td>
		</tr>
		<tr>
			<th><label for="start_date"><?php esc_html_e( 'Subscription Start Date', 'gemscan-accounting' ); ?></label></th>
			<td><input type="date" name="start_date" id="start_date" value="<?php echo esc_attr( $gsa_v['start_date'] ); ?>" /></td>
		</tr>
		<tr>
			<th><label for="expiry_date"><?php esc_html_e( 'Expiry Date', 'gemscan-accounting' ); ?></label></th>
			<td><input type="date" name="expiry_date" id="expiry_date" value="<?php echo esc_attr( $gsa_v['expiry_date'] ); ?>" /></td>
		</tr>
		<tr>
			<th><label for="status"><?php esc_html_e( 'Payment Status', 'gemscan-accounting' ); ?></label></th>
			<td><?php $gsa_select( 'status', gsa_statuses(), $gsa_v['status'] ); ?></td>
		</tr>
		<tr>
			<th><label for="notes"><?php esc_html_e( 'Notes', 'gemscan-accounting' ); ?></label></th>
			<td><textarea name="notes" id="notes" class="large-text" rows="3"><?php echo esc_textarea( $gsa_v['notes'] ); ?></textarea></td>
		</tr>
	</table>

	<p class="submit">
		<button type="submit" class="button button-primary"><?php echo $gsa_is_new ? esc_html__( 'Add Payment', 'gemscan-accounting' ) : esc_html__( 'Save Changes', 'gemscan-accounting' ); ?></button>
		<a href="<?php echo esc_url( $gsa_back ); ?>" class="button"><?php esc_html_e( 'Cancel', 'gemscan-accounting' ); ?></a>
	</p>
</form>

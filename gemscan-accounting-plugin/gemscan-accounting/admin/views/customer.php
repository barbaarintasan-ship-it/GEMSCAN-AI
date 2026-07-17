<?php
/**
 * Customer detail: payment history, current subscription, renewals, lifetime total.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$gsa_email = isset( $_GET['email'] ) ? sanitize_email( wp_unslash( $_GET['email'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification
$gsa_back  = gsa_admin_url( array( 'page' => 'gemscan-accounting-payments' ) );

if ( ! $gsa_email ) {
	echo '<p>' . esc_html__( 'No customer selected.', 'gemscan-accounting' ) . '</p>';
	echo '<a href="' . esc_url( $gsa_back ) . '" class="button">&larr; ' . esc_html__( 'Back to payments', 'gemscan-accounting' ) . '</a>';
	return;
}

$gsa_rows     = GSA_DB::customer_payments( $gsa_email );
$gsa_lifetime = GSA_DB::customer_lifetime( $gsa_email );
$gsa_cur      = gsa_settings()['default_currency'];

// Current subscription = latest paid, non-free record.
$gsa_current = null;
$gsa_paid    = 0;
foreach ( $gsa_rows as $gsa_r ) {
	if ( 'paid' === $gsa_r['status'] && 'free' !== $gsa_r['plan'] ) {
		$gsa_paid++;
		if ( null === $gsa_current ) {
			$gsa_current = $gsa_r;
		}
	}
}
$gsa_name    = ( $gsa_rows && $gsa_rows[0]['customer_name'] ) ? $gsa_rows[0]['customer_name'] : $gsa_email;
$gsa_renewed = max( 0, $gsa_paid - 1 );
?>

<p><a href="<?php echo esc_url( $gsa_back ); ?>" class="button">&larr; <?php esc_html_e( 'Back to payments', 'gemscan-accounting' ); ?></a></p>

<h2><?php echo esc_html( $gsa_name ); ?></h2>
<p class="gsa-muted"><?php echo esc_html( $gsa_email ); ?></p>

<div class="gsa-tiles gsa-tiles-3">
	<div class="gsa-tile gsa-tile-primary">
		<div class="gsa-tile-label"><?php esc_html_e( 'Lifetime Payments', 'gemscan-accounting' ); ?></div>
		<div class="gsa-tile-value"><?php echo esc_html( gsa_money( $gsa_lifetime, $gsa_cur ) ); ?></div>
	</div>
	<div class="gsa-tile">
		<div class="gsa-tile-label"><?php esc_html_e( 'Current Plan', 'gemscan-accounting' ); ?></div>
		<div class="gsa-tile-value" style="font-size:20px;">
			<?php echo $gsa_current ? esc_html( gsa_label( $gsa_current['plan'], 'plan' ) ) : esc_html__( 'None / Free', 'gemscan-accounting' ); ?>
		</div>
		<?php if ( $gsa_current && ! empty( $gsa_current['expiry_date'] ) ) : ?>
			<div class="gsa-muted"><?php esc_html_e( 'Expires', 'gemscan-accounting' ); ?> <?php echo esc_html( $gsa_current['expiry_date'] ); ?></div>
		<?php endif; ?>
	</div>
	<div class="gsa-tile">
		<div class="gsa-tile-label"><?php esc_html_e( 'Renewals', 'gemscan-accounting' ); ?></div>
		<div class="gsa-tile-value"><?php echo (int) $gsa_renewed; ?></div>
	</div>
</div>

<h3><?php esc_html_e( 'Payment history', 'gemscan-accounting' ); ?></h3>
<table class="wp-list-table widefat fixed striped">
	<thead>
		<tr>
			<th><?php esc_html_e( 'Date', 'gemscan-accounting' ); ?></th>
			<th><?php esc_html_e( 'Plan', 'gemscan-accounting' ); ?></th>
			<th><?php esc_html_e( 'Amount', 'gemscan-accounting' ); ?></th>
			<th><?php esc_html_e( 'Method', 'gemscan-accounting' ); ?></th>
			<th><?php esc_html_e( 'Transaction ID', 'gemscan-accounting' ); ?></th>
			<th><?php esc_html_e( 'Status', 'gemscan-accounting' ); ?></th>
			<th></th>
		</tr>
	</thead>
	<tbody>
		<?php if ( empty( $gsa_rows ) ) : ?>
			<tr><td colspan="7"><?php esc_html_e( 'No payments for this customer.', 'gemscan-accounting' ); ?></td></tr>
		<?php else : ?>
			<?php foreach ( $gsa_rows as $gsa_r ) : ?>
				<?php
				$gsa_edit = gsa_admin_url(
					array(
						'page'   => 'gemscan-accounting-payments',
						'action' => 'edit',
						'id'     => (int) $gsa_r['id'],
					)
				);
				?>
				<tr>
					<td><?php echo esc_html( mysql2date( 'Y-m-d', $gsa_r['created_at'] ) ); ?></td>
					<td><?php echo esc_html( gsa_label( $gsa_r['plan'], 'plan' ) ); ?></td>
					<td><strong><?php echo esc_html( gsa_money( $gsa_r['amount'], $gsa_r['currency'] ) ); ?></strong></td>
					<td><?php echo esc_html( gsa_label( $gsa_r['method'], 'method' ) ); ?></td>
					<td><?php echo esc_html( $gsa_r['txn_id'] ); ?></td>
					<td><span class="gsa-badge gsa-badge-<?php echo esc_attr( gsa_status_class( $gsa_r['status'] ) ); ?>"><?php echo esc_html( gsa_label( $gsa_r['status'], 'status' ) ); ?></span></td>
					<td><a href="<?php echo esc_url( $gsa_edit ); ?>"><?php esc_html_e( 'Edit', 'gemscan-accounting' ); ?></a></td>
				</tr>
			<?php endforeach; ?>
		<?php endif; ?>
	</tbody>
</table>

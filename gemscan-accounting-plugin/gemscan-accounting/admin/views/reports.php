<?php
/**
 * Reports: pick a period, view summary + chart, download PDF or print.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$gsa_period = isset( $_GET['period'] ) ? sanitize_key( wp_unslash( $_GET['period'] ) ) : 'monthly'; // phpcs:ignore WordPress.Security.NonceVerification
$gsa_valid  = array( 'daily', 'weekly', 'monthly', 'annual' );
if ( ! in_array( $gsa_period, $gsa_valid, true ) ) {
	$gsa_period = 'monthly';
}
$gsa_r   = GSA_Reports::period_report( $gsa_period );
$gsa_cur = gsa_settings()['default_currency'];

$gsa_period_labels = array(
	'daily'   => __( 'Daily', 'gemscan-accounting' ),
	'weekly'  => __( 'Weekly', 'gemscan-accounting' ),
	'monthly' => __( 'Monthly', 'gemscan-accounting' ),
	'annual'  => __( 'Annual', 'gemscan-accounting' ),
);
?>

<div class="gsa-page-head gsa-no-print">
	<nav class="gsa-subtabs">
		<?php foreach ( $gsa_period_labels as $gsa_k => $gsa_lbl ) : ?>
			<a href="<?php echo esc_url( gsa_admin_url( array( 'page' => 'gemscan-accounting-reports', 'period' => $gsa_k ) ) ); ?>"
				class="button <?php echo $gsa_period === $gsa_k ? 'button-primary' : ''; ?>">
				<?php echo esc_html( $gsa_lbl ); ?>
			</a>
		<?php endforeach; ?>
	</nav>
	<form method="get" style="display:inline;">
		<input type="hidden" name="page" value="gemscan-accounting-reports" />
		<input type="hidden" name="period" value="<?php echo esc_attr( $gsa_period ); ?>" />
		<?php wp_nonce_field( 'gsa_export' ); ?>
		<button type="submit" name="gsa_action" value="export_pdf" class="button"><?php esc_html_e( 'Download PDF', 'gemscan-accounting' ); ?></button>
		<button type="button" class="button" onclick="window.print();"><?php esc_html_e( 'Print', 'gemscan-accounting' ); ?></button>
	</form>
</div>

<div class="gsa-report">
	<h2><?php echo esc_html( $gsa_r['title'] ); ?></h2>
	<p class="gsa-muted"><?php echo esc_html( substr( $gsa_r['from'], 0, 10 ) . ' → ' . substr( $gsa_r['to'], 0, 10 ) ); ?></p>

	<div class="gsa-tiles gsa-tiles-2">
		<div class="gsa-tile gsa-tile-primary">
			<div class="gsa-tile-label"><?php esc_html_e( 'Revenue (paid)', 'gemscan-accounting' ); ?></div>
			<div class="gsa-tile-value"><?php echo esc_html( gsa_money( $gsa_r['revenue'], $gsa_cur ) ); ?></div>
		</div>
		<div class="gsa-tile">
			<div class="gsa-tile-label"><?php esc_html_e( 'Paid transactions', 'gemscan-accounting' ); ?></div>
			<div class="gsa-tile-value"><?php echo (int) $gsa_r['count']; ?></div>
		</div>
	</div>

	<div class="gsa-card gsa-no-print">
		<h3><?php esc_html_e( 'Revenue by method', 'gemscan-accounting' ); ?></h3>
		<canvas class="gsa-chart" data-type="bar"
			data-labels='<?php echo esc_attr( wp_json_encode( array_map( function ( $k ) { return gsa_label( $k, 'method' ); }, array_keys( $gsa_r['by_method'] ) ) ) ); ?>'
			data-values='<?php echo esc_attr( wp_json_encode( array_map( function ( $v ) { return $v['total']; }, array_values( $gsa_r['by_method'] ) ) ) ); ?>'
			height="200"></canvas>
	</div>

	<div class="gsa-grid-3">
		<?php
		gsa_breakdown_card( __( 'By Plan', 'gemscan-accounting' ), $gsa_r['by_plan'], 'plan', $gsa_cur );
		gsa_breakdown_card( __( 'By Method', 'gemscan-accounting' ), $gsa_r['by_method'], 'method', $gsa_cur );
		gsa_breakdown_card( __( 'By Country', 'gemscan-accounting' ), $gsa_r['by_country'], 'country', $gsa_cur );
		?>
	</div>
</div>

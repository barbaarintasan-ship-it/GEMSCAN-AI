<?php
/**
 * Accounting dashboard: revenue tiles, breakdowns, subscription health, charts.
 *
 * @package GemScan_Accounting
 * @var string $tab
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$gsa_cur     = gsa_settings()['default_currency'];
$gsa_tiles   = GSA_Reports::revenue_tiles();
$gsa_stats   = GSA_Reports::subscription_stats();
$gsa_methods = GSA_Reports::totals_by( 'method' );
$gsa_byplan  = GSA_Reports::totals_by( 'plan' );
$gsa_country = GSA_Reports::totals_by( 'country' );
$gsa_series  = GSA_Reports::timeseries( 'month', 12 );
?>

<div class="gsa-tiles">
	<?php
	$gsa_tile_defs = array(
		'total' => __( 'Total Revenue', 'gemscan-accounting' ),
		'today' => __( 'Today', 'gemscan-accounting' ),
		'week'  => __( 'This Week', 'gemscan-accounting' ),
		'month' => __( 'This Month', 'gemscan-accounting' ),
		'year'  => __( 'This Year', 'gemscan-accounting' ),
	);
	foreach ( $gsa_tile_defs as $gsa_k => $gsa_label ) :
		?>
		<div class="gsa-tile">
			<div class="gsa-tile-label"><?php echo esc_html( $gsa_label ); ?></div>
			<div class="gsa-tile-value"><?php echo esc_html( gsa_money( $gsa_tiles[ $gsa_k ], $gsa_cur ) ); ?></div>
		</div>
	<?php endforeach; ?>
</div>

<div class="gsa-stats">
	<div class="gsa-stat gsa-stat-ok">
		<span class="gsa-stat-num"><?php echo (int) $gsa_stats['active']; ?></span>
		<span class="gsa-stat-lbl"><?php esc_html_e( 'Active subscriptions', 'gemscan-accounting' ); ?></span>
	</div>
	<div class="gsa-stat gsa-stat-warn">
		<span class="gsa-stat-num"><?php echo (int) $gsa_stats['expired']; ?></span>
		<span class="gsa-stat-lbl"><?php esc_html_e( 'Expired', 'gemscan-accounting' ); ?></span>
	</div>
	<div class="gsa-stat">
		<span class="gsa-stat-num"><?php echo (int) $gsa_stats['renewals']; ?></span>
		<span class="gsa-stat-lbl"><?php esc_html_e( 'Renewals', 'gemscan-accounting' ); ?></span>
	</div>
	<div class="gsa-stat gsa-stat-muted">
		<span class="gsa-stat-num"><?php echo (int) $gsa_stats['refunds']; ?></span>
		<span class="gsa-stat-lbl"><?php esc_html_e( 'Refunds', 'gemscan-accounting' ); ?></span>
	</div>
</div>

<div class="gsa-grid-2">
	<div class="gsa-card">
		<h2><?php esc_html_e( 'Revenue trend (12 months)', 'gemscan-accounting' ); ?></h2>
		<canvas class="gsa-chart" data-type="bar"
			data-labels='<?php echo esc_attr( wp_json_encode( $gsa_series['labels'] ) ); ?>'
			data-values='<?php echo esc_attr( wp_json_encode( $gsa_series['data'] ) ); ?>'
			height="220"></canvas>
	</div>
	<div class="gsa-card">
		<h2><?php esc_html_e( 'Revenue by plan', 'gemscan-accounting' ); ?></h2>
		<canvas class="gsa-chart" data-type="doughnut"
			data-labels='<?php echo esc_attr( wp_json_encode( array_map( function ( $k ) { return gsa_label( $k, 'plan' ); }, array_keys( $gsa_byplan ) ) ) ); ?>'
			data-values='<?php echo esc_attr( wp_json_encode( array_map( function ( $v ) { return $v['total']; }, array_values( $gsa_byplan ) ) ) ); ?>'
			height="220"></canvas>
	</div>
</div>

<div class="gsa-grid-3">
	<?php
	gsa_breakdown_card( __( 'By Payment Method', 'gemscan-accounting' ), $gsa_methods, 'method', $gsa_cur );
	gsa_breakdown_card( __( 'By Subscription Plan', 'gemscan-accounting' ), $gsa_byplan, 'plan', $gsa_cur );
	gsa_breakdown_card( __( 'By Country', 'gemscan-accounting' ), $gsa_country, 'country', $gsa_cur );
	?>
</div>

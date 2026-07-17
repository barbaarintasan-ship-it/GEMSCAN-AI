<?php
/**
 * Payments list view (table + search/filter/sort/bulk + export buttons).
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$gsa_table = GSA_Admin::payments_table();
$gsa_table->prepare_items();
$gsa_filters = GSA_Admin::filters_from_request();
$gsa_add_url = gsa_admin_url(
	array(
		'page'   => 'gemscan-accounting-payments',
		'action' => 'new',
	)
);
?>

<div class="gsa-page-head">
	<a href="<?php echo esc_url( $gsa_add_url ); ?>" class="button button-primary"><?php esc_html_e( '+ Add Payment', 'gemscan-accounting' ); ?></a>

	<form method="get" class="gsa-export-form">
		<input type="hidden" name="page" value="gemscan-accounting-payments" />
		<?php
		// Carry the active filters into the export so it exports what you see.
		foreach ( array( 's', 'status', 'plan', 'method', 'country', 'from', 'to', 'orderby', 'order' ) as $gsa_f ) {
			$gsa_v = isset( $gsa_filters[ $gsa_f ] ) ? $gsa_filters[ $gsa_f ] : ( isset( $_REQUEST[ $gsa_f ] ) ? sanitize_text_field( wp_unslash( $_REQUEST[ $gsa_f ] ) ) : '' ); // phpcs:ignore WordPress.Security.NonceVerification
			if ( '' !== $gsa_v ) {
				echo '<input type="hidden" name="' . esc_attr( $gsa_f ) . '" value="' . esc_attr( $gsa_v ) . '" />';
			}
		}
		wp_nonce_field( 'gsa_export' );
		?>
		<button type="submit" name="gsa_action" value="export_csv" class="button"><?php esc_html_e( 'Export CSV', 'gemscan-accounting' ); ?></button>
		<button type="submit" name="gsa_action" value="export_excel" class="button"><?php esc_html_e( 'Export Excel', 'gemscan-accounting' ); ?></button>
		<button type="button" class="button" onclick="window.print();"><?php esc_html_e( 'Print', 'gemscan-accounting' ); ?></button>
	</form>
</div>

<form method="get">
	<input type="hidden" name="page" value="gemscan-accounting-payments" />
	<?php
	$gsa_table->search_box( __( 'Search payments', 'gemscan-accounting' ), 'gsa-search' );
	$gsa_table->display();
	?>
</form>

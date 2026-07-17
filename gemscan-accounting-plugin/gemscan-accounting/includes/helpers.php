<?php
/**
 * Shared enums, option keys and small formatting/sanitizing helpers.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Option key for plugin settings (default currency, webhook secret, etc.). */
define( 'GSA_OPT', 'gsa_settings' );

/**
 * Subscription plans. Keys are stored in the DB; labels are shown in the UI.
 * "professional" == the app's Pro / Gem Collector tier (kept consistent with
 * the GemScan app + payment plugin tier naming).
 *
 * @return array<string,string>
 */
function gsa_plans() {
	return array(
		'free'         => __( 'Free', 'gemscan-accounting' ),
		'explorer'     => __( 'Explorer', 'gemscan-accounting' ),
		'professional' => __( 'Pro (Gem Collector)', 'gemscan-accounting' ),
	);
}

/**
 * Payment methods.
 *
 * @return array<string,string>
 */
function gsa_methods() {
	return array(
		'stripe' => __( 'Stripe', 'gemscan-accounting' ),
		'paypal' => __( 'PayPal', 'gemscan-accounting' ),
		'salaam' => __( 'Salaam', 'gemscan-accounting' ),
		'evc'    => __( 'EVC Plus', 'gemscan-accounting' ),
		'zaad'   => __( 'Zaad', 'gemscan-accounting' ),
		'edahab' => __( 'eDahab', 'gemscan-accounting' ),
		'bank'   => __( 'Bank Transfer', 'gemscan-accounting' ),
		'cash'   => __( 'Cash', 'gemscan-accounting' ),
		'other'  => __( 'Other', 'gemscan-accounting' ),
	);
}

/**
 * Payment statuses.
 *
 * @return array<string,string>
 */
function gsa_statuses() {
	return array(
		'pending'   => __( 'Pending', 'gemscan-accounting' ),
		'paid'      => __( 'Paid', 'gemscan-accounting' ),
		'failed'    => __( 'Failed', 'gemscan-accounting' ),
		'refunded'  => __( 'Refunded', 'gemscan-accounting' ),
		'cancelled' => __( 'Cancelled', 'gemscan-accounting' ),
	);
}

/** Salaam ledger entry directions. */
function gsa_ledger_types() {
	return array(
		'received'    => __( 'Received', 'gemscan-accounting' ),
		'transferred' => __( 'Transferred', 'gemscan-accounting' ),
	);
}

/**
 * Human label for an enum key, falling back to the raw key.
 *
 * @param string $key   Stored key.
 * @param string $group One of: plan|method|status|ledger_type.
 * @return string
 */
function gsa_label( $key, $group ) {
	switch ( $group ) {
		case 'plan':
			$map = gsa_plans();
			break;
		case 'method':
			$map = gsa_methods();
			break;
		case 'status':
			$map = gsa_statuses();
			break;
		case 'ledger_type':
			$map = gsa_ledger_types();
			break;
		default:
			$map = array();
	}
	return isset( $map[ $key ] ) ? $map[ $key ] : $key;
}

/** Plugin settings, merged with defaults. */
function gsa_settings() {
	return wp_parse_args(
		get_option( GSA_OPT, array() ),
		array(
			'default_currency' => 'USD',
			'webhook_secret'   => '',
		)
	);
}

/**
 * Format a monetary amount for display.
 *
 * @param float|string $amount   Amount.
 * @param string       $currency Currency code.
 * @return string
 */
function gsa_money( $amount, $currency = 'USD' ) {
	$currency = $currency ? $currency : 'USD';
	return esc_html( $currency ) . ' ' . number_format( (float) $amount, 2 );
}

/**
 * Status → CSS colour class suffix (used by the admin stylesheet).
 *
 * @param string $status Status key.
 * @return string
 */
function gsa_status_class( $status ) {
	$map = array(
		'paid'      => 'ok',
		'pending'   => 'warn',
		'failed'    => 'err',
		'refunded'  => 'muted',
		'cancelled' => 'muted',
	);
	return isset( $map[ $status ] ) ? $map[ $status ] : 'muted';
}

/** Admin page URL for a given GSA view/action. */
function gsa_admin_url( $args = array() ) {
	$args = wp_parse_args( $args, array( 'page' => 'gemscan-accounting' ) );
	return add_query_arg( $args, admin_url( 'admin.php' ) );
}

/**
 * Render a small "totals table" card for a breakdown (used by dashboard +
 * reports views). Kept here so it is available to any view.
 *
 * @param string $title Card title.
 * @param array  $rows  key => ['total'=>float,'count'=>int].
 * @param string $group Enum group for labels (or 'country' = raw).
 * @param string $cur   Currency.
 */
function gsa_breakdown_card( $title, $rows, $group, $cur ) {
	echo '<div class="gsa-card"><h2>' . esc_html( $title ) . '</h2>';
	if ( empty( $rows ) ) {
		echo '<p class="gsa-muted">' . esc_html__( 'No paid records yet.', 'gemscan-accounting' ) . '</p></div>';
		return;
	}
	echo '<table class="gsa-mini"><tbody>';
	foreach ( $rows as $key => $data ) {
		$label = ( 'country' === $group ) ? ( $key ? $key : __( '(unknown)', 'gemscan-accounting' ) ) : gsa_label( $key, $group );
		printf(
			'<tr><td>%1$s</td><td class="gsa-num">%2$s</td><td class="gsa-count">%3$d</td></tr>',
			esc_html( $label ),
			esc_html( gsa_money( $data['total'], $cur ) ),
			(int) $data['count']
		);
	}
	echo '</tbody></table></div>';
}

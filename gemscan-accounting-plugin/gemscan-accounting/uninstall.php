<?php
/**
 * Uninstall cleanup.
 *
 * Removes plugin options. Financial DATA (the two tables) is intentionally
 * KEPT so uninstalling the plugin never destroys accounting history. To also
 * drop the tables, define GSA_DELETE_DATA as true in wp-config.php before
 * uninstalling.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'gsa_settings' );
delete_option( 'gsa_db_version' );

if ( defined( 'GSA_DELETE_DATA' ) && GSA_DELETE_DATA ) {
	global $wpdb;
	// Table names are static (plugin-controlled), not user input.
	$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}gsa_payments" );        // phpcs:ignore WordPress.DB
	$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}gsa_salaam_ledger" );   // phpcs:ignore WordPress.DB
}

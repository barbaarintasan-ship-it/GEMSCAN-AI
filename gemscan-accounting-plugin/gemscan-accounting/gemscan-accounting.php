<?php
/**
 * Plugin Name: GemScan Accounting
 * Plugin URI:  https://barbaarintasan.com/
 * Description: Standalone accounting & subscription-management module for GemScan. Records every payment, a Salaam transfers ledger, dashboards, reports (CSV/Excel/PDF/print) and an integration bridge to record payments from Stripe/PayPal/Salaam/EVC Plus/Zaad/eDahab. Self-contained — it does not modify any existing Barbaarintasan functionality.
 * Version:     1.1.0
 * Author:      GemScan
 * License:     GPL-2.0+
 * Text Domain: gemscan-accounting
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

/* -------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------- */
define( 'GSA_VERSION', '1.1.0' );
define( 'GSA_DB_VERSION', '1.0.0' );
define( 'GSA_FILE', __FILE__ );
define( 'GSA_DIR', plugin_dir_path( __FILE__ ) );
define( 'GSA_URL', plugin_dir_url( __FILE__ ) );
define( 'GSA_CAP', 'manage_options' ); // Only WordPress Administrators.

/* -------------------------------------------------------------------------
 * Includes (modular — each class has a single responsibility)
 * ---------------------------------------------------------------------- */
require_once GSA_DIR . 'includes/helpers.php';
require_once GSA_DIR . 'includes/class-gsa-activator.php';
require_once GSA_DIR . 'includes/class-gsa-db.php';
require_once GSA_DIR . 'includes/class-gsa-reports.php';
require_once GSA_DIR . 'includes/class-gsa-export.php';
require_once GSA_DIR . 'includes/class-gsa-pdf.php';
require_once GSA_DIR . 'includes/class-gsa-rest.php';
require_once GSA_DIR . 'includes/class-gsa-bridge.php';
require_once GSA_DIR . 'includes/class-gsa-admin.php';

/* -------------------------------------------------------------------------
 * Activation / deactivation
 * ---------------------------------------------------------------------- */
register_activation_hook( __FILE__, array( 'GSA_Activator', 'activate' ) );

// Create/upgrade tables on load if the DB version changed (e.g. after a manual
// plugin-files update that didn't re-trigger activation).
add_action( 'plugins_loaded', array( 'GSA_Activator', 'maybe_upgrade' ) );

/* -------------------------------------------------------------------------
 * Boot
 * ---------------------------------------------------------------------- */
add_action( 'init', array( 'GSA_REST', 'init' ) );            // REST route + record hook.
add_action( 'plugins_loaded', array( 'GSA_Bridge', 'init' ) ); // Auto-record on GemScan Payments activation.
add_action( 'plugins_loaded', array( 'GSA_Admin', 'init' ) );  // Admin menu + handlers (admin only inside).

/**
 * Public helper so other plugins/gateways can record a payment in one call:
 *
 *   gsa_record_payment( array(
 *       'customer_name' => 'Aamina Yuusuf',
 *       'email'         => 'aamina@example.com',
 *       'plan'          => 'professional',
 *       'amount'        => 14.99,
 *       'currency'      => 'USD',
 *       'method'        => 'evc',
 *       'txn_id'        => 'EVC123456',
 *       'status'        => 'paid',
 *   ) );
 *
 * @param array $data Payment fields (see GSA_DB::sanitize_payment()).
 * @return int|WP_Error Inserted row id, or WP_Error on failure.
 */
function gsa_record_payment( array $data ) {
	return GSA_DB::record_payment( $data );
}

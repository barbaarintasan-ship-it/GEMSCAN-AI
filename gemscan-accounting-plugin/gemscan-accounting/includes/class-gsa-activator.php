<?php
/**
 * Creates and upgrades the plugin's database tables.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Table installer. Uses dbDelta so re-runs are safe (create-or-alter).
 */
class GSA_Activator {

	/** Payments table name (with prefix). */
	public static function payments_table() {
		global $wpdb;
		return $wpdb->prefix . 'gsa_payments';
	}

	/** Salaam ledger table name (with prefix). */
	public static function ledger_table() {
		global $wpdb;
		return $wpdb->prefix . 'gsa_salaam_ledger';
	}

	/**
	 * Run on plugin activation.
	 */
	public static function activate() {
		self::install();
		update_option( 'gsa_db_version', GSA_DB_VERSION );
	}

	/**
	 * Upgrade tables if the stored DB version is behind the code.
	 */
	public static function maybe_upgrade() {
		if ( get_option( 'gsa_db_version' ) !== GSA_DB_VERSION ) {
			self::install();
			update_option( 'gsa_db_version', GSA_DB_VERSION );
		}
	}

	/**
	 * Create/alter the tables.
	 */
	public static function install() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$payments        = self::payments_table();
		$ledger          = self::ledger_table();

		// Every payment / subscription record.
		$sql_payments = "CREATE TABLE {$payments} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			customer_name VARCHAR(191) NOT NULL DEFAULT '',
			email VARCHAR(191) NOT NULL DEFAULT '',
			phone VARCHAR(64) NOT NULL DEFAULT '',
			country VARCHAR(100) NOT NULL DEFAULT '',
			user_id BIGINT UNSIGNED NULL DEFAULT NULL,
			plan VARCHAR(32) NOT NULL DEFAULT 'free',
			amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
			currency VARCHAR(8) NOT NULL DEFAULT 'USD',
			method VARCHAR(32) NOT NULL DEFAULT 'other',
			txn_id VARCHAR(191) NOT NULL DEFAULT '',
			start_date DATE NULL DEFAULT NULL,
			expiry_date DATE NULL DEFAULT NULL,
			status VARCHAR(20) NOT NULL DEFAULT 'pending',
			notes TEXT NULL,
			created_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00',
			updated_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00',
			PRIMARY KEY  (id),
			KEY email (email),
			KEY txn_id (txn_id),
			KEY status (status),
			KEY plan (plan),
			KEY method (method),
			KEY created_at (created_at),
			KEY expiry_date (expiry_date)
		) {$charset_collate};";

		// Salaam transfers ledger (received vs transferred → running balance).
		$sql_ledger = "CREATE TABLE {$ledger} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			entry_date DATE NOT NULL,
			type VARCHAR(20) NOT NULL DEFAULT 'received',
			amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
			currency VARCHAR(8) NOT NULL DEFAULT 'USD',
			reference VARCHAR(191) NOT NULL DEFAULT '',
			entered_by BIGINT UNSIGNED NULL DEFAULT NULL,
			entered_by_name VARCHAR(191) NOT NULL DEFAULT '',
			notes TEXT NULL,
			created_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00',
			PRIMARY KEY  (id),
			KEY entry_date (entry_date),
			KEY type (type)
		) {$charset_collate};";

		dbDelta( $sql_payments );
		dbDelta( $sql_ledger );
	}
}

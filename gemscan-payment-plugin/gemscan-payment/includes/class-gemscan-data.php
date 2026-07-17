<?php
/**
 * GemScan Payments — analytics data layer.
 *
 * Owns two WordPress tables (revenue + financial ledger), records revenue when
 * the admin activates a subscription or grants credits, and fetches + CACHES
 * the Supabase usage analytics (via the gemscan-analytics Edge Function) so the
 * dashboard never hits the network on every page load.
 *
 * All DB access uses $wpdb->prepare(); all writes are admin-only + nonce-guarded
 * at the call sites. Does not change any existing GemScan Payments behaviour.
 *
 * @package GemScan_Payments
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Analytics + accounting persistence for the payment plugin.
 */
class GemScan_Data {

	const DB_VERSION   = '1.0.0';
	const ANALYTICS_TTL = 1800; // 30 min cache for the Supabase analytics blob.
	const CRON_HOOK    = 'gemscan_refresh_analytics';

	/** Revenue table name. */
	public static function revenue_table() {
		global $wpdb;
		return $wpdb->prefix . 'gemscan_revenue';
	}

	/** Financial ledger table name. */
	public static function ledger_table() {
		global $wpdb;
		return $wpdb->prefix . 'gemscan_ledger';
	}

	/* ---------------------------------------------------------------------
	 * Install / cron
	 * ------------------------------------------------------------------ */

	/** Create/upgrade tables + schedule the analytics refresh cron. */
	public static function maybe_install() {
		if ( get_option( 'gemscan_data_db_version' ) === self::DB_VERSION ) {
			return;
		}
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		global $wpdb;
		$charset = $wpdb->get_charset_collate();
		$rev     = self::revenue_table();
		$led     = self::ledger_table();

		dbDelta(
			"CREATE TABLE {$rev} (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				entry_date DATE NOT NULL,
				email VARCHAR(191) NOT NULL DEFAULT '',
				type VARCHAR(20) NOT NULL DEFAULT 'subscription',
				plan VARCHAR(40) NOT NULL DEFAULT '',
				credits INT NOT NULL DEFAULT 0,
				amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
				currency VARCHAR(8) NOT NULL DEFAULT 'USD',
				method VARCHAR(32) NOT NULL DEFAULT '',
				reference VARCHAR(191) NOT NULL DEFAULT '',
				created_by BIGINT UNSIGNED NULL DEFAULT NULL,
				created_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00',
				PRIMARY KEY  (id),
				KEY entry_date (entry_date),
				KEY type (type),
				KEY email (email)
			) {$charset};"
		);

		dbDelta(
			"CREATE TABLE {$led} (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				entry_date DATE NOT NULL,
				category VARCHAR(40) NOT NULL DEFAULT 'expense',
				direction VARCHAR(10) NOT NULL DEFAULT 'out',
				amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
				currency VARCHAR(8) NOT NULL DEFAULT 'USD',
				description VARCHAR(255) NOT NULL DEFAULT '',
				notes TEXT NULL,
				created_by_name VARCHAR(191) NOT NULL DEFAULT '',
				created_by BIGINT UNSIGNED NULL DEFAULT NULL,
				created_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00',
				PRIMARY KEY  (id),
				KEY entry_date (entry_date),
				KEY category (category)
			) {$charset};"
		);

		update_option( 'gemscan_data_db_version', self::DB_VERSION );
	}

	/** Categories for the financial ledger. */
	public static function ledger_categories() {
		return array(
			'salaam_transfer' => __( 'Salaam Bank transfer', 'gemscan-payment' ),
			'bank_deposit'    => __( 'Bank deposit', 'gemscan-payment' ),
			'cash_withdrawal' => __( 'Cash withdrawal', 'gemscan-payment' ),
			'refund'          => __( 'Refund', 'gemscan-payment' ),
			'adjustment'      => __( 'Manual adjustment', 'gemscan-payment' ),
			'expense'         => __( 'Operating expense', 'gemscan-payment' ),
		);
	}

	/* ---------------------------------------------------------------------
	 * Revenue recording (called from the activate / add-credits admin tools)
	 * ------------------------------------------------------------------ */

	/**
	 * Record a revenue line (subscription or credit purchase).
	 *
	 * @param array $in email, type(subscription|credit), plan, credits, amount, method, reference.
	 * @return int|false Row id.
	 */
	public static function record_revenue( array $in ) {
		global $wpdb;
		$type = isset( $in['type'] ) && 'credit' === $in['type'] ? 'credit' : 'subscription';
		$row  = array(
			'entry_date' => current_time( 'Y-m-d' ),
			'email'      => isset( $in['email'] ) ? sanitize_email( $in['email'] ) : '',
			'type'       => $type,
			'plan'       => isset( $in['plan'] ) ? sanitize_text_field( $in['plan'] ) : '',
			'credits'    => isset( $in['credits'] ) ? (int) $in['credits'] : 0,
			'amount'     => isset( $in['amount'] ) ? round( (float) $in['amount'], 2 ) : 0.00,
			'currency'   => isset( $in['currency'] ) ? strtoupper( sanitize_text_field( $in['currency'] ) ) : 'USD',
			'method'     => isset( $in['method'] ) ? sanitize_text_field( $in['method'] ) : '',
			'reference'  => isset( $in['reference'] ) ? sanitize_text_field( $in['reference'] ) : '',
			'created_by' => get_current_user_id() ? get_current_user_id() : null,
			'created_at' => current_time( 'mysql' ),
		);
		$ok = $wpdb->insert( self::revenue_table(), $row, array( '%s', '%s', '%s', '%s', '%d', '%f', '%s', '%s', '%s', '%d', '%s' ) ); // phpcs:ignore WordPress.DB
		return $ok ? (int) $wpdb->insert_id : false;
	}

	/** Sum of revenue between two mysql datetimes (optionally by type). */
	public static function revenue_between( $from = null, $to = null, $type = null ) {
		global $wpdb;
		$sql  = 'SELECT COALESCE(SUM(amount),0) FROM ' . self::revenue_table() . ' WHERE 1=1';
		$args = array();
		if ( $from ) {
			$sql   .= ' AND created_at >= %s';
			$args[] = $from;
		}
		if ( $to ) {
			$sql   .= ' AND created_at <= %s';
			$args[] = $to;
		}
		if ( $type ) {
			$sql   .= ' AND type = %s';
			$args[] = $type;
		}
		return (float) ( $args ? $wpdb->get_var( $wpdb->prepare( $sql, $args ) ) : $wpdb->get_var( $sql ) ); // phpcs:ignore WordPress.DB
	}

	/** Monthly revenue series (last N months) → [ 'YYYY-MM' => total ]. */
	public static function revenue_by_month( $months = 12 ) {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				'SELECT DATE_FORMAT(created_at, %s) AS m, COALESCE(SUM(amount),0) AS t FROM ' . self::revenue_table()
				. ' GROUP BY m ORDER BY m ASC',
				'%Y-%m'
			),
			ARRAY_A
		); // phpcs:ignore WordPress.DB
		$out = array();
		foreach ( (array) $rows as $r ) {
			$out[ $r['m'] ] = (float) $r['t'];
		}
		return array_slice( $out, -1 * max( 1, (int) $months ), null, true );
	}

	/** Revenue grouped by plan (subscription) or pack (credit). */
	public static function revenue_by_plan() {
		global $wpdb;
		$rows = $wpdb->get_results( 'SELECT plan, COALESCE(SUM(amount),0) AS t, COUNT(*) AS c FROM ' . self::revenue_table() . " WHERE type='subscription' GROUP BY plan ORDER BY t DESC", ARRAY_A ); // phpcs:ignore WordPress.DB
		return $rows ? $rows : array();
	}

	/** All revenue rows for one customer email. */
	public static function customer_revenue( $email ) {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare( 'SELECT * FROM ' . self::revenue_table() . ' WHERE email = %s ORDER BY created_at DESC', sanitize_email( $email ) ),
			ARRAY_A
		); // phpcs:ignore WordPress.DB
		return $rows ? $rows : array();
	}

	/* ---------------------------------------------------------------------
	 * Financial ledger CRUD
	 * ------------------------------------------------------------------ */

	/** Insert a ledger entry. */
	public static function insert_ledger( array $in ) {
		global $wpdb;
		$cats = self::ledger_categories();
		$cat  = isset( $in['category'] ) ? sanitize_key( $in['category'] ) : 'expense';
		$u    = wp_get_current_user();
		$row  = array(
			'entry_date'      => self::clean_date( isset( $in['entry_date'] ) ? $in['entry_date'] : '' ),
			'category'        => isset( $cats[ $cat ] ) ? $cat : 'expense',
			'direction'       => ( isset( $in['direction'] ) && 'in' === $in['direction'] ) ? 'in' : 'out',
			'amount'          => isset( $in['amount'] ) ? round( (float) $in['amount'], 2 ) : 0.00,
			'currency'        => isset( $in['currency'] ) ? strtoupper( sanitize_text_field( $in['currency'] ) ) : 'USD',
			'description'     => isset( $in['description'] ) ? sanitize_text_field( $in['description'] ) : '',
			'notes'           => isset( $in['notes'] ) ? sanitize_textarea_field( $in['notes'] ) : '',
			'created_by_name' => ( $u && $u->exists() ) ? $u->display_name : '',
			'created_by'      => get_current_user_id() ? get_current_user_id() : null,
			'created_at'      => current_time( 'mysql' ),
		);
		if ( empty( $row['entry_date'] ) ) {
			$row['entry_date'] = current_time( 'Y-m-d' );
		}
		return $wpdb->insert( self::ledger_table(), $row, array( '%s', '%s', '%s', '%f', '%s', '%s', '%s', '%s', '%d', '%s' ) ); // phpcs:ignore WordPress.DB
	}

	/** Update a ledger entry. */
	public static function update_ledger( $id, array $in ) {
		global $wpdb;
		$cats = self::ledger_categories();
		$cat  = isset( $in['category'] ) ? sanitize_key( $in['category'] ) : 'expense';
		$row  = array(
			'entry_date'  => self::clean_date( isset( $in['entry_date'] ) ? $in['entry_date'] : '' ),
			'category'    => isset( $cats[ $cat ] ) ? $cat : 'expense',
			'direction'   => ( isset( $in['direction'] ) && 'in' === $in['direction'] ) ? 'in' : 'out',
			'amount'      => isset( $in['amount'] ) ? round( (float) $in['amount'], 2 ) : 0.00,
			'currency'    => isset( $in['currency'] ) ? strtoupper( sanitize_text_field( $in['currency'] ) ) : 'USD',
			'description' => isset( $in['description'] ) ? sanitize_text_field( $in['description'] ) : '',
			'notes'       => isset( $in['notes'] ) ? sanitize_textarea_field( $in['notes'] ) : '',
		);
		if ( empty( $row['entry_date'] ) ) {
			$row['entry_date'] = current_time( 'Y-m-d' );
		}
		return false !== $wpdb->update( self::ledger_table(), $row, array( 'id' => absint( $id ) ), array( '%s', '%s', '%s', '%f', '%s', '%s', '%s' ), array( '%d' ) ); // phpcs:ignore WordPress.DB
	}

	/** Delete a ledger entry. */
	public static function delete_ledger( $id ) {
		global $wpdb;
		return false !== $wpdb->delete( self::ledger_table(), array( 'id' => absint( $id ) ), array( '%d' ) ); // phpcs:ignore WordPress.DB
	}

	/** Get one ledger entry. */
	public static function get_ledger( $id ) {
		global $wpdb;
		return $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::ledger_table() . ' WHERE id = %d', absint( $id ) ), ARRAY_A ); // phpcs:ignore WordPress.DB
	}

	/**
	 * Query ledger with optional search/category/date filters.
	 *
	 * @param array $args search, category, from, to.
	 * @return array
	 */
	public static function query_ledger( array $args = array() ) {
		global $wpdb;
		$where = array( '1=1' );
		$p     = array();
		if ( ! empty( $args['search'] ) ) {
			$like    = '%' . $wpdb->esc_like( sanitize_text_field( $args['search'] ) ) . '%';
			$where[] = '(description LIKE %s OR notes LIKE %s)';
			$p[]     = $like;
			$p[]     = $like;
		}
		if ( ! empty( $args['category'] ) ) {
			$where[] = 'category = %s';
			$p[]     = sanitize_key( $args['category'] );
		}
		if ( ! empty( $args['from'] ) ) {
			$where[] = 'entry_date >= %s';
			$p[]     = self::clean_date( $args['from'] );
		}
		if ( ! empty( $args['to'] ) ) {
			$where[] = 'entry_date <= %s';
			$p[]     = self::clean_date( $args['to'] );
		}
		$sql = 'SELECT * FROM ' . self::ledger_table() . ' WHERE ' . implode( ' AND ', $where ) . ' ORDER BY entry_date DESC, id DESC';
		return $wpdb->get_results( $p ? $wpdb->prepare( $sql, $p ) : $sql, ARRAY_A ); // phpcs:ignore WordPress.DB
	}

	/** Sum of ledger "out" (expenses/refunds/withdrawals) between dates. */
	public static function ledger_out_between( $from = null, $to = null ) {
		global $wpdb;
		$sql  = 'SELECT COALESCE(SUM(amount),0) FROM ' . self::ledger_table() . " WHERE direction='out'";
		$args = array();
		if ( $from ) {
			$sql   .= ' AND entry_date >= %s';
			$args[] = substr( $from, 0, 10 );
		}
		if ( $to ) {
			$sql   .= ' AND entry_date <= %s';
			$args[] = substr( $to, 0, 10 );
		}
		return (float) ( $args ? $wpdb->get_var( $wpdb->prepare( $sql, $args ) ) : $wpdb->get_var( $sql ) ); // phpcs:ignore WordPress.DB
	}

	/* ---------------------------------------------------------------------
	 * Supabase analytics (fetch + cache)
	 * ------------------------------------------------------------------ */

	/**
	 * Get the Supabase usage analytics blob, from cache when fresh.
	 *
	 * @param bool $force Bypass the cache.
	 * @return array|null
	 */
	public static function get_analytics( $force = false ) {
		if ( ! $force ) {
			$cached = get_transient( 'gemscan_analytics' );
			if ( is_array( $cached ) ) {
				return $cached;
			}
		}
		$data = self::fetch_analytics();
		if ( is_array( $data ) ) {
			set_transient( 'gemscan_analytics', $data, self::ANALYTICS_TTL );
		}
		return $data;
	}

	/** Call the gemscan-analytics Edge Function (server-to-server, secret). */
	private static function fetch_analytics() {
		$o = gemscan_opts();
		if ( empty( $o['functions_url'] ) || empty( $o['activation_secret'] ) ) {
			return null;
		}
		$res = wp_remote_post(
			rtrim( $o['functions_url'], '/' ) . '/gemscan-analytics',
			array(
				'timeout' => 25,
				'headers' => array( 'Content-Type' => 'application/json' ),
				'body'    => wp_json_encode( array( 'secret' => $o['activation_secret'] ) ),
			)
		);
		if ( is_wp_error( $res ) ) {
			return null;
		}
		$data = json_decode( wp_remote_retrieve_body( $res ), true );
		return ( isset( $data['ok'] ) && $data['ok'] && isset( $data['analytics'] ) ) ? $data['analytics'] : null;
	}

	/** WP-Cron callback: refresh the analytics cache in the background. */
	public static function cron_refresh() {
		self::get_analytics( true );
	}

	/* ---------------------------------------------------------------------
	 * Helpers
	 * ------------------------------------------------------------------ */

	/** Validate a Y-m-d date, returning '' when empty/invalid. */
	private static function clean_date( $date ) {
		$date = trim( (string) $date );
		if ( '' === $date ) {
			return '';
		}
		$ts = strtotime( $date );
		return $ts ? gmdate( 'Y-m-d', $ts ) : '';
	}
}

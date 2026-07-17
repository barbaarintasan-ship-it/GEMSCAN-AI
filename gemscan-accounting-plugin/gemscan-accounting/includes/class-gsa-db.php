<?php
/**
 * Data access layer. ALL database access goes through here and uses
 * $wpdb->prepare() for every dynamic value (no raw interpolation of input).
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Payments + Salaam ledger persistence.
 */
class GSA_DB {

	/* ---------------------------------------------------------------------
	 * Sanitizing
	 * ------------------------------------------------------------------ */

	/**
	 * Sanitize + validate a payment payload into a storable row.
	 *
	 * @param array $in Raw input.
	 * @return array Clean column => value map.
	 */
	public static function sanitize_payment( array $in ) {
		$plans    = gsa_plans();
		$methods  = gsa_methods();
		$statuses = gsa_statuses();

		$plan   = isset( $in['plan'] ) ? sanitize_key( $in['plan'] ) : 'free';
		$method = isset( $in['method'] ) ? sanitize_key( $in['method'] ) : 'other';
		$status = isset( $in['status'] ) ? sanitize_key( $in['status'] ) : 'pending';

		$row = array(
			'customer_name' => isset( $in['customer_name'] ) ? sanitize_text_field( $in['customer_name'] ) : '',
			'email'         => isset( $in['email'] ) ? sanitize_email( $in['email'] ) : '',
			'phone'         => isset( $in['phone'] ) ? sanitize_text_field( $in['phone'] ) : '',
			'country'       => isset( $in['country'] ) ? sanitize_text_field( $in['country'] ) : '',
			'user_id'       => ! empty( $in['user_id'] ) ? absint( $in['user_id'] ) : null,
			'plan'          => isset( $plans[ $plan ] ) ? $plan : 'free',
			'amount'        => isset( $in['amount'] ) ? round( (float) $in['amount'], 2 ) : 0.00,
			'currency'      => isset( $in['currency'] ) ? strtoupper( sanitize_text_field( $in['currency'] ) ) : 'USD',
			'method'        => isset( $methods[ $method ] ) ? $method : 'other',
			'txn_id'        => isset( $in['txn_id'] ) ? sanitize_text_field( $in['txn_id'] ) : '',
			'start_date'    => self::clean_date( isset( $in['start_date'] ) ? $in['start_date'] : '' ),
			'expiry_date'   => self::clean_date( isset( $in['expiry_date'] ) ? $in['expiry_date'] : '' ),
			'status'        => isset( $statuses[ $status ] ) ? $status : 'pending',
			'notes'         => isset( $in['notes'] ) ? sanitize_textarea_field( $in['notes'] ) : '',
		);

		return $row;
	}

	/**
	 * Validate a Y-m-d date string, returning null when empty/invalid.
	 *
	 * @param string $date Date string.
	 * @return string|null
	 */
	private static function clean_date( $date ) {
		$date = trim( (string) $date );
		if ( '' === $date ) {
			return null;
		}
		$ts = strtotime( $date );
		return $ts ? gmdate( 'Y-m-d', $ts ) : null;
	}

	/* ---------------------------------------------------------------------
	 * Payments CRUD
	 * ------------------------------------------------------------------ */

	/**
	 * Insert a payment row.
	 *
	 * @param array $data Sanitized or raw payment data.
	 * @return int|WP_Error New row id or error.
	 */
	public static function insert_payment( array $data ) {
		global $wpdb;
		$row               = self::sanitize_payment( $data );
		$now               = current_time( 'mysql' );
		$row['created_at'] = $now;
		$row['updated_at'] = $now;

		$ok = $wpdb->insert(
			GSA_Activator::payments_table(),
			$row,
			self::payment_formats( $row )
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

		if ( false === $ok ) {
			return new WP_Error( 'gsa_insert_failed', __( 'Could not save the payment.', 'gemscan-accounting' ) );
		}
		return (int) $wpdb->insert_id;
	}

	/**
	 * Update a payment row by id.
	 *
	 * @param int   $id   Row id.
	 * @param array $data Payment data.
	 * @return bool
	 */
	public static function update_payment( $id, array $data ) {
		global $wpdb;
		$row               = self::sanitize_payment( $data );
		$row['updated_at'] = current_time( 'mysql' );

		return false !== $wpdb->update(
			GSA_Activator::payments_table(),
			$row,
			array( 'id' => absint( $id ) ),
			self::payment_formats( $row ),
			array( '%d' )
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	/**
	 * Idempotent "record a payment" used by the integration bridge: if a row
	 * with the same non-empty txn_id + method already exists it is updated,
	 * otherwise a new row is inserted. Keeps accounting in sync with gateways
	 * that may retry webhooks.
	 *
	 * @param array $data Payment data.
	 * @return int|WP_Error Row id.
	 */
	public static function record_payment( array $data ) {
		global $wpdb;
		$row = self::sanitize_payment( $data );

		if ( '' !== $row['txn_id'] ) {
			$existing = $wpdb->get_var(
				$wpdb->prepare(
					'SELECT id FROM ' . GSA_Activator::payments_table() . ' WHERE txn_id = %s AND method = %s LIMIT 1',
					$row['txn_id'],
					$row['method']
				)
			); // phpcs:ignore WordPress.DB
			if ( $existing ) {
				self::update_payment( (int) $existing, $data );
				/**
				 * Fires after an existing accounting record is synced.
				 *
				 * @param int   $id   Row id.
				 * @param array $data Payment data.
				 */
				do_action( 'gsa_payment_synced', (int) $existing, $data );
				return (int) $existing;
			}
		}

		$id = self::insert_payment( $data );
		if ( ! is_wp_error( $id ) ) {
			/**
			 * Fires after a new accounting record is created.
			 *
			 * @param int   $id   Row id.
			 * @param array $data Payment data.
			 */
			do_action( 'gsa_payment_recorded', $id, $data );
		}
		return $id;
	}

	/**
	 * Delete a payment row.
	 *
	 * @param int $id Row id.
	 * @return bool
	 */
	public static function delete_payment( $id ) {
		global $wpdb;
		return false !== $wpdb->delete(
			GSA_Activator::payments_table(),
			array( 'id' => absint( $id ) ),
			array( '%d' )
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	/**
	 * Get a single payment.
	 *
	 * @param int $id Row id.
	 * @return array|null
	 */
	public static function get_payment( $id ) {
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare( 'SELECT * FROM ' . GSA_Activator::payments_table() . ' WHERE id = %d', absint( $id ) ),
			ARRAY_A
		); // phpcs:ignore WordPress.DB
		return $row ? $row : null;
	}

	/**
	 * Column formats for $wpdb->insert/update, in the row's key order.
	 *
	 * @param array $row Row.
	 * @return array
	 */
	private static function payment_formats( array $row ) {
		$formats = array();
		foreach ( $row as $key => $val ) {
			if ( 'amount' === $key ) {
				$formats[] = '%f';
			} elseif ( in_array( $key, array( 'user_id' ), true ) ) {
				$formats[] = '%d';
			} else {
				$formats[] = '%s';
			}
		}
		return $formats;
	}

	/* ---------------------------------------------------------------------
	 * Querying (search / filter / sort / paginate)
	 * ------------------------------------------------------------------ */

	/**
	 * Build a safe WHERE clause from filter args.
	 *
	 * @param array $args Filters: search, status, plan, method, country, from, to, email, user_id.
	 * @return array{sql:string, params:array}
	 */
	private static function build_where( array $args ) {
		global $wpdb;
		$where  = array( '1=1' );
		$params = array();

		if ( ! empty( $args['search'] ) ) {
			$like     = '%' . $wpdb->esc_like( sanitize_text_field( $args['search'] ) ) . '%';
			$where[]  = '(customer_name LIKE %s OR email LIKE %s OR phone LIKE %s OR txn_id LIKE %s OR country LIKE %s)';
			$params[] = $like;
			$params[] = $like;
			$params[] = $like;
			$params[] = $like;
			$params[] = $like;
		}
		foreach ( array( 'status', 'plan', 'method' ) as $key ) {
			if ( ! empty( $args[ $key ] ) ) {
				$where[]  = "{$key} = %s";
				$params[] = sanitize_key( $args[ $key ] );
			}
		}
		if ( ! empty( $args['country'] ) ) {
			$where[]  = 'country = %s';
			$params[] = sanitize_text_field( $args['country'] );
		}
		if ( ! empty( $args['email'] ) ) {
			$where[]  = 'email = %s';
			$params[] = sanitize_email( $args['email'] );
		}
		if ( ! empty( $args['user_id'] ) ) {
			$where[]  = 'user_id = %d';
			$params[] = absint( $args['user_id'] );
		}
		if ( ! empty( $args['from'] ) ) {
			$where[]  = 'created_at >= %s';
			$params[] = self::clean_date( $args['from'] ) . ' 00:00:00';
		}
		if ( ! empty( $args['to'] ) ) {
			$where[]  = 'created_at <= %s';
			$params[] = self::clean_date( $args['to'] ) . ' 23:59:59';
		}

		return array(
			'sql'    => implode( ' AND ', $where ),
			'params' => $params,
		);
	}

	/**
	 * Query payments with filters, sorting and pagination.
	 *
	 * @param array $args search/status/plan/method/country/from/to, orderby, order, per_page, paged.
	 * @return array{items:array, total:int}
	 */
	public static function query_payments( array $args = array() ) {
		global $wpdb;
		$table = GSA_Activator::payments_table();
		$where = self::build_where( $args );

		// Sorting — whitelist columns/direction (never trust raw input).
		$allowed_orderby = array( 'id', 'customer_name', 'email', 'country', 'plan', 'amount', 'method', 'status', 'created_at', 'expiry_date' );
		$orderby         = ( isset( $args['orderby'] ) && in_array( $args['orderby'], $allowed_orderby, true ) ) ? $args['orderby'] : 'created_at';
		$order           = ( isset( $args['order'] ) && 'asc' === strtolower( $args['order'] ) ) ? 'ASC' : 'DESC';

		$per_page = isset( $args['per_page'] ) ? max( 1, absint( $args['per_page'] ) ) : 25;
		$paged    = isset( $args['paged'] ) ? max( 1, absint( $args['paged'] ) ) : 1;
		$offset   = ( $paged - 1 ) * $per_page;

		// Total (for pagination).
		$count_sql = 'SELECT COUNT(*) FROM ' . $table . ' WHERE ' . $where['sql'];
		$total     = (int) ( $where['params']
			? $wpdb->get_var( $wpdb->prepare( $count_sql, $where['params'] ) ) // phpcs:ignore WordPress.DB
			: $wpdb->get_var( $count_sql ) ); // phpcs:ignore WordPress.DB

		// Page of results. orderby/order are whitelisted; values are prepared.
		$sql          = "SELECT * FROM {$table} WHERE {$where['sql']} ORDER BY {$orderby} {$order} LIMIT %d OFFSET %d";
		$query_params = array_merge( $where['params'], array( $per_page, $offset ) );
		$items        = $wpdb->get_results( $wpdb->prepare( $sql, $query_params ), ARRAY_A ); // phpcs:ignore WordPress.DB

		return array(
			'items' => $items ? $items : array(),
			'total' => $total,
		);
	}

	/**
	 * All rows matching filters (no pagination) — used by exports/reports.
	 *
	 * @param array $args Filters + orderby/order.
	 * @return array
	 */
	public static function all_payments( array $args = array() ) {
		$args['per_page'] = 100000;
		$args['paged']    = 1;
		$res              = self::query_payments( $args );
		return $res['items'];
	}

	/** Distinct country list (for the filter dropdown). */
	public static function distinct_countries() {
		global $wpdb;
		$rows = $wpdb->get_col( 'SELECT DISTINCT country FROM ' . GSA_Activator::payments_table() . " WHERE country <> '' ORDER BY country ASC" ); // phpcs:ignore WordPress.DB
		return $rows ? $rows : array();
	}

	/* ---------------------------------------------------------------------
	 * Customer view
	 * ------------------------------------------------------------------ */

	/**
	 * Every payment for one customer email, newest first.
	 *
	 * @param string $email Email.
	 * @return array
	 */
	public static function customer_payments( $email ) {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				'SELECT * FROM ' . GSA_Activator::payments_table() . ' WHERE email = %s ORDER BY created_at DESC',
				sanitize_email( $email )
			),
			ARRAY_A
		); // phpcs:ignore WordPress.DB
		return $rows ? $rows : array();
	}

	/**
	 * Lifetime total (paid only) for a customer.
	 *
	 * @param string $email Email.
	 * @return float
	 */
	public static function customer_lifetime( $email ) {
		global $wpdb;
		return (float) $wpdb->get_var(
			$wpdb->prepare(
				'SELECT COALESCE(SUM(amount),0) FROM ' . GSA_Activator::payments_table() . " WHERE email = %s AND status = 'paid'",
				sanitize_email( $email )
			)
		); // phpcs:ignore WordPress.DB
	}

	/* ---------------------------------------------------------------------
	 * Salaam ledger
	 * ------------------------------------------------------------------ */

	/**
	 * Sanitize a ledger entry.
	 *
	 * @param array $in Raw.
	 * @return array
	 */
	public static function sanitize_ledger( array $in ) {
		$types = gsa_ledger_types();
		$type  = isset( $in['type'] ) ? sanitize_key( $in['type'] ) : 'received';
		return array(
			'entry_date'      => self::clean_date( isset( $in['entry_date'] ) ? $in['entry_date'] : '' ),
			'type'            => isset( $types[ $type ] ) ? $type : 'received',
			'amount'          => isset( $in['amount'] ) ? round( (float) $in['amount'], 2 ) : 0.00,
			'currency'        => isset( $in['currency'] ) ? strtoupper( sanitize_text_field( $in['currency'] ) ) : 'USD',
			'reference'       => isset( $in['reference'] ) ? sanitize_text_field( $in['reference'] ) : '',
			'entered_by'      => get_current_user_id() ? get_current_user_id() : null,
			'entered_by_name' => self::current_user_name(),
			'notes'           => isset( $in['notes'] ) ? sanitize_textarea_field( $in['notes'] ) : '',
		);
	}

	/** Current user's display name (falls back gracefully). */
	private static function current_user_name() {
		$u = wp_get_current_user();
		return ( $u && $u->exists() ) ? $u->display_name : '';
	}

	/**
	 * Insert a ledger entry.
	 *
	 * @param array $data Entry.
	 * @return int|WP_Error
	 */
	public static function insert_ledger( array $data ) {
		global $wpdb;
		$row               = self::sanitize_ledger( $data );
		$row['created_at'] = current_time( 'mysql' );
		if ( empty( $row['entry_date'] ) ) {
			$row['entry_date'] = current_time( 'Y-m-d' );
		}
		$ok = $wpdb->insert(
			GSA_Activator::ledger_table(),
			$row,
			array( '%s', '%s', '%f', '%s', '%s', '%d', '%s', '%s', '%s' )
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		if ( false === $ok ) {
			return new WP_Error( 'gsa_ledger_failed', __( 'Could not save the ledger entry.', 'gemscan-accounting' ) );
		}
		return (int) $wpdb->insert_id;
	}

	/**
	 * Delete a ledger entry.
	 *
	 * @param int $id Id.
	 * @return bool
	 */
	public static function delete_ledger( $id ) {
		global $wpdb;
		return false !== $wpdb->delete( GSA_Activator::ledger_table(), array( 'id' => absint( $id ) ), array( '%d' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	/**
	 * All ledger entries, newest first.
	 *
	 * @return array
	 */
	public static function all_ledger() {
		global $wpdb;
		$rows = $wpdb->get_results( 'SELECT * FROM ' . GSA_Activator::ledger_table() . ' ORDER BY entry_date DESC, id DESC', ARRAY_A ); // phpcs:ignore WordPress.DB
		return $rows ? $rows : array();
	}

	/**
	 * Ledger totals: received, transferred, balance.
	 *
	 * @return array{received:float, transferred:float, balance:float}
	 */
	public static function ledger_totals() {
		global $wpdb;
		$table       = GSA_Activator::ledger_table();
		$received    = (float) $wpdb->get_var( "SELECT COALESCE(SUM(amount),0) FROM {$table} WHERE type = 'received'" ); // phpcs:ignore WordPress.DB
		$transferred = (float) $wpdb->get_var( "SELECT COALESCE(SUM(amount),0) FROM {$table} WHERE type = 'transferred'" ); // phpcs:ignore WordPress.DB
		return array(
			'received'    => $received,
			'transferred' => $transferred,
			'balance'     => $received - $transferred,
		);
	}
}

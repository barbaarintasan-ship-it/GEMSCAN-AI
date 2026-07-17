<?php
/**
 * Aggregation / reporting queries for the dashboard and reports pages.
 * Revenue figures count PAID rows only.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Read-only reporting helpers.
 */
class GSA_Reports {

	/** Sum of `amount` for PAID rows created within [$from,$to] (mysql datetimes, optional). */
	public static function revenue_between( $from = null, $to = null ) {
		global $wpdb;
		$table = GSA_Activator::payments_table();
		$sql   = "SELECT COALESCE(SUM(amount),0) FROM {$table} WHERE status = 'paid'";
		$args  = array();
		if ( $from ) {
			$sql   .= ' AND created_at >= %s';
			$args[] = $from;
		}
		if ( $to ) {
			$sql   .= ' AND created_at <= %s';
			$args[] = $to;
		}
		return (float) ( $args ? $wpdb->get_var( $wpdb->prepare( $sql, $args ) ) : $wpdb->get_var( $sql ) ); // phpcs:ignore WordPress.DB
	}

	/**
	 * Headline revenue tiles.
	 *
	 * @return array<string,float>
	 */
	public static function revenue_tiles() {
		$now         = current_time( 'timestamp' ); // phpcs:ignore WordPress.DateTime.CurrentTimeTimestamp
		$today       = current_time( 'Y-m-d' );
		$week_start  = gmdate( 'Y-m-d', strtotime( 'monday this week', $now ) );
		$month_start = current_time( 'Y-m' ) . '-01';
		$year_start  = current_time( 'Y' ) . '-01-01';

		return array(
			'total' => self::revenue_between(),
			'today' => self::revenue_between( $today . ' 00:00:00', $today . ' 23:59:59' ),
			'week'  => self::revenue_between( $week_start . ' 00:00:00' ),
			'month' => self::revenue_between( $month_start . ' 00:00:00' ),
			'year'  => self::revenue_between( $year_start . ' 00:00:00' ),
		);
	}

	/**
	 * Grouped PAID totals by a whitelisted column.
	 *
	 * @param string $column One of: method|plan|country.
	 * @return array<string,float> label-key => total
	 */
	public static function totals_by( $column ) {
		global $wpdb;
		$allowed = array( 'method', 'plan', 'country' );
		if ( ! in_array( $column, $allowed, true ) ) {
			return array();
		}
		$table = GSA_Activator::payments_table();
		$rows  = $wpdb->get_results( "SELECT {$column} AS k, COALESCE(SUM(amount),0) AS t, COUNT(*) AS c FROM {$table} WHERE status = 'paid' GROUP BY {$column} ORDER BY t DESC", ARRAY_A ); // phpcs:ignore WordPress.DB
		$out   = array();
		foreach ( (array) $rows as $r ) {
			$out[ $r['k'] ] = array(
				'total' => (float) $r['t'],
				'count' => (int) $r['c'],
			);
		}
		return $out;
	}

	/**
	 * Subscription health counters.
	 *
	 * @return array<string,int>
	 */
	public static function subscription_stats() {
		global $wpdb;
		$table = GSA_Activator::payments_table();
		$today = current_time( 'Y-m-d' );

		// Active = paid, non-free, not yet expired (or no expiry set).
		$active = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$table} WHERE status = 'paid' AND plan <> 'free' AND (expiry_date IS NULL OR expiry_date >= %s)",
				$today
			)
		); // phpcs:ignore WordPress.DB
		$expired = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$table} WHERE status = 'paid' AND plan <> 'free' AND expiry_date IS NOT NULL AND expiry_date < %s",
				$today
			)
		); // phpcs:ignore WordPress.DB
		$refunds = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table} WHERE status = 'refunded'" ); // phpcs:ignore WordPress.DB

		// Renewals = customers (email) with more than one paid, non-free payment.
		$renewals = (int) $wpdb->get_var(
			"SELECT COUNT(*) FROM (
				SELECT email FROM {$table}
				WHERE status = 'paid' AND plan <> 'free' AND email <> ''
				GROUP BY email HAVING COUNT(*) > 1
			) x"
		); // phpcs:ignore WordPress.DB

		return array(
			'active'   => $active,
			'expired'  => $expired,
			'renewals' => $renewals,
			'refunds'  => $refunds,
		);
	}

	/**
	 * Time-series of PAID revenue for charts.
	 *
	 * @param string $granularity day|week|month|year.
	 * @param int    $points      Number of buckets to return (most recent).
	 * @return array{labels:array,data:array}
	 */
	public static function timeseries( $granularity = 'month', $points = 12 ) {
		global $wpdb;
		$table  = GSA_Activator::payments_table();
		$points = max( 1, min( 60, absint( $points ) ) );

		switch ( $granularity ) {
			case 'day':
				$fmt = '%Y-%m-%d';
				break;
			case 'week':
				$fmt = '%x-W%v';
				break;
			case 'year':
				$fmt = '%Y';
				break;
			case 'month':
			default:
				$fmt = '%Y-%m';
		}

		// Group by the formatted bucket. $fmt is a fixed whitelist value above.
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT DATE_FORMAT(created_at, %s) AS bucket, COALESCE(SUM(amount),0) AS total
				 FROM {$table} WHERE status = 'paid'
				 GROUP BY bucket ORDER BY bucket ASC",
				$fmt
			),
			ARRAY_A
		); // phpcs:ignore WordPress.DB

		$rows   = array_slice( (array) $rows, -1 * $points );
		$labels = array();
		$data   = array();
		foreach ( $rows as $r ) {
			$labels[] = $r['bucket'];
			$data[]   = (float) $r['total'];
		}
		return array(
			'labels' => $labels,
			'data'   => $data,
		);
	}

	/**
	 * A full report bundle for a named period (used by the Reports page + PDF).
	 *
	 * @param string $period daily|weekly|monthly|annual.
	 * @return array
	 */
	public static function period_report( $period ) {
		$now = current_time( 'timestamp' ); // phpcs:ignore WordPress.DateTime.CurrentTimeTimestamp
		switch ( $period ) {
			case 'daily':
				$from  = current_time( 'Y-m-d' ) . ' 00:00:00';
				$to    = current_time( 'Y-m-d' ) . ' 23:59:59';
				$title = __( 'Daily Report', 'gemscan-accounting' ) . ' — ' . current_time( 'Y-m-d' );
				break;
			case 'weekly':
				$from  = gmdate( 'Y-m-d', strtotime( 'monday this week', $now ) ) . ' 00:00:00';
				$to    = gmdate( 'Y-m-d', strtotime( 'sunday this week', $now ) ) . ' 23:59:59';
				$title = __( 'Weekly Report', 'gemscan-accounting' );
				break;
			case 'annual':
				$from  = current_time( 'Y' ) . '-01-01 00:00:00';
				$to    = current_time( 'Y' ) . '-12-31 23:59:59';
				$title = __( 'Annual Report', 'gemscan-accounting' ) . ' — ' . current_time( 'Y' );
				break;
			case 'monthly':
			default:
				$from  = current_time( 'Y-m' ) . '-01 00:00:00';
				$to    = current_time( 'Y-m-t' ) . ' 23:59:59';
				$title = __( 'Monthly Report', 'gemscan-accounting' ) . ' — ' . current_time( 'F Y' );
		}

		return array(
			'period'  => $period,
			'title'   => $title,
			'from'    => $from,
			'to'      => $to,
			'revenue' => self::revenue_between( $from, $to ),
			'by_plan' => self::totals_by_between( 'plan', $from, $to ),
			'by_method' => self::totals_by_between( 'method', $from, $to ),
			'by_country' => self::totals_by_between( 'country', $from, $to ),
			'count'   => self::count_between( $from, $to ),
		);
	}

	/** PAID row count within a window. */
	public static function count_between( $from, $to ) {
		global $wpdb;
		$table = GSA_Activator::payments_table();
		return (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$table} WHERE status = 'paid' AND created_at >= %s AND created_at <= %s", $from, $to )
		); // phpcs:ignore WordPress.DB
	}

	/** Grouped PAID totals by column within a window. */
	public static function totals_by_between( $column, $from, $to ) {
		global $wpdb;
		$allowed = array( 'method', 'plan', 'country' );
		if ( ! in_array( $column, $allowed, true ) ) {
			return array();
		}
		$table = GSA_Activator::payments_table();
		$rows  = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT {$column} AS k, COALESCE(SUM(amount),0) AS t, COUNT(*) AS c FROM {$table}
				 WHERE status = 'paid' AND created_at >= %s AND created_at <= %s GROUP BY {$column} ORDER BY t DESC",
				$from,
				$to
			),
			ARRAY_A
		); // phpcs:ignore WordPress.DB
		$out = array();
		foreach ( (array) $rows as $r ) {
			$out[ $r['k'] ] = array(
				'total' => (float) $r['t'],
				'count' => (int) $r['c'],
			);
		}
		return $out;
	}
}

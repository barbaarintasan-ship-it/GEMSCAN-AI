<?php
/**
 * Payments list table (search, filter, sort, paginate, bulk-delete).
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! class_exists( 'WP_List_Table' ) ) {
	require_once ABSPATH . 'wp-admin/includes/class-wp-list-table.php';
}

/**
 * Extends the core list table.
 */
class GSA_Payments_Table extends WP_List_Table {

	public function __construct() {
		parent::__construct(
			array(
				'singular' => 'payment',
				'plural'   => 'payments',
				'ajax'     => false,
			)
		);
	}

	public function get_columns() {
		return array(
			'cb'         => '<input type="checkbox" />',
			'id'         => __( 'ID', 'gemscan-accounting' ),
			'customer'   => __( 'Customer', 'gemscan-accounting' ),
			'country'    => __( 'Country', 'gemscan-accounting' ),
			'plan'       => __( 'Plan', 'gemscan-accounting' ),
			'amount'     => __( 'Amount', 'gemscan-accounting' ),
			'method'     => __( 'Method', 'gemscan-accounting' ),
			'status'     => __( 'Status', 'gemscan-accounting' ),
			'created_at' => __( 'Date', 'gemscan-accounting' ),
		);
	}

	protected function get_sortable_columns() {
		return array(
			'id'         => array( 'id', false ),
			'country'    => array( 'country', false ),
			'plan'       => array( 'plan', false ),
			'amount'     => array( 'amount', false ),
			'method'     => array( 'method', false ),
			'status'     => array( 'status', false ),
			'created_at' => array( 'created_at', true ),
		);
	}

	protected function get_bulk_actions() {
		return array( 'delete' => __( 'Delete', 'gemscan-accounting' ) );
	}

	public function column_cb( $item ) {
		return sprintf( '<input type="checkbox" name="ids[]" value="%d" />', (int) $item['id'] );
	}

	public function column_default( $item, $column_name ) {
		return isset( $item[ $column_name ] ) ? esc_html( $item[ $column_name ] ) : '';
	}

	public function column_id( $item ) {
		$edit = gsa_admin_url(
			array(
				'page'   => 'gemscan-accounting-payments',
				'action' => 'edit',
				'id'     => (int) $item['id'],
			)
		);
		$del_url = wp_nonce_url(
			gsa_admin_url(
				array(
					'page'       => 'gemscan-accounting-payments',
					'gsa_action' => 'delete_payment',
					'id'         => (int) $item['id'],
				)
			),
			'gsa_delete_payment_' . (int) $item['id']
		);
		$actions = array(
			'edit'   => '<a href="' . esc_url( $edit ) . '">' . esc_html__( 'Edit', 'gemscan-accounting' ) . '</a>',
			'delete' => '<a href="' . esc_url( $del_url ) . '" onclick="return confirm(\'' . esc_js( __( 'Delete this payment?', 'gemscan-accounting' ) ) . '\');" style="color:#b32d2e;">' . esc_html__( 'Delete', 'gemscan-accounting' ) . '</a>',
		);
		return sprintf( '<strong>#%1$d</strong> %2$s', (int) $item['id'], $this->row_actions( $actions ) );
	}

	public function column_customer( $item ) {
		$cust = gsa_admin_url(
			array(
				'page'  => 'gemscan-accounting-payments',
				'view'  => 'customer',
				'email' => rawurlencode( $item['email'] ),
			)
		);
		$name = $item['customer_name'] ? $item['customer_name'] : __( '(no name)', 'gemscan-accounting' );
		$out  = '<strong>' . esc_html( $name ) . '</strong>';
		if ( $item['email'] ) {
			$out .= '<br><a href="' . esc_url( $cust ) . '">' . esc_html( $item['email'] ) . '</a>';
		}
		if ( $item['phone'] ) {
			$out .= '<br><span class="gsa-muted">' . esc_html( $item['phone'] ) . '</span>';
		}
		return $out;
	}

	public function column_plan( $item ) {
		return esc_html( gsa_label( $item['plan'], 'plan' ) );
	}

	public function column_method( $item ) {
		return esc_html( gsa_label( $item['method'], 'method' ) );
	}

	public function column_amount( $item ) {
		return '<strong>' . esc_html( gsa_money( $item['amount'], $item['currency'] ) ) . '</strong>';
	}

	public function column_status( $item ) {
		return sprintf(
			'<span class="gsa-badge gsa-badge-%1$s">%2$s</span>',
			esc_attr( gsa_status_class( $item['status'] ) ),
			esc_html( gsa_label( $item['status'], 'status' ) )
		);
	}

	public function column_created_at( $item ) {
		$out = esc_html( mysql2date( 'Y-m-d', $item['created_at'] ) );
		if ( ! empty( $item['expiry_date'] ) ) {
			$out .= '<br><span class="gsa-muted">' . esc_html__( 'exp', 'gemscan-accounting' ) . ' ' . esc_html( $item['expiry_date'] ) . '</span>';
		}
		return $out;
	}

	/** Filter controls above the table. */
	protected function extra_tablenav( $which ) {
		if ( 'top' !== $which ) {
			return;
		}
		// phpcs:disable WordPress.Security.NonceVerification.Recommended
		$status  = isset( $_REQUEST['status'] ) ? sanitize_key( wp_unslash( $_REQUEST['status'] ) ) : '';
		$plan    = isset( $_REQUEST['plan'] ) ? sanitize_key( wp_unslash( $_REQUEST['plan'] ) ) : '';
		$method  = isset( $_REQUEST['method'] ) ? sanitize_key( wp_unslash( $_REQUEST['method'] ) ) : '';
		$country = isset( $_REQUEST['country'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['country'] ) ) : '';
		$from    = isset( $_REQUEST['from'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['from'] ) ) : '';
		$to      = isset( $_REQUEST['to'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['to'] ) ) : '';
		// phpcs:enable

		echo '<div class="alignleft actions gsa-filters">';
		self::dropdown( 'status', gsa_statuses(), $status, __( 'All statuses', 'gemscan-accounting' ) );
		self::dropdown( 'plan', gsa_plans(), $plan, __( 'All plans', 'gemscan-accounting' ) );
		self::dropdown( 'method', gsa_methods(), $method, __( 'All methods', 'gemscan-accounting' ) );

		$countries = array();
		foreach ( GSA_DB::distinct_countries() as $c ) {
			$countries[ $c ] = $c;
		}
		self::dropdown( 'country', $countries, $country, __( 'All countries', 'gemscan-accounting' ) );

		echo '<input type="date" name="from" value="' . esc_attr( $from ) . '" title="' . esc_attr__( 'From', 'gemscan-accounting' ) . '" /> ';
		echo '<input type="date" name="to" value="' . esc_attr( $to ) . '" title="' . esc_attr__( 'To', 'gemscan-accounting' ) . '" /> ';
		submit_button( __( 'Filter', 'gemscan-accounting' ), 'secondary', 'filter_action', false );
		echo '</div>';
	}

	/** Render a labelled select. */
	private static function dropdown( $name, $options, $selected, $all_label ) {
		echo '<select name="' . esc_attr( $name ) . '">';
		echo '<option value="">' . esc_html( $all_label ) . '</option>';
		foreach ( $options as $key => $label ) {
			printf(
				'<option value="%1$s"%2$s>%3$s</option>',
				esc_attr( $key ),
				selected( $selected, $key, false ),
				esc_html( $label )
			);
		}
		echo '</select> ';
	}

	/** Delete selected rows (bulk), nonce-checked. */
	private function process_bulk_action() {
		if ( 'delete' !== $this->current_action() ) {
			return;
		}
		check_admin_referer( 'bulk-' . $this->_args['plural'] );
		$ids = isset( $_REQUEST['ids'] ) ? array_map( 'absint', (array) wp_unslash( $_REQUEST['ids'] ) ) : array();
		foreach ( $ids as $id ) {
			GSA_DB::delete_payment( $id );
		}
	}

	public function prepare_items() {
		$this->process_bulk_action();

		$columns  = $this->get_columns();
		$hidden   = array();
		$sortable = $this->get_sortable_columns();
		$this->_column_headers = array( $columns, $hidden, $sortable );

		$filters             = GSA_Admin::filters_from_request();
		$per_page            = 25;
		$filters['per_page'] = $per_page;
		$filters['paged']    = $this->get_pagenum();

		$result      = GSA_DB::query_payments( $filters );
		$this->items = $result['items'];

		$this->set_pagination_args(
			array(
				'total_items' => $result['total'],
				'per_page'    => $per_page,
				'total_pages' => (int) ceil( $result['total'] / $per_page ),
			)
		);
	}

	public function no_items() {
		esc_html_e( 'No payments found.', 'gemscan-accounting' );
	}
}

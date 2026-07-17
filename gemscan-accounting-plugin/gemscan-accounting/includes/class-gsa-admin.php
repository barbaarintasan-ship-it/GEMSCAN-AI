<?php
/**
 * Admin controller: menu, page routing, secure form handlers, asset loading.
 *
 * Security model (applied to every mutating request):
 *   - current_user_can( GSA_CAP )  (Administrators only)
 *   - check_admin_referer()        (nonce verification)
 *   - all values sanitized before use; all DB access is prepared (GSA_DB)
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Wires the wp-admin UI.
 */
class GSA_Admin {

	/** Menu/page slugs → in-page tab. */
	const SLUGS = array(
		'gemscan-accounting'          => 'dashboard',
		'gemscan-accounting-payments' => 'payments',
		'gemscan-accounting-ledger'   => 'ledger',
		'gemscan-accounting-reports'  => 'reports',
		'gemscan-accounting-settings' => 'settings',
	);

	/** Boot (only meaningful in admin). */
	public static function init() {
		if ( ! is_admin() ) {
			return;
		}
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'handle_actions' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
		add_action( 'admin_notices', array( __CLASS__, 'notices' ) );
	}

	/* --------------------------------------------------------------------- */
	/* Menu                                                                   */
	/* --------------------------------------------------------------------- */

	public static function menu() {
		add_menu_page(
			__( 'GemScan Accounting', 'gemscan-accounting' ),
			__( 'GemScan', 'gemscan-accounting' ),
			GSA_CAP,
			'gemscan-accounting',
			array( __CLASS__, 'render' ),
			'dashicons-chart-area',
			58
		);

		$submenus = array(
			'gemscan-accounting'          => __( 'Accounting', 'gemscan-accounting' ),
			'gemscan-accounting-payments' => __( 'Payments', 'gemscan-accounting' ),
			'gemscan-accounting-ledger'   => __( 'Salaam Ledger', 'gemscan-accounting' ),
			'gemscan-accounting-reports'  => __( 'Reports', 'gemscan-accounting' ),
			'gemscan-accounting-settings' => __( 'Settings', 'gemscan-accounting' ),
		);
		foreach ( $submenus as $slug => $label ) {
			add_submenu_page( 'gemscan-accounting', $label, $label, GSA_CAP, $slug, array( __CLASS__, 'render' ) );
		}
	}

	/** Current tab from the page slug. */
	private static function current_tab() {
		$page = isset( $_GET['page'] ) ? sanitize_key( wp_unslash( $_GET['page'] ) ) : 'gemscan-accounting'; // phpcs:ignore WordPress.Security.NonceVerification
		return isset( self::SLUGS[ $page ] ) ? self::SLUGS[ $page ] : 'dashboard';
	}

	/* --------------------------------------------------------------------- */
	/* Assets                                                                 */
	/* --------------------------------------------------------------------- */

	public static function assets( $hook ) {
		if ( false === strpos( (string) $hook, 'gemscan-accounting' ) ) {
			return;
		}
		wp_enqueue_style( 'gsa-admin', GSA_URL . 'assets/gsa-admin.css', array(), GSA_VERSION );
		// Charts are drawn by a tiny self-contained canvas renderer in gsa-admin.js
		// (no external Chart.js dependency — nothing loaded from a CDN at runtime).
		wp_enqueue_script( 'gsa-admin', GSA_URL . 'assets/gsa-admin.js', array(), GSA_VERSION, true );
	}

	/* --------------------------------------------------------------------- */
	/* Secure action handlers (run before any output)                         */
	/* --------------------------------------------------------------------- */

	public static function handle_actions() {
		if ( empty( $_REQUEST['gsa_action'] ) ) {
			return;
		}
		if ( ! current_user_can( GSA_CAP ) ) {
			return;
		}
		$action = sanitize_key( wp_unslash( $_REQUEST['gsa_action'] ) );

		switch ( $action ) {
			case 'save_payment':
				self::do_save_payment();
				break;
			case 'delete_payment':
				self::do_delete_payment();
				break;
			case 'add_ledger':
				self::do_add_ledger();
				break;
			case 'delete_ledger':
				self::do_delete_ledger();
				break;
			case 'save_settings':
				self::do_save_settings();
				break;
			case 'export_csv':
			case 'export_excel':
			case 'export_pdf':
				self::do_export( $action );
				break;
		}
	}

	private static function do_save_payment() {
		check_admin_referer( 'gsa_save_payment' );
		$id   = isset( $_POST['id'] ) ? absint( $_POST['id'] ) : 0;
		$data = wp_unslash( $_POST ); // Individual fields are sanitized in GSA_DB.

		if ( $id ) {
			GSA_DB::update_payment( $id, $data );
			$notice = 'updated';
		} else {
			$res    = GSA_DB::insert_payment( $data );
			$notice = is_wp_error( $res ) ? 'error' : 'created';
		}
		self::redirect( 'gemscan-accounting-payments', array( 'gsa_notice' => $notice ) );
	}

	private static function do_delete_payment() {
		$id = isset( $_REQUEST['id'] ) ? absint( $_REQUEST['id'] ) : 0;
		check_admin_referer( 'gsa_delete_payment_' . $id );
		if ( $id ) {
			GSA_DB::delete_payment( $id );
		}
		self::redirect( 'gemscan-accounting-payments', array( 'gsa_notice' => 'deleted' ) );
	}

	private static function do_add_ledger() {
		check_admin_referer( 'gsa_add_ledger' );
		GSA_DB::insert_ledger( wp_unslash( $_POST ) );
		self::redirect( 'gemscan-accounting-ledger', array( 'gsa_notice' => 'ledger_added' ) );
	}

	private static function do_delete_ledger() {
		$id = isset( $_REQUEST['id'] ) ? absint( $_REQUEST['id'] ) : 0;
		check_admin_referer( 'gsa_delete_ledger_' . $id );
		if ( $id ) {
			GSA_DB::delete_ledger( $id );
		}
		self::redirect( 'gemscan-accounting-ledger', array( 'gsa_notice' => 'ledger_deleted' ) );
	}

	private static function do_save_settings() {
		check_admin_referer( 'gsa_save_settings' );
		$current = gsa_settings();
		$new     = array(
			'default_currency' => isset( $_POST['default_currency'] ) ? strtoupper( sanitize_text_field( wp_unslash( $_POST['default_currency'] ) ) ) : 'USD',
			'webhook_secret'   => isset( $_POST['webhook_secret'] ) ? sanitize_text_field( wp_unslash( $_POST['webhook_secret'] ) ) : $current['webhook_secret'],
		);
		if ( ! empty( $_POST['gsa_regen_secret'] ) ) {
			$new['webhook_secret'] = wp_generate_password( 40, false );
		}
		update_option( GSA_OPT, $new );
		self::redirect( 'gemscan-accounting-settings', array( 'gsa_notice' => 'settings_saved' ) );
	}

	/**
	 * Handle CSV/Excel/PDF export (outputs + exits).
	 *
	 * @param string $action export_csv|export_excel|export_pdf.
	 */
	private static function do_export( $action ) {
		check_admin_referer( 'gsa_export' );
		$filters = self::filters_from_request();

		if ( 'export_csv' === $action ) {
			GSA_Export::csv( $filters );
		} elseif ( 'export_excel' === $action ) {
			GSA_Export::excel( $filters );
		} else {
			$period = isset( $_REQUEST['period'] ) ? sanitize_key( wp_unslash( $_REQUEST['period'] ) ) : 'monthly';
			GSA_Export::pdf_report( $period );
		}
	}

	/**
	 * Read list filters from the request (shared by table + exports).
	 *
	 * @return array
	 */
	public static function filters_from_request() {
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- read-only filters.
		return array(
			'search'  => isset( $_REQUEST['s'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['s'] ) ) : '',
			'status'  => isset( $_REQUEST['status'] ) ? sanitize_key( wp_unslash( $_REQUEST['status'] ) ) : '',
			'plan'    => isset( $_REQUEST['plan'] ) ? sanitize_key( wp_unslash( $_REQUEST['plan'] ) ) : '',
			'method'  => isset( $_REQUEST['method'] ) ? sanitize_key( wp_unslash( $_REQUEST['method'] ) ) : '',
			'country' => isset( $_REQUEST['country'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['country'] ) ) : '',
			'from'    => isset( $_REQUEST['from'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['from'] ) ) : '',
			'to'      => isset( $_REQUEST['to'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['to'] ) ) : '',
			'orderby' => isset( $_REQUEST['orderby'] ) ? sanitize_key( wp_unslash( $_REQUEST['orderby'] ) ) : 'created_at',
			'order'   => isset( $_REQUEST['order'] ) ? sanitize_key( wp_unslash( $_REQUEST['order'] ) ) : 'desc',
		);
		// phpcs:enable
	}

	/** Redirect back to a page with query args (post/redirect/get). */
	private static function redirect( $page, $args = array() ) {
		$url = add_query_arg( array_merge( array( 'page' => $page ), $args ), admin_url( 'admin.php' ) );
		wp_safe_redirect( $url );
		exit;
	}

	/* --------------------------------------------------------------------- */
	/* Notices                                                                */
	/* --------------------------------------------------------------------- */

	public static function notices() {
		if ( empty( $_GET['gsa_notice'] ) || false === strpos( (string) ( isset( $_GET['page'] ) ? $_GET['page'] : '' ), 'gemscan-accounting' ) ) { // phpcs:ignore WordPress.Security.NonceVerification
			return;
		}
		$map     = array(
			'created'         => array( 'success', __( 'Payment added.', 'gemscan-accounting' ) ),
			'updated'         => array( 'success', __( 'Payment updated.', 'gemscan-accounting' ) ),
			'deleted'         => array( 'success', __( 'Payment deleted.', 'gemscan-accounting' ) ),
			'ledger_added'    => array( 'success', __( 'Ledger entry added.', 'gemscan-accounting' ) ),
			'ledger_deleted'  => array( 'success', __( 'Ledger entry deleted.', 'gemscan-accounting' ) ),
			'settings_saved'  => array( 'success', __( 'Settings saved.', 'gemscan-accounting' ) ),
			'error'           => array( 'error', __( 'Something went wrong. Please try again.', 'gemscan-accounting' ) ),
		);
		$key = sanitize_key( wp_unslash( $_GET['gsa_notice'] ) ); // phpcs:ignore WordPress.Security.NonceVerification
		if ( isset( $map[ $key ] ) ) {
			printf(
				'<div class="notice notice-%1$s is-dismissible"><p>%2$s</p></div>',
				esc_attr( $map[ $key ][0] ),
				esc_html( $map[ $key ][1] )
			);
		}
	}

	/* --------------------------------------------------------------------- */
	/* Render                                                                 */
	/* --------------------------------------------------------------------- */

	public static function render() {
		if ( ! current_user_can( GSA_CAP ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'gemscan-accounting' ) );
		}
		$tab = self::current_tab();

		echo '<div class="wrap gsa-wrap">';
		self::tabs_nav( $tab );

		// Sub-view routing within the Payments tab.
		$view = isset( $_GET['view'] ) ? sanitize_key( wp_unslash( $_GET['view'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification
		$sub  = isset( $_GET['action'] ) ? sanitize_key( wp_unslash( $_GET['action'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification

		switch ( $tab ) {
			case 'payments':
				if ( 'customer' === $view ) {
					require GSA_DIR . 'admin/views/customer.php';
				} elseif ( 'edit' === $sub || 'new' === $sub ) {
					require GSA_DIR . 'admin/views/payment-form.php';
				} else {
					require GSA_DIR . 'admin/views/payments.php';
				}
				break;
			case 'ledger':
				require GSA_DIR . 'admin/views/salaam-ledger.php';
				break;
			case 'reports':
				require GSA_DIR . 'admin/views/reports.php';
				break;
			case 'settings':
				require GSA_DIR . 'admin/views/settings.php';
				break;
			case 'dashboard':
			default:
				require GSA_DIR . 'admin/views/dashboard.php';
		}

		echo '</div>';
	}

	/** Tab navigation bar. */
	private static function tabs_nav( $current ) {
		$tabs = array(
			'dashboard' => array( 'gemscan-accounting', __( 'Dashboard', 'gemscan-accounting' ) ),
			'payments'  => array( 'gemscan-accounting-payments', __( 'Payments', 'gemscan-accounting' ) ),
			'ledger'    => array( 'gemscan-accounting-ledger', __( 'Salaam Ledger', 'gemscan-accounting' ) ),
			'reports'   => array( 'gemscan-accounting-reports', __( 'Reports', 'gemscan-accounting' ) ),
			'settings'  => array( 'gemscan-accounting-settings', __( 'Settings', 'gemscan-accounting' ) ),
		);
		echo '<h1 class="gsa-title">💎 ' . esc_html__( 'GemScan Accounting', 'gemscan-accounting' ) . '</h1>';
		echo '<nav class="nav-tab-wrapper gsa-tabs">';
		foreach ( $tabs as $key => $t ) {
			printf(
				'<a href="%1$s" class="nav-tab%2$s">%3$s</a>',
				esc_url( gsa_admin_url( array( 'page' => $t[0] ) ) ),
				$current === $key ? ' nav-tab-active' : '',
				esc_html( $t[1] )
			);
		}
		echo '</nav>';
	}

	/** Lazy-load and return a configured payments list table. */
	public static function payments_table() {
		if ( ! class_exists( 'WP_List_Table' ) ) {
			require_once ABSPATH . 'wp-admin/includes/class-wp-list-table.php';
		}
		require_once GSA_DIR . 'includes/class-gsa-payments-table.php';
		return new GSA_Payments_Table();
	}
}

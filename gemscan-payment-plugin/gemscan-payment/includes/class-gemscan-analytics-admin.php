<?php
/**
 * GemScan Payments — business analytics & accounting dashboard (admin).
 *
 * Adds a "GemScan Business" admin menu with a Dashboard (revenue, subscriptions,
 * scans, credits, estimated AI cost, profit + charts), a Financial Ledger
 * (CRUD + CSV), and Cost Settings (per-model AI cost + editable expenses).
 * Usage data comes from Supabase via GemScan_Data::get_analytics() (cached);
 * revenue/expenses are WordPress-local. Administrator-only, nonce-guarded.
 *
 * @package GemScan_Payments
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The analytics dashboard UI + handlers.
 */
class GemScan_Analytics_Admin {

	const OPT = 'gemscan_analytics_opt';
	const CAP = 'manage_options';

	/** Boot. */
	public static function init() {
		if ( ! is_admin() ) {
			return;
		}
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'handle_actions' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
	}

	/** Cost / expense settings, merged with defaults. */
	public static function settings() {
		return wp_parse_args(
			get_option( self::OPT, array() ),
			array(
				'currency'       => 'USD',
				'cost_gemini'    => '0.002',
				'cost_openai'    => '0.010',
				'cost_claude'    => '0.012',
				'expense_hosting' => '0',
				'expense_other'  => '0',
			)
		);
	}

	/* --------------------------------------------------------------------- */
	/* Menu                                                                   */
	/* --------------------------------------------------------------------- */

	public static function menu() {
		add_menu_page(
			__( 'GemScan Business', 'gemscan-payment' ),
			__( 'GemScan Business', 'gemscan-payment' ),
			self::CAP,
			'gemscan-business',
			array( __CLASS__, 'render_dashboard' ),
			'dashicons-chart-bar',
			59
		);
		add_submenu_page( 'gemscan-business', __( 'Dashboard', 'gemscan-payment' ), __( 'Dashboard', 'gemscan-payment' ), self::CAP, 'gemscan-business', array( __CLASS__, 'render_dashboard' ) );
		add_submenu_page( 'gemscan-business', __( 'Registered Users', 'gemscan-payment' ), __( 'Registered Users', 'gemscan-payment' ), self::CAP, 'gemscan-business-users', array( __CLASS__, 'render_users' ) );
		add_submenu_page( 'gemscan-business', __( 'Financial Ledger', 'gemscan-payment' ), __( 'Financial Ledger', 'gemscan-payment' ), self::CAP, 'gemscan-business-ledger', array( __CLASS__, 'render_ledger' ) );
		add_submenu_page( 'gemscan-business', __( 'Cost Settings', 'gemscan-payment' ), __( 'Cost Settings', 'gemscan-payment' ), self::CAP, 'gemscan-business-costs', array( __CLASS__, 'render_costs' ) );
	}

	public static function assets( $hook ) {
		if ( false === strpos( (string) $hook, 'gemscan-business' ) ) {
			return;
		}
		wp_enqueue_style( 'gemscan-biz', GEMSCAN_URL . 'assets/gemscan-biz.css', array(), GEMSCAN_VER );
		wp_enqueue_script( 'gemscan-biz', GEMSCAN_URL . 'assets/gemscan-biz.js', array(), GEMSCAN_VER, true );
	}

	/* --------------------------------------------------------------------- */
	/* Handlers (admin_init, before output)                                   */
	/* --------------------------------------------------------------------- */

	public static function handle_actions() {
		if ( empty( $_REQUEST['gemscan_biz_action'] ) || ! current_user_can( self::CAP ) ) {
			return;
		}
		$action = sanitize_key( wp_unslash( $_REQUEST['gemscan_biz_action'] ) );

		if ( 'save_costs' === $action ) {
			check_admin_referer( 'gemscan_save_costs' );
			$cur = self::settings();
			update_option(
				self::OPT,
				array(
					'currency'        => isset( $_POST['currency'] ) ? strtoupper( sanitize_text_field( wp_unslash( $_POST['currency'] ) ) ) : 'USD',
					'cost_gemini'     => isset( $_POST['cost_gemini'] ) ? (string) floatval( $_POST['cost_gemini'] ) : $cur['cost_gemini'],
					'cost_openai'     => isset( $_POST['cost_openai'] ) ? (string) floatval( $_POST['cost_openai'] ) : $cur['cost_openai'],
					'cost_claude'     => isset( $_POST['cost_claude'] ) ? (string) floatval( $_POST['cost_claude'] ) : $cur['cost_claude'],
					'expense_hosting' => isset( $_POST['expense_hosting'] ) ? (string) floatval( $_POST['expense_hosting'] ) : $cur['expense_hosting'],
					'expense_other'   => isset( $_POST['expense_other'] ) ? (string) floatval( $_POST['expense_other'] ) : $cur['expense_other'],
				)
			);
			self::redirect( 'gemscan-business-costs', 'saved' );
		}

		if ( 'save_ledger' === $action ) {
			check_admin_referer( 'gemscan_save_ledger' );
			$id   = isset( $_POST['id'] ) ? absint( $_POST['id'] ) : 0;
			$data = wp_unslash( $_POST );
			if ( $id ) {
				GemScan_Data::update_ledger( $id, $data );
			} else {
				GemScan_Data::insert_ledger( $data );
			}
			self::redirect( 'gemscan-business-ledger', 'ledger_saved' );
		}

		if ( 'delete_ledger' === $action ) {
			$id = isset( $_REQUEST['id'] ) ? absint( $_REQUEST['id'] ) : 0;
			check_admin_referer( 'gemscan_delete_ledger_' . $id );
			if ( $id ) {
				GemScan_Data::delete_ledger( $id );
			}
			self::redirect( 'gemscan-business-ledger', 'ledger_deleted' );
		}

		if ( 'export_ledger_csv' === $action ) {
			check_admin_referer( 'gemscan_export_ledger' );
			self::export_ledger_csv();
		}

		if ( 'refresh_analytics' === $action ) {
			check_admin_referer( 'gemscan_refresh' );
			GemScan_Data::get_analytics( true );
			self::redirect( 'gemscan-business', 'refreshed' );
		}
	}

	private static function redirect( $page, $notice ) {
		wp_safe_redirect( add_query_arg( array( 'page' => $page, 'gsb_notice' => $notice ), admin_url( 'admin.php' ) ) );
		exit;
	}

	/* --------------------------------------------------------------------- */
	/* AI cost + profit computation                                           */
	/* --------------------------------------------------------------------- */

	/**
	 * Estimated AI cost for a given standard + deep scan count.
	 * gemini runs on every scan; openai + claude only on Deep Scans.
	 *
	 * @param int $standard Standard scan count.
	 * @param int $deep     Deep scan count.
	 * @return float
	 */
	public static function ai_cost( $standard, $deep ) {
		$s = self::settings();
		$gemini = ( (int) $standard + (int) $deep ) * (float) $s['cost_gemini'];
		$openai = (int) $deep * (float) $s['cost_openai'];
		$claude = (int) $deep * (float) $s['cost_claude'];
		return $gemini + $openai + $claude;
	}

	/* --------------------------------------------------------------------- */
	/* Render: Dashboard                                                      */
	/* --------------------------------------------------------------------- */

	public static function render_dashboard() {
		if ( ! current_user_can( self::CAP ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'gemscan-payment' ) );
		}
		$a   = GemScan_Data::get_analytics();
		$s   = self::settings();
		$cur = $s['currency'];

		self::notices();
		echo '<div class="wrap gemscan-biz">';
		echo '<h1>💎 ' . esc_html__( 'GemScan Business', 'gemscan-payment' ) . ' ';
		$refresh = wp_nonce_url( add_query_arg( array( 'page' => 'gemscan-business', 'gemscan_biz_action' => 'refresh_analytics' ), admin_url( 'admin.php' ) ), 'gemscan_refresh' );
		echo '<a href="' . esc_url( $refresh ) . '" class="button" style="vertical-align:middle;">↻ ' . esc_html__( 'Refresh', 'gemscan-payment' ) . '</a></h1>';

		if ( null === $a ) {
			echo '<div class="notice notice-warning"><p>'
				. esc_html__( 'Could not load usage analytics from Supabase. Set the Functions URL + Activation secret under Settings → GemScan, and deploy the gemscan-analytics function.', 'gemscan-payment' )
				. '</p></div>';
		}

		$subs    = isset( $a['subscriptions'] ) ? $a['subscriptions'] : array();
		$scans   = isset( $a['scans'] ) ? $a['scans'] : array();
		$credits = isset( $a['credits'] ) ? $a['credits'] : array();

		$std_total  = (int) ( $scans['standard_total'] ?? 0 );
		$deep_total = (int) ( $scans['deep_total'] ?? 0 );

		$rev_total  = GemScan_Data::revenue_between();
		$rev_sub    = GemScan_Data::revenue_between( null, null, 'subscription' );
		$rev_credit = GemScan_Data::revenue_between( null, null, 'credit' );
		$ai_total   = self::ai_cost( $std_total, $deep_total );
		$expenses   = (float) $s['expense_hosting'] + (float) $s['expense_other'] + GemScan_Data::ledger_out_between();
		$profit     = $rev_total - $ai_total - $expenses;

		// ── Summary cards ─────────────────────────────────────────────────
		echo '<div class="gsb-cards">';
		self::card( __( 'Total Revenue', 'gemscan-payment' ), self::money( $rev_total, $cur ), 'ok' );
		self::card( __( 'Subscription Revenue', 'gemscan-payment' ), self::money( $rev_sub, $cur ) );
		self::card( __( 'Credit Revenue', 'gemscan-payment' ), self::money( $rev_credit, $cur ) );
		self::card( __( 'Active Subscribers', 'gemscan-payment' ), (int) ( $subs['active'] ?? 0 ), 'ok' );
		self::card( __( 'Expired Subscribers', 'gemscan-payment' ), (int) ( $subs['expired'] ?? 0 ), 'warn' );
		self::card( __( 'Total Subscribers', 'gemscan-payment' ), (int) ( $subs['total'] ?? 0 ) );
		self::card( __( 'Standard Scans', 'gemscan-payment' ), $std_total );
		self::card( __( 'Deep Scans', 'gemscan-payment' ), $deep_total );
		self::card( __( 'Deep Credits Remaining', 'gemscan-payment' ), (int) ( $credits['remaining_total'] ?? 0 ) );
		self::card( __( 'Estimated AI Cost', 'gemscan-payment' ), self::money( $ai_total, $cur ), 'warn' );
		self::card( __( 'Estimated Gross Profit', 'gemscan-payment' ), self::money( $profit, $cur ), $profit >= 0 ? 'ok' : 'err' );
		echo '</div>';

		// ── Profit dashboard (periods) ────────────────────────────────────
		echo '<div class="gsb-card-box"><h2>' . esc_html__( 'Profit', 'gemscan-payment' ) . '</h2>';
		echo '<table class="widefat striped"><thead><tr><th>' . esc_html__( 'Period', 'gemscan-payment' )
			. '</th><th class="num">' . esc_html__( 'Revenue', 'gemscan-payment' )
			. '</th><th class="num">' . esc_html__( 'AI cost', 'gemscan-payment' )
			. '</th><th class="num">' . esc_html__( 'Est. profit*', 'gemscan-payment' ) . '</th></tr></thead><tbody>';
		self::profit_row( __( 'Today', 'gemscan-payment' ), current_time( 'Y-m-d' ) . ' 00:00:00', current_time( 'Y-m-d' ) . ' 23:59:59', (int) ( $scans['standard_today'] ?? 0 ), (int) ( $scans['deep_today'] ?? 0 ), $cur );
		self::profit_row( __( 'This Month', 'gemscan-payment' ), current_time( 'Y-m' ) . '-01 00:00:00', null, (int) ( $scans['standard_month'] ?? 0 ), (int) ( $scans['deep_month'] ?? 0 ), $cur );
		self::profit_row( __( 'Lifetime', 'gemscan-payment' ), null, null, $std_total, $deep_total, $cur );
		echo '</tbody></table>';
		echo '<p class="description">* ' . esc_html__( 'Profit = revenue − estimated AI cost − expenses (Today/Month AI cost uses period scans; lifetime uses all scans). Hosting/other fixed expenses apply to the total figures above.', 'gemscan-payment' ) . '</p>';
		echo '</div>';

		// ── Charts ────────────────────────────────────────────────────────
		$by_month = GemScan_Data::revenue_by_month( 12 );
		echo '<div class="gsb-grid-2">';
		echo '<div class="gsb-card-box"><h2>' . esc_html__( 'Revenue by month', 'gemscan-payment' ) . '</h2>';
		echo '<canvas class="gsb-chart" data-type="bar" data-labels=\'' . esc_attr( wp_json_encode( array_keys( $by_month ) ) ) . '\' data-values=\'' . esc_attr( wp_json_encode( array_values( $by_month ) ) ) . '\' height="200"></canvas></div>';
		echo '<div class="gsb-card-box"><h2>' . esc_html__( 'Standard vs Deep scans', 'gemscan-payment' ) . '</h2>';
		echo '<canvas class="gsb-chart" data-type="doughnut" data-labels=\'' . esc_attr( wp_json_encode( array( 'Standard', 'Deep' ) ) ) . '\' data-values=\'' . esc_attr( wp_json_encode( array( $std_total, $deep_total ) ) ) . '\' height="200"></canvas></div>';
		echo '</div>';

		// ── Top users ─────────────────────────────────────────────────────
		if ( ! empty( $a['top_users'] ) ) {
			echo '<div class="gsb-card-box"><h2>' . esc_html__( 'Top 20 most active users', 'gemscan-payment' ) . '</h2>';
			echo '<table class="widefat striped"><thead><tr><th>' . esc_html__( 'Email', 'gemscan-payment' )
				. '</th><th class="num">' . esc_html__( 'Standard', 'gemscan-payment' )
				. '</th><th class="num">' . esc_html__( 'Deep', 'gemscan-payment' )
				. '</th><th class="num">' . esc_html__( 'Est. AI cost', 'gemscan-payment' ) . '</th></tr></thead><tbody>';
			foreach ( $a['top_users'] as $u ) {
				$us = (int) ( $u['standard'] ?? 0 );
				$ud = (int) ( $u['deep'] ?? 0 );
				printf(
					'<tr><td>%1$s</td><td class="num">%2$d</td><td class="num">%3$d</td><td class="num">%4$s</td></tr>',
					esc_html( $u['email'] ?? '' ),
					$us,
					$ud,
					esc_html( self::money( self::ai_cost( $us, $ud ), $cur ) )
				);
			}
			echo '</tbody></table></div>';
		}

		echo '</div>';
	}

	/** One profit table row. */
	private static function profit_row( $label, $from, $to, $std, $deep, $cur ) {
		$rev = GemScan_Data::revenue_between( $from, $to );
		$ai  = self::ai_cost( $std, $deep );
		printf(
			'<tr><td><strong>%1$s</strong></td><td class="num">%2$s</td><td class="num">%3$s</td><td class="num"><strong>%4$s</strong></td></tr>',
			esc_html( $label ),
			esc_html( self::money( $rev, $cur ) ),
			esc_html( self::money( $ai, $cur ) ),
			esc_html( self::money( $rev - $ai, $cur ) )
		);
	}

	/* --------------------------------------------------------------------- */
	/* Render: Registered Users (full list, admin only)                       */
	/* --------------------------------------------------------------------- */

	public static function render_users() {
		if ( ! current_user_can( self::CAP ) ) {
			wp_die( esc_html__( 'Permission denied.', 'gemscan-payment' ) );
		}
		$per_page = 50;
		// phpcs:disable WordPress.Security.NonceVerification.Recommended
		$search = isset( $_GET['s'] ) ? sanitize_text_field( wp_unslash( $_GET['s'] ) ) : '';
		$paged  = isset( $_GET['paged'] ) ? max( 1, absint( $_GET['paged'] ) ) : 1;
		// phpcs:enable
		$offset = ( $paged - 1 ) * $per_page;
		$data   = GemScan_Data::fetch_users_list( $per_page, $offset, $search );

		echo '<div class="wrap gemscan-biz"><h1>' . esc_html__( 'Registered Users', 'gemscan-payment' ) . '</h1>';
		echo '<p class="description">' . esc_html__( 'Everyone who has signed up in the GemScan app (from Supabase). Administrator-only.', 'gemscan-payment' ) . '</p>';

		if ( null === $data ) {
			echo '<div class="notice notice-warning"><p>'
				. esc_html__( 'Could not load users from Supabase. Set the Functions URL + Activation secret under Settings → GemScan, and deploy the gemscan-users function.', 'gemscan-payment' )
				. '</p></div></div>';
			return;
		}

		$total = isset( $data['total'] ) ? (int) $data['total'] : 0;
		$users = isset( $data['users'] ) && is_array( $data['users'] ) ? $data['users'] : array();
		$pages = max( 1, (int) ceil( $total / $per_page ) );

		// Search box.
		echo '<form method="get" class="gsb-ledger-filters"><input type="hidden" name="page" value="gemscan-business-users">';
		echo '<input type="search" name="s" value="' . esc_attr( $search ) . '" placeholder="' . esc_attr__( 'Search email…', 'gemscan-payment' ) . '"> ';
		submit_button( __( 'Search', 'gemscan-payment' ), 'secondary', '', false );
		if ( '' !== $search ) {
			echo ' <a class="button" href="' . esc_url( add_query_arg( array( 'page' => 'gemscan-business-users' ), admin_url( 'admin.php' ) ) ) . '">' . esc_html__( 'Clear', 'gemscan-payment' ) . '</a>';
		}
		echo '</form>';

		echo '<p>' . sprintf(
			/* translators: %s: total user count. */
			esc_html__( '%s registered users', 'gemscan-payment' ),
			'<strong>' . esc_html( number_format_i18n( $total ) ) . '</strong>'
		) . '</p>';

		echo '<table class="widefat striped"><thead><tr>'
			. '<th>' . esc_html__( 'Email', 'gemscan-payment' ) . '</th>'
			. '<th>' . esc_html__( 'Joined', 'gemscan-payment' ) . '</th>'
			. '<th>' . esc_html__( 'Plan', 'gemscan-payment' ) . '</th>'
			. '<th>' . esc_html__( 'Status', 'gemscan-payment' ) . '</th>'
			. '<th class="num">' . esc_html__( 'Standard', 'gemscan-payment' ) . '</th>'
			. '<th class="num">' . esc_html__( 'Deep', 'gemscan-payment' ) . '</th>'
			. '</tr></thead><tbody>';
		if ( empty( $users ) ) {
			echo '<tr><td colspan="6">' . esc_html__( 'No users found.', 'gemscan-payment' ) . '</td></tr>';
		}
		foreach ( $users as $u ) {
			$joined  = ! empty( $u['created_at'] ) ? gmdate( 'Y-m-d', strtotime( $u['created_at'] ) ) : '—';
			$expires = ! empty( $u['expires'] ) ? gmdate( 'Y-m-d', strtotime( $u['expires'] ) ) : '';
			printf(
				'<tr><td>%1$s</td><td>%2$s</td><td>%3$s</td><td>%4$s%5$s</td><td class="num">%6$d</td><td class="num">%7$d</td></tr>',
				esc_html( isset( $u['email'] ) ? $u['email'] : '' ),
				esc_html( $joined ),
				esc_html( isset( $u['tier'] ) ? ucfirst( $u['tier'] ) : 'free' ),
				esc_html( isset( $u['status'] ) ? $u['status'] : '—' ),
				$expires ? ' <span class="description">(' . esc_html( $expires ) . ')</span>' : '',
				(int) ( isset( $u['standard'] ) ? $u['standard'] : 0 ),
				(int) ( isset( $u['deep'] ) ? $u['deep'] : 0 )
			);
		}
		echo '</tbody></table>';

		// Pagination.
		if ( $pages > 1 ) {
			$base = add_query_arg( array( 'page' => 'gemscan-business-users', 's' => $search ), admin_url( 'admin.php' ) );
			echo '<p class="tablenav-pages" style="margin-top:12px;">';
			if ( $paged > 1 ) {
				echo '<a class="button" href="' . esc_url( add_query_arg( 'paged', $paged - 1, $base ) ) . '">‹ ' . esc_html__( 'Prev', 'gemscan-payment' ) . '</a> ';
			}
			echo '<span style="margin:0 8px;">' . sprintf(
				/* translators: 1: current page, 2: total pages. */
				esc_html__( 'Page %1$d of %2$d', 'gemscan-payment' ),
				(int) $paged,
				(int) $pages
			) . '</span>';
			if ( $paged < $pages ) {
				echo ' <a class="button" href="' . esc_url( add_query_arg( 'paged', $paged + 1, $base ) ) . '">' . esc_html__( 'Next', 'gemscan-payment' ) . ' ›</a>';
			}
			echo '</p>';
		}

		echo '</div>';
	}

	/* --------------------------------------------------------------------- */
	/* Render: Financial Ledger                                               */
	/* --------------------------------------------------------------------- */

	public static function render_ledger() {
		if ( ! current_user_can( self::CAP ) ) {
			wp_die( esc_html__( 'Permission denied.', 'gemscan-payment' ) );
		}
		self::notices();
		// phpcs:disable WordPress.Security.NonceVerification.Recommended
		$filters = array(
			'search'   => isset( $_GET['s'] ) ? sanitize_text_field( wp_unslash( $_GET['s'] ) ) : '',
			'category' => isset( $_GET['category'] ) ? sanitize_key( wp_unslash( $_GET['category'] ) ) : '',
			'from'     => isset( $_GET['from'] ) ? sanitize_text_field( wp_unslash( $_GET['from'] ) ) : '',
			'to'       => isset( $_GET['to'] ) ? sanitize_text_field( wp_unslash( $_GET['to'] ) ) : '',
		);
		$edit_id = isset( $_GET['edit'] ) ? absint( $_GET['edit'] ) : 0;
		// phpcs:enable
		$edit = $edit_id ? GemScan_Data::get_ledger( $edit_id ) : null;
		$rows = GemScan_Data::query_ledger( $filters );
		$cats = GemScan_Data::ledger_categories();
		$s    = self::settings();

		echo '<div class="wrap gemscan-biz"><h1>' . esc_html__( 'Financial Ledger', 'gemscan-payment' ) . '</h1>';

		// Add / edit form.
		echo '<div class="gsb-card-box"><h2>' . ( $edit ? esc_html__( 'Edit entry', 'gemscan-payment' ) : esc_html__( 'Add entry', 'gemscan-payment' ) ) . '</h2>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin.php' ) ) . '">';
		echo '<input type="hidden" name="page" value="gemscan-business-ledger"><input type="hidden" name="gemscan_biz_action" value="save_ledger"><input type="hidden" name="id" value="' . ( $edit ? (int) $edit['id'] : 0 ) . '">';
		wp_nonce_field( 'gemscan_save_ledger' );
		echo '<div class="gsb-inline">';
		echo '<label>' . esc_html__( 'Date', 'gemscan-payment' ) . '<input type="date" name="entry_date" value="' . esc_attr( $edit ? $edit['entry_date'] : current_time( 'Y-m-d' ) ) . '" required></label>';
		echo '<label>' . esc_html__( 'Category', 'gemscan-payment' ) . '<select name="category">';
		foreach ( $cats as $k => $lbl ) {
			printf( '<option value="%1$s"%2$s>%3$s</option>', esc_attr( $k ), selected( $edit ? $edit['category'] : '', $k, false ), esc_html( $lbl ) );
		}
		echo '</select></label>';
		echo '<label>' . esc_html__( 'Direction', 'gemscan-payment' ) . '<select name="direction">'
			. '<option value="out"' . selected( $edit ? $edit['direction'] : 'out', 'out', false ) . '>' . esc_html__( 'Money out', 'gemscan-payment' ) . '</option>'
			. '<option value="in"' . selected( $edit ? $edit['direction'] : '', 'in', false ) . '>' . esc_html__( 'Money in', 'gemscan-payment' ) . '</option></select></label>';
		echo '<label>' . esc_html__( 'Amount', 'gemscan-payment' ) . '<input type="number" step="0.01" min="0" name="amount" value="' . esc_attr( $edit ? $edit['amount'] : '' ) . '" required></label>';
		echo '<label class="gsb-grow">' . esc_html__( 'Description', 'gemscan-payment' ) . '<input type="text" name="description" value="' . esc_attr( $edit ? $edit['description'] : '' ) . '"></label>';
		echo '</div>';
		echo '<label>' . esc_html__( 'Notes', 'gemscan-payment' ) . '<textarea name="notes" class="large-text" rows="2">' . esc_textarea( $edit ? $edit['notes'] : '' ) . '</textarea></label>';
		echo '<p><button class="button button-primary">' . ( $edit ? esc_html__( 'Save changes', 'gemscan-payment' ) : esc_html__( 'Add entry', 'gemscan-payment' ) ) . '</button> ';
		if ( $edit ) {
			echo '<a class="button" href="' . esc_url( add_query_arg( array( 'page' => 'gemscan-business-ledger' ), admin_url( 'admin.php' ) ) ) . '">' . esc_html__( 'Cancel', 'gemscan-payment' ) . '</a>';
		}
		echo '</p></form></div>';

		// Filters + export.
		echo '<form method="get" class="gsb-ledger-filters"><input type="hidden" name="page" value="gemscan-business-ledger">';
		echo '<input type="search" name="s" value="' . esc_attr( $filters['search'] ) . '" placeholder="' . esc_attr__( 'Search…', 'gemscan-payment' ) . '"> ';
		echo '<select name="category"><option value="">' . esc_html__( 'All categories', 'gemscan-payment' ) . '</option>';
		foreach ( $cats as $k => $lbl ) {
			printf( '<option value="%1$s"%2$s>%3$s</option>', esc_attr( $k ), selected( $filters['category'], $k, false ), esc_html( $lbl ) );
		}
		echo '</select> ';
		echo '<input type="date" name="from" value="' . esc_attr( $filters['from'] ) . '"> <input type="date" name="to" value="' . esc_attr( $filters['to'] ) . '"> ';
		submit_button( __( 'Filter', 'gemscan-payment' ), 'secondary', '', false );
		echo ' <a class="button" href="' . esc_url( wp_nonce_url( add_query_arg( array_merge( array( 'page' => 'gemscan-business-ledger', 'gemscan_biz_action' => 'export_ledger_csv' ), $filters ), admin_url( 'admin.php' ) ), 'gemscan_export_ledger' ) ) . '">' . esc_html__( 'Export CSV', 'gemscan-payment' ) . '</a>';
		echo '</form>';

		// Table.
		echo '<table class="widefat striped"><thead><tr><th>' . esc_html__( 'Date', 'gemscan-payment' ) . '</th><th>' . esc_html__( 'Category', 'gemscan-payment' ) . '</th><th>' . esc_html__( 'Description', 'gemscan-payment' ) . '</th><th class="num">' . esc_html__( 'Amount', 'gemscan-payment' ) . '</th><th>' . esc_html__( 'By', 'gemscan-payment' ) . '</th><th></th></tr></thead><tbody>';
		if ( empty( $rows ) ) {
			echo '<tr><td colspan="6">' . esc_html__( 'No ledger entries.', 'gemscan-payment' ) . '</td></tr>';
		}
		foreach ( (array) $rows as $r ) {
			$edit_url = add_query_arg( array( 'page' => 'gemscan-business-ledger', 'edit' => (int) $r['id'] ), admin_url( 'admin.php' ) );
			$del_url  = wp_nonce_url( add_query_arg( array( 'page' => 'gemscan-business-ledger', 'gemscan_biz_action' => 'delete_ledger', 'id' => (int) $r['id'] ), admin_url( 'admin.php' ) ), 'gemscan_delete_ledger_' . (int) $r['id'] );
			$sign     = 'in' === $r['direction'] ? '+' : '−';
			printf(
				'<tr><td>%1$s</td><td>%2$s</td><td>%3$s</td><td class="num">%4$s %5$s</td><td>%6$s</td><td><a href="%7$s">%8$s</a> | <a href="%9$s" style="color:#b32d2e" onclick="return confirm(\'%10$s\')">%11$s</a></td></tr>',
				esc_html( $r['entry_date'] ),
				esc_html( isset( $cats[ $r['category'] ] ) ? $cats[ $r['category'] ] : $r['category'] ),
				esc_html( $r['description'] ),
				esc_html( $sign ),
				esc_html( self::money( $r['amount'], $r['currency'] ) ),
				esc_html( $r['created_by_name'] ),
				esc_url( $edit_url ),
				esc_html__( 'Edit', 'gemscan-payment' ),
				esc_url( $del_url ),
				esc_js( __( 'Delete this entry?', 'gemscan-payment' ) ),
				esc_html__( 'Delete', 'gemscan-payment' )
			);
		}
		echo '</tbody></table></div>';
	}

	/** Stream the (filtered) ledger as CSV. */
	private static function export_ledger_csv() {
		// phpcs:disable WordPress.Security.NonceVerification.Recommended
		$filters = array(
			'search'   => isset( $_GET['s'] ) ? sanitize_text_field( wp_unslash( $_GET['s'] ) ) : '',
			'category' => isset( $_GET['category'] ) ? sanitize_key( wp_unslash( $_GET['category'] ) ) : '',
			'from'     => isset( $_GET['from'] ) ? sanitize_text_field( wp_unslash( $_GET['from'] ) ) : '',
			'to'       => isset( $_GET['to'] ) ? sanitize_text_field( wp_unslash( $_GET['to'] ) ) : '',
		);
		// phpcs:enable
		$rows = GemScan_Data::query_ledger( $filters );
		nocache_headers();
		header( 'Content-Type: text/csv; charset=utf-8' );
		header( 'Content-Disposition: attachment; filename=gemscan-ledger-' . gmdate( 'Ymd-His' ) . '.csv' );
		$out = fopen( 'php://output', 'w' );
		fprintf( $out, chr( 0xEF ) . chr( 0xBB ) . chr( 0xBF ) );
		fputcsv( $out, array( 'Date', 'Category', 'Direction', 'Amount', 'Currency', 'Description', 'Notes', 'By', 'Created At' ) );
		foreach ( (array) $rows as $r ) {
			fputcsv( $out, array( $r['entry_date'], $r['category'], $r['direction'], $r['amount'], $r['currency'], $r['description'], $r['notes'], $r['created_by_name'], $r['created_at'] ) );
		}
		fclose( $out ); // phpcs:ignore
		exit;
	}

	/* --------------------------------------------------------------------- */
	/* Render: Cost Settings                                                  */
	/* --------------------------------------------------------------------- */

	public static function render_costs() {
		if ( ! current_user_can( self::CAP ) ) {
			wp_die( esc_html__( 'Permission denied.', 'gemscan-payment' ) );
		}
		self::notices();
		$s = self::settings();
		echo '<div class="wrap gemscan-biz"><h1>' . esc_html__( 'Cost Settings', 'gemscan-payment' ) . '</h1>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin.php' ) ) . '">';
		echo '<input type="hidden" name="page" value="gemscan-business-costs"><input type="hidden" name="gemscan_biz_action" value="save_costs">';
		wp_nonce_field( 'gemscan_save_costs' );
		echo '<h2>' . esc_html__( 'Estimated AI cost per request (USD)', 'gemscan-payment' ) . '</h2>';
		echo '<table class="form-table" role="presentation">';
		self::cost_field( 'cost_gemini', 'Gemini (every scan)', $s['cost_gemini'] );
		self::cost_field( 'cost_openai', 'OpenAI (Deep Scans only)', $s['cost_openai'] );
		self::cost_field( 'cost_claude', 'Claude (Deep Scans only)', $s['cost_claude'] );
		echo '</table>';
		echo '<h2>' . esc_html__( 'Fixed expenses', 'gemscan-payment' ) . '</h2>';
		echo '<table class="form-table" role="presentation">';
		self::cost_field( 'expense_hosting', 'Hosting / server (total)', $s['expense_hosting'] );
		self::cost_field( 'expense_other', 'Other business expenses (total)', $s['expense_other'] );
		echo '<tr><th><label for="currency">' . esc_html__( 'Currency', 'gemscan-payment' ) . '</label></th><td><input type="text" id="currency" name="currency" class="small-text" value="' . esc_attr( $s['currency'] ) . '"></td></tr>';
		echo '</table>';
		submit_button( __( 'Save cost settings', 'gemscan-payment' ) );
		echo '</form>';
		echo '<p class="description">' . esc_html__( 'AI cost is recalculated automatically from Supabase scan counts × these per-request costs. gemini runs on every scan; openai + claude only on Deep Scans. Ongoing itemised expenses can also be logged in the Financial Ledger.', 'gemscan-payment' ) . '</p>';
		echo '</div>';
	}

	private static function cost_field( $key, $label, $val ) {
		printf(
			'<tr><th><label for="%1$s">%2$s</label></th><td><input type="number" step="0.0001" min="0" id="%1$s" name="%1$s" class="regular-text" value="%3$s"></td></tr>',
			esc_attr( $key ),
			esc_html( $label ),
			esc_attr( $val )
		);
	}

	/* --------------------------------------------------------------------- */
	/* Helpers                                                                */
	/* --------------------------------------------------------------------- */

	private static function card( $label, $value, $tone = '' ) {
		printf(
			'<div class="gsb-card gsb-%3$s"><div class="gsb-card-label">%1$s</div><div class="gsb-card-value">%2$s</div></div>',
			esc_html( $label ),
			esc_html( $value ),
			esc_attr( $tone ? $tone : 'plain' )
		);
	}

	private static function money( $amount, $cur = 'USD' ) {
		return $cur . ' ' . number_format( (float) $amount, 2 );
	}

	private static function notices() {
		if ( empty( $_GET['gsb_notice'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification
			return;
		}
		$map = array(
			'saved'          => __( 'Cost settings saved.', 'gemscan-payment' ),
			'ledger_saved'   => __( 'Ledger entry saved.', 'gemscan-payment' ),
			'ledger_deleted' => __( 'Ledger entry deleted.', 'gemscan-payment' ),
			'refreshed'      => __( 'Analytics refreshed.', 'gemscan-payment' ),
		);
		$k = sanitize_key( wp_unslash( $_GET['gsb_notice'] ) ); // phpcs:ignore WordPress.Security.NonceVerification
		if ( isset( $map[ $k ] ) ) {
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html( $map[ $k ] ) . '</p></div>';
		}
	}
}

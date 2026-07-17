<?php
/**
 * Integration bridge to the existing "GemScan Payments" plugin.
 *
 * WORKFLOW (mobile money is manual): a buyer submits the "I have paid" form →
 * you verify the money actually arrived → you approve them using GemScan
 * Payments' "Activate an account" tool (Settings → GemScan). At THAT moment
 * this bridge mirrors the sale into the accounting ledger automatically.
 *
 * It does NOT modify the GemScan Payments plugin — it only listens (read-only)
 * for that plugin's own activation submission on admin_init, verifies the same
 * nonce, and records the payment via gsa_record_payment(). If GemScan Payments
 * is not installed, nothing happens.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Observes GemScan Payments account activations.
 */
class GSA_Bridge {

	/** Map GemScan Payments plan labels → accounting plan keys. */
	const PLAN_MAP = array(
		'Gem Collector' => 'professional',
		'Explorer'      => 'explorer',
	);

	/** Map GemScan Payments activation methods → accounting method keys. */
	const METHOD_MAP = array(
		'stripe'              => 'stripe',
		'mobile_money_evc'    => 'evc',
		'mobile_money_edahab' => 'edahab',
		'mobile_money_zaad'   => 'zaad',
		'mobile_money_sahal'  => 'other', // No dedicated Sahal method in accounting.
	);

	public static function init() {
		if ( ! is_admin() ) {
			return;
		}
		// Priority 20: run alongside the GemScan Payments settings-page handler
		// on the same request. Read-only detection; never blocks that plugin.
		add_action( 'admin_init', array( __CLASS__, 'capture_activation' ), 20 );
	}

	/**
	 * Detect a GemScan Payments "Activate an account" submission and record it.
	 */
	public static function capture_activation() {
		// Only when the GemScan Payments activation form is being submitted.
		if ( empty( $_POST['gemscan_do_activate'] ) ) {
			return;
		}
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		// Verify the SAME nonce GemScan Payments uses (non-fatal — never breaks
		// that plugin's own processing if it fails here).
		$nonce = isset( $_POST['_wpnonce'] ) ? sanitize_text_field( wp_unslash( $_POST['_wpnonce'] ) ) : '';
		if ( ! wp_verify_nonce( $nonce, 'gemscan_activate_now' ) ) {
			return;
		}
		if ( ! function_exists( 'gsa_record_payment' ) ) {
			return;
		}

		$email = isset( $_POST['act_email'] ) ? sanitize_email( wp_unslash( $_POST['act_email'] ) ) : '';
		if ( ! $email || ! is_email( $email ) ) {
			return;
		}
		$plan_label = isset( $_POST['act_plan'] ) ? sanitize_text_field( wp_unslash( $_POST['act_plan'] ) ) : '';
		$method_raw = isset( $_POST['act_method'] ) ? sanitize_text_field( wp_unslash( $_POST['act_method'] ) ) : '';

		// Pull the price + currency straight from GemScan Payments' own settings.
		$opts = wp_parse_args(
			get_option( 'gemscan_payment_options', array() ),
			array(
				'explorer_price'  => '4.99',
				'collector_price' => '14.99',
				'currency'        => 'USD',
			)
		);

		$plan_key = isset( self::PLAN_MAP[ $plan_label ] ) ? self::PLAN_MAP[ $plan_label ] : 'explorer';
		$amount   = ( 'professional' === $plan_key ) ? $opts['collector_price'] : $opts['explorer_price'];
		$method   = isset( self::METHOD_MAP[ $method_raw ] ) ? self::METHOD_MAP[ $method_raw ] : 'other';

		// Synthetic reference so a same-day double-activation de-duplicates,
		// while a genuine later renewal (different day) creates a new record.
		$txn = 'ACT-' . substr( md5( $email . $plan_key . current_time( 'Y-m-d' ) ), 0, 12 );

		gsa_record_payment(
			array(
				'email'       => $email,
				'plan'        => $plan_key,
				'amount'      => $amount,
				'currency'    => $opts['currency'],
				'method'      => $method,
				'txn_id'      => $txn,
				'status'      => 'paid',
				'start_date'  => current_time( 'Y-m-d' ),
				'expiry_date' => gmdate( 'Y-m-d', strtotime( '+1 year', current_time( 'timestamp' ) ) ), // phpcs:ignore WordPress.DateTime.CurrentTimeTimestamp
				'notes'       => 'Auto-recorded on account activation (GemScan Payments).',
			)
		);
	}
}

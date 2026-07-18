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
		// Mirror EVERY GemScan Payments sale — subscription or credit pack,
		// activated manually OR automatically by the Stripe webhook — into the
		// accounting ledger. GemScan Payments fires this action from a single
		// choke point (GemScan_Data::record_revenue), so it works in the admin
		// tools and in the REST (Stripe webhook) context alike. If GemScan
		// Payments is older / not installed, the action simply never fires.
		add_action( 'gemscan_revenue_recorded', array( __CLASS__, 'capture_revenue' ), 10, 1 );
	}

	/**
	 * Record a GemScan Payments sale into the accounting ledger.
	 *
	 * @param array $data email, type(subscription|credit), plan, credits,
	 *                    amount, currency, method, reference.
	 */
	public static function capture_revenue( $data ) {
		if ( ! function_exists( 'gsa_record_payment' ) || ! is_array( $data ) ) {
			return;
		}
		$email = isset( $data['email'] ) ? sanitize_email( $data['email'] ) : '';
		if ( ! $email || ! is_email( $email ) ) {
			return;
		}

		$type      = ( isset( $data['type'] ) && 'credit' === $data['type'] ) ? 'credit' : 'subscription';
		$amount    = isset( $data['amount'] ) ? (float) $data['amount'] : 0;
		$currency  = isset( $data['currency'] ) ? strtoupper( sanitize_text_field( $data['currency'] ) ) : 'USD';
		$ref       = isset( $data['reference'] ) ? sanitize_text_field( $data['reference'] ) : '';
		$method_in = isset( $data['method'] ) ? $data['method'] : '';
		$method    = isset( self::METHOD_MAP[ $method_in ] ) ? self::METHOD_MAP[ $method_in ] : 'other';

		if ( 'credit' === $type ) {
			$credits = isset( $data['credits'] ) ? (int) $data['credits'] : 0;
			// Reuse the Stripe session id when present (unique) so webhook
			// retries de-duplicate; otherwise a per-minute synthetic key.
			$txn = $ref ? $ref : 'GSA-CR-' . substr( md5( $email . $credits . current_time( 'YmdHi' ) ), 0, 12 );
			gsa_record_payment(
				array(
					'email'       => $email,
					'plan'        => 'credits',
					'amount'      => $amount,
					'currency'    => $currency,
					'method'      => $method,
					'txn_id'      => $txn,
					'status'      => 'paid',
					'start_date'  => current_time( 'Y-m-d' ),
					'expiry_date' => '', // Purchased credits roll over — no expiry.
					'notes'       => $credits . ' Deep Scan credits (auto-recorded from GemScan Payments).',
				)
			);
			return;
		}

		$plan_label = isset( $data['plan'] ) ? $data['plan'] : '';
		$plan_key   = isset( self::PLAN_MAP[ $plan_label ] ) ? self::PLAN_MAP[ $plan_label ] : 'explorer';
		$txn        = $ref ? $ref : 'GSA-SUB-' . substr( md5( $email . $plan_key . current_time( 'Y-m-d' ) ), 0, 12 );
		gsa_record_payment(
			array(
				'email'       => $email,
				'plan'        => $plan_key,
				'amount'      => $amount,
				'currency'    => $currency,
				'method'      => $method,
				'txn_id'      => $txn,
				'status'      => 'paid',
				'start_date'  => current_time( 'Y-m-d' ),
				'expiry_date' => gmdate( 'Y-m-d', strtotime( '+6 months', current_time( 'timestamp' ) ) ), // phpcs:ignore WordPress.DateTime.CurrentTimeTimestamp
				'notes'       => 'Subscription (auto-recorded from GemScan Payments).',
			)
		);
	}
}

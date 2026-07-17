<?php
/**
 * Integration bridge. Lets external gateways / the GemScan payment plugin
 * record a sale into accounting WITHOUT touching this plugin's code:
 *
 *   1. REST webhook (secret-authenticated):
 *        POST /wp-json/gsa/v1/payment
 *        header: X-GSA-Secret: <settings webhook secret>
 *        body:   { customer_name, email, plan, amount, currency, method,
 *                  txn_id, status, start_date, expiry_date, phone, country }
 *
 *   2. WordPress action from any PHP on the same site:
 *        do_action( 'gsa_capture_payment', $data );
 *
 *   3. Direct function call:
 *        gsa_record_payment( $data );
 *
 * All three converge on GSA_DB::record_payment() which is idempotent on
 * (txn_id, method), so retried webhooks won't create duplicates — keeping the
 * ledger synchronized with the gateways and GemScan subscriptions.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * REST + hook integration.
 */
class GSA_REST {

	/** Wire hooks (called on `init`). */
	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );

		// Generic capture hook other code can fire.
		add_action( 'gsa_capture_payment', array( __CLASS__, 'on_capture' ), 10, 1 );
	}

	/** Any PHP: do_action( 'gsa_capture_payment', $data ). */
	public static function on_capture( $data ) {
		if ( is_array( $data ) ) {
			GSA_DB::record_payment( $data );
		}
	}

	/** Register the REST route. */
	public static function register_routes() {
		register_rest_route(
			'gsa/v1',
			'/payment',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'handle_payment' ),
				'permission_callback' => array( __CLASS__, 'check_secret' ),
			)
		);
	}

	/**
	 * Authenticate the webhook via a shared secret (header or `secret` param),
	 * compared in constant time. Returns true only on an exact match.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return bool|WP_Error
	 */
	public static function check_secret( WP_REST_Request $request ) {
		$configured = (string) gsa_settings()['webhook_secret'];
		if ( '' === $configured ) {
			return new WP_Error( 'gsa_no_secret', 'Webhook secret is not configured.', array( 'status' => 403 ) );
		}
		$provided = $request->get_header( 'x_gsa_secret' );
		if ( null === $provided ) {
			$provided = (string) $request->get_param( 'secret' );
		}
		if ( ! hash_equals( $configured, (string) $provided ) ) {
			return new WP_Error( 'gsa_bad_secret', 'Invalid secret.', array( 'status' => 403 ) );
		}
		return true;
	}

	/**
	 * Record the incoming payment.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function handle_payment( WP_REST_Request $request ) {
		$params = $request->get_json_params();
		if ( empty( $params ) ) {
			$params = $request->get_params();
		}
		unset( $params['secret'] );

		$id = GSA_DB::record_payment( (array) $params );
		if ( is_wp_error( $id ) ) {
			return new WP_REST_Response(
				array(
					'success' => false,
					'error'   => $id->get_error_message(),
				),
				500
			);
		}
		return new WP_REST_Response(
			array(
				'success' => true,
				'id'      => $id,
			),
			200
		);
	}
}

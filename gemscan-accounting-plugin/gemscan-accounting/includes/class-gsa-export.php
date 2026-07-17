<?php
/**
 * Exporters: CSV, Excel (SpreadsheetML-compatible), and a self-contained PDF
 * summary. All entry points re-check the capability + nonce.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Streaming exporters.
 */
class GSA_Export {

	/**
	 * Column order shared by CSV/Excel exports.
	 *
	 * @return array<string,string> column => header label
	 */
	private static function columns() {
		return array(
			'id'            => 'ID',
			'customer_name' => 'Customer Name',
			'email'         => 'Email',
			'phone'         => 'Phone',
			'country'       => 'Country',
			'user_id'       => 'User ID',
			'plan'          => 'Plan',
			'amount'        => 'Amount',
			'currency'      => 'Currency',
			'method'        => 'Method',
			'txn_id'        => 'Transaction ID',
			'start_date'    => 'Start Date',
			'expiry_date'   => 'Expiry Date',
			'status'        => 'Status',
			'notes'         => 'Notes',
			'created_at'    => 'Created At',
			'updated_at'    => 'Updated At',
		);
	}

	/**
	 * Map a raw row to display values (enum labels).
	 *
	 * @param array $row Row.
	 * @return array
	 */
	private static function display_row( array $row ) {
		$row['plan']   = gsa_label( isset( $row['plan'] ) ? $row['plan'] : '', 'plan' );
		$row['method'] = gsa_label( isset( $row['method'] ) ? $row['method'] : '', 'method' );
		$row['status'] = gsa_label( isset( $row['status'] ) ? $row['status'] : '', 'status' );
		return $row;
	}

	/**
	 * Send CSV of the (filtered) payments to the browser.
	 *
	 * @param array $filters Query filters.
	 */
	public static function csv( array $filters ) {
		$rows    = GSA_DB::all_payments( $filters );
		$columns = self::columns();

		nocache_headers();
		header( 'Content-Type: text/csv; charset=utf-8' );
		header( 'Content-Disposition: attachment; filename=gemscan-payments-' . gmdate( 'Ymd-His' ) . '.csv' );

		$out = fopen( 'php://output', 'w' );
		fprintf( $out, chr( 0xEF ) . chr( 0xBB ) . chr( 0xBF ) ); // UTF-8 BOM for Excel.
		fputcsv( $out, array_values( $columns ) );
		foreach ( $rows as $row ) {
			$row  = self::display_row( $row );
			$line = array();
			foreach ( array_keys( $columns ) as $key ) {
				$line[] = isset( $row[ $key ] ) ? $row[ $key ] : '';
			}
			fputcsv( $out, $line );
		}
		fclose( $out ); // phpcs:ignore
		exit;
	}

	/**
	 * Send an Excel-openable file (SpreadsheetML 2003 XML — real spreadsheet,
	 * not a renamed CSV, and dependency-free).
	 *
	 * @param array $filters Query filters.
	 */
	public static function excel( array $filters ) {
		$rows    = GSA_DB::all_payments( $filters );
		$columns = self::columns();

		nocache_headers();
		header( 'Content-Type: application/vnd.ms-excel; charset=utf-8' );
		header( 'Content-Disposition: attachment; filename=gemscan-payments-' . gmdate( 'Ymd-His' ) . '.xls' );

		echo "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
		echo '<?mso-application progid="Excel.Sheet"?>' . "\n";
		echo '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">';
		echo '<Worksheet ss:Name="Payments"><Table>';

		echo '<Row>';
		foreach ( $columns as $label ) {
			echo '<Cell><Data ss:Type="String">' . esc_html( $label ) . '</Data></Cell>';
		}
		echo '</Row>';

		foreach ( $rows as $row ) {
			$row = self::display_row( $row );
			echo '<Row>';
			foreach ( array_keys( $columns ) as $key ) {
				$val  = isset( $row[ $key ] ) ? $row[ $key ] : '';
				$type = ( 'amount' === $key || 'id' === $key || 'user_id' === $key ) && is_numeric( $val ) ? 'Number' : 'String';
				echo '<Cell><Data ss:Type="' . esc_attr( $type ) . '">' . esc_html( $val ) . '</Data></Cell>';
			}
			echo '</Row>';
		}

		echo '</Table></Worksheet></Workbook>';
		exit;
	}

	/**
	 * Build a PDF summary report and stream it.
	 *
	 * @param string $period daily|weekly|monthly|annual.
	 */
	public static function pdf_report( $period ) {
		$r   = GSA_Reports::period_report( $period );
		$pdf = new GSA_PDF();

		$pdf->title( 'GemScan — ' . $r['title'] );
		$pdf->meta( 'Generated: ' . current_time( 'Y-m-d H:i' ) . '   |   Range: ' . substr( $r['from'], 0, 10 ) . ' to ' . substr( $r['to'], 0, 10 ) );
		$pdf->spacer();

		$pdf->section( 'Summary' );
		$pdf->kv( 'Total Revenue (paid)', gsa_money( $r['revenue'], gsa_settings()['default_currency'] ) );
		$pdf->kv( 'Paid transactions', (string) $r['count'] );
		$pdf->spacer();

		$pdf->section( 'By Plan' );
		foreach ( $r['by_plan'] as $k => $v ) {
			$pdf->kv( gsa_label( $k, 'plan' ), gsa_money( $v['total'] ) . '  (' . $v['count'] . ')' );
		}
		$pdf->spacer();

		$pdf->section( 'By Payment Method' );
		foreach ( $r['by_method'] as $k => $v ) {
			$pdf->kv( gsa_label( $k, 'method' ), gsa_money( $v['total'] ) . '  (' . $v['count'] . ')' );
		}
		$pdf->spacer();

		$pdf->section( 'By Country' );
		foreach ( $r['by_country'] as $k => $v ) {
			$pdf->kv( $k ? $k : '(unknown)', gsa_money( $v['total'] ) . '  (' . $v['count'] . ')' );
		}

		$pdf->footer_note( 'GemScan Accounting — this is an internal management report, not a tax document.' );

		nocache_headers();
		header( 'Content-Type: application/pdf' );
		header( 'Content-Disposition: attachment; filename=gemscan-' . $period . '-report-' . gmdate( 'Ymd' ) . '.pdf' );
		echo $pdf->render(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- binary PDF.
		exit;
	}
}

<?php
/**
 * Minimal, dependency-free PDF writer for summary reports.
 *
 * Produces a valid PDF 1.4 file (A4, core Helvetica fonts) with a title,
 * section headers and key/value lines, paginating automatically. Deliberately
 * small: enough for management summaries without bundling a heavy library.
 * For pixel-perfect invoices you can later drop in Dompdf/FPDF and swap
 * GSA_Export::pdf_report() over — nothing else depends on this class.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Tiny PDF document builder.
 */
class GSA_PDF {

	const PAGE_W = 595; // A4 width in points.
	const PAGE_H = 842; // A4 height in points.
	const LEFT   = 55;
	const VALUE_X = 320;
	const TOP    = 792;
	const BOTTOM = 60;
	const LH     = 16; // line height.

	/** @var string[] Per-page content streams. */
	private $pages = array();

	/** @var string Current page content stream. */
	private $cur = '';

	/** @var float Current y cursor. */
	private $y = self::TOP;

	public function __construct() {
		$this->y = self::TOP;
	}

	/** Escape a string for a PDF literal ()-string, ASCII only. */
	private function esc( $s ) {
		$s = (string) $s;
		$s = preg_replace( '/[^\x20-\x7E]/', '', $s ); // core fonts: ASCII only.
		return strtr( $s, array( '\\' => '\\\\', '(' => '\\(', ')' => '\\)' ) );
	}

	/** Draw one text line at the cursor with the given font/size, then advance. */
	private function line( $text, $size = 11, $bold = false, $x = self::LEFT ) {
		if ( $this->y < self::BOTTOM ) {
			$this->page_break();
		}
		$font       = $bold ? 'F2' : 'F1';
		$this->cur .= "BT /{$font} {$size} Tf 1 0 0 1 {$x} {$this->y} Tm (" . $this->esc( $text ) . ") Tj ET\n";
		$this->y   -= self::LH;
	}

	/** Start a new page. */
	private function page_break() {
		$this->pages[] = $this->cur;
		$this->cur     = '';
		$this->y       = self::TOP;
	}

	/* --------------------------------------------------------------------- */

	/** Document title. */
	public function title( $text ) {
		$this->line( $text, 18, true );
		$this->y -= 4;
	}

	/** Small meta line under the title. */
	public function meta( $text ) {
		$this->line( $text, 9, false );
	}

	/** Section header. */
	public function section( $text ) {
		if ( $this->y < self::BOTTOM + 30 ) {
			$this->page_break();
		}
		$this->y -= 4;
		$this->line( $text, 13, true );
	}

	/** Key/value row. */
	public function kv( $key, $value ) {
		if ( $this->y < self::BOTTOM ) {
			$this->page_break();
		}
		$font       = 'F1';
		$this->cur .= "BT /{$font} 11 Tf 1 0 0 1 " . self::LEFT . " {$this->y} Tm (" . $this->esc( $key ) . ") Tj ET\n";
		$this->cur .= "BT /F2 11 Tf 1 0 0 1 " . self::VALUE_X . " {$this->y} Tm (" . $this->esc( $value ) . ") Tj ET\n";
		$this->y   -= self::LH;
	}

	/** Vertical space. */
	public function spacer() {
		$this->y -= 10;
	}

	/** A footer note drawn near the bottom of the current page. */
	public function footer_note( $text ) {
		$this->cur .= 'BT /F1 8 Tf 1 0 0 1 ' . self::LEFT . ' 40 Tm (' . $this->esc( $text ) . ") Tj ET\n";
	}

	/**
	 * Assemble and return the final PDF bytes.
	 *
	 * @return string
	 */
	public function render() {
		// Flush the in-progress page.
		$this->pages[] = $this->cur;

		$objects = array(); // obj number => body (between "N 0 obj" and "endobj").

		$objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
		// obj 2 (Pages) filled after we know the kids.
		$objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
		$objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

		$kids    = array();
		$next    = 5;
		foreach ( $this->pages as $content ) {
			$content_obj = $next++;
			$page_obj    = $next++;
			$kids[]      = $page_obj . ' 0 R';

			$objects[ $content_obj ] = "<< /Length " . strlen( $content ) . " >>\nstream\n" . $content . "endstream";
			$objects[ $page_obj ]    = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " . self::PAGE_W . ' ' . self::PAGE_H . "] "
				. "/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {$content_obj} 0 R >>";
		}

		$objects[2] = "<< /Type /Pages /Kids [" . implode( ' ', $kids ) . '] /Count ' . count( $this->pages ) . " >>";

		ksort( $objects );

		$pdf     = "%PDF-1.4\n";
		$offsets = array();
		foreach ( $objects as $num => $body ) {
			$offsets[ $num ] = strlen( $pdf );
			$pdf            .= "{$num} 0 obj\n{$body}\nendobj\n";
		}

		$xref_pos = strlen( $pdf );
		$count    = count( $objects ) + 1; // +1 for the free object 0.
		$pdf     .= "xref\n0 {$count}\n0000000000 65535 f \n";
		for ( $i = 1; $i < $count; $i++ ) {
			$pdf .= sprintf( "%010d 00000 n \n", isset( $offsets[ $i ] ) ? $offsets[ $i ] : 0 );
		}
		$pdf .= "trailer\n<< /Size {$count} /Root 1 0 R >>\nstartxref\n{$xref_pos}\n%%EOF";

		return $pdf;
	}
}

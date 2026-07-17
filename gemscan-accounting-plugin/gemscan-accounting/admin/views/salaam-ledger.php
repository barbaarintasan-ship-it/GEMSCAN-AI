<?php
/**
 * Salaam transfers ledger: totals + add-entry form + entries table.
 *
 * @package GemScan_Accounting
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$gsa_cur     = gsa_settings()['default_currency'];
$gsa_totals  = GSA_DB::ledger_totals();
$gsa_entries = GSA_DB::all_ledger();
?>

<div class="gsa-tiles gsa-tiles-3">
	<div class="gsa-tile gsa-tile-ok">
		<div class="gsa-tile-label"><?php esc_html_e( 'Total Received', 'gemscan-accounting' ); ?></div>
		<div class="gsa-tile-value"><?php echo esc_html( gsa_money( $gsa_totals['received'], $gsa_cur ) ); ?></div>
	</div>
	<div class="gsa-tile gsa-tile-warn">
		<div class="gsa-tile-label"><?php esc_html_e( 'Total Transferred', 'gemscan-accounting' ); ?></div>
		<div class="gsa-tile-value"><?php echo esc_html( gsa_money( $gsa_totals['transferred'], $gsa_cur ) ); ?></div>
	</div>
	<div class="gsa-tile gsa-tile-primary">
		<div class="gsa-tile-label"><?php esc_html_e( 'Current Balance', 'gemscan-accounting' ); ?></div>
		<div class="gsa-tile-value"><?php echo esc_html( gsa_money( $gsa_totals['balance'], $gsa_cur ) ); ?></div>
	</div>
</div>

<div class="gsa-card gsa-ledger-form">
	<h2><?php esc_html_e( 'Add ledger entry', 'gemscan-accounting' ); ?></h2>
	<form method="post" action="<?php echo esc_url( admin_url( 'admin.php' ) ); ?>">
		<input type="hidden" name="page" value="gemscan-accounting-ledger" />
		<input type="hidden" name="gsa_action" value="add_ledger" />
		<?php wp_nonce_field( 'gsa_add_ledger' ); ?>
		<div class="gsa-inline-fields">
			<label><?php esc_html_e( 'Date', 'gemscan-accounting' ); ?>
				<input type="date" name="entry_date" value="<?php echo esc_attr( current_time( 'Y-m-d' ) ); ?>" required />
			</label>
			<label><?php esc_html_e( 'Type', 'gemscan-accounting' ); ?>
				<select name="type">
					<?php foreach ( gsa_ledger_types() as $gsa_k => $gsa_lbl ) : ?>
						<option value="<?php echo esc_attr( $gsa_k ); ?>"><?php echo esc_html( $gsa_lbl ); ?></option>
					<?php endforeach; ?>
				</select>
			</label>
			<label><?php esc_html_e( 'Amount', 'gemscan-accounting' ); ?>
				<input type="number" step="0.01" min="0" name="amount" required />
			</label>
			<label><?php esc_html_e( 'Reference Number', 'gemscan-accounting' ); ?>
				<input type="text" name="reference" />
			</label>
			<label class="gsa-grow"><?php esc_html_e( 'Notes', 'gemscan-accounting' ); ?>
				<input type="text" name="notes" />
			</label>
		</div>
		<p><button type="submit" class="button button-primary"><?php esc_html_e( 'Add entry', 'gemscan-accounting' ); ?></button></p>
	</form>
</div>

<table class="wp-list-table widefat fixed striped">
	<thead>
		<tr>
			<th><?php esc_html_e( 'Date', 'gemscan-accounting' ); ?></th>
			<th><?php esc_html_e( 'Type', 'gemscan-accounting' ); ?></th>
			<th><?php esc_html_e( 'Amount', 'gemscan-accounting' ); ?></th>
			<th><?php esc_html_e( 'Reference', 'gemscan-accounting' ); ?></th>
			<th><?php esc_html_e( 'Entered By', 'gemscan-accounting' ); ?></th>
			<th><?php esc_html_e( 'Notes', 'gemscan-accounting' ); ?></th>
			<th></th>
		</tr>
	</thead>
	<tbody>
		<?php if ( empty( $gsa_entries ) ) : ?>
			<tr><td colspan="7"><?php esc_html_e( 'No ledger entries yet.', 'gemscan-accounting' ); ?></td></tr>
		<?php else : ?>
			<?php foreach ( $gsa_entries as $gsa_e ) : ?>
				<?php
				$gsa_del = wp_nonce_url(
					gsa_admin_url(
						array(
							'page'       => 'gemscan-accounting-ledger',
							'gsa_action' => 'delete_ledger',
							'id'         => (int) $gsa_e['id'],
						)
					),
					'gsa_delete_ledger_' . (int) $gsa_e['id']
				);
				?>
				<tr>
					<td><?php echo esc_html( $gsa_e['entry_date'] ); ?></td>
					<td>
						<span class="gsa-badge gsa-badge-<?php echo 'received' === $gsa_e['type'] ? 'ok' : 'warn'; ?>">
							<?php echo esc_html( gsa_label( $gsa_e['type'], 'ledger_type' ) ); ?>
						</span>
					</td>
					<td><strong><?php echo esc_html( gsa_money( $gsa_e['amount'], $gsa_e['currency'] ) ); ?></strong></td>
					<td><?php echo esc_html( $gsa_e['reference'] ); ?></td>
					<td><?php echo esc_html( $gsa_e['entered_by_name'] ); ?></td>
					<td><?php echo esc_html( $gsa_e['notes'] ); ?></td>
					<td><a href="<?php echo esc_url( $gsa_del ); ?>" onclick="return confirm('<?php echo esc_js( __( 'Delete this entry?', 'gemscan-accounting' ) ); ?>');" style="color:#b32d2e;"><?php esc_html_e( 'Delete', 'gemscan-accounting' ); ?></a></td>
				</tr>
			<?php endforeach; ?>
		<?php endif; ?>
	</tbody>
</table>

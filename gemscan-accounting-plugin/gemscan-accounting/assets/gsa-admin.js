/**
 * GemScan Accounting — tiny, dependency-free canvas charts + small UI helpers.
 * Draws the bar / doughnut charts declared as:
 *   <canvas class="gsa-chart" data-type="bar|doughnut"
 *           data-labels='["Jan",...]' data-values='[12.5,...]'></canvas>
 */
( function () {
	'use strict';

	var PALETTE = [
		'#C9A227', '#2E7D32', '#635BFF', '#25D366', '#E67E22',
		'#8E44AD', '#16A085', '#C0392B', '#2980B9', '#7F8C8D'
	];

	function parse( el, attr ) {
		try {
			return JSON.parse( el.getAttribute( attr ) || '[]' );
		} catch ( e ) {
			return [];
		}
	}

	function setup( canvas ) {
		// Handle HiDPI displays crisply.
		var ratio = window.devicePixelRatio || 1;
		var cssW = canvas.clientWidth || canvas.parentNode.clientWidth || 480;
		var cssH = parseInt( canvas.getAttribute( 'height' ), 10 ) || 220;
		canvas.width = cssW * ratio;
		canvas.height = cssH * ratio;
		canvas.style.height = cssH + 'px';
		var ctx = canvas.getContext( '2d' );
		ctx.scale( ratio, ratio );
		return { ctx: ctx, w: cssW, h: cssH };
	}

	function money( n ) {
		return Math.round( n ).toLocaleString();
	}

	function drawBar( canvas, labels, values ) {
		var s = setup( canvas ), ctx = s.ctx, w = s.w, h = s.h;
		var padL = 44, padB = 26, padT = 12, padR = 8;
		var chartW = w - padL - padR, chartH = h - padB - padT;
		var max = Math.max.apply( null, values.concat( [ 1 ] ) );
		var n = values.length || 1;
		var bw = chartW / n * 0.62;
		var gap = chartW / n;

		// Axis baseline.
		ctx.strokeStyle = '#e2e2e2';
		ctx.beginPath();
		ctx.moveTo( padL, padT );
		ctx.lineTo( padL, padT + chartH );
		ctx.lineTo( padL + chartW, padT + chartH );
		ctx.stroke();

		ctx.fillStyle = '#8a8a8e';
		ctx.font = '10px -apple-system, Segoe UI, sans-serif';
		ctx.textAlign = 'right';
		ctx.fillText( money( max ), padL - 6, padT + 8 );
		ctx.fillText( '0', padL - 6, padT + chartH );

		values.forEach( function ( v, i ) {
			var bh = max ? ( v / max ) * chartH : 0;
			var x = padL + gap * i + ( gap - bw ) / 2;
			var y = padT + chartH - bh;
			ctx.fillStyle = PALETTE[ i % PALETTE.length ];
			ctx.fillRect( x, y, bw, bh );

			ctx.fillStyle = '#555';
			ctx.textAlign = 'center';
			ctx.font = '9px -apple-system, Segoe UI, sans-serif';
			var lbl = String( labels[ i ] == null ? '' : labels[ i ] );
			if ( lbl.length > 8 ) { lbl = lbl.slice( 0, 7 ) + '…'; }
			ctx.fillText( lbl, x + bw / 2, padT + chartH + 14 );
		} );
	}

	function drawDoughnut( canvas, labels, values ) {
		var s = setup( canvas ), ctx = s.ctx, w = s.w, h = s.h;
		var cx = h / 2 + 4, cy = h / 2, r = h / 2 - 10, inner = r * 0.58;
		var total = values.reduce( function ( a, b ) { return a + b; }, 0 ) || 1;
		var start = -Math.PI / 2;

		values.forEach( function ( v, i ) {
			var slice = ( v / total ) * Math.PI * 2;
			ctx.beginPath();
			ctx.moveTo( cx, cy );
			ctx.arc( cx, cy, r, start, start + slice );
			ctx.closePath();
			ctx.fillStyle = PALETTE[ i % PALETTE.length ];
			ctx.fill();
			start += slice;
		} );

		// Punch the hole.
		ctx.globalCompositeOperation = 'destination-out';
		ctx.beginPath();
		ctx.arc( cx, cy, inner, 0, Math.PI * 2 );
		ctx.fill();
		ctx.globalCompositeOperation = 'source-over';

		// Legend.
		var lx = h + 12, ly = 14;
		ctx.textAlign = 'left';
		ctx.font = '11px -apple-system, Segoe UI, sans-serif';
		labels.forEach( function ( lbl, i ) {
			ctx.fillStyle = PALETTE[ i % PALETTE.length ];
			ctx.fillRect( lx, ly - 8, 10, 10 );
			ctx.fillStyle = '#3a3a3a';
			var pct = Math.round( ( values[ i ] / total ) * 100 );
			ctx.fillText( ( lbl || '—' ) + '  ' + pct + '%', lx + 16, ly );
			ly += 18;
		} );
	}

	function render() {
		var charts = document.querySelectorAll( '.gsa-chart' );
		for ( var i = 0; i < charts.length; i++ ) {
			var c = charts[ i ];
			var labels = parse( c, 'data-labels' );
			var values = parse( c, 'data-values' ).map( Number );
			if ( !values.length ) { continue; }
			if ( c.getAttribute( 'data-type' ) === 'doughnut' ) {
				drawDoughnut( c, labels, values );
			} else {
				drawBar( c, labels, values );
			}
		}
	}

	if ( document.readyState !== 'loading' ) {
		render();
	} else {
		document.addEventListener( 'DOMContentLoaded', render );
	}
} )();

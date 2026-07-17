/* GemScan Business — tiny dependency-free canvas charts for the dashboard.
   <canvas class="gsb-chart" data-type="bar|doughnut" data-labels='[...]' data-values='[...]'> */
(function () {
	"use strict";
	var PALETTE = ["#C9A227", "#2E7D32", "#635BFF", "#25D366", "#E67E22", "#8E44AD", "#16A085", "#C0392B", "#2980B9", "#7F8C8D"];

	function parse(el, a) { try { return JSON.parse(el.getAttribute(a) || "[]"); } catch (e) { return []; } }

	function setup(c) {
		var r = window.devicePixelRatio || 1;
		var w = c.clientWidth || c.parentNode.clientWidth || 460;
		var h = parseInt(c.getAttribute("height"), 10) || 200;
		c.width = w * r; c.height = h * r; c.style.height = h + "px";
		var ctx = c.getContext("2d"); ctx.scale(r, r);
		return { ctx: ctx, w: w, h: h };
	}
	function fmt(n) { return Math.round(n).toLocaleString(); }

	function bar(c, labels, values) {
		var s = setup(c), ctx = s.ctx, w = s.w, h = s.h;
		var pl = 46, pb = 28, pt = 10, pr = 8;
		var cw = w - pl - pr, ch = h - pb - pt;
		var max = Math.max.apply(null, values.concat([1]));
		var n = values.length || 1, gap = cw / n, bw = gap * 0.6;
		ctx.strokeStyle = "#e2e2e2"; ctx.beginPath(); ctx.moveTo(pl, pt); ctx.lineTo(pl, pt + ch); ctx.lineTo(pl + cw, pt + ch); ctx.stroke();
		ctx.fillStyle = "#8a8a8e"; ctx.font = "10px sans-serif"; ctx.textAlign = "right";
		ctx.fillText(fmt(max), pl - 6, pt + 8); ctx.fillText("0", pl - 6, pt + ch);
		values.forEach(function (v, i) {
			var bh = max ? (v / max) * ch : 0, x = pl + gap * i + (gap - bw) / 2, y = pt + ch - bh;
			ctx.fillStyle = PALETTE[i % PALETTE.length]; ctx.fillRect(x, y, bw, bh);
			ctx.fillStyle = "#555"; ctx.textAlign = "center"; ctx.font = "9px sans-serif";
			var l = String(labels[i] == null ? "" : labels[i]); if (l.length > 7) l = l.slice(2);
			ctx.fillText(l, x + bw / 2, pt + ch + 13);
		});
	}

	function doughnut(c, labels, values) {
		var s = setup(c), ctx = s.ctx, h = s.h;
		var cx = h / 2 + 4, cy = h / 2, r = h / 2 - 10, inner = r * 0.58;
		var total = values.reduce(function (a, b) { return a + b; }, 0) || 1, start = -Math.PI / 2;
		values.forEach(function (v, i) {
			var sl = (v / total) * Math.PI * 2;
			ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, start, start + sl); ctx.closePath();
			ctx.fillStyle = PALETTE[i % PALETTE.length]; ctx.fill(); start += sl;
		});
		ctx.globalCompositeOperation = "destination-out"; ctx.beginPath(); ctx.arc(cx, cy, inner, 0, Math.PI * 2); ctx.fill();
		ctx.globalCompositeOperation = "source-over";
		var lx = h + 14, ly = 18; ctx.textAlign = "left"; ctx.font = "12px sans-serif";
		labels.forEach(function (l, i) {
			ctx.fillStyle = PALETTE[i % PALETTE.length]; ctx.fillRect(lx, ly - 9, 11, 11);
			ctx.fillStyle = "#333"; var pct = Math.round((values[i] / total) * 100);
			ctx.fillText((l || "—") + "  " + pct + "%", lx + 17, ly); ly += 20;
		});
	}

	function render() {
		var els = document.querySelectorAll(".gsb-chart");
		for (var i = 0; i < els.length; i++) {
			var c = els[i], labels = parse(c, "data-labels"), values = parse(c, "data-values").map(Number);
			if (!values.length) continue;
			if (c.getAttribute("data-type") === "doughnut") doughnut(c, labels, values); else bar(c, labels, values);
		}
	}
	if (document.readyState !== "loading") render(); else document.addEventListener("DOMContentLoaded", render);
})();

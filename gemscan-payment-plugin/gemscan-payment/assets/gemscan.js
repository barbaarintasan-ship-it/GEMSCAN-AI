(function () {
    "use strict";

    function ready(fn) {
        if (document.readyState !== "loading") { fn(); }
        else { document.addEventListener("DOMContentLoaded", fn); }
    }

    ready(function () {
        var wrap = document.querySelector(".gs-wrap");
        if (!wrap) return;

        var cfgEl = document.getElementById("gs-config");
        var cfg = {};
        try { cfg = JSON.parse(cfgEl.textContent); } catch (e) { cfg = {}; }

        // ---- Language toggle ----
        function setLang(lang) {
            wrap.querySelectorAll(".gs-i18n").forEach(function (el) {
                var val = el.getAttribute("data-" + lang);
                if (val !== null) el.textContent = val;
            });
            wrap.querySelectorAll(".gs-lang-btn").forEach(function (b) {
                b.classList.toggle("is-active", b.getAttribute("data-lang") === lang);
            });
        }
        wrap.querySelectorAll(".gs-lang-btn").forEach(function (b) {
            b.addEventListener("click", function () { setLang(b.getAttribute("data-lang")); });
        });

        // ---- Plan selection → reveal payment section ----
        var emailMain = document.getElementById("gs-email-main");
        var paySection = document.getElementById("gs-pay");
        var payPlanLabel = document.getElementById("gs-pay-plan");
        var formPlan = document.getElementById("gs-form-plan");
        var formEmail = document.getElementById("gs-form-email");
        var stripeBtn = document.getElementById("gs-stripe");
        var stripePlan = document.getElementById("gs-stripe-plan");
        var stripeEmail = document.getElementById("gs-stripe-email");
        var stripeForm = document.querySelector(".gs-stripe-form");
        var cardGroup = document.getElementById("gs-card-group");

        function appendEmail(url, email) {
            if (!url) return "#";
            if (!email) return url;
            var sep = url.indexOf("?") === -1 ? "?" : "&";
            // Stripe Payment Links understand prefilled_email + client_reference_id.
            return url + sep + "prefilled_email=" + encodeURIComponent(email) +
                   "&client_reference_id=" + encodeURIComponent(email);
        }

        wrap.querySelectorAll(".gs-buy").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var plan = btn.getAttribute("data-plan");
                var price = btn.getAttribute("data-price") || "";
                var mode = btn.getAttribute("data-mode") || "";
                var email = emailMain ? emailMain.value.trim() : "";

                // Credit packs are bought by mobile money here (card has its own
                // direct link on the pack), so hide the card group for mode="momo".
                if (cardGroup) cardGroup.style.display = (mode === "momo") ? "none" : "";

                if (payPlanLabel) payPlanLabel.textContent = plan;
                if (formPlan) formPlan.value = plan;
                if (formEmail && email) formEmail.value = email;

                // Show the exact amount to send in the mobile-money instructions.
                var amountText = (cfg.currency ? cfg.currency + " " : "") + price;
                wrap.querySelectorAll(".gs-amt").forEach(function (el) {
                    el.textContent = amountText;
                });

                // Fill the plan amount into every USSD "tap to pay" code. Somali
                // mobile-money USSD types the decimal as another * (4.99 → 4*99),
                // so convert here. Wire the tel: link (encode the trailing #) and
                // the Copy button.
                var amtUssd = price.replace(".", "*");
                wrap.querySelectorAll(".gs-ussd-code").forEach(function (el) {
                    var tpl = el.getAttribute("data-ussd") || "";
                    var code = tpl.replace("{amount}", amtUssd);
                    el.textContent = code;
                    el.setAttribute("href", "tel:" + code.replace(/#/g, "%23"));
                });
                wrap.querySelectorAll(".gs-copy-ussd").forEach(function (btn) {
                    var tpl = btn.getAttribute("data-ussd") || "";
                    btn.setAttribute("data-copy", tpl.replace("{amount}", amtUssd));
                });

                // Per-plan Stripe Payment Link: point the button at this plan's link.
                var planLink = cfg.links && cfg.links[plan];
                if (stripeBtn && planLink) stripeBtn.setAttribute("href", appendEmail(planLink, email));

                // Keys-based Stripe Checkout form (only used if no links configured).
                if (stripePlan) stripePlan.value = plan;
                if (stripeEmail) stripeEmail.value = email;

                if (paySection) {
                    paySection.style.display = "block";
                    paySection.scrollIntoView({ behavior: "smooth" });
                }
            });
        });

        // ---- Copy a mobile-money number to the clipboard ----
        wrap.querySelectorAll(".gs-copy").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var num = btn.getAttribute("data-copy") || "";
                var done = function () {
                    var label = btn.querySelector(".gs-i18n");
                    var prev = label ? label.textContent : btn.textContent;
                    if (label) { label.textContent = "✓"; } else { btn.textContent = "✓"; }
                    btn.classList.add("is-copied");
                    setTimeout(function () {
                        if (label) { label.textContent = prev; } else { btn.textContent = prev; }
                        btn.classList.remove("is-copied");
                    }, 1500);
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(num).then(done).catch(done);
                } else {
                    var t = document.createElement("textarea");
                    t.value = num; document.body.appendChild(t); t.select();
                    try { document.execCommand("copy"); } catch (e) {}
                    document.body.removeChild(t); done();
                }
            });
        });

        // Ensure the freshest email is submitted to Stripe Checkout.
        if (stripeForm) {
            stripeForm.addEventListener("submit", function (e) {
                var email = emailMain ? emailMain.value.trim() : "";
                if (!email) {
                    e.preventDefault();
                    if (emailMain) emailMain.focus();
                    return;
                }
                if (stripeEmail) stripeEmail.value = email;
            });
        }
    });
})();

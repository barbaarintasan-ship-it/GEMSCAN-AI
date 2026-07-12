#!/usr/bin/env node
/**
 * check-no-billing-deps.js
 *
 * Enforces the payment-separation decision (see /05-Monetization-Legal-Payments.md)
 * at the tooling level, not just as a policy statement: this mobile app must
 * NEVER implement Apple In-App Purchase, Google Play Billing, or any
 * subscription-selling SDK. If any of the packages below ever appear in
 * package.json (dependencies or devDependencies), install/start fails loudly
 * instead of silently letting IAP creep back into the app.
 *
 * Runs automatically via the "preinstall" and "prestart" npm scripts.
 */

const fs = require("fs");
const path = require("path");

const BANNED_PACKAGES = [
  "react-native-iap",
  "expo-in-app-purchases",
  "react-native-purchases", // RevenueCat
  "react-native-purchases-ui",
  "@invertase/react-native-apphud",
  "react-native-billing",
  "expo-billing",
  "react-native-google-play-billing",
];

const pkgPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

const allDeps = {
  ...(pkg.dependencies || {}),
  ...(pkg.devDependencies || {}),
};

const found = BANNED_PACKAGES.filter((name) => name in allDeps);

if (found.length > 0) {
  console.error("\n🚫 BLOCKED: banned in-app-purchase/billing dependency detected.\n");
  console.error(
    "GemScan AI's mobile app must never sell subscriptions or implement " +
      "Apple/Google in-app billing. All payments happen exclusively on the " +
      "official website (see /05-Monetization-Legal-Payments.md at the repo root).\n",
  );
  console.error("Offending package(s):");
  found.forEach((name) => console.error(`  - ${name}`));
  console.error(
    "\nRemove the package(s) above from mobile/package.json. If you believe " +
      "this rule needs to change, that's a product decision, not an " +
      "engineering one — raise it before editing this script.\n",
  );
  process.exit(1);
}

console.log("✓ No billing/IAP dependencies detected — payment separation intact.");

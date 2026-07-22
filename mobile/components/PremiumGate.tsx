// PremiumGate
//
// Wraps any feature that requires a paid tier. It NEVER renders a "Buy" or
// "Subscribe" button that purchases anything in-app — the only call to
// action is an outbound Linking.openURL() to the official website's pricing
// page, where the actual Stripe/PayPal/mobile-money checkout happens. This
// component has no knowledge of prices, Stripe, or any payment SDK.
import React from "react";
import { View, Text, Pressable, Linking, StyleSheet } from "react-native";
import { useSubscriptionStatus, SubscriptionTier } from "../lib/subscription";
import { EXTERNAL_PURCHASES_ENABLED } from "../lib/appLinks";

const WEBSITE_PRICING_URL = "https://barbaarintasan.com/gemscanpayment";

const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  premium: 1,
  lifetime: 1,
  professional: 2,
};

type Props = {
  requiredTier: SubscriptionTier;
  children: React.ReactNode;
  featureName?: string;
};

export function PremiumGate({ requiredTier, children, featureName }: Props) {
  const { data, isLoading } = useSubscriptionStatus();

  if (isLoading) {
    return null; // or a skeleton loader
  }

  const currentTier: SubscriptionTier = data?.tier ?? "free";
  const isEntitled = TIER_RANK[currentTier] >= TIER_RANK[requiredTier];

  if (isEntitled) {
    return <>{children}</>;
  }

  // On iOS we cannot show an external-purchase call-to-action (Guideline
  // 3.1.1), so a locked premium feature is simply hidden rather than teased
  // with a "subscribe on our website" button.
  if (!EXTERNAL_PURCHASES_ENABLED) {
    return null;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        {featureName ? `${featureName} is a premium feature` : "This is a premium feature"}
      </Text>
      <Text style={styles.subtitle}>
        Upgrade on the LuulScan website to unlock this. Once you subscribe, your account unlocks
        automatically.
      </Text>
      <Pressable
        style={styles.button}
        onPress={() => Linking.openURL(WEBSITE_PRICING_URL)}
        accessibilityRole="link"
        accessibilityLabel="Open LuulScan pricing page in browser"
      >
        <Text style={styles.buttonText}>Unlock on the website</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 24,
    borderRadius: 16,
    alignItems: "center",
    gap: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 13,
    textAlign: "center",
    opacity: 0.7,
  },
  button: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 999,
    backgroundColor: "#C9A227", // gold accent, per the design system (§06)
  },
  buttonText: {
    color: "#0B0B0C",
    fontWeight: "700",
  },
});

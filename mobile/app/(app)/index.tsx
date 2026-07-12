import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useSubscriptionStatus } from "../../lib/subscription";
import { PremiumGate } from "../../components/PremiumGate";

export default function HomeScreen() {
  const { data, isLoading } = useSubscriptionStatus();
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>GemScan AI</Text>

      {!isLoading && (
        <Text style={styles.tierBadge}>
          Current plan: {data?.tier ?? "free"}
          {data?.features.dailyScanLimit != null
            ? ` — ${data.features.dailyScanLimit} scans/day`
            : " — unlimited scans"}
        </Text>
      )}

      <Pressable style={styles.scanButton} onPress={() => router.push("/(app)/scan/capture")}>
        <Text style={styles.scanButtonText}>Start New Scan</Text>
      </Pressable>

      {/*
        Note this component never sells anything — it only reads entitlement
        and, if not entitled, links out to the website. The multi-model
        "Deep Scan" ensemble itself is enforced server-side in
        orchestrate-scan (see providers/*.ts requiresEnsembleTier), not just
        gated here in the UI.
      */}
      <PremiumGate requiredTier="premium" featureName="Deep Scan (multi-model AI ensemble)">
        <Text style={styles.body}>
          Deep Scan is unlocked — every scan runs the full multi-model AI ensemble.
        </Text>
      </PremiumGate>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, backgroundColor: "#0B0B0C", gap: 16 },
  heading: { fontSize: 22, fontWeight: "700", color: "#F5F1E8" },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  tierBadge: {
    color: "#C9A227",
    fontWeight: "600",
    fontSize: 13,
  },
  scanButton: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: "center",
  },
  scanButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 16 },
});

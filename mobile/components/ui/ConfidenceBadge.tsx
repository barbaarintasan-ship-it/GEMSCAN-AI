// Consistent confidence pill — replaces the BAND_COLOR map that used to be
// copy-pasted in history.tsx, results.tsx and batch-results.tsx.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, radius, spacing } from "../../lib/theme";

export type ConfidenceBand = "low" | "medium" | "high";

const BAND_COLOR: Record<ConfidenceBand, string> = {
  high: colors.confidenceHigh,
  medium: colors.confidenceMedium,
  low: colors.confidenceLow,
};

type Props = { pct: number; band: ConfidenceBand; size?: "sm" | "md" | "lg" };

// Memoized: rendered once per row in History's FlatList and per alternative
// in results.tsx — pure given its props.
export const ConfidenceBadge = React.memo(function ConfidenceBadge({ pct, band, size = "md" }: Props) {
  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: BAND_COLOR[band] },
        size === "sm" && styles.pillSm,
        size === "lg" && styles.pillLg,
      ]}
    >
      <Text style={[styles.text, size === "sm" && styles.textSm, size === "lg" && styles.textLg]}>
        {Math.round(pct)}%
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  pill: { paddingHorizontal: spacing.sm + 2, paddingVertical: 3, borderRadius: radius.pill, alignSelf: "flex-start" },
  pillSm: { paddingHorizontal: spacing.sm, paddingVertical: 2 },
  pillLg: { paddingHorizontal: spacing.md, paddingVertical: 6 },
  text: { fontSize: 11, fontWeight: "800", color: "#0B0B0C" },
  textSm: { fontSize: 10 },
  textLg: { fontSize: 13 },
});

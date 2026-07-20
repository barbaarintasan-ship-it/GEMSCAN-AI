import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, type as typo } from "../../lib/theme";

type Props = { message: string };

// Shown whenever a screen is displaying cached data instead of a fresh live
// fetch — either because the device is offline, or because the live refresh
// itself failed while cached data was already on screen (kept rather than
// cleared, so a failed refresh never blanks out good data).
export function OfflineBanner({ message }: Props) {
  return (
    <View style={styles.banner}>
      <Ionicons name="cloud-offline-outline" size={15} color={colors.gold} />
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.goldSoft,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  text: { ...typo.bodySmall, color: colors.gold, flex: 1 },
});

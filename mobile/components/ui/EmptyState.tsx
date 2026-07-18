import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, type as t } from "../../lib/theme";
import { Button } from "./Button";

type Props = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  hint: string;
  ctaLabel?: string;
  onPressCta?: () => void;
};

export function EmptyState({ icon, title, hint, ctaLabel, onPressCta }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.iconCircle}>
        <Ionicons name={icon} size={38} color={colors.gold} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.hint}>{hint}</Text>
      {ctaLabel && onPressCta && (
        <Button title={ctaLabel} onPress={onPressCta} style={styles.cta} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "center", justifyContent: "center", padding: spacing.xxxl, gap: spacing.sm },
  iconCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.goldSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  title: { ...t.heading, textAlign: "center" },
  hint: { ...t.body, textAlign: "center" },
  cta: { marginTop: spacing.md, paddingHorizontal: spacing.xxl },
});

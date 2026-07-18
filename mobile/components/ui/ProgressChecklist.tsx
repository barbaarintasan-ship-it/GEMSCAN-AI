// Professional "waiting" experience — replaces a bare spinner with a
// checklist that fills in as each REAL pipeline stage actually completes
// (quality check → AI analysis → hallmark detection → market estimation →
// final report). This is purely a presentational reflection of stages the
// app already runs sequentially; it does not add, skip, reorder or fake any
// processing step.
import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Animated, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, type as t } from "../../lib/theme";

export type ProgressStep = { key: string; label: string; done: boolean; active: boolean };

function StepRow({ step }: { step: ProgressStep }) {
  const opacity = useRef(new Animated.Value(step.done || step.active ? 1 : 0.4)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: step.done || step.active ? 1 : 0.4,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [step.done, step.active, opacity]);

  return (
    <Animated.View style={[styles.row, { opacity }]}>
      <View style={styles.iconWrap}>
        {step.done ? (
          <Ionicons name="checkmark-circle" size={20} color={colors.success} />
        ) : step.active ? (
          <ActivityIndicator size="small" color={colors.gold} />
        ) : (
          <Ionicons name="ellipse-outline" size={16} color={colors.textFaint} />
        )}
      </View>
      <Text style={[styles.label, step.done && styles.labelDone, step.active && styles.labelActive]}>
        {step.label}
      </Text>
    </Animated.View>
  );
}

export function ProgressChecklist({ title, steps }: { title?: string; steps: ProgressStep[] }) {
  return (
    <View style={styles.card}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {steps.map((s) => (
        <StepRow key={s.key} step={s} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xl,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    width: "100%",
  },
  title: { ...t.subheading, marginBottom: spacing.xs, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  iconWrap: { width: 22, alignItems: "center" },
  label: { ...t.body, color: colors.textFaint },
  labelActive: { color: colors.text, fontWeight: "700" },
  labelDone: { color: colors.textMuted },
});

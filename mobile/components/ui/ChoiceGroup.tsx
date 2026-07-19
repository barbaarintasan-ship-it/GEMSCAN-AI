// Reusable data-driven single-select control — one component covers every
// "pick one of N" questionnaire step in the Diamond Verification wizard
// (hardness questions, transparency, fire, sparkle, shape, magnet, fog, UV,
// loupe, color, units) instead of bespoke UI per step. Two layouts:
//   - "list" (default): vertical rows, each with an optional sub-label —
//     for options with real descriptive text.
//   - "chips": wrapped horizontal pills — for short single-word choices
//     (e.g. the color picker) where a full-width row would waste space.
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "../../lib/theme";

export type ChoiceOption = { value: string; label: string; subLabel?: string };

type Props = {
  options: ChoiceOption[];
  value?: string;
  onChange: (value: string) => void;
  layout?: "list" | "chips";
};

export function ChoiceGroup({ options, value, onChange, layout = "list" }: Props) {
  if (layout === "chips") {
    return (
      <View style={styles.chipWrap}>
        {options.map((opt) => {
          const selected = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              style={[styles.chip, selected && styles.chipSelected]}
              onPress={() => onChange(opt.value)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  }

  return (
    <View style={styles.list}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            style={[styles.row, selected && styles.rowSelected]}
            onPress={() => onChange(opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
          >
            <View style={styles.rowBody}>
              <Text style={[styles.rowLabel, selected && styles.rowLabelSelected]}>{opt.label}</Text>
              {opt.subLabel ? <Text style={styles.rowSubLabel}>{opt.subLabel}</Text> : null}
            </View>
            {selected && <Ionicons name="checkmark-circle" size={20} color={colors.gold} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
  },
  rowSelected: { borderColor: colors.goldBorder, backgroundColor: colors.goldSoft },
  rowBody: { flex: 1, gap: 2 },
  rowLabel: { color: colors.text, fontWeight: "700", fontSize: 15 },
  rowLabelSelected: { color: colors.gold },
  rowSubLabel: { color: colors.textFaint, fontSize: 12.5, lineHeight: 17 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  chipSelected: { backgroundColor: colors.goldSoft, borderColor: colors.goldBorder },
  chipText: { color: colors.textMuted, fontWeight: "600", fontSize: 13.5 },
  chipTextSelected: { color: colors.gold },
});

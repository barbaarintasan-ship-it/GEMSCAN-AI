// Which commodity is this assessment for?
//
// The list is the pack's own commodity profiles — 23 today — read at render time.
// Never a literal array in this file: a hard-coded list drifts the moment a profile
// is added or renamed, and then the app offers a commodity the engine cannot model,
// or hides one it can.
//
// WHAT CHOOSING A COMMODITY DOES, AND WHAT IT DOES NOT
//
// It conditions the SAME evidence. A gold assessment weights structure and drainage
// differently from a chromium one because their deposit styles differ, and it drops
// evidence its deposit model has no use for. It does not load a second model, and it
// does not make the number mean something new.
//
// "None" is the default, and it is the validated one: LOO AUC 0.900, BLIND 0.843,
// measured on the real pack. Every commodity lens sits on top of that.
//
// WHAT IS NEVER SAID HERE
//
// No probability. Not "60% chance of gold", not "likely deposit", not odds of any
// kind. 159 occurrences across 23 commodities cannot calibrate a probability, and
// most profiles have too few to calibrate anything at all — so those are labelled
// UNCALIBRATED to their face rather than quietly presented as if they were not.
// A score here ranks ground against other ground. That is all it does.
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../lib/theme";
import { commodityModelFor, type CommodityModel } from "../lib/geo/commodityModel";
import type { PackData } from "../../shared/geo-core/pack/types";
import type { TFunc } from "../lib/exploration/format";

export function CommodityChooser({
  pack, selected, onSelect, t,
}: {
  pack: PackData | null;
  selected: string | null;
  onSelect: (code: string | null) => void;
  t: TFunc;
}) {
  // From the pack, sorted by the name the geologist will read.
  const profiles = React.useMemo(() => {
    const rows = pack?.commodities ?? [];
    return [...rows].sort((a, b) => a.name.localeCompare(b.name));
  }, [pack]);

  const model = React.useMemo(
    () => (pack && selected ? commodityModelFor(pack, selected) : null),
    [pack, selected],
  );

  if (profiles.length === 0) {
    // No profiles in the pack: say so, rather than showing an empty row that
    // looks like a loading state that never finishes.
    return <Text style={styles.empty}>{t("field.commodity.none")}</Text>;
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.current}>
        {selected && model
          ? t("field.commodity.current", { name: model.name.toUpperCase() })
          : t("field.commodity.currentUniversal")}
      </Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        <Chip
          label={t("field.commodity.universal")}
          active={selected === null}
          onPress={() => onSelect(null)}
        />
        {profiles.map((p) => (
          <Chip
            key={p.code}
            label={p.name}
            active={selected === p.code}
            onPress={() => onSelect(p.code)}
          />
        ))}
      </ScrollView>

      {model ? <Basis model={model} t={t} /> : (
        <Text style={styles.note}>{t("field.commodity.universalNote")}</Text>
      )}
    </View>
  );
}

/**
 * What the chosen profile can and cannot support.
 *
 * Shown every time a commodity is active, not hidden behind a tap. The whole
 * reason for stating the basis is that an uncalibrated lens looks identical to a
 * calibrated one from the outside.
 */
function Basis({ model, t }: { model: CommodityModel; t: TFunc }) {
  const { calibration } = model;
  return (
    <View style={styles.basis}>
      <View style={styles.basisHead}>
        <Text style={[styles.tag, calibration.calibrated ? styles.tagOk : styles.tagWarn]}>
          {calibration.calibrated
            ? t("field.commodity.calibrated")
            : t("field.commodity.uncalibrated")}
        </Text>
        <Text style={styles.occ}>
          {t("field.commodity.occurrences", { count: calibration.occurrences })}
        </Text>
      </View>

      <Text style={styles.reason}>{calibration.reason}</Text>

      {/* The profile's own statement of its limits, carried through unchanged.
          It is the source's caveat, not the app's paraphrase of it. */}
      {model.limitations ? (
        <Text style={styles.limits}>{model.limitations}</Text>
      ) : null}

      {/* Said outright, every time. It is the single most likely thing for a
          reader to assume the number means. */}
      <Text style={styles.noProbability}>{t("field.commodity.notAProbability")}</Text>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, active && styles.chipActive]}
      hitSlop={6}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.md, gap: spacing.sm,
  },
  current: { color: colors.text, fontSize: 13, fontWeight: "700", letterSpacing: 0.4 },
  chips: { flexDirection: "row", gap: spacing.xs, paddingVertical: 2 },
  chip: {
    paddingHorizontal: spacing.md, paddingVertical: 6,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
  },
  chipActive: { borderColor: colors.gold, backgroundColor: "rgba(212,175,55,0.14)" },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextActive: { color: colors.gold, fontWeight: "700" },
  basis: { gap: 4, marginTop: 2 },
  basisHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  tag: { fontSize: 10, fontWeight: "800", letterSpacing: 0.6 },
  tagOk: { color: "#22C55E" },
  tagWarn: { color: colors.gold },
  occ: { color: colors.textMuted, fontSize: 11 },
  reason: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  limits: { color: colors.textMuted, fontSize: 11, lineHeight: 16, fontStyle: "italic" },
  noProbability: { color: colors.textFaint, fontSize: 10, lineHeight: 15, marginTop: 2 },
  empty: { color: colors.textMuted, fontSize: 12 },
  note: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
});

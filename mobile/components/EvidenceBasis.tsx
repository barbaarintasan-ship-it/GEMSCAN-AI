// What the score in front of you was built from.
//
// Measured on 10 August 2026: strip out known mineral occurrences and the engine
// cannot tell mineralised ground from random ground at all (AUC 0.53), because
// nine points in ten have no evidence of any kind. Four of the pack's layers ship
// with zero rows; three roles have no data source anywhere. None of that was
// visible in the app. A "High" from one fault looked exactly like a "High" from
// six agreeing layers.
//
// So the basis is shown, always, next to the number it produced — and the four
// kinds of absence are kept apart, because they are four different statements:
//
//   Used                      it contributed here
//   Data present, not scored  the app HAS this and does not use it, and says why
//   None within range         the layer is loaded; none of it is near you
//   Layer empty               nobody has loaded this data yet
//   No data source            this does not exist anywhere in the system
//
// A geologist reading "no alteration" must be able to tell "there is none" from
// "nobody looked". Collapsing these into "missing" is the difference between a
// geological assistant and a confident liar.
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../lib/theme";
import {
  COVERAGE_STATE_KEY, ROLE_LABEL_KEY,
  type CoverageState, type EvidenceRole,
} from "../lib/geo/evidenceRoles";
import { rolesInState, type EvidenceCoverage } from "../lib/geo/evidenceCoverage";
import type { TFunc } from "../lib/exploration/format";

/** Read top to bottom: what helped, what was held back, what is not there. */
const ORDER: CoverageState[] = ["present", "not_scored", "none_here", "empty_layer", "no_source"];

/** Below this the score rests on very little, and the reader is told so plainly. */
const THIN_BASIS = 0.35;

export function EvidenceBasis({ coverage, t }: { coverage: EvidenceCoverage; t: TFunc }) {
  const groups = ORDER
    .map((state) => ({ state, roles: rolesInState(coverage, state) }))
    .filter((g) => g.roles.length > 0);

  const thin = coverage.present / coverage.total < THIN_BASIS;
  // Reasons are only shown for what is being withheld — an explanation attached
  // to every row would be noise, and the two withheld roles are the ones a
  // geologist will otherwise assume the app simply lacks.
  const notScored = rolesInState(coverage, "not_scored");

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.count}>
          {t("field.coverage.count", { present: coverage.present, total: coverage.total })}
        </Text>
        <View style={styles.bar}>
          <View style={[styles.barFill, { flex: Math.max(0.02, coverage.present / coverage.total) }]} />
          <View style={{ flex: Math.max(0.02, 1 - coverage.present / coverage.total) }} />
        </View>
      </View>

      {groups.map((g) => (
        <View key={g.state} style={styles.row}>
          <Text style={[styles.state, stateStyle[g.state]]}>{t(COVERAGE_STATE_KEY(g.state))}</Text>
          <Text style={styles.roles}>
            {g.roles.map((r) => t(ROLE_LABEL_KEY(r))).join(" · ")}
          </Text>
        </View>
      ))}

      {notScored.map((r) => (
        <Text key={r} style={styles.why}>{t(whyKey(r))}</Text>
      ))}

      {thin ? (
        <Text style={styles.thin}>
          {t("field.coverage.thin", { present: coverage.present, total: coverage.total })}
        </Text>
      ) : null}
    </View>
  );
}

/** Only the withheld roles have a stated reason; anything else falls back to none. */
function whyKey(role: EvidenceRole): string {
  return `field.coverage.notScoredWhy.${role}`;
}

const stateStyle: Record<CoverageState, { color: string }> = {
  present: { color: "#22C55E" },
  not_scored: { color: colors.gold },
  none_here: { color: colors.textMuted },
  empty_layer: { color: colors.textFaint },
  no_source: { color: colors.textFaint },
};

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.md, gap: spacing.xs,
  },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  count: { color: colors.text, fontSize: 13, fontWeight: "700" },
  bar: {
    flex: 1, flexDirection: "row", height: 4, borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.10)", overflow: "hidden",
  },
  barFill: { backgroundColor: "#22C55E" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, paddingVertical: 2 },
  state: { fontSize: 11, fontWeight: "700", width: 132 },
  roles: { color: colors.text, fontSize: 12, flex: 1, lineHeight: 17 },
  why: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  thin: {
    color: colors.gold, fontSize: 11, lineHeight: 16,
    marginTop: spacing.xs, fontStyle: "italic",
  },
});

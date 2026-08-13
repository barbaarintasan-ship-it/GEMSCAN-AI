// Field diagnostics — what the app actually believes, right now.
//
// TEMPORARY by request, and ENABLED until explicitly removed (see
// lib/devIndicator.ts). This is a field-testing build: when something looks wrong
// on a hillside, the questions are always the same, and every one of them should
// be answerable without a cable and a laptop:
//
//   Is the GPS wrong, or the target?      → fix, accuracy, lat/lng, target id
//   Did the knowledge pack load?          → version + SHA256
//   Is the tile cache working?            → bytes on disk, tiles painted
//   Is the expedition alive?              → expedition id, session state, queue
//   Did the workspace restart?            → workspace id changing is the proof
//   Have the labels drifted again?        → projection + strips in force
//
// Every value is READ, never computed here. A diagnostics panel that derives its
// own numbers can agree with itself while the app is wrong.
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "../lib/theme";
import { DEV_INDICATOR_ENABLED } from "../lib/devIndicator";

export interface DiagnosticRow {
  label: string;
  value: string;
  /** True when the value is a problem a tester should act on. */
  warn?: boolean;
  /** True when it is the healthy, expected answer. */
  good?: boolean;
}

export function DevDiagnostics({ rows, title }: { rows: DiagnosticRow[]; title: string }) {
  const [open, setOpen] = React.useState(false);
  if (!DEV_INDICATOR_ENABLED) return null;

  const problems = rows.filter((r) => r.warn).length;

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.head} onPress={() => setOpen((v) => !v)}>
        <Ionicons name="bug" size={14} color="#6ED47A" />
        <Text style={styles.title}>{title}</Text>
        {problems > 0 ? <Text style={styles.problems}>{problems}</Text> : null}
        <View style={styles.spacer} />
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.textMuted} />
      </Pressable>

      {open ? (
        <View style={styles.body}>
          {rows.map((r) => (
            <View key={r.label} style={styles.row}>
              <Text style={styles.k}>{r.label}</Text>
              <Text
                selectable
                style={[styles.v, r.warn && styles.warn, r.good && styles.good]}
              >
                {r.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1, borderColor: "rgba(110,212,122,0.4)", borderRadius: radius.lg,
    backgroundColor: "rgba(110,212,122,0.06)", marginBottom: spacing.lg,
    overflow: "hidden",
  },
  head: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  title: { color: "#6ED47A", fontSize: 11, fontWeight: "700", letterSpacing: 0.6 },
  problems: {
    color: "#0B0B0C", backgroundColor: colors.gold, fontSize: 10, fontWeight: "800",
    paddingHorizontal: 6, borderRadius: 8, overflow: "hidden",
  },
  spacer: { flex: 1 },
  body: {
    paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: 3,
    borderTopWidth: 1, borderTopColor: "rgba(110,212,122,0.25)", paddingTop: spacing.sm,
  },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  k: { color: colors.textFaint, fontSize: 10, width: 116 },
  v: { color: colors.text, fontSize: 10, flex: 1, fontFamily: "monospace" },
  warn: { color: colors.gold },
  good: { color: "#6ED47A" },
});

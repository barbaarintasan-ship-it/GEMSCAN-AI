// Your own earlier work, near where you are standing.
//
// The panel that had to exist: a geologist walked back into a valley they had
// worked before, and the app — which held eight photographs and a bagged sample for
// that exact spot — said "No sample recorded". Absence of a panel read as absence
// of evidence.
//
// So the empty case is worded as a MEASUREMENT ("none recorded within 250 m"), not
// as a shrug, and the populated case says what is there: how far, what type,
// whether a sample was taken and what it was called.
//
// CONTEXT ONLY, and the panel says so. This changes no score — the last line is
// there because a list of encouraging past findings sitting under a prospectivity
// number invites exactly the wrong inference.
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../lib/theme";
import {
  summariseNearby, type NearbyWaypoint,
} from "../lib/field/nearbyWaypoints";
import { waypointTypeLabelKey, sampleTypeLabelKey } from "../lib/field/waypointTypes";
import { formatDistance, type TFunc } from "../lib/exploration/format";

/** A date a geologist can place, in the reader's own locale. */
function dateOf(at: number, locale: string): string {
  try {
    return new Date(at).toLocaleDateString(locale === "so" ? "so-SO" : "en-GB", {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch {
    // A locale the platform does not carry must not cost the reader the date.
    return new Date(at).toISOString().slice(0, 10);
  }
}

export function NearbyEvidence({
  near, radiusM, locale, t,
}: {
  near: readonly NearbyWaypoint[];
  radiusM: number;
  locale: string;
  t: TFunc;
}) {
  const radius = formatDistance(t, radiusM);

  if (near.length === 0) {
    // A measurement, not a shrug: nothing WAS recorded within this distance.
    return <Text style={styles.none}>{t("field.nearby.none", { radius })}</Text>;
  }

  const s = summariseNearby(near);

  return (
    <View style={styles.wrap}>
      <Text style={styles.head}>{t("field.nearby.within", { radius })}</Text>
      <Text style={styles.summary}>
        {t("field.nearby.summary", {
          count: s.count,
          photos: s.photoCount,
          samples: s.sampleCount,
          nearest: formatDistance(t, s.nearestM ?? 0),
        })}
      </Text>

      {near.map((w) => (
        <View key={w.id} style={styles.row}>
          <Text style={styles.rowTitle}>
            {t("field.nearby.row", {
              type: t(waypointTypeLabelKey(w.type)),
              distance: formatDistance(t, w.distanceM),
              date: dateOf(w.capturedAt, locale),
            })}
          </Text>
          <Text style={styles.rowDetail}>
            {w.photoCount > 0 ? t("field.nearby.rowPhotos", { count: w.photoCount }) : ""}
            {w.photoCount > 0 && w.sample ? "  ·  " : ""}
            {/* Named outright when there is one. "No sample recorded" over ground
                that has one is the sentence this whole panel exists to prevent. */}
            {w.sample
              ? t("field.nearby.rowSample", {
                  id: w.sample.sampleId,
                  type: t(sampleTypeLabelKey(w.sample.sampleType)),
                })
              : w.photoCount > 0 ? "" : t("field.nearby.rowNoSample")}
          </Text>
        </View>
      ))}

      <Text style={styles.contextOnly}>{t("field.nearby.contextOnly")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.md, gap: 2,
  },
  head: { color: colors.text, fontSize: 13, fontWeight: "700" },
  summary: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginBottom: spacing.xs },
  row: { paddingVertical: 3 },
  rowTitle: { color: colors.text, fontSize: 13, lineHeight: 19 },
  rowDetail: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  none: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  contextOnly: {
    color: colors.textFaint, fontSize: 10, lineHeight: 15,
    marginTop: spacing.xs, fontStyle: "italic",
  },
});

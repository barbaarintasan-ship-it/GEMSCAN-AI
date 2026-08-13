// Enterprise Field Work › Exploration Reports.
//
// Every section a geologist has finished, and where each one has got to. This is
// the destination the workflow never had: an assessment used to be visible only
// inside the live exploration screen, for the CURRENT mission, and walking away
// from the map meant walking away from the report.
//
// WHAT THIS IS NOT
//
// It is not My Samples. A sample is a rock in a bag; a mission is a place that was
// investigated — a target, a walk, observations, photographs and an interpretation
// of the ground. The two are kept apart deliberately, all the way down to which
// providers the AI is allowed to use, and this screen never shows a personal
// sample.
//
// OFFLINE FIRST, like every list in this app. The packages are on the device —
// they were built there — so this reads the local store and never waits on a
// network. What the network adds is the assessment, collected by the sync loop.
import React from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { commodityLabel, localStamp } from "../../../lib/exploration/format";
import type { PhotoStateCounts } from "../../../lib/sync/photoUploadQueue";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius, spacing } from "../../../lib/theme";
import { useExploration } from "../../../lib/exploration/provider";
import { EmptyState } from "../../../components/ui/EmptyState";
import type { EvidencePackage } from "../../../lib/exploration/evidencePackage";

/**
 * Where a mission has got to, as one word.
 *
 * Derived, never stored — the same rule `deliveryOf` follows. Four states, and the
 * distinction that matters most is between "waiting" and "failed": one resolves on
 * its own and one needs somebody to do something.
 */
export type ReportState =
  | "analysed" | "uploading" | "retrying" | "refused" | "waiting" | "failed";

/**
 * Where one report stands, in a word the reader can act on.
 *
 * `uploading` used to swallow three more situations. The queue's `pendingFor`
 * counts every photograph that is not yet in storage, so a refused one and a
 * first attempt arrived here as the same integer, and the pill said "UPLOADING
 * 7" for forty-five minutes over photographs that were never going to move.
 *
 * The order is the priority a geologist would put them in. A refusal needs
 * somebody to do something and never resolves alone, so it outranks a retry;
 * a retry is still working, so it outranks the ones that have not been tried.
 */
export function reportStateOf(
  p: EvidencePackage, c: PhotoStateCounts,
): ReportState {
  if (p.analysis) return "analysed";
  // Before the photo states: a mission the server has already refused is not
  // waiting on anything, whatever its photo queue still says.
  if (p.analysisError) return "failed";
  if (c.blocked > 0) return "refused";
  if (c.failed > 0) return "retrying";
  if (c.pending + c.uploading > 0) return "uploading";
  return "waiting";
}

/** No queue yet, or nothing of this mission in it. */
const NO_PHOTOS: PhotoStateCounts = {
  pending: 0, uploading: 0, uploaded: 0, failed: 0, blocked: 0,
};

export default function ExplorationReportsScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { packages, photoUploads } = useExploration();
  const [rows, setRows] = React.useState<EvidencePackage[]>([]);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!packages) return;
    await packages.load();
    // Newest first: the section just finished is the one being looked for.
    setRows([...packages.all()].sort((a, b) => b.completedAt - a.completedAt));
  }, [packages]);

  React.useEffect(() => {
    void load();
    // The store notifies when the sync loop attaches an assessment, so a report
    // that arrives while this screen is open appears without a pull-to-refresh.
    return packages?.subscribe(() => { void load(); });
  }, [packages, load]);

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{t("reports.title")}</Text>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(p) => p.id}
        contentContainerStyle={rows.length === 0 ? styles.emptyWrap : styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gold} />}
        ListEmptyComponent={
          <EmptyState
            icon="document-text-outline"
            title={t("reports.emptyTitle")}
            hint={t("reports.emptyBody")}
          />
        }
        renderItem={({ item }) => (
          <ReportRow
            pkg={item}
            photos={photoUploads?.countsFor(item.missionId) ?? NO_PHOTOS}
            t={t}
          />
        )}
      />
    </View>
  );
}

function ReportRow({
  pkg, photos, t,
}: { pkg: EvidencePackage; photos: PhotoStateCounts; t: (k: string, p?: Record<string, unknown>) => string }) {
  const state = reportStateOf(pkg, photos);
  const date = localStamp(pkg.completedAt, false);

  return (
    <Pressable
      style={styles.row}
      onPress={() => router.push(`/(app)/enterprise/report/${pkg.missionId}`)}
      accessibilityRole="button"
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {pkg.commodity ? commodityLabel(pkg.commodity) : t("reports.universal")}
          {"  ·  "}
          <Text style={styles.rowCell}>{pkg.targetCell}</Text>
        </Text>
        <Text style={styles.rowMeta}>
          {date}
          {"  ·  "}
          {t("reports.observations", { n: pkg.observations.length })}
          {"  ·  "}
          {t("reports.photos", { n: pkg.observations.reduce((s, o) => s + o.photos.length, 0) })}
        </Text>
      </View>
      <StatePill state={state} photos={photos} t={t} />
    </Pressable>
  );
}

function StatePill({
  state, photos, t,
}: { state: ReportState; photos: PhotoStateCounts; t: (k: string, p?: Record<string, unknown>) => string }) {
  const style =
    state === "analysed" ? styles.pillDone
      : state === "failed" ? styles.pillFailed
        : styles.pillWaiting;
  const label =
    state === "analysed" ? t("reports.state.analysed")
      : state === "failed" ? t("reports.state.failed")
        : state === "refused" ? t("reports.state.refused", { n: photos.blocked })
          : state === "retrying" ? t("reports.state.retrying", { n: photos.failed })
            : state === "uploading"
              ? t("reports.state.uploading", { n: photos.pending + photos.uploading })
              : t("reports.state.waiting");
  return (
    <View style={[styles.pill, style]}>
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },
  list: { padding: spacing.md, gap: spacing.sm },
  emptyWrap: { flexGrow: 1, justifyContent: "center", padding: spacing.xl },
  row: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: spacing.md,
  },
  rowMain: { flex: 1, gap: 3 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
  rowCell: { color: colors.textMuted, fontSize: 12, fontWeight: "400" },
  rowMeta: { color: colors.textMuted, fontSize: 11 },
  pill: {
    borderRadius: radius.pill, borderWidth: 1,
    paddingVertical: 3, paddingHorizontal: spacing.sm,
  },
  pillDone: { borderColor: "#22C55E", backgroundColor: "rgba(34,197,94,0.14)" },
  pillWaiting: { borderColor: colors.border },
  pillFailed: { borderColor: "#EF4444", backgroundColor: "rgba(239,68,68,0.12)" },
  pillText: { color: colors.text, fontSize: 10, fontWeight: "700" },
});

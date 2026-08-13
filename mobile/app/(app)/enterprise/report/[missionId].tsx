// One mission's field report.
//
// Everything on this screen is rendered from the package the device already holds
// plus the findings the sync loop collected. No network read: a geologist reads a
// report in the field, on the drive back, on a plane — and the whole point of
// storing the package verbatim was that an assessment months later can be read
// against exactly what was submitted.
//
// The report itself is `AIGeologistReport`, unchanged — the same component the
// live map shows for the mission in progress. One renderer, so a report cannot
// say one thing here and another there.
//
// The ENGINE's prospectivity score is passed in from the package. The analysis
// never carries one, and this screen never computes one.
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { commodityLabel, localStamp } from "../../../../lib/exploration/format";
import { shareExplorationReportPdf } from "../../../../lib/explorationReportPdf";
import { colors, radius, spacing } from "../../../../lib/theme";
import { useExploration } from "../../../../lib/exploration/provider";
import { AIGeologistReport } from "../../../../components/AIGeologistReport";
import type { EvidencePackage } from "../../../../lib/exploration/evidencePackage";
import type { ReportLanguage } from "../../../../../shared/geo-core/gie/renderReport";
import type { Mission } from "../../../../lib/exploration/mission";

export default function MissionReportScreen() {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const { missionId } = useLocalSearchParams<{ missionId: string }>();
  const { packages, photoUploads } = useExploration();
  const [pkg, setPkg] = React.useState<EvidencePackage | null>(null);

  const load = React.useCallback(async () => {
    if (!packages || !missionId) return;
    await packages.load();
    setPkg(packages.all().find((p) => p.missionId === missionId) ?? null);
  }, [packages, missionId]);

  React.useEffect(() => {
    void load();
    return packages?.subscribe(() => { void load(); });
  }, [packages, load]);

  const photosPending = photoUploads?.pendingFor(missionId ?? "").length ?? 0;
  const photos = photoUploads?.countsFor(missionId ?? "") ?? null;
  const lang = (i18n.language?.startsWith("so") ? "so" : "en") as ReportLanguage;
  const stalled = (photos?.failed ?? 0) + (photos?.blocked ?? 0);
  const [retrying, setRetrying] = React.useState(false);

  // The geologist pressing this means one thing — "go on then" — so it covers
  // refusals and failures alike and does not ask them to know the difference.
  const [sharing, setSharing] = React.useState(false);
  // Only offered once there is an assessment: a PDF of "awaiting analysis" is a
  // document that says nothing, sent to somebody who was waiting for something.
  const onSharePdf = React.useCallback(async () => {
    if (!pkg?.analysis) return;
    setSharing(true);
    try { await shareExplorationReportPdf(pkg, t as never, lang); } catch { /* the sheet was dismissed */ }
    finally { setSharing(false); }
  }, [pkg, t, lang]);

  const onRetry = React.useCallback(async () => {
    if (!photoUploads || !missionId) return;
    setRetrying(true);
    try { await photoUploads.retryNow(missionId); } finally { setRetrying(false); }
  }, [photoUploads, missionId]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{t("reports.oneTitle")}</Text>
      </View>

      {pkg == null ? (
        <View style={styles.centre}>
          <Text style={styles.muted}>{t("reports.notFound")}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {/* ── 1. Overview ──────────────────────────────────────────────── */}
          <Section title={t("report.section.overview")}>
            <Field label={t("reports.field.date")} value={localStamp(pkg.completedAt)} />
            <Field label={t("reports.field.target")} value={pkg.targetCell} />
            <Field
              label={t("reports.field.position")}
              value={`${pkg.targetCentre.lat.toFixed(5)}, ${pkg.targetCentre.lng.toFixed(5)}`}
            />
            <Field
              label={t("reports.field.commodity")}
              value={pkg.commodity ? commodityLabel(pkg.commodity) : t("reports.universal")}
            />
            <Field label={t("reports.field.mission")} value={pkg.missionId} />
            <Field
              label={t("reports.field.collected")}
              value={t("reports.collectedSummary", {
                obs: pkg.observations.length,
                photos: pkg.observations.reduce((s, o) => s + o.photos.length, 0),
                track: pkg.track.length,
              })}
            />
          </Section>

          {/* WHAT IT IS WAITING FOR.
              Shown only when there is something to say. For three hours this
              screen said "awaiting analysis" while the server answered every
              sixty seconds; the answer was recorded nowhere the geologist could
              reach it. */}
          {pkg.analysisNote || stalled > 0 ? (
            <Section title={t("report.section.delivery")}>
              {pkg.analysisNote ? (
                <Field label={t("reports.field.lastAnswer")} value={pkg.analysisNote} />
              ) : null}
              {photos ? (
                <Field
                  label={t("reports.field.photoStates")}
                  value={
                    `${photos.uploaded} uploaded · ${photos.pending + photos.uploading} pending` +
                    (photos.failed ? ` · ${photos.failed} failed` : "") +
                    (photos.blocked ? ` · ${photos.blocked} refused` : "")
                  }
                />
              ) : null}
              {stalled > 0 ? (
                <Pressable style={styles.retry} onPress={() => void onRetry()} disabled={retrying}>
                  <Text style={styles.retryText}>
                    {retrying ? t("reports.retrying") : t("reports.retryPhotos", { n: stalled })}
                  </Text>
                </Pressable>
              ) : null}
            </Section>
          ) : null}

          {/* The findings, rendered from codes into the reader's language. */}
          <AIGeologistReport
            mission={{ id: pkg.missionId, state: "ai_analysis_complete" } as Mission}
            findings={pkg.analysis}
            prospectivityScore={pkg.prospectivityScore}
            photosPending={photosPending}
            analysisError={pkg.analysisError ?? null}
            appLanguage={lang}
            t={t as never}
          />

          {/* THE REPORT LEAVES THE PHONE. The person who sent the coordinate and
              the photographs is usually not the person holding this device. */}
          {pkg.analysis ? (
            <Pressable
              style={styles.share}
              onPress={() => void onSharePdf()}
              disabled={sharing}
              accessibilityRole="button"
            >
              <Ionicons name="share-outline" size={16} color={colors.bg} />
              <Text style={styles.shareText}>
                {sharing ? t("reports.sharePdf") : t("reports.exportPdf")}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  share: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: spacing.xs, marginTop: spacing.lg, paddingVertical: spacing.md,
    borderRadius: radius.md, backgroundColor: colors.gold,
  },
  shareText: { color: colors.bg, fontWeight: "800", fontSize: 14 },
  retry: {
    marginTop: spacing.sm, paddingVertical: spacing.sm, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.gold, alignItems: "center",
  },
  retryText: { color: colors.gold, fontWeight: "700", fontSize: 13 },
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.3, flex: 1 },
  centre: { flex: 1, alignItems: "center", justifyContent: "center" },
  muted: { color: colors.textMuted, fontSize: 13 },
  body: { padding: spacing.md, gap: spacing.md },
  section: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: spacing.md, gap: spacing.xs,
  },
  sectionTitle: {
    color: colors.gold, fontSize: 11, fontWeight: "800", letterSpacing: 0.6,
    marginBottom: spacing.xs,
  },
  field: { flexDirection: "row", gap: spacing.sm },
  fieldLabel: { color: colors.textMuted, fontSize: 12, width: 92 },
  fieldValue: { color: colors.text, fontSize: 12, flex: 1 },
});

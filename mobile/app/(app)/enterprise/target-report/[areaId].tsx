// Target Report — Phase 14 (Unified Target Report).
//
// A single, shareable document assembling what Phase 7 (AI cross-contributor
// synthesis), Phase 10 (evidence graph) and Phase 11 (human review) already
// produced for one target. PURE AGGREGATION — nothing here computes a score
// or narrates anything new; see target-report/handler.ts's own header note.
// Not the future Phase 15+ region-wide discovery, not a new scoring engine.
import React, { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Alert, Share } from "react-native";
import { router, useLocalSearchParams, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing, radius } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { SectionLabel } from "../../../../components/ui/SectionLabel";
import { bandFor } from "../../../../../shared/geo-core/confidence.ts";
import { fetchTargetReport, computeAreaSpectralIndex, type TargetReport } from "../../../../lib/enterprise/missions";

const STATUS_LABEL: Record<string, { en: string; so: string }> = {
  pending: { en: "Pending review", so: "Sugaya dib-u-eegis" },
  accepted: { en: "Accepted", so: "La aqbalay" },
  rejected: { en: "Rejected", so: "La diiday" },
  needs_more_data: { en: "Needs more data", so: "U baahan xog dheeraad ah" },
};

function reportAsText(r: TargetReport, so: boolean): string {
  const lines: string[] = [];
  lines.push(`${so ? "WARBIXIN BARTILMAAMEED" : "TARGET REPORT"}: ${r.area.name}`);
  lines.push(`${so ? "Xaaladda" : "Status"}: ${STATUS_LABEL[r.area.review_status]?.[so ? "so" : "en"] ?? r.area.review_status}`);
  if (r.target.target_h3) lines.push(`H3: ${r.target.target_h3}`);
  if (r.target.score != null) lines.push(`${so ? "Isku-dhaf" : "Score"}: ${Math.round(r.target.score * 100)}/100`);
  if (r.target.reasons?.length) {
    lines.push(so ? "Sababaha:" : "Reasons:");
    for (const reason of r.target.reasons) lines.push(`  - ${JSON.stringify(reason)}`);
  }
  if (r.ai_synthesis) {
    lines.push(so ? "Isbarbardhig AI:" : "AI cross-check:");
    lines.push(`  ${so ? r.ai_synthesis.narrative_so ?? r.ai_synthesis.narrative : r.ai_synthesis.narrative}`);
  }
  if (r.area.review_notes) lines.push(`${so ? "Fiiro" : "Notes"}: ${r.area.review_notes}`);
  return lines.join("\n");
}

export default function TargetReportScreen() {
  const { areaId, missionId } = useLocalSearchParams<{ areaId: string; missionId: string }>();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<TargetReport | null>(null);
  const [spectralLoading, setSpectralLoading] = useState(false);

  const load = useCallback(async () => {
    if (!areaId || !missionId) return;
    setLoading(true);
    try {
      const r = await fetchTargetReport(missionId, areaId);
      setReport(r);
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [areaId, missionId, so]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const band = report?.target.score != null ? bandFor(report.target.score) : null;

  async function handleAnalyzeSpectral() {
    if (!areaId || !missionId) return;
    setSpectralLoading(true);
    try {
      const result = await computeAreaSpectralIndex(missionId, areaId);
      setReport((prev) => (prev ? { ...prev, spectral: result } : prev));
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setSpectralLoading(false);
    }
  }

  async function handleShare() {
    if (!report) return;
    try {
      await Share.share({ message: reportAsText(report, so) });
    } catch {
      // user-cancelled or platform share failure — not worth surfacing
    }
  }

  if (loading || !report) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.centerFill}><ActivityIndicator color={colors.gold} /></View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{report.area.name}</Text>
        <Pressable onPress={handleShare} hitSlop={10}>
          <Ionicons name="share-outline" size={22} color={colors.gold} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Card style={styles.card}>
          <Text style={styles.statusText}>
            {STATUS_LABEL[report.area.review_status]?.[so ? "so" : "en"] ?? report.area.review_status}
          </Text>
          {report.area.reviewed_at && (
            <Text style={styles.mutedText}>
              {so ? "Dib loo eegay: " : "Reviewed: "}{new Date(report.area.reviewed_at).toLocaleString()}
            </Text>
          )}
        </Card>

        {report.target.target_h3 && (
          <>
            <SectionLabel>{so ? "Bartilmaameedka" : "Target"}</SectionLabel>
            <Card style={styles.card}>
              <Text style={styles.h3Text}>{report.target.target_h3}</Text>
              {report.target.score != null && (
                <Text style={[styles.scoreValue, band === "High" && styles.bandHigh, band === "Moderate" && styles.bandModerate]}>
                  {Math.round(report.target.score * 100)}/100 · {band}
                </Text>
              )}
              {report.target.integrated_score != null && (
                <Text style={styles.mutedText}>
                  {so ? "Isku-dhaf (caddeyn la geliyay): " : "Integrated: "}{Math.round(report.target.integrated_score * 100)}/100
                </Text>
              )}
            </Card>
          </>
        )}

        {report.target.reasons && report.target.reasons.length > 0 && (
          <>
            <SectionLabel>{so ? "Sababaha" : "Reasons"}</SectionLabel>
            <Card style={styles.card}>
              {report.target.reasons.map((r: any, i: number) => (
                <Text key={i} style={styles.evidenceText}>• {JSON.stringify(r)}</Text>
              ))}
            </Card>
          </>
        )}

        {report.ai_synthesis && (
          <>
            <SectionLabel>{so ? "Isbarbardhig AI (Cross-check)" : "AI Cross-check"}</SectionLabel>
            <Card style={styles.card}>
              <Text style={styles.synthesisHeadline}>
                {so ? report.ai_synthesis.headline_so ?? report.ai_synthesis.headline : report.ai_synthesis.headline}
              </Text>
              <Text style={styles.evidenceText}>
                {so ? report.ai_synthesis.narrative_so ?? report.ai_synthesis.narrative : report.ai_synthesis.narrative}
              </Text>
              <Text style={styles.mutedText}>
                {report.ai_synthesis.contributor_count} {so ? "wax-ka-qeybgale" : "contributor(s)"} · {report.ai_synthesis.agreement}
              </Text>
            </Card>
          </>
        )}

        <SectionLabel>{so ? "Falanqaynta Satellite-ka (Iron Oxide)" : "Satellite Analysis (Iron Oxide)"}</SectionLabel>
        <Card style={styles.card}>
          {report.spectral ? (
            <>
              {report.spectral.value != null ? (
                <Text style={styles.scoreValue}>{report.spectral.value.toFixed(2)}</Text>
              ) : (
                <Text style={styles.mutedText}>
                  {so ? "Ma jirto sawir cirbir-la'aan ah oo la helay" : "No cloud-free acquisition available"}
                </Text>
              )}
              <Text style={styles.mutedText}>
                {so ? "Taariikhda: " : "Acquisition: "}{report.spectral.acquisition_date}
                {report.spectral.cloud_fraction != null && `  ·  ${so ? "Daruur" : "Cloud"} ${Math.round(report.spectral.cloud_fraction * 100)}%`}
              </Text>
              <Text style={styles.mutedText}>{report.spectral.source} · {report.spectral.resolution_m}m</Text>
              <Text style={styles.mutedText}>
                {so
                  ? "Macluumaad kaliya — kuma jirto isku-dhafka rasmiga ah."
                  : "Informational only — not part of the deterministic score."}
              </Text>
              <Button
                title={spectralLoading ? "…" : (so ? "Cusboonaysii" : "Refresh")}
                variant="outline"
                onPress={handleAnalyzeSpectral}
                disabled={spectralLoading}
                style={styles.shareButton}
              />
            </>
          ) : (
            <>
              <Text style={styles.mutedText}>
                {so
                  ? "Weli lama falanqeynin sawirka satellite-ka ee goobtan."
                  : "This target hasn't been analyzed via satellite imagery yet."}
              </Text>
              <Button
                title={spectralLoading ? "…" : (so ? "Falanqee Satellite-ka" : "Analyze via Satellite")}
                variant="outline"
                onPress={handleAnalyzeSpectral}
                disabled={spectralLoading}
                style={styles.shareButton}
              />
            </>
          )}
        </Card>

        {report.area.review_notes && (
          <>
            <SectionLabel>{so ? "Fiiro dib-u-eegis" : "Review notes"}</SectionLabel>
            <Card style={styles.card}>
              <Text style={styles.evidenceText}>{report.area.review_notes}</Text>
            </Card>
          </>
        )}

        <Button
          title={so ? "Wadaag Warbixinta" : "Share Report"}
          variant="outline"
          onPress={handleShare}
          style={styles.shareButton}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.3, flex: 1 },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: 60 },
  card: { gap: 4, marginBottom: spacing.sm },
  statusText: { color: colors.gold, fontSize: 16, fontWeight: "800" },
  mutedText: { color: colors.textFaint, fontSize: 12, fontStyle: "italic" },
  h3Text: { color: colors.text, fontSize: 14, fontWeight: "700" },
  scoreValue: { color: colors.text, fontSize: 18, fontWeight: "800" },
  bandModerate: { color: colors.gold },
  bandHigh: { color: colors.gold },
  evidenceText: { color: colors.textMuted, fontSize: 12, marginBottom: 2 },
  synthesisHeadline: { color: colors.text, fontSize: 13, fontWeight: "700" },
  shareButton: { marginTop: spacing.md },
});

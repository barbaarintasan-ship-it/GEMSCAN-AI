// Area Review — Phase 11 (Geological Intelligence Transformation).
//
// A minimal Team review screen: a manager opens a mission area, sees the
// SAME deterministic evidence Phase 10 already persisted (score, reasons,
// coverage, positive/negative evidence) plus any saved AI cross-check, and
// records accept/reject/needs-more-data. Nothing here computes a score or
// calls an AI model — review-area's own header note is the authority on
// what this screen is and is not (not the Phase 14 Target Report).
import React, { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Alert } from "react-native";
import { router, useLocalSearchParams, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing, radius } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { SectionLabel } from "../../../../components/ui/SectionLabel";
import { bandFor } from "../../../../../shared/geo-core/confidence.ts";
import {
  fetchAreaReviewDetail, reviewArea, fetchAreaGeologicalAnalogues,
  type AreaReviewDetail, type AreaReviewStatus, type AreaAnaloguesResult,
} from "../../../../lib/enterprise/missions";

const STATUS_LABEL: Record<AreaReviewStatus, { en: string; so: string }> = {
  pending: { en: "Pending review", so: "Sugaya dib-u-eegis" },
  accepted: { en: "Accepted", so: "La aqbalay" },
  rejected: { en: "Rejected", so: "La diiday" },
  needs_more_data: { en: "Needs more data", so: "U baahan xog dheeraad ah" },
};

export default function AreaReviewScreen() {
  const { areaId, missionId } = useLocalSearchParams<{ areaId: string; missionId: string }>();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<AreaReviewDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState<AreaReviewStatus | null>(null);
  // Phase 13 — fetched lazily (an explicit tap, not on screen load): a real
  // read, but no reason to pay for it before the manager asks.
  const [analogues, setAnalogues] = useState<AreaAnaloguesResult | null>(null);
  const [loadingAnalogues, setLoadingAnalogues] = useState(false);

  const load = useCallback(async () => {
    if (!areaId || !missionId) return;
    setLoading(true);
    try {
      const d = await fetchAreaReviewDetail(missionId, areaId);
      setDetail(d);
      setNotes(d.reviewNotes ?? "");
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [areaId, missionId, so]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const bestCell = useMemo(() => detail?.cells[0] ?? null, [detail]);
  const band = bestCell?.prospectivity_score != null ? bandFor(bestCell.prospectivity_score) : null;

  // Negative/confirmed-absent evidence (Phase 10.3) is any item with
  // polarity:"negative" — shown separately so a manager sees disconfirming
  // findings as clearly as supporting ones, never silently folded together.
  const positiveEvidence = (bestCell?.evidence ?? []).filter((e: any) => e.reason?.polarity !== "negative" && (e as any).polarity !== "negative");
  const negativeEvidence = (bestCell?.evidence ?? []).filter((e: any) => (e as any).polarity === "negative");

  async function handleLoadAnalogues() {
    if (!areaId || !missionId) return;
    setLoadingAnalogues(true);
    try {
      const r = await fetchAreaGeologicalAnalogues(missionId, areaId);
      setAnalogues(r);
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setLoadingAnalogues(false);
    }
  }

  async function handleDecision(decision: Exclude<AreaReviewStatus, "pending">) {
    if (!areaId || !missionId) return;
    setSubmitting(decision);
    try {
      // Server response is authoritative — local state is only ever set
      // AFTER the RPC succeeds, never optimistically ahead of it.
      const result = await reviewArea(missionId, areaId, decision, notes.trim() || undefined);
      setDetail((prev) => prev ? {
        ...prev, reviewStatus: result.reviewStatus, reviewedBy: result.reviewedBy, reviewedAt: result.reviewedAt,
        reviewNotes: notes.trim() || null,
      } : prev);
      Alert.alert(
        so ? "Waa la keydiyay" : "Saved",
        so ? `Xaaladda dib-u-eegista: ${STATUS_LABEL[result.reviewStatus].so}` : `Review status: ${STATUS_LABEL[result.reviewStatus].en}`,
      );
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setSubmitting(null);
    }
  }

  if (loading || !detail) {
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
        <Text style={styles.title} numberOfLines={1}>{detail.name}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Card style={styles.statusCard}>
          <Text style={styles.statusLabel}>{so ? "Xaaladda hadda" : "Current status"}</Text>
          <Text style={[styles.statusValue, statusColorStyle(detail.reviewStatus)]}>
            {STATUS_LABEL[detail.reviewStatus][so ? "so" : "en"]}
          </Text>
          {detail.reviewedAt && (
            <Text style={styles.mutedText}>
              {so ? "Dib loo eegay: " : "Reviewed: "}{new Date(detail.reviewedAt).toLocaleString()}
              {detail.reviewerRole ? ` (${detail.reviewerRole})` : ""}
            </Text>
          )}
        </Card>

        {detail.sourceTargetH3 && (
          <>
            <SectionLabel>{so ? "Bartilmaameedka (H3)" : "Target (H3)"}</SectionLabel>
            <Card style={styles.card}>
              <Text style={styles.h3Text}>{detail.sourceTargetH3}</Text>
              {detail.sourceCommodity && (
                <Text style={styles.mutedText}>{so ? "Macdanta: " : "Commodity: "}{detail.sourceCommodity}</Text>
              )}
            </Card>
          </>
        )}

        <SectionLabel>{so ? "Isku-dhafan deterministic ah" : "Deterministic score"}</SectionLabel>
        <Card style={styles.card}>
          {bestCell?.prospectivity_score != null ? (
            <>
              <Text style={[styles.scoreValue, band === "High" && styles.bandHigh, band === "Moderate" && styles.bandModerate]}>
                {Math.round(bestCell.prospectivity_score * 100)}/100 · {band}
              </Text>
              {bestCell.integrated_score != null && (
                <Text style={styles.mutedText}>
                  {so ? "Isku-dhafan (caddeyn la geliyay): " : "Integrated (with evidence): "}
                  {Math.round(bestCell.integrated_score * 100)}/100 · {bestCell.evidence_sample_count} {so ? "muunad" : "sample(s)"}
                </Text>
              )}
            </>
          ) : (
            <Text style={styles.mutedText}>{so ? "Weli lama qiimeynin." : "Not scored yet."}</Text>
          )}
        </Card>

        {bestCell?.coverage && (
          <>
            <SectionLabel>{so ? "Daboolka xogta (Coverage)" : "Data coverage"}</SectionLabel>
            <Card style={styles.card}>
              <Text style={styles.mutedText}>
                {so
                  ? `${bestCell.coverage.present}/${bestCell.coverage.total} nooc oo caddeyn ah ayaa la helay.`
                  : `${bestCell.coverage.present}/${bestCell.coverage.total} evidence roles present.`}
              </Text>
              {bestCell.coverage.unavailable.length > 0 && (
                <Text style={styles.mutedText}>
                  {so ? "Xog maqan: " : "Unavailable: "}{bestCell.coverage.unavailable.join(", ")}
                </Text>
              )}
            </Card>
          </>
        )}

        {bestCell?.reasons && bestCell.reasons.length > 0 && (
          <>
            <SectionLabel>{so ? "Sababaha" : "Reasons"}</SectionLabel>
            <Card style={styles.card}>
              {bestCell.reasons.map((r: any, i: number) => (
                <Text key={i} style={styles.reasonText}>• {JSON.stringify(r)}</Text>
              ))}
            </Card>
          </>
        )}

        {positiveEvidence.length > 0 && (
          <>
            <SectionLabel>{so ? "Caddeyn taageereysa" : "Supporting evidence"}</SectionLabel>
            <Card style={styles.card}>
              {positiveEvidence.map((e: any, i: number) => (
                <Text key={i} style={styles.evidenceText}>• {e.item?.statement ?? JSON.stringify(e)}</Text>
              ))}
            </Card>
          </>
        )}

        {negativeEvidence.length > 0 && (
          <>
            <SectionLabel>{so ? "Caddeyn taban (la hubiyay, lama helin)" : "Negative evidence (checked, absent)"}</SectionLabel>
            <Card style={[styles.card, styles.negativeCard]}>
              {negativeEvidence.map((e: any, i: number) => (
                <Text key={i} style={styles.evidenceText}>• {e.item?.statement ?? JSON.stringify(e)}</Text>
              ))}
            </Card>
          </>
        )}

        <SectionLabel>{so ? "Aagagga la mid ah (Analogues)" : "Known analogues"}</SectionLabel>
        <Card style={styles.card}>
          {!analogues ? (
            <Pressable style={styles.analoguesFetchBtn} onPress={handleLoadAnalogues} disabled={loadingAnalogues}>
              {loadingAnalogues
                ? <ActivityIndicator color={colors.gold} size="small" />
                : <Text style={styles.analoguesFetchBtnText}>{so ? "Raadi aagagga la mid ah" : "Find known analogues"}</Text>}
            </Pressable>
          ) : analogues.analogues.length === 0 ? (
            <Text style={styles.mutedText}>
              {analogues.note ?? (so ? "Wax aagag la mid ah ah lama helin." : "No known analogues found.")}
            </Text>
          ) : (
            <>
              {analogues.analogues.map((a, i) => (
                <Text key={i} style={styles.evidenceText}>
                  • {a.name ?? (so ? "Magac lama helin" : "Unnamed")} — {a.commodity_key}
                  {a.deposit_type ? ` (${a.deposit_type})` : ""}
                </Text>
              ))}
              {!analogues.deposit_style_ontology_populated && (
                <Text style={styles.mutedText}>{analogues.note}</Text>
              )}
            </>
          )}
        </Card>

        <SectionLabel>{so ? "Fiiro dib-u-eegis (ikhtiyaari)" : "Review notes (optional)"}</SectionLabel>
        <TextInput
          style={styles.notesInput}
          placeholder={so ? "Sababta geologiga ah ee go'aankan..." : "Geological rationale for this decision..."}
          placeholderTextColor={colors.textFaint}
          value={notes}
          onChangeText={setNotes}
          multiline
        />

        <View style={styles.actionsRow}>
          <Button
            title={so ? "Aqbal" : "Accept"}
            loading={submitting === "accepted"}
            disabled={submitting != null}
            onPress={() => handleDecision("accepted")}
            style={styles.actionButton}
          />
          <Button
            title={so ? "Xog dheeraad ah" : "Needs more data"}
            variant="outline"
            loading={submitting === "needs_more_data"}
            disabled={submitting != null}
            onPress={() => handleDecision("needs_more_data")}
            style={styles.actionButton}
          />
          <Button
            title={so ? "Diid" : "Reject"}
            variant="outline"
            loading={submitting === "rejected"}
            disabled={submitting != null}
            onPress={() => handleDecision("rejected")}
            style={styles.actionButton}
          />
        </View>
      </ScrollView>
    </View>
  );
}

function statusColorStyle(status: AreaReviewStatus) {
  if (status === "accepted") return styles.statusAccepted;
  if (status === "rejected") return styles.statusRejected;
  if (status === "needs_more_data") return styles.statusNeedsData;
  return styles.statusPending;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.3, flexShrink: 1 },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: 60 },
  card: { gap: 4, marginBottom: spacing.sm },
  statusCard: { gap: 4, marginBottom: spacing.sm },
  statusLabel: { color: colors.textFaint, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  statusValue: { fontSize: 16, fontWeight: "800" },
  statusPending: { color: colors.textMuted },
  statusAccepted: { color: colors.gold },
  statusRejected: { color: "#c0392b" },
  statusNeedsData: { color: "#c9a227" },
  mutedText: { color: colors.textFaint, fontSize: 12, fontStyle: "italic" },
  h3Text: { color: colors.text, fontSize: 14, fontWeight: "700" },
  scoreValue: { color: colors.text, fontSize: 18, fontWeight: "800" },
  bandModerate: { color: colors.gold },
  bandHigh: { color: colors.gold },
  reasonText: { color: colors.textMuted, fontSize: 12, marginBottom: 2 },
  evidenceText: { color: colors.textMuted, fontSize: 12, marginBottom: 2 },
  negativeCard: { borderWidth: 1, borderColor: "#c0392b33" },
  analoguesFetchBtn: { paddingVertical: 6, alignItems: "flex-start" },
  analoguesFetchBtnText: { color: colors.gold, fontWeight: "700", fontSize: 13 },
  notesInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.text, fontSize: 14,
    minHeight: 70, textAlignVertical: "top", marginBottom: spacing.md,
  },
  actionsRow: { gap: spacing.sm },
  actionButton: { marginBottom: 0 },
});

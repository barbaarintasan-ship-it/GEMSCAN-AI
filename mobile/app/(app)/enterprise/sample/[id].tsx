// Enterprise › Sample Details (Sprint 4.2 owner beta).
// Read-only view of one submitted sample (GET /enterprise-samples/:id,
// RLS-scoped). Shows GPS, photos, minerals and rock/field notes — enough to
// confirm the submission round-tripped. No edit/verify/community actions.
import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Image, RefreshControl, Pressable, Alert } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../../lib/supabase";
import { colors, spacing, radius, type as t } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { SectionLabel } from "../../../../components/ui/SectionLabel";
import { getSample, reanalyzeSample, type SampleDetail, type AssessmentEvidence } from "../../../../lib/enterpriseSamples";

export default function SampleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const [sample, setSample] = useState<SampleDetail | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const s = await getSample(String(id));
      setSample(s);
      // Photos are private — resolve short-lived signed URLs for display.
      const map: Record<string, string> = {};
      for (const m of s.sample_media ?? []) {
        const { data } = await supabase.storage.from("scan-images").createSignedUrl(m.storage_path, 3600);
        if (data?.signedUrl) map[m.id] = data.signedUrl;
      }
      setThumbs(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sample.");
    } finally {
      isRefresh ? setRefreshing(false) : setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Force a fresh AI re-analysis (picks up newly loaded data, e.g. MRDS).
  const onReanalyze = useCallback(async () => {
    setReanalyzing(true);
    try {
      await reanalyzeSample(String(id));
      Alert.alert(
        so ? "Dib-u-falanqayn bilaabatay" : "Re-analysis started",
        so ? "AI-gu wuu dib u xisaabinayaa. Daqiiqad ka dib hoos u jiid si aad u aragto natiijada cusub." : "The AI is re-analyzing. Pull to refresh in a moment to see the updated result.",
      );
    } catch (e) {
      Alert.alert("Re-analyze failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setReanalyzing(false);
    }
  }, [id, so]);

  if (loading) return <View style={styles.center}><ActivityIndicator color={colors.gold} /></View>;
  if (error || !sample) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={40} color={colors.danger} />
        <Text style={styles.errText}>{error ?? "Sample not found."}</Text>
      </View>
    );
  }

  const loc = sample.sample_location?.[0];
  const rock = sample.rock_observation?.[0];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.gold} />}
    >
      <Text style={styles.title}>{sample.name || `Sample ${sample.id.slice(0, 8)}`}</Text>
      <Text style={styles.subtitle}>Collected {new Date(sample.collected_at).toLocaleString()}</Text>

      <View style={styles.badges}>
        <Badge label={statusLabel(sample.status)} />
        {sample.ai_confidence != null && <Badge label={`AI ${Math.round(sample.ai_confidence)}%`} />}
        {sample.geologist_confidence != null && <Badge label={`Geologist ${Math.round(sample.geologist_confidence)}%`} />}
        {sample.completeness_score != null && <Badge label={`${Math.round(sample.completeness_score)}/100 complete`} />}
      </View>

      {loc && (
        <>
          <SectionLabel>Location</SectionLabel>
          <Card>
            <Row icon="location" text={`${loc.h3_cell}`} />
            {loc.gps_accuracy_m != null && <Row icon="navigate-outline" text={`±${loc.gps_accuracy_m} m`} />}
            {loc.altitude_m != null && <Row icon="trending-up-outline" text={`${loc.altitude_m} m altitude`} />}
            <Row icon="ellipse-outline" text={`source: ${loc.provenance}`} />
          </Card>
        </>
      )}

      {sample.sample_media?.length > 0 && (
        <>
          <SectionLabel>Photos ({sample.sample_media.length})</SectionLabel>
          <View style={styles.photoRow}>
            {sample.sample_media.map((m) =>
              thumbs[m.id] ? (
                <Image key={m.id} source={{ uri: thumbs[m.id] }} style={styles.thumb} />
              ) : (
                <View key={m.id} style={[styles.thumb, styles.thumbPlaceholder]}>
                  <Ionicons name="image-outline" size={20} color={colors.textFaint} />
                </View>
              ),
            )}
          </View>
        </>
      )}

      {sample.mineral_observation?.length > 0 && (
        <>
          <SectionLabel>Minerals</SectionLabel>
          <View style={styles.chips}>
            {sample.mineral_observation.map((m, i) => (
              <View key={i} style={styles.chip}><Text style={styles.chipText}>{m.mineral}</Text></View>
            ))}
          </View>
        </>
      )}

      {(rock?.rock_class || rock?.notes) && (
        <>
          <SectionLabel>Host rock</SectionLabel>
          <Card>
            {rock?.rock_class && <Text style={styles.bodyText}>{rock.rock_class}</Text>}
            {rock?.notes && <Text style={[styles.bodyText, { color: colors.textMuted, marginTop: 4 }]}>{rock.notes}</Text>}
          </Card>
        </>
      )}

      {sample.field_observations && (
        <>
          <SectionLabel>Field notes</SectionLabel>
          <Card><Text style={styles.bodyText}>{sample.field_observations}</Text></Card>
        </>
      )}

      {/* AI Geological Assessment (§6/§7/§10/§11) */}
      <View style={styles.aiHeader}>
        <SectionLabel>{so ? "Falanqaynta Juqraafi ee AI" : "AI Geological Analysis"}</SectionLabel>
        <Pressable style={styles.reBtn} onPress={onReanalyze} disabled={reanalyzing} hitSlop={6}>
          {reanalyzing
            ? <ActivityIndicator color={colors.gold} size="small" />
            : <Ionicons name="refresh" size={15} color={colors.gold} />}
          <Text style={styles.reBtnText}>{so ? "Dib u falanqee" : "Re-analyze"}</Text>
        </Pressable>
      </View>
      <AiAnalysis sample={sample} so={so} />
    </ScrollView>
  );
}

// Human-friendly status labels for the production lifecycle (§13).
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", ready: "Ready", uploading: "Uploading", ai_processing: "AI Processing",
  ai_completed: "AI Completed", awaiting_review: "Waiting for Geologist", verified: "Verified",
  needs_more_data: "Needs More Data", rejected: "Rejected", submitted: "Submitted",
  community_confirmed: "Community Confirmed", expert_verified: "Expert Verified",
  lab_verified: "Lab Verified", held: "Held",
};
function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s.replace(/_/g, " ");
}

function Badge({ label }: { label: string }) {
  return <View style={styles.badge}><Text style={styles.badgeText}>{label}</Text></View>;
}
function Row({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={styles.detailRow}>
      <Ionicons name={icon} size={16} color={colors.textMuted} />
      <Text style={styles.bodyText}>{text}</Text>
    </View>
  );
}

const KIND_LABELS: Record<string, string> = {
  rock_type: "Rock type", mineralization: "Mineralization", ore_mineral: "Ore minerals",
  gangue_mineral: "Gangue minerals", environment: "Geological environment",
  deposit_model: "Deposit model", exploration_significance: "Exploration significance",
};
const KIND_LABELS_SO: Record<string, string> = {
  rock_type: "Nooca dhagaxa", mineralization: "Macdaneed", ore_mineral: "Macdanaha birta",
  gangue_mineral: "Macdanaha aan faa'iidada lahayn", environment: "Deegaanka juqraafi",
  deposit_model: "Qaabka kaydka", exploration_significance: "Muhiimadda sahaminta",
};

// AI Geological Assessment — conclusions each shown with the evidence that
// produced them (the traceable graph), plus recommendations and uncertainties.
// Bilingual: shows Somali text when the app language is 'so', else English.
function AiAnalysis({ sample, so }: { sample: SampleDetail; so: boolean }) {
  const a = sample.assessment;
  const evStatement = (e: AssessmentEvidence) => (so && e.statement_so) ? e.statement_so : e.statement;
  if (!a) {
    return (
      <Card>
        <Text style={styles.pendingText}>
          {sample.status === "ai_processing"
            ? (so ? "Falanqaynta AI-gu waa socotaa…" : "AI analysis in progress…")
            : (so ? "Falanqaynta AI-gu si toos ah ayey u shaqaysaa gudbinta kadib. Hoos u jiid si aad u cusboonaysiiso." : "AI analysis runs automatically after submission. Pull to refresh.")}
        </Text>
      </Card>
    );
  }
  const evById = new Map(a.assessment_evidence.map((e) => [e.id, e]));
  const edgeEv = (cid: string, pol: string): AssessmentEvidence[] =>
    a.assessment_edge
      .filter((e) => e.conclusion_id === cid && e.polarity === pol)
      .map((e) => evById.get(e.evidence_id))
      .filter((e): e is AssessmentEvidence => !!e);
  const recs = a.report?.recommendations ?? [];
  const unc = a.report?.uncertainties ?? [];
  const missing = a.report?.missingInformation ?? [];

  return (
    <>
      {a.overall_confidence != null && (
        <Card>
          <View style={styles.detailRow}>
            <Ionicons name="sparkles-outline" size={16} color={colors.gold} />
            <Text style={styles.bodyText}>{so ? "Kalsoonida guud ee AI" : "Overall AI confidence"}: {Math.round(a.overall_confidence)}%</Text>
          </View>
        </Card>
      )}
      {a.assessment_conclusion.map((c) => {
        const support = edgeEv(c.id, "supporting");
        const contra = edgeEv(c.id, "contradicting");
        return (
          <Card key={c.id} style={{ marginTop: 8 }}>
            <View style={styles.conclHeader}>
              <Text style={styles.conclKind}>{(so ? KIND_LABELS_SO : KIND_LABELS)[c.kind] ?? c.kind}</Text>
              {c.confidence != null && (
                <View style={styles.confPill}><Text style={styles.confPillText}>{Math.round(c.confidence)}%</Text></View>
              )}
            </View>
            <Text style={styles.bodyText}>{(so && c.statement_so) ? c.statement_so : c.statement}</Text>
            <Text style={styles.tag}>{c.is_interpretation ? (so ? "fasiraad" : "interpretation") : (so ? "indho-indhayn" : "observation")}</Text>
            {support.length > 0 && (
              <View style={styles.evBlock}>
                <Text style={styles.evLabel}>{so ? "Caddaynta taageerta" : "Supporting evidence"}</Text>
                {support.map((e) => (
                  <Text key={e.id} style={styles.evItem}>• {evStatement(e)} <Text style={styles.evSrc}>({e.ev_type})</Text></Text>
                ))}
              </View>
            )}
            {contra.length > 0 && (
              <View style={styles.evBlock}>
                <Text style={[styles.evLabel, { color: colors.danger }]}>{so ? "Caddayn ka hor imanaysa" : "Contradicting"}</Text>
                {contra.map((e) => <Text key={e.id} style={styles.evItem}>• {evStatement(e)}</Text>)}
              </View>
            )}
          </Card>
        );
      })}
      {recs.length > 0 && (
        <>
          <SectionLabel>{so ? "Talooyin" : "Recommendations"}</SectionLabel>
          <Card>
            {recs.map((r, i) => (
              <View key={i} style={styles.detailRow}>
                <Ionicons name={r.flagged ? "alert-circle-outline" : "arrow-forward-circle-outline"} size={16} color={r.flagged ? colors.danger : colors.gold} />
                <Text style={styles.bodyText}>{(so && r.actionSo) ? r.actionSo : r.action}{r.scaleM ? ` (${r.scaleM} m)` : ""}</Text>
              </View>
            ))}
          </Card>
        </>
      )}
      {(unc.length > 0 || missing.length > 0) && (
        <>
          <SectionLabel>{so ? "Hubin la'aan & xog maqan" : "Uncertainties & missing data"}</SectionLabel>
          <Card>
            {unc.map((u, i) => <Text key={`u${i}`} style={styles.evItem}>• {so ? u.so : u.en}</Text>)}
            {missing.map((m, i) => <Text key={`m${i}`} style={[styles.evItem, { color: colors.textFaint }]}>• {so ? "maqan" : "missing"}: {so ? m.so : m.en}</Text>)}
          </Card>
        </>
      )}
      <Text style={styles.traceNote}>{so ? "Gunaanad kasta wuxuu ku xiran yahay caddaynta soo saartay." : "Every conclusion is linked to the evidence that produced it."}</Text>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, backgroundColor: colors.bg, padding: spacing.xl },
  errText: { ...t.body, textAlign: "center" },
  title: { ...t.title },
  subtitle: { ...t.caption, marginTop: 4, marginBottom: spacing.md },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.sm },
  badge: { backgroundColor: colors.surfaceSunken, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { ...t.caption, color: colors.textMuted, textTransform: "capitalize" },
  detailRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 4 },
  bodyText: { ...t.body, color: colors.text },
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  thumb: { width: 88, height: 88, borderRadius: radius.md, backgroundColor: colors.surfaceAlt },
  thumbPlaceholder: { alignItems: "center", justifyContent: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: { backgroundColor: colors.goldSoft, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.goldBorder },
  chipText: { ...t.bodySmall, color: colors.text },
  aiHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  reBtn: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.goldSoft, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.goldBorder },
  reBtnText: { ...t.caption, color: colors.gold, fontWeight: "700" },
  pendingText: { ...t.body, color: colors.textMuted, fontStyle: "italic" },
  conclHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  conclKind: { ...t.label, color: colors.gold },
  confPill: { backgroundColor: colors.goldSoft, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderColor: colors.goldBorder },
  confPillText: { ...t.caption, color: colors.gold, fontWeight: "700" },
  tag: { ...t.caption, color: colors.textFaint, marginTop: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  evBlock: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  evLabel: { ...t.caption, color: colors.success, fontWeight: "700", marginBottom: 3 },
  evItem: { ...t.bodySmall, color: colors.textMuted, marginBottom: 2 },
  evSrc: { color: colors.textFaint },
  traceNote: { ...t.caption, color: colors.textFaint, fontStyle: "italic", marginTop: spacing.md, textAlign: "center" },
});

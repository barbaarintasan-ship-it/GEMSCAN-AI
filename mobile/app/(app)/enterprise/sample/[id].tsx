// Enterprise › Sample Details (Sprint 4.2 owner beta).
// Read-only view of one submitted sample (GET /enterprise-samples/:id,
// RLS-scoped). Shows GPS, photos, minerals and rock/field notes — enough to
// confirm the submission round-tripped. No edit/verify/community actions.
import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Image } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../../lib/supabase";
import { colors, spacing, radius, type as t } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { SectionLabel } from "../../../../components/ui/SectionLabel";
import { getSample, type SampleDetail } from "../../../../lib/enterpriseSamples";

export default function SampleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [sample, setSample] = useState<SampleDetail | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Sample {sample.id.slice(0, 8)}</Text>
      <Text style={styles.subtitle}>Collected {new Date(sample.collected_at).toLocaleString()}</Text>

      <View style={styles.badges}>
        <Badge label={sample.status} />
        {sample.completeness_status && <Badge label={sample.completeness_status} />}
        {sample.confidence_score != null && <Badge label={`confidence ${Math.round(sample.confidence_score * 100)}%`} />}
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
    </ScrollView>
  );
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
});

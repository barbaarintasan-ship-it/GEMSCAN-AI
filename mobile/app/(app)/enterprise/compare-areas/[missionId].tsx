// Compare Areas — Phase 12 ("Why A > B" comparative reasoning).
//
// A manager picks two of the mission's areas and sees a purely deterministic
// side-by-side: score, reasons, coverage, and the structured diff Phase 12's
// RPC already computed (never recomputed here, no AI involved) — see
// compare-areas/handler.ts's own header note.
import React, { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { router, useLocalSearchParams, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing, radius } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { SectionLabel } from "../../../../components/ui/SectionLabel";
import {
  fetchMissionAreas, compareMissionAreas,
  type MissionArea, type AreaComparison,
} from "../../../../lib/enterprise/missions";

export default function CompareAreasScreen() {
  const { missionId } = useLocalSearchParams<{ missionId: string }>();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [loading, setLoading] = useState(true);
  const [areas, setAreas] = useState<MissionArea[]>([]);
  const [pickA, setPickA] = useState<string | null>(null);
  const [pickB, setPickB] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [result, setResult] = useState<AreaComparison | null>(null);

  const load = useCallback(async () => {
    if (!missionId) return;
    setLoading(true);
    try {
      const rows = await fetchMissionAreas(missionId);
      setAreas(rows);
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [missionId, so]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const canCompare = useMemo(() => !!pickA && !!pickB && pickA !== pickB, [pickA, pickB]);

  async function handleCompare() {
    if (!missionId || !pickA || !pickB) return;
    setComparing(true);
    setResult(null);
    try {
      const r = await compareMissionAreas(missionId, pickA, pickB);
      setResult(r);
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setComparing(false);
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{so ? "Isbarbardhig Aagagga" : "Compare Areas"}</Text>
      </View>

      {loading ? (
        <View style={styles.centerFill}><ActivityIndicator color={colors.gold} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {areas.length < 2 ? (
            <Text style={styles.mutedText}>
              {so ? "Ugu yaraan laba aag ayaa loo baahan yahay si loo isbarbardhigo." : "At least two areas are needed to compare."}
            </Text>
          ) : (
            <>
              <SectionLabel>{so ? "Aag A" : "Area A"}</SectionLabel>
              <View style={styles.chips}>
                {areas.map((a) => (
                  <Pressable
                    key={a.area_id}
                    style={[styles.chip, pickA === a.area_id && styles.chipActive]}
                    onPress={() => setPickA(a.area_id)}
                  >
                    <Text style={[styles.chipText, pickA === a.area_id && styles.chipTextActive]}>{a.name}</Text>
                  </Pressable>
                ))}
              </View>

              <SectionLabel>{so ? "Aag B" : "Area B"}</SectionLabel>
              <View style={styles.chips}>
                {areas.map((a) => (
                  <Pressable
                    key={a.area_id}
                    style={[styles.chip, pickB === a.area_id && styles.chipActive]}
                    onPress={() => setPickB(a.area_id)}
                  >
                    <Text style={[styles.chipText, pickB === a.area_id && styles.chipTextActive]}>{a.name}</Text>
                  </Pressable>
                ))}
              </View>

              <Button
                title={so ? "Isbarbardhig" : "Compare"}
                disabled={!canCompare}
                loading={comparing}
                onPress={handleCompare}
                style={styles.compareButton}
              />
            </>
          )}

          {result && (
            <>
              <SectionLabel>{so ? "Natiijada" : "Result"}</SectionLabel>
              <Card style={styles.card}>
                <View style={styles.sideBySideRow}>
                  <Text style={styles.sideName} numberOfLines={1}>{result.area_a.name}</Text>
                  <Text style={styles.sideName} numberOfLines={1}>{result.area_b.name}</Text>
                </View>
                <View style={styles.sideBySideRow}>
                  <Text style={styles.sideScore}>
                    {result.area_a.score != null ? `${Math.round(result.area_a.score * 100)}/100` : (so ? "lama qiimeynin" : "not scored")}
                  </Text>
                  <Text style={styles.sideScore}>
                    {result.area_b.score != null ? `${Math.round(result.area_b.score * 100)}/100` : (so ? "lama qiimeynin" : "not scored")}
                  </Text>
                </View>
                {result.diff.score_delta != null && (
                  <Text style={styles.deltaText}>
                    {so ? "Farqiga isku-dhafka: " : "Score delta: "}
                    {result.diff.score_delta > 0 ? "A > B" : result.diff.score_delta < 0 ? "B > A" : "A = B"}
                    {" ("}{Math.abs(Math.round(result.diff.score_delta * 100))}{" pts)"}
                  </Text>
                )}
              </Card>

              {(result.diff.roles_only_in_a.length > 0 || result.diff.roles_only_in_b.length > 0) && (
                <>
                  <SectionLabel>{so ? "Daboolka xogta oo kaliya" : "Coverage only in one"}</SectionLabel>
                  <Card style={styles.card}>
                    {result.diff.roles_only_in_a.length > 0 && (
                      <Text style={styles.diffText}>A: {result.diff.roles_only_in_a.join(", ")}</Text>
                    )}
                    {result.diff.roles_only_in_b.length > 0 && (
                      <Text style={styles.diffText}>B: {result.diff.roles_only_in_b.join(", ")}</Text>
                    )}
                  </Card>
                </>
              )}

              {(result.diff.reason_kinds_only_in_a.length > 0 || result.diff.reason_kinds_only_in_b.length > 0) && (
                <>
                  <SectionLabel>{so ? "Sababaha oo kaliya" : "Reasons only in one"}</SectionLabel>
                  <Card style={styles.card}>
                    {result.diff.reason_kinds_only_in_a.length > 0 && (
                      <Text style={styles.diffText}>A: {result.diff.reason_kinds_only_in_a.join(", ")}</Text>
                    )}
                    {result.diff.reason_kinds_only_in_b.length > 0 && (
                      <Text style={styles.diffText}>B: {result.diff.reason_kinds_only_in_b.join(", ")}</Text>
                    )}
                  </Card>
                </>
              )}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.3, flexShrink: 1 },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: 60 },
  mutedText: { color: colors.textFaint, fontSize: 12, fontStyle: "italic" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  chipActive: { backgroundColor: colors.goldSoft, borderColor: colors.goldBorder },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextActive: { color: colors.gold, fontWeight: "700" },
  compareButton: { marginBottom: spacing.md },
  card: { gap: 6, marginBottom: spacing.sm },
  sideBySideRow: { flexDirection: "row", justifyContent: "space-between" },
  sideName: { color: colors.text, fontSize: 13, fontWeight: "700", flex: 1 },
  sideScore: { color: colors.text, fontSize: 16, fontWeight: "800", flex: 1 },
  deltaText: { color: colors.gold, fontSize: 12, fontWeight: "700", marginTop: 4 },
  diffText: { color: colors.textMuted, fontSize: 12, marginBottom: 2 },
});

// Phase 17 — "Find Gold" mode: the SAME deterministic score/reasons Phase 10
// already computed, restated in plain language for a field worker with no
// geology background. Computes nothing new. See plainLanguage.ts's own
// header note. The full technical report stays reachable from the detail
// screen for anyone who wants it.
import React, { useCallback, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { router, useLocalSearchParams, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { bandFor } from "../../../../../shared/geo-core/confidence.ts";
import { fetchMissionAreas } from "../../../../lib/enterprise/missions";
import { fetchAreaReviewDetail } from "../../../../lib/enterprise/missions";
import { bandToSimpleLevel, levelLabel, topReasonSentence, LEVEL_EMOJI, type SimpleLevel } from "../../../../lib/enterprise/plainLanguage";

type AreaCard = { area_id: string; name: string; level: SimpleLevel; sentence: string | null };

const LEVEL_ORDER: Record<SimpleLevel, number> = { good: 3, maybe: 2, low: 1, unknown: 0 };

// Real bug (2026-09-25): the screen title stayed hardcoded "Find Gold" even
// when a manager picked a different commodity from find-gold-start —
// misleading, since the `commodity` badge below it correctly showed the
// real selection. Title now reflects whatever was actually picked.
const COMMODITY_TITLE: Record<string, { en: string; so: string }> = {
  gold: { en: "Find Gold", so: "Raadi Dahabka" },
  diamond: { en: "Find Diamond", so: "Raadi Dheemanka" },
  silver: { en: "Find Silver", so: "Raadi Qalinka" },
  copper: { en: "Find Copper", so: "Raadi Naxaaska" },
};
function titleFor(commodity: string | undefined, so: boolean): string {
  if (!commodity) return so ? "Raadi Dahabka" : "Find Gold";
  const known = COMMODITY_TITLE[commodity.toLowerCase()];
  if (known) return so ? known.so : known.en;
  const cap = commodity.charAt(0).toUpperCase() + commodity.slice(1);
  return so ? `Raadi ${cap}` : `Find ${cap}`;
}

export default function FindGoldScreen() {
  const { missionId, commodity } = useLocalSearchParams<{ missionId: string; commodity?: string }>();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState<AreaCard[]>([]);

  const load = useCallback(async () => {
    if (!missionId) return;
    setLoading(true);
    try {
      const areas = await fetchMissionAreas(missionId);
      const details = await Promise.all(
        areas.map(async (a): Promise<AreaCard> => {
          try {
            const d = await fetchAreaReviewDetail(missionId, a.area_id);
            const best = d.cells[0];
            const band = best?.prospectivity_score != null ? bandFor(best.prospectivity_score) : null;
            return {
              area_id: a.area_id, name: a.name,
              level: bandToSimpleLevel(band),
              sentence: topReasonSentence(best?.reasons, so),
            };
          } catch {
            return { area_id: a.area_id, name: a.name, level: "unknown", sentence: null };
          }
        }),
      );
      details.sort((x, y) => LEVEL_ORDER[y.level] - LEVEL_ORDER[x.level]);
      setCards(details);
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [missionId, so]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) {
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
        <Text style={styles.title}>{titleFor(commodity, so)}</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.introText}>
          {so
            ? "Halkan waxaa ku qoran meelaha ugu fiican ee lagu raadin karo macdan, af fudud."
            : "Here are the best spots to explore, in plain language."}
        </Text>
        {commodity && (
          <Text style={styles.commodityBadge}>
            {so ? `Raadinta: ${commodity}` : `Looking for: ${commodity}`}
          </Text>
        )}
        {cards.length === 0 && (
          <Text style={styles.mutedText}>
            {so ? "Weli meel lama xaddidin mishankan." : "No spots have been marked for this mission yet."}
          </Text>
        )}
        {cards.map((c) => (
          <Pressable
            key={c.area_id}
            onPress={() => router.push(
              `/(app)/enterprise/find-gold-detail/${c.area_id}?missionId=${missionId}${commodity ? `&commodity=${encodeURIComponent(commodity)}` : ""}`,
            )}
          >
            <Card style={styles.areaCard}>
              <View style={styles.areaRow}>
                <Text style={styles.emoji}>{LEVEL_EMOJI[c.level]}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.areaName} numberOfLines={1}>{c.name}</Text>
                  <Text style={styles.levelLabel}>{levelLabel(c.level, so)}</Text>
                  {c.sentence && <Text style={styles.sentence} numberOfLines={2}>{c.sentence}</Text>}
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
              </View>
            </Card>
          </Pressable>
        ))}

        {missionId && (
          <Button
            title={so ? "🗺️ Sahami Gobol Cusub" : "🗺️ Discover a New Region"}
            variant="outline"
            onPress={() => router.push(
              `/(app)/enterprise/discover-region/${missionId}${commodity ? `?commodity=${encodeURIComponent(commodity)}` : ""}`,
            )}
            style={styles.discoverButton}
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: "800" },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: 60 },
  introText: { color: colors.textMuted, fontSize: 13, marginBottom: spacing.sm },
  commodityBadge: { color: colors.gold, fontSize: 12, fontWeight: "700", marginBottom: spacing.sm },
  discoverButton: { marginTop: spacing.md },
  mutedText: { color: colors.textFaint, fontSize: 13, fontStyle: "italic" },
  areaCard: { marginBottom: spacing.sm },
  areaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  emoji: { fontSize: 28 },
  areaName: { color: colors.text, fontSize: 15, fontWeight: "800" },
  levelLabel: { color: colors.gold, fontSize: 13, fontWeight: "700", marginTop: 2 },
  sentence: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
});

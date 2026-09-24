// Phase 17 guided commodity entry (2026-09-24) — "Maxaad rabtaa inaad
// raadiso?" A pure UI-level entry point in front of the EXISTING Find Gold
// flow (find-gold/[missionId].tsx), which is unchanged by this screen: it
// still lists whatever is already scored, exactly as before. Selecting a
// commodity only carries a `commodity` param forward to the screens that
// actually RUN new deterministic scoring (discover-region, recommend-area),
// which already accept a commodity parameter — nothing new invented here.
//
// "Other mineral" lists geo.commodity_profile directly (migration 0158) —
// the SAME table TargetingEngine's commodityModelFor() reads server-side,
// not a second commodity list.
import React, { useCallback, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput } from "react-native";
import { router, useLocalSearchParams, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { fetchFeaturedCommodities, fetchCommodityChoices, type CommodityChoice } from "../../../../lib/enterprise/missions";

const FEATURED_LABEL: Record<string, { en: string; so: string; emoji: string }> = {
  gold: { en: "Gold", so: "Dahab", emoji: "🟡" },
  diamond: { en: "Diamond", so: "Dheeman", emoji: "💎" },
  silver: { en: "Silver", so: "Qalin", emoji: "⚪" },
  copper: { en: "Copper", so: "Naxaas", emoji: "🟠" },
};

export default function FindGoldStartScreen() {
  const { missionId } = useLocalSearchParams<{ missionId: string }>();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [loading, setLoading] = useState(true);
  const [featured, setFeatured] = useState<CommodityChoice[]>([]);
  const [showOther, setShowOther] = useState(false);
  const [allCommodities, setAllCommodities] = useState<CommodityChoice[]>([]);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFeatured(await fetchFeaturedCommodities());
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleShowOther() {
    setShowOther(true);
    if (allCommodities.length === 0) {
      setAllCommodities(await fetchCommodityChoices());
    }
  }

  function selectCommodity(code: string) {
    if (!missionId) return;
    router.push(`/(app)/enterprise/find-gold/${missionId}?commodity=${encodeURIComponent(code)}`);
  }

  const filteredOther = allCommodities.filter(
    (c) => c.name.toLowerCase().includes(search.toLowerCase()) || c.code.toLowerCase().includes(search.toLowerCase()),
  );

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
        <Text style={styles.title}>{so ? "Maxaad rabtaa inaad raadiso?" : "What are you looking for?"}</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {featured.map((c) => {
          const label = FEATURED_LABEL[c.code] ?? { en: c.name, so: c.name, emoji: "⛏️" };
          return (
            <Pressable key={c.code} onPress={() => selectCommodity(c.code)}>
              <Card style={styles.choiceCard}>
                <Text style={styles.emoji}>{label.emoji}</Text>
                <Text style={styles.choiceLabel}>{so ? label.so : label.en}</Text>
                <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
              </Card>
            </Pressable>
          );
        })}

        {!showOther ? (
          <Pressable onPress={handleShowOther}>
            <Card style={styles.choiceCard}>
              <Text style={styles.emoji}>⛏️</Text>
              <Text style={styles.choiceLabel}>{so ? "Macdan kale" : "Other mineral"}</Text>
              <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
            </Card>
          </Pressable>
        ) : (
          <>
            <Text style={styles.sectionLabel}>{so ? "Macdan kale" : "Other mineral"}</Text>
            <TextInput
              style={styles.searchInput}
              placeholder={so ? "Raadi macdan..." : "Search minerals..."}
              placeholderTextColor={colors.textFaint}
              value={search}
              onChangeText={setSearch}
            />
            {filteredOther.map((c) => (
              <Pressable key={c.code} onPress={() => selectCommodity(c.code)}>
                <Card style={styles.otherCard}>
                  <Text style={styles.otherLabel}>{c.name}</Text>
                  {!c.hasProfile && (
                    <Text style={styles.captionText}>
                      {so ? "Xog geological ah oo faahfaahsan lama helin weli" : "No detailed geological profile yet"}
                    </Text>
                  )}
                </Card>
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { color: colors.text, fontSize: 17, fontWeight: "800", flex: 1, textAlign: "center" },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: 60 },
  choiceCard: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm },
  emoji: { fontSize: 26 },
  choiceLabel: { color: colors.text, fontSize: 16, fontWeight: "700", flex: 1 },
  sectionLabel: { color: colors.gold, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4, marginTop: spacing.sm },
  searchInput: { backgroundColor: colors.surfaceAlt, color: colors.text, borderRadius: 8, paddingHorizontal: spacing.sm, paddingVertical: 8, fontSize: 14, marginBottom: spacing.sm },
  otherCard: { marginBottom: spacing.xs, gap: 2 },
  otherLabel: { color: colors.text, fontSize: 14, fontWeight: "600" },
  captionText: { color: colors.textFaint, fontSize: 11, fontStyle: "italic" },
});

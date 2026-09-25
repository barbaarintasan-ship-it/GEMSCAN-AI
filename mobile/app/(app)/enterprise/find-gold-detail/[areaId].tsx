// Phase 17 — "Find Gold" detail: one spot, in plain language. Same
// underlying data as area-review/target-report (Phase 10/11/16) — this
// screen only restates it and offers the same three review actions with
// everyday labels. The full technical report is one tap away.
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
import {
  fetchAreaReviewDetail, reviewArea, computeAreaSpectralIndex,
  isMissionManager, fetchAreaFieldSuggestions, submitAreaFieldSuggestion,
  fetchCommodityFieldChecklist,
  type AreaReviewDetail, type AreaSpectralIndex, type AreaFieldSuggestionRow, type FieldSuggestion,
  type CommodityFieldChecklist,
} from "../../../../lib/enterprise/missions";
import { bandToSimpleLevel, levelLabel, allReasonSentences, LEVEL_EMOJI, type SimpleLevel } from "../../../../lib/enterprise/plainLanguage";

export default function FindGoldDetailScreen() {
  const { areaId, missionId, commodity } = useLocalSearchParams<{ areaId: string; missionId: string; commodity?: string }>();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<AreaReviewDetail | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [spectralLoading, setSpectralLoading] = useState(false);
  const [spectral, setSpectral] = useState<AreaSpectralIndex | null>(null);
  const [isManager, setIsManager] = useState(false);
  const [suggestions, setSuggestions] = useState<AreaFieldSuggestionRow[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [checklist, setChecklist] = useState<CommodityFieldChecklist | null>(null);

  const load = useCallback(async () => {
    if (!areaId || !missionId) return;
    setLoading(true);
    try {
      const [d, manager, sugg, cl] = await Promise.all([
        fetchAreaReviewDetail(missionId, areaId),
        isMissionManager(missionId),
        fetchAreaFieldSuggestions(areaId),
        commodity ? fetchCommodityFieldChecklist(commodity) : Promise.resolve(null),
      ]);
      setDetail(d);
      setIsManager(manager);
      setSuggestions(sugg);
      setChecklist(cl);
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [areaId, missionId, commodity, so]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleDecide(decision: "accepted" | "rejected" | "needs_more_data") {
    if (!areaId || !missionId) return;
    setDeciding(true);
    try {
      await reviewArea(missionId, areaId, decision);
      await load();
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setDeciding(false);
    }
  }

  async function handleSuggest(suggestion: FieldSuggestion) {
    if (!areaId || !missionId) return;
    setSuggesting(true);
    try {
      await submitAreaFieldSuggestion(missionId, areaId, suggestion);
      setSuggestions(await fetchAreaFieldSuggestions(areaId));
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  async function handleCheckSpace() {
    if (!areaId || !missionId) return;
    setSpectralLoading(true);
    try {
      setSpectral(await computeAreaSpectralIndex(missionId, areaId));
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setSpectralLoading(false);
    }
  }

  if (loading || !detail) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.centerFill}><ActivityIndicator color={colors.gold} /></View>
      </View>
    );
  }

  const best = detail.cells[0];
  const band = best?.prospectivity_score != null ? bandFor(best.prospectivity_score) : null;
  const level: SimpleLevel = bandToSimpleLevel(band);
  const sentences = allReasonSentences(best?.reasons, so);
  const alreadyDecided = detail.reviewStatus !== "pending";

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{detail.name}</Text>
        <Pressable onPress={() => router.push(`/(app)/enterprise/target-report/${areaId}?missionId=${missionId}`)} hitSlop={10}>
          <Ionicons name="document-text-outline" size={22} color={colors.gold} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Card style={styles.levelCard}>
          <Text style={styles.emoji}>{LEVEL_EMOJI[level]}</Text>
          <Text style={styles.levelLabel}>{levelLabel(level, so)}</Text>
        </Card>

        {sentences.length > 0 && (
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>{so ? "Sababta" : "Why"}</Text>
            {sentences.map((s, i) => <Text key={i} style={styles.sentence}>• {s}</Text>)}
          </Card>
        )}

        {checklist && (checklist.explorationIndicators.length > 0 || checklist.alterationStyles.length > 0 || checklist.associatedMinerals.length > 0) && (
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>
              {so ? `Waxa lagu doondooni doono: ${checklist.name}` : `What to look for: ${checklist.name}`}
            </Text>
            {checklist.explorationIndicators.length > 0 && (
              <>
                <Text style={styles.checklistGroupLabel}>{so ? "Calaamado" : "Signs"}</Text>
                {checklist.explorationIndicators.map((s, i) => <Text key={`ei-${i}`} style={styles.sentence}>• {s}</Text>)}
              </>
            )}
            {checklist.alterationStyles.length > 0 && (
              <>
                <Text style={styles.checklistGroupLabel}>{so ? "Isbedelka dhagaxa" : "Rock alteration"}</Text>
                {checklist.alterationStyles.map((s, i) => <Text key={`as-${i}`} style={styles.sentence}>• {s}</Text>)}
              </>
            )}
            {checklist.associatedMinerals.length > 0 && (
              <>
                <Text style={styles.checklistGroupLabel}>{so ? "Macdanaha la xiriira" : "Associated minerals"}</Text>
                {checklist.associatedMinerals.map((s, i) => <Text key={`am-${i}`} style={styles.sentence}>• {s}</Text>)}
              </>
            )}
            {checklist.limitations && (
              <Text style={styles.captionText}>{checklist.limitations}</Text>
            )}
          </Card>
        )}

        <Card style={styles.card}>
          <Text style={styles.sectionTitle}>{so ? "Falanqaynta hawada sare (Satellite)" : "Satellite check"}</Text>
          {spectral ? (
            spectral.value != null ? (
              <>
                <Text style={styles.mutedText}>
                  {so ? "Tirada calaamadda: " : "Signal reading: "}{spectral.value.toFixed(2)} ({spectral.acquisition_date})
                </Text>
                <Text style={styles.captionText}>
                  {so
                    ? "Waali waa tijaabo — waydii geologist si loo fasiro."
                    : "Still experimental — ask a geologist to interpret this."}
                </Text>
              </>
            ) : (
              <Text style={styles.mutedText}>{spectral.note ?? (so ? "Sawir ma la helin" : "No image available")}</Text>
            )
          ) : (
            <Button
              title={spectralLoading ? "…" : (so ? "Hubi Satellite-ka" : "Check from space")}
              variant="outline"
              onPress={handleCheckSpace}
              disabled={spectralLoading}
            />
          )}
        </Card>

        {isManager ? (
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>{so ? "Go'aan rasmi ah (Manager)" : "Formal review (Manager)"}</Text>
            {alreadyDecided ? (
              <Text style={styles.mutedText}>
                {so ? "Go'aan horey ayaa la gaadhay: " : "Already decided: "}{detail.reviewStatus}
              </Text>
            ) : null}
            <View style={styles.decideRow}>
              <Button
                title={so ? "Haa, wax baan helay" : "Yes, found something"}
                onPress={() => handleDecide("accepted")}
                disabled={deciding}
                style={styles.decideButton}
              />
              <Button
                title={so ? "Maya, waxba ma jiraan" : "No, nothing here"}
                variant="outline"
                onPress={() => handleDecide("rejected")}
                disabled={deciding}
                style={styles.decideButton}
              />
            </View>
            <Button
              title={so ? "Wali ma hubo" : "Not sure yet"}
              variant="outline"
              onPress={() => handleDecide("needs_more_data")}
              disabled={deciding}
              style={styles.shareButton}
            />
          </Card>
        ) : (
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>{so ? "Soo jeedin (Adigu)" : "Your suggestion"}</Text>
            <Text style={styles.captionText}>
              {so
                ? "Tani ma aha go'aan rasmi ah — waxay u tagaysaa hoggaamiyaha si uu ugu fikiro."
                : "This is not a formal decision — it goes to your team lead as input."}
            </Text>
            <View style={styles.decideRow}>
              <Button
                title={so ? "Wax baan helay" : "Found something"}
                onPress={() => handleSuggest("found_evidence")}
                disabled={suggesting}
                style={styles.decideButton}
              />
              <Button
                title={so ? "Waxba ma jiraan" : "Nothing here"}
                variant="outline"
                onPress={() => handleSuggest("not_found")}
                disabled={suggesting}
                style={styles.decideButton}
              />
            </View>
            <Button
              title={so ? "Wali ma hubo" : "Not sure yet"}
              variant="outline"
              onPress={() => handleSuggest("not_sure")}
              disabled={suggesting}
              style={styles.shareButton}
            />
          </Card>
        )}

        {suggestions.length > 0 && (
          <Card style={styles.card}>
            <Text style={styles.sectionTitle}>{so ? "Soo jeedimaha Kooxda" : "Team suggestions"}</Text>
            {suggestions.map((s) => (
              <Text key={s.id} style={styles.sentence}>
                • {SUGGESTION_LABEL[s.suggestion][so ? "so" : "en"]} — {new Date(s.created_at).toLocaleDateString()}
              </Text>
            ))}
          </Card>
        )}
      </ScrollView>
    </View>
  );
}

const SUGGESTION_LABEL: Record<FieldSuggestion, { en: string; so: string }> = {
  found_evidence: { en: "Found something", so: "Wax baa la helay" },
  not_found: { en: "Nothing found", so: "Waxba ma jirin" },
  not_sure: { en: "Not sure", so: "Lama hubin" },
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", flex: 1 },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: 60 },
  levelCard: { alignItems: "center", gap: 4, paddingVertical: spacing.md },
  emoji: { fontSize: 56 },
  levelLabel: { color: colors.text, fontSize: 18, fontWeight: "800" },
  card: { gap: 6, marginBottom: spacing.sm },
  sectionTitle: { color: colors.gold, fontSize: 13, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  sentence: { color: colors.text, fontSize: 14 },
  checklistGroupLabel: { color: colors.textMuted, fontSize: 12, fontWeight: "700", marginTop: spacing.xs },
  mutedText: { color: colors.textFaint, fontSize: 13 },
  captionText: { color: colors.textFaint, fontSize: 11, fontStyle: "italic" },
  decideRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  decideButton: { flex: 1 },
  shareButton: { marginTop: spacing.sm },
});

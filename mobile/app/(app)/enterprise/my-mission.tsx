// My Mission — the field worker's entry point into Team Mission Mode.
//
// Answers exactly the questions the field-worker brief called for: what is my
// mission, where do I need to go, what have I already done, what needs
// attention. Deliberately NOT a map (see manager-mission/[missionId].tsx's
// header comment for why no H3 hex-polygon renderer exists yet) — a cell list
// with a "Navigate" deep link into the phone's own Maps app answers "where do
// I go" without building new map-rendering infrastructure.
import React, { useCallback, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Linking } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing, radius } from "../../../lib/theme";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import {
  fetchMyMissions, fetchMissionAssignments,
  type MyMission, type Assignment,
} from "../../../lib/enterprise/missions";
import { supabase } from "../../../lib/supabase";
import { cellCentre } from "../../../lib/geo/h3";

type MissionBlock = { mine: MyMission; cells: Assignment[] };

const STATUS_LABEL: Record<string, { en: string; so: string; color: string }> = {
  assigned: { en: "To do", so: "Weli hawshu ma bilaabmin", color: colors.textFaint },
  in_progress: { en: "In progress", so: "Socda", color: colors.gold },
  completed: { en: "Done", so: "La dhammeeyay", color: colors.success },
  skipped: { en: "Skipped", so: "La dhaafay", color: colors.textFaint },
  expired: { en: "Expired", so: "Wakhtigii dhamaaday", color: colors.dangerStrong },
};

export default function MyMissionScreen() {
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [loading, setLoading] = useState(true);
  const [blocks, setBlocks] = useState<MissionBlock[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      const mine = await fetchMyMissions();
      const withCells = await Promise.all(
        mine.map(async (m) => {
          const all = await fetchMissionAssignments(m.mission_id);
          const cells = uid ? all.filter((c) => c.contributor_id === uid) : [];
          return { mine: m, cells };
        }),
      );
      setBlocks(withCells);
    } catch {
      setBlocks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  function navigateTo(cell: string) {
    const { lat, lng } = cellCentre(cell);
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`);
  }

  function submitEvidence(missionId: string, cell: string) {
    router.push({
      pathname: "/(app)/enterprise/new-sample",
      params: { from: "exploration", enterpriseMissionId: missionId, assignmentH3: cell },
    });
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{so ? "Mission-kayga" : "My Mission"}</Text>
      </View>

      {loading ? (
        <View style={styles.centerFill}><ActivityIndicator color={colors.gold} /></View>
      ) : blocks.length === 0 ? (
        <View style={styles.centerFill}>
          <Ionicons name="flag-outline" size={36} color={colors.textFaint} />
          <Text style={styles.emptyText}>
            {so ? "Weli kuma jirtid mission koox ah." : "You're not on any team missions yet."}
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {blocks.map(({ mine, cells }) => (
            <View key={mine.mission_id} style={styles.missionBlock}>
              <View style={styles.missionHead}>
                <Text style={styles.missionName}>{mine.mission.name}</Text>
                <View style={styles.roleBadge}><Text style={styles.roleBadgeText}>{mine.role}</Text></View>
              </View>
              {mine.mission.description ? (
                <Text style={styles.missionDesc}>{mine.mission.description}</Text>
              ) : null}

              {cells.length === 0 ? (
                <Text style={styles.noCells}>
                  {so ? "Weli lama kuu qoondeynin unug goob ah." : "No H3 cells assigned to you yet."}
                </Text>
              ) : (
                cells.map((c) => {
                  const st = STATUS_LABEL[c.status] ?? STATUS_LABEL.assigned;
                  return (
                    <Card key={c.id} style={styles.cellCard}>
                      <View style={styles.cellTop}>
                        <Text style={styles.cellId}>{c.target_h3}</Text>
                        <View style={[styles.statusDot, { backgroundColor: st.color }]} />
                        <Text style={[styles.statusText, { color: st.color }]}>{so ? st.so : st.en}</Text>
                      </View>
                      {c.due_at ? (
                        <Text style={styles.dueText}>
                          {so ? "Kama dambeyska ah: " : "Due: "}{new Date(c.due_at).toLocaleDateString()}
                        </Text>
                      ) : null}
                      <View style={styles.cellActions}>
                        <Button
                          title={so ? "U jeeso" : "Navigate"}
                          variant="outline" size="sm"
                          icon={<Ionicons name="navigate-outline" size={15} color={colors.gold} />}
                          onPress={() => navigateTo(c.target_h3)}
                        />
                        <Button
                          title={so ? "Gudbi Caddayn" : "Submit Evidence"}
                          size="sm"
                          onPress={() => submitEvidence(mine.mission_id, c.target_h3)}
                        />
                      </View>
                    </Card>
                  );
                })
              )}
            </View>
          ))}
        </ScrollView>
      )}
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
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.xl },
  emptyText: { color: colors.textMuted, fontSize: 13, textAlign: "center" },
  body: { padding: spacing.md, gap: spacing.lg, paddingBottom: 40 },
  missionBlock: { gap: spacing.sm },
  missionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  missionName: { color: colors.text, fontSize: 17, fontWeight: "800", flexShrink: 1 },
  roleBadge: {
    backgroundColor: colors.goldSoft, borderRadius: radius.pill,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  roleBadgeText: { color: colors.gold, fontSize: 11, fontWeight: "800", textTransform: "capitalize" },
  missionDesc: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  noCells: { color: colors.textFaint, fontSize: 12, fontStyle: "italic" },
  cellCard: { gap: spacing.sm },
  cellTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cellId: { color: colors.text, fontSize: 13, fontWeight: "700", flex: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, fontWeight: "700" },
  dueText: { color: colors.textFaint, fontSize: 12 },
  cellActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
});

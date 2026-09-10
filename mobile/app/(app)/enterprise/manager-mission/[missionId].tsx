// Manager Mission — Team Mission Mode's "map" for V1.
//
// This is deliberately a LIST, not a geographic hexagon map. The mobile app
// has no true H3 polygon renderer anywhere today (confirmed by reading
// ExplorationMap.tsx — it's a custom GPS-live WebView/canvas built for a
// different job, and cellToBoundary is never imported anywhere in this
// codebase). Building a real hex map is a separate, much larger unit of
// work; a list answers the manager's actual questions today — who is
// responsible, what has been done, what remains — using every RPC already
// built and tested (Phase 2A/2B), with zero new rendering engine.
import React, { useCallback, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Alert } from "react-native";
import { router, useLocalSearchParams, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing, radius } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { SectionLabel } from "../../../../components/ui/SectionLabel";
import { supabase } from "../../../../lib/supabase";
import {
  fetchMissionAssignments, fetchMissionContributors, fetchMissionAreas,
  addMissionContributor, assignCells, generateMissionCells,
  type Assignment, type MissionContributor, type MissionArea,
} from "../../../../lib/enterprise/missions";

const TERMINAL = new Set(["completed", "skipped", "expired"]);

export default function ManagerMissionScreen() {
  const { missionId } = useLocalSearchParams<{ missionId: string }>();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [loading, setLoading] = useState(true);
  const [missionName, setMissionName] = useState("");
  const [areas, setAreas] = useState<MissionArea[]>([]);
  const [contributors, setContributors] = useState<MissionContributor[]>([]);
  const [cells, setCells] = useState<Assignment[]>([]);
  const [expandedCell, setExpandedCell] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [addEmail, setAddEmail] = useState("");
  const [addingContributor, setAddingContributor] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!missionId) return;
    setLoading(true);
    try {
      const [{ data: mission }, areaRows, contributorRows, cellRows] = await Promise.all([
        supabase.schema("enterprise").from("exploration_mission").select("name").eq("id", missionId).maybeSingle(),
        fetchMissionAreas(missionId),
        fetchMissionContributors(missionId),
        fetchMissionAssignments(missionId),
      ]);
      setMissionName((mission as any)?.name ?? "");
      setAreas(areaRows);
      setContributors(contributorRows);
      setCells(cellRows);
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleGenerate(areaId: string) {
    if (!missionId) return;
    setGenerating(areaId);
    try {
      const r = await generateMissionCells(missionId, areaId);
      Alert.alert(
        so ? "Waa la sameeyay" : "Done",
        so
          ? `${r.totalCells} unug ayaa la helay, ${r.newlyCreated} oo cusub ayaa la abuuray.`
          : `${r.totalCells} cells found, ${r.newlyCreated} newly created.`,
      );
      await load();
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setGenerating(null);
    }
  }

  async function handleAddContributor() {
    if (!missionId || !addEmail.trim()) return;
    setAddingContributor(true);
    try {
      await addMissionContributor(missionId, addEmail.trim());
      setAddEmail("");
      await load();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      let text = msg;
      if (/no_account/i.test(msg)) text = so ? "Qofkan akoon GEMSCAN ah kuma haysto." : "This person doesn't have a GEMSCAN account.";
      if (/not_org_member/i.test(msg)) text = so ? "Waa inuu horeba xubin ka ahaan shirkadda." : "They must already be a member of the organization.";
      Alert.alert(so ? "Khalad" : "Error", text);
    } finally {
      setAddingContributor(false);
    }
  }

  function assignTo(cell: Assignment, contributor: MissionContributor) {
    if (!missionId) return;
    const isReassign = !!cell.contributor_id && cell.contributor_id !== contributor.contributor_id && !TERMINAL.has(cell.status);
    const run = async () => {
      setAssigning(cell.target_h3);
      try {
        await assignCells(missionId, [cell.target_h3], contributor.contributor_id, isReassign);
        setExpandedCell(null);
        await load();
      } catch (err) {
        Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
      } finally {
        setAssigning(null);
      }
    };
    if (isReassign) {
      Alert.alert(
        so ? "Dib u qoondee?" : "Reassign?",
        so ? `Unugan waxaa horeba loo qoondeeyay qof kale. Dib ugu qoondee ${contributor.email}?` : `This cell is already assigned to someone else. Reassign to ${contributor.email}?`,
        [{ text: so ? "Jooji" : "Cancel", style: "cancel" }, { text: so ? "Dib u qoondee" : "Reassign", onPress: run }],
      );
    } else {
      run();
    }
  }

  const emailFor = (id: string | null) => contributors.find((c) => c.contributor_id === id)?.email;
  const unassignedCount = cells.filter((c) => !c.contributor_id).length;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{missionName || (so ? "Mission" : "Mission")}</Text>
      </View>

      {loading ? (
        <View style={styles.centerFill}><ActivityIndicator color={colors.gold} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <Card style={styles.summaryCard}>
            <Text style={styles.summaryText}>
              {so
                ? `${cells.length} unug · ${cells.length - unassignedCount} la qoondeeyay · ${unassignedCount} bilaash`
                : `${cells.length} cells · ${cells.length - unassignedCount} assigned · ${unassignedCount} unassigned`}
            </Text>
          </Card>

          <SectionLabel>{so ? "Aagagga (Areas)" : "Areas"}</SectionLabel>
          {areas.length === 0 ? (
            <Text style={styles.mutedText}>{so ? "Ma jiraan aagag la xidhay mission-kan." : "No areas linked to this mission yet."}</Text>
          ) : (
            areas.map((a) => (
              <View key={a.area_id} style={styles.areaRow}>
                <Text style={styles.areaName}>{a.name}</Text>
                <Button
                  title={so ? "Samee Unugyo" : "Generate Cells"}
                  size="sm" variant="outline"
                  loading={generating === a.area_id}
                  onPress={() => handleGenerate(a.area_id)}
                />
              </View>
            ))
          )}

          <SectionLabel>{so ? "Xubnaha" : "Roster"}</SectionLabel>
          <Card style={styles.rosterCard}>
            {contributors.map((c, idx) => (
              <View key={c.contributor_id}>
                {idx > 0 && <View style={styles.divider} />}
                <View style={styles.rosterRow}>
                  <Text style={styles.rosterEmail} numberOfLines={1}>{c.email}</Text>
                  <Text style={styles.rosterRole}>{c.role}</Text>
                </View>
              </View>
            ))}
            <View style={[styles.row, styles.addRosterRow]}>
              <TextInput
                style={styles.input}
                placeholder={so ? "email@tusaale.com" : "teammate@email.com"}
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                keyboardType="email-address"
                value={addEmail}
                onChangeText={setAddEmail}
              />
              <Button title={so ? "Dar" : "Add"} size="sm" loading={addingContributor} onPress={handleAddContributor} />
            </View>
          </Card>

          <SectionLabel>{so ? "Unugyada H3" : "H3 Cells"}</SectionLabel>
          {cells.length === 0 ? (
            <Text style={styles.mutedText}>
              {so ? "Weli lama samayn unugyo. Kor ka dooro aag oo taabo \"Samee Unugyo\"." : "No cells generated yet. Pick an area above and tap \"Generate Cells\"."}
            </Text>
          ) : (
            cells.map((c) => {
              const isOpen = expandedCell === c.target_h3;
              return (
                <Card key={c.id} style={styles.cellCard}>
                  <Pressable onPress={() => setExpandedCell(isOpen ? null : c.target_h3)} style={styles.cellRow}>
                    <Text style={styles.cellId} numberOfLines={1}>{c.target_h3}</Text>
                    <Text style={styles.cellAssignee} numberOfLines={1}>
                      {emailFor(c.contributor_id) ?? (so ? "bilaash" : "unassigned")}
                    </Text>
                    <Ionicons name={isOpen ? "chevron-up" : "chevron-down"} size={16} color={colors.textFaint} />
                  </Pressable>
                  {isOpen && (
                    <View style={styles.assignChips}>
                      {contributors.length === 0 ? (
                        <Text style={styles.mutedText}>{so ? "Marka hore koox ku dar." : "Add someone to the roster first."}</Text>
                      ) : (
                        contributors.map((ct) => (
                          <Pressable
                            key={ct.contributor_id}
                            style={[styles.chip, c.contributor_id === ct.contributor_id && styles.chipActive]}
                            disabled={assigning === c.target_h3}
                            onPress={() => assignTo(c, ct)}
                          >
                            <Text style={[styles.chipText, c.contributor_id === ct.contributor_id && styles.chipTextActive]}>
                              {ct.email}
                            </Text>
                          </Pressable>
                        ))
                      )}
                    </View>
                  )}
                </Card>
              );
            })
          )}
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
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.3, flexShrink: 1 },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: 40 },
  summaryCard: { marginBottom: spacing.sm },
  summaryText: { color: colors.gold, fontSize: 13, fontWeight: "700" },
  mutedText: { color: colors.textFaint, fontSize: 12, fontStyle: "italic", marginBottom: spacing.sm },
  areaRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: colors.surfaceAlt, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.sm,
  },
  areaName: { color: colors.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  rosterCard: { gap: 0, marginBottom: spacing.sm },
  rosterRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10 },
  rosterEmail: { color: colors.text, fontSize: 14, flexShrink: 1 },
  rosterRole: { color: colors.textFaint, fontSize: 12, textTransform: "capitalize" },
  divider: { height: 1, backgroundColor: colors.borderSubtle },
  addRosterRow: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  row: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: 10, color: colors.text, fontSize: 14, flex: 1,
  },
  cellCard: { marginBottom: spacing.sm, gap: spacing.sm },
  cellRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cellId: { color: colors.text, fontSize: 13, fontWeight: "700", flex: 1 },
  cellAssignee: { color: colors.textMuted, fontSize: 12, maxWidth: 140 },
  assignChips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, paddingTop: spacing.xs },
  chip: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill,
    paddingHorizontal: spacing.md, paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.goldSoft, borderColor: colors.goldBorder },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextActive: { color: colors.gold, fontWeight: "700" },
});

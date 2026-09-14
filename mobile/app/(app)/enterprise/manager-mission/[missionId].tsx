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
  addMissionContributor, assignCells, generateMissionCells, scoreMissionCells,
  recomputeMissionProgress, fetchMissionProgressDetail,
  type Assignment, type MissionContributor, type MissionArea,
  type MissionProgress, type MissionProgressDetail,
} from "../../../../lib/enterprise/missions";
// Phase 3 (Solo→Team shared-targeting): the SAME band thresholds Solo's own
// confidence readout uses (shared/geo-core/confidence.ts) — reused here for
// display only, never recomputed. No new interpretation scale invented.
import { bandFor } from "../../../../../shared/geo-core/confidence.ts";

const TERMINAL = new Set(["completed", "skipped", "expired"]);

export default function ManagerMissionScreen() {
  const { missionId } = useLocalSearchParams<{ missionId: string }>();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [loading, setLoading] = useState(true);
  const [missionName, setMissionName] = useState("");
  const [targetObservationCount, setTargetObservationCount] = useState(0);
  const [targetCoveragePct, setTargetCoveragePct] = useState(0);
  const [areas, setAreas] = useState<MissionArea[]>([]);
  const [contributors, setContributors] = useState<MissionContributor[]>([]);
  const [cells, setCells] = useState<Assignment[]>([]);
  const [progress, setProgress] = useState<MissionProgress | null>(null);
  const [progressDetail, setProgressDetail] = useState<MissionProgressDetail | null>(null);
  const [expandedCell, setExpandedCell] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [scoring, setScoring] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addingContributor, setAddingContributor] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!missionId) return;
    setLoading(true);
    try {
      const [{ data: mission }, areaRows, contributorRows, cellRows, progressRow, detail] = await Promise.all([
        supabase.schema("enterprise").from("exploration_mission")
          .select("name,target_observation_count,target_coverage_pct").eq("id", missionId).maybeSingle(),
        fetchMissionAreas(missionId),
        fetchMissionContributors(missionId),
        fetchMissionAssignments(missionId),
        // Explicit on-demand recompute (Phase 2D refresh strategy) — every
        // time this screen opens, not on a trigger/cron. recompute returns
        // the fresh row directly, so this is the only progress round trip.
        recomputeMissionProgress(missionId),
        fetchMissionProgressDetail(missionId),
      ]);
      setMissionName((mission as any)?.name ?? "");
      setTargetObservationCount((mission as any)?.target_observation_count ?? 0);
      setTargetCoveragePct(Number((mission as any)?.target_coverage_pct ?? 0));
      setAreas(areaRows);
      setContributors(contributorRows);
      setCells(cellRows);
      setProgress(progressRow);
      setProgressDetail(detail);
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
      // STEP A (geometry) done — STEP B (score) follows immediately, scoped
      // to this area, so the manager sees priority the moment cells exist.
      // A scoring failure here is reported but does not undo cell creation:
      // the cells are real either way, "not yet scored" is itself an honest
      // state (see missions.ts's own Assignment.prospectivity_score comment).
      let scoreNote = "";
      try {
        const s = await scoreMissionCells(missionId, { areaId });
        scoreNote = so
          ? ` ${s.scored}/${s.requested} ayaa la qiimeeyay.`
          : ` ${s.scored}/${s.requested} scored.`;
      } catch (scoreErr) {
        scoreNote = so
          ? ` (Qiimeyntu way fashilantay: ${(scoreErr as Error).message})`
          : ` (Scoring failed: ${(scoreErr as Error).message})`;
      }
      Alert.alert(
        so ? "Waa la sameeyay" : "Done",
        (so
          ? `${r.totalCells} unug ayaa la helay, ${r.newlyCreated} oo cusub ayaa la abuuray.`
          : `${r.totalCells} cells found, ${r.newlyCreated} newly created.`) + scoreNote,
      );
      await load();
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setGenerating(null);
    }
  }

  /** Manual re-entry point for cells that predate scoring, or a fresh pass
   *  over the whole mission — the per-area call above covers the common case. */
  async function handleScoreAll() {
    if (!missionId) return;
    setScoring(true);
    try {
      const s = await scoreMissionCells(missionId);
      Alert.alert(
        so ? "Waa la qiimeeyay" : "Scored",
        so ? `${s.scored}/${s.requested} unug ayaa la qiimeeyay.` : `${s.scored}/${s.requested} cells scored.`,
      );
      await load();
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setScoring(false);
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

          <SectionLabel>{so ? "Horumarka (Progress)" : "Progress"}</SectionLabel>
          <Card style={styles.progressCard}>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel}>{so ? "Unugyo la qoondeeyay" : "Assigned cells"}</Text>
              <Text style={styles.progressValue}>{cells.length}</Text>
            </View>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel}>{so ? "Caddaymo la ururiyay" : "Samples collected"}</Text>
              <Text style={styles.progressValue}>{progress?.sample_count ?? 0}</Text>
            </View>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel}>{so ? "Indho-indhayn (observations)" : "Observations"}</Text>
              <Text style={styles.progressValue}>{progress?.observation_count ?? 0}</Text>
            </View>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel}>
                {so ? "Caddaymo ka baxsan qoondaynta" : "Outside-assignment samples"}
              </Text>
              <Text style={styles.progressValue}>{progressDetail?.outside_assignment_count ?? 0}</Text>
            </View>
            {(progressDetail?.per_contributor.length ?? 0) > 0 && (
              <View style={styles.perContributorBlock}>
                <Text style={styles.progressLabel}>{so ? "Xubin kasta" : "Per contributor"}</Text>
                {progressDetail!.per_contributor.map((row) => (
                  <View key={row.contributor_id} style={styles.perContributorRow}>
                    <Text style={styles.perContributorEmail} numberOfLines={1}>
                      {emailFor(row.contributor_id) ?? row.contributor_id}
                    </Text>
                    <Text style={styles.progressValue}>{row.sample_count}</Text>
                  </View>
                ))}
              </View>
            )}
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel}>{so ? "Waqtiga ugu dambeeyay" : "Last activity"}</Text>
              <Text style={styles.progressValue}>
                {progressDetail?.last_activity_at
                  ? new Date(progressDetail.last_activity_at).toLocaleString()
                  : (so ? "Wax lama diirin" : "None yet")}
              </Text>
            </View>
            {targetObservationCount > 0 && (
              <View style={styles.progressRow}>
                <Text style={styles.progressLabel}>{so ? "Bartilmaameedka indho-indhaynta" : "Target observations"}</Text>
                <Text style={styles.progressValue}>{targetObservationCount}</Text>
              </View>
            )}
            {targetCoveragePct > 0 && (
              <View style={styles.progressRow}>
                <Text style={styles.progressLabel}>{so ? "Bartilmaameedka daboolka" : "Target coverage"}</Text>
                <Text style={styles.progressValue}>{targetCoveragePct}%</Text>
              </View>
            )}
            <Text style={styles.mutedText}>
              {so
                ? "Daboolka unugyada (cell coverage) weli lama xisaabin — waxay u baahan tahay in la kaydiyo unugga H3 ee saxda ah ee caddaymo kasta, oo weli aan la dhisin."
                : "Cell-level coverage isn't calculated yet — it needs the exact H3 assignment cell each sample landed in to be persisted, which hasn't been built."}
            </Text>
            {progress?.updated_at && (
              <Text style={styles.progressUpdatedAt}>
                {so ? "La cusboonaysiiyay: " : "Updated: "}{new Date(progress.updated_at).toLocaleString()}
              </Text>
            )}
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
          <Button
            title={so ? "+ Aag AI ah oo la Talinayo" : "+ AI Recommended Area"}
            variant="outline"
            onPress={() => missionId && router.push(`/(app)/enterprise/recommend-area/${missionId}`)}
            style={styles.newAreaButton}
          />

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

          <View style={styles.h3SectionHeader}>
            <SectionLabel>{so ? "Unugyada H3 (la kala saaray)" : "H3 Cells (ranked)"}</SectionLabel>
            {cells.length > 0 && (
              <Button
                title={so ? "Qiimee Unugyada" : "Score Cells"}
                size="sm" variant="outline" loading={scoring}
                onPress={handleScoreAll}
              />
            )}
          </View>
          {cells.length === 0 ? (
            <Text style={styles.mutedText}>
              {so ? "Weli lama samayn unugyo. Kor ka dooro aag oo taabo \"Samee Unugyo\"." : "No cells generated yet. Pick an area above and tap \"Generate Cells\"."}
            </Text>
          ) : (
            cells.map((c, index) => {
              const isOpen = expandedCell === c.target_h3;
              const scored = c.prospectivity_score != null;
              const band = scored ? bandFor(c.prospectivity_score!) : null;
              return (
                <Card key={c.id} style={styles.cellCard}>
                  <Pressable onPress={() => setExpandedCell(isOpen ? null : c.target_h3)} style={styles.cellRow}>
                    <Text style={styles.cellRank}>#{index + 1}</Text>
                    <View style={styles.cellIdBlock}>
                      <Text style={styles.cellId} numberOfLines={1}>{c.target_h3}</Text>
                      <Text style={styles.cellAssignee} numberOfLines={1}>
                        {emailFor(c.contributor_id) ?? (so ? "bilaash" : "unassigned")}
                      </Text>
                    </View>
                    <Text style={[
                      styles.cellScore,
                      band === "High" && styles.bandHigh, band === "Moderate" && styles.bandModerate,
                    ]}>
                      {scored ? `${Math.round(c.prospectivity_score! * 100)}/100 · ${band}` : (so ? "lama qiimeynin" : "not scored")}
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
  progressCard: { marginBottom: spacing.sm, gap: 6 },
  progressRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  progressLabel: { color: colors.textMuted, fontSize: 13, flexShrink: 1 },
  progressValue: { color: colors.text, fontSize: 13, fontWeight: "700" },
  perContributorBlock: { gap: 4, marginTop: 2 },
  perContributorRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingLeft: spacing.sm,
  },
  perContributorEmail: { color: colors.textMuted, fontSize: 12, flexShrink: 1 },
  progressUpdatedAt: { color: colors.textFaint, fontSize: 11, fontStyle: "italic", marginTop: 2 },
  mutedText: { color: colors.textFaint, fontSize: 12, fontStyle: "italic", marginBottom: spacing.sm },
  areaRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: colors.surfaceAlt, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.sm,
  },
  areaName: { color: colors.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  newAreaButton: { marginBottom: spacing.sm },
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
  h3SectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cellCard: { marginBottom: spacing.sm, gap: spacing.sm },
  cellRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cellRank: { color: colors.textFaint, fontSize: 12, fontWeight: "700", width: 28 },
  cellIdBlock: { flex: 1, gap: 2 },
  cellId: { color: colors.text, fontSize: 13, fontWeight: "700" },
  cellAssignee: { color: colors.textMuted, fontSize: 12, maxWidth: 140 },
  cellScore: { color: colors.textFaint, fontSize: 12, fontWeight: "700" },
  bandModerate: { color: colors.gold },
  bandHigh: { color: colors.gold },
  assignChips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, paddingTop: spacing.xs },
  chip: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill,
    paddingHorizontal: spacing.md, paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.goldSoft, borderColor: colors.goldBorder },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextActive: { color: colors.gold, fontWeight: "700" },
});

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
import { supabase } from "../../../../lib/supabase";
import {
  fetchMissionAssignments, fetchMissionContributors, fetchMissionAreas,
  addMissionContributor, assignCells, unassignMissionCellContributor,
  generateMissionCells, scoreMissionCells, groupMissionCells,
  recomputeMissionProgress, fetchMissionProgressDetail,
  generateCellSynthesis, fetchCellSynthesis, createFollowupMission,
  type Assignment, type MissionContributor, type MissionArea,
  type MissionProgress, type MissionProgressDetail, type MissionCellGroup, type CellSynthesis,
} from "../../../../lib/enterprise/missions";
// Phase 3 (Solo→Team shared-targeting): the SAME band thresholds Solo's own
// confidence readout uses (shared/geo-core/confidence.ts) — reused here for
// display only, never recomputed. No new interpretation scale invented.
import { bandFor } from "../../../../../shared/geo-core/confidence.ts";

// Phase 7 — the fixed vocabulary enterprise.cell_synthesis.agreement is
// constrained to (0130); bilingual display labels.
const AGREEMENT_LABEL: Record<string, { en: string; so: string }> = {
  consistent: { en: "Consistent", so: "Isku mid" },
  mixed: { en: "Mixed", so: "Isku dhafan" },
  conflicting: { en: "Conflicting", so: "Iska hor imaad" },
  insufficient_data: { en: "Not enough data yet", so: "Xog kuma filna weli" },
};

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
  // Phase 7 — cross-contributor synthesis, keyed by target_h3. Fetched lazily
  // (existing saved result) when a multi-contributor cell is opened; only
  // regenerated (a real API call) when the manager explicitly asks.
  const [synthesis, setSynthesis] = useState<Record<string, CellSynthesis>>({});
  const [synthesizing, setSynthesizing] = useState<string | null>(null);
  // Phase 9 — follow-up mission, named after the source's best-scoring cell.
  const [followupName, setFollowupName] = useState("");
  const [creatingFollowup, setCreatingFollowup] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);
  const [scoring, setScoring] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addingContributor, setAddingContributor] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);

  // Phase 4: one card per H3 CELL, not per assignment row — a cell with
  // three contributors is still ONE geological ranking, never three.
  const cellGroups = useMemo(() => groupMissionCells(cells), [cells]);

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

  /** Phase 4: additive, never destructive — assigning a contributor to a
   *  cell others already hold never removes them. No confirmation needed:
   *  the only action that removes anyone is the explicit Unassign below. */
  async function handleAssignAlso(group: MissionCellGroup, contributor: MissionContributor) {
    if (!missionId) return;
    setAssigning(group.targetH3);
    try {
      await assignCells(missionId, [group.targetH3], contributor.contributor_id);
      await load();
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setAssigning(null);
    }
  }

  /** The one action that actually removes someone — confirmed, since unlike
   *  assigning, this is the destructive direction. */
  function handleUnassign(group: MissionCellGroup, contributor: Assignment) {
    if (!missionId) return;
    const email = emailFor(contributor.contributor_id) ?? contributor.contributor_id;
    Alert.alert(
      so ? "Ka saar?" : "Unassign?",
      so
        ? `${email} ka saar unugan? Unugga, isku-dhafkiisa (score) iyo caddaymaha la soo gudbiyay waa sii jiri doonaan.`
        : `Remove ${email} from this cell? The cell, its score, and any evidence already submitted stay exactly as they are.`,
      [
        { text: so ? "Jooji" : "Cancel", style: "cancel" },
        {
          text: so ? "Ka saar" : "Unassign", style: "destructive",
          onPress: async () => {
            setAssigning(group.targetH3);
            try {
              await unassignMissionCellContributor(missionId, group.targetH3, contributor.contributor_id!);
              await load();
            } catch (err) {
              Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
            } finally {
              setAssigning(null);
            }
          },
        },
      ],
    );
  }

  /** Opening a multi-contributor cell silently checks for an already-saved
   *  synthesis (free — a read) without generating a new one (a Claude call,
   *  costs money) — that only happens when the manager taps "Synthesize". */
  function handleToggleCell(group: MissionCellGroup) {
    const opening = expandedCell !== group.targetH3;
    setExpandedCell(opening ? group.targetH3 : null);
    if (opening && group.contributors.length > 1 && !synthesis[group.targetH3] && missionId) {
      fetchCellSynthesis(missionId, group.targetH3)
        .then((s) => { if (s) setSynthesis((prev) => ({ ...prev, [group.targetH3]: s })); })
        .catch(() => {});
    }
  }

  async function handleSynthesize(group: MissionCellGroup) {
    if (!missionId) return;
    setSynthesizing(group.targetH3);
    try {
      const s = await generateCellSynthesis(missionId, group.targetH3);
      setSynthesis((prev) => ({ ...prev, [group.targetH3]: s }));
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setSynthesizing(null);
    }
  }

  /** Phase 9 — spins off a new mission from this one's best-scoring cell.
   *  The server picks the cell and its score; this only names the mission. */
  async function handleCreateFollowup() {
    if (!missionId || !followupName.trim()) return;
    setCreatingFollowup(true);
    try {
      const f = await createFollowupMission(missionId, followupName.trim());
      setFollowupName("");
      Alert.alert(
        so ? "Mission cusub ayaa la abuuray" : "Follow-up mission created",
        so
          ? `Waxaa lagu saleeyay unugga ugu qiimaha sarreeya (${Math.round(f.sourceScore * 100)}/100).`
          : `Based on the best-scoring cell (${Math.round(f.sourceScore * 100)}/100).`,
        [
          { text: so ? "Hagaag" : "OK" },
          { text: so ? "Fur" : "Open", onPress: () => router.push(`/(app)/enterprise/manager-mission/${f.missionId}`) },
        ],
      );
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setCreatingFollowup(false);
    }
  }

  const emailFor = (id: string | null) => contributors.find((c) => c.contributor_id === id)?.email;
  const unassignedCount = cellGroups.filter((g) => g.contributors.length === 0).length;

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
                ? `${cellGroups.length} unug · ${cellGroups.length - unassignedCount} la qoondeeyay · ${unassignedCount} bilaash`
                : `${cellGroups.length} cells · ${cellGroups.length - unassignedCount} assigned · ${unassignedCount} unassigned`}
            </Text>
          </Card>

          <SectionLabel>{so ? "Horumarka (Progress)" : "Progress"}</SectionLabel>
          <Card style={styles.progressCard}>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel}>{so ? "Unugyo la sameeyay" : "Generated cells"}</Text>
              <Text style={styles.progressValue}>{cellGroups.length}</Text>
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
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel}>{so ? "Daboolka unugyada (dhab ah)" : "Cell coverage (actual)"}</Text>
              <Text style={styles.progressValue}>{progress?.coverage_pct ?? 0}%</Text>
            </View>
            <Text style={styles.mutedText}>
              {so
                ? "Boqolkiiba unugyada la sameeyay oo ay ku jiraan ugu yaraan hal caddeyn — la xisaabiyay iyadoo la isticmaalayo unugga H3 ee saxda ah ee caddeyn kasta ay ku dhacday (Phase 5)."
                : "Percentage of generated cells that have at least one sample landing in them — computed from the exact H3 assignment cell each sample fell in (Phase 5)."}
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
                <View style={styles.areaRowButtons}>
                  <Button
                    title={so ? "Dib u eeg" : "Review"}
                    size="sm" variant="outline"
                    onPress={() => router.push(`/(app)/enterprise/area-review/${a.area_id}?missionId=${missionId}`)}
                  />
                  <Button
                    title={so ? "Samee Unugyo" : "Generate Cells"}
                    size="sm" variant="outline"
                    loading={generating === a.area_id}
                    onPress={() => handleGenerate(a.area_id)}
                  />
                </View>
              </View>
            ))
          )}
          <Button
            title={so ? "+ Aag AI ah oo la Talinayo" : "+ AI Recommended Area"}
            variant="outline"
            onPress={() => missionId && router.push(`/(app)/enterprise/recommend-area/${missionId}`)}
            style={styles.newAreaButton}
          />
          {areas.length > 0 && (
            <Button
              title={so ? "🔍 Raadi (Fudud)" : "🔍 Find (Simple Mode)"}
              variant="outline"
              onPress={() => missionId && router.push(`/(app)/enterprise/find-gold-start/${missionId}`)}
              style={styles.newAreaButton}
            />
          )}
          <Button
            title={so ? "🗺️ Sahami Gobolka" : "🗺️ Scan a Region"}
            variant="outline"
            onPress={() => missionId && router.push(`/(app)/enterprise/discover-region/${missionId}`)}
            style={styles.newAreaButton}
          />
          {areas.length >= 2 && (
            <Button
              title={so ? "Isbarbardhig Aagagga" : "Compare Areas"}
              variant="outline"
              onPress={() => missionId && router.push(`/(app)/enterprise/compare-areas/${missionId}`)}
              style={styles.newAreaButton}
            />
          )}

          {cellGroups.some((g) => g.prospectivityScore != null) && (
            <>
              <SectionLabel>{so ? "Mission Xigta (Follow-up)" : "Follow-up Mission"}</SectionLabel>
              <Card>
                <Text style={styles.mutedText}>
                  {so
                    ? "Waxay ku bilaabmaysaa unugga mission-kan ugu qiimaha sarreeya."
                    : "Starts from this mission's best-scoring cell."}
                </Text>
                <View style={[styles.row, styles.addRosterRow]}>
                  <TextInput
                    style={styles.input}
                    placeholder={so ? "Magaca mission-ka cusub" : "New mission name"}
                    placeholderTextColor={colors.textFaint}
                    value={followupName}
                    onChangeText={setFollowupName}
                  />
                  <Button
                    title={so ? "Abuur" : "Create"}
                    size="sm" loading={creatingFollowup} disabled={!followupName.trim()}
                    onPress={handleCreateFollowup}
                  />
                </View>
              </Card>
            </>
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

          <View style={styles.h3SectionHeader}>
            <SectionLabel>{so ? "Unugyada H3 (la kala saaray)" : "H3 Cells (ranked)"}</SectionLabel>
            {cellGroups.length > 0 && (
              <Button
                title={so ? "Qiimee Unugyada" : "Score Cells"}
                size="sm" variant="outline" loading={scoring}
                onPress={handleScoreAll}
              />
            )}
          </View>
          {cellGroups.length === 0 ? (
            <Text style={styles.mutedText}>
              {so ? "Weli lama samayn unugyo. Kor ka dooro aag oo taabo \"Samee Unugyo\"." : "No cells generated yet. Pick an area above and tap \"Generate Cells\"."}
            </Text>
          ) : (
            cellGroups.map((group, index) => {
              const isOpen = expandedCell === group.targetH3;
              const scored = group.prospectivityScore != null;
              const band = scored ? bandFor(group.prospectivityScore!) : null;
              // Roster members not currently holding this cell — tapping
              // one of these is additive ("assign also"), never a replace.
              const assignableContributors = contributors.filter(
                (ct) => !group.contributors.some((a) => a.contributor_id === ct.contributor_id),
              );
              return (
                <Card key={group.targetH3} style={styles.cellCard}>
                  <Pressable onPress={() => handleToggleCell(group)} style={styles.cellRow}>
                    <Text style={styles.cellRank}>#{index + 1}</Text>
                    <View style={styles.cellIdBlock}>
                      <Text style={styles.cellId} numberOfLines={1}>{group.targetH3}</Text>
                      <Text style={styles.cellAssignee} numberOfLines={1}>
                        {group.contributors.length === 0
                          ? (so ? "bilaash" : "unassigned")
                          : group.contributors.length === 1
                            ? (emailFor(group.contributors[0].contributor_id) ?? group.contributors[0].contributor_id)
                            : (so ? `${group.contributors.length} qof` : `${group.contributors.length} people`)}
                      </Text>
                    </View>
                    <Text style={[
                      styles.cellScore,
                      band === "High" && styles.bandHigh, band === "Moderate" && styles.bandModerate,
                    ]}>
                      {scored ? `${Math.round(group.prospectivityScore! * 100)}/100 · ${band}` : (so ? "lama qiimeynin" : "not scored")}
                    </Text>
                    <Ionicons name={isOpen ? "chevron-up" : "chevron-down"} size={16} color={colors.textFaint} />
                  </Pressable>
                  {isOpen && (
                    <View style={styles.assignSection}>
                      {group.integratedScore != null && (
                        <View style={styles.integratedRow}>
                          <Text style={styles.integratedLabel}>
                            {so ? "Isku-dhafan (caddeyn la geliyay)" : "Integrated (with evidence)"}
                          </Text>
                          <Text style={styles.integratedValue}>
                            {Math.round(group.integratedScore * 100)}/100
                            {" · "}
                            {so ? `${group.evidenceSampleCount} muunad` : `${group.evidenceSampleCount} sample(s)`}
                          </Text>
                        </View>
                      )}
                      <Text style={styles.assignSectionLabel}>
                        {so ? "Loo qoondeeyay:" : "Assigned:"}
                      </Text>
                      {group.contributors.length === 0 ? (
                        <Text style={styles.mutedText}>{so ? "Cid weli looma qoondeynin." : "Nobody assigned yet."}</Text>
                      ) : (
                        <View style={styles.assignChips}>
                          {group.contributors.map((a) => (
                            <Pressable
                              key={a.contributor_id}
                              style={[styles.chip, styles.chipActive]}
                              disabled={assigning === group.targetH3}
                              onPress={() => handleUnassign(group, a)}
                            >
                              <Text style={styles.chipTextActive}>
                                {emailFor(a.contributor_id) ?? a.contributor_id} ✕
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      )}
                      <Text style={[styles.assignSectionLabel, styles.assignAlsoLabel]}>
                        {so ? "Ku dar (u shaqee sidoo kale):" : "Assign also:"}
                      </Text>
                      {assignableContributors.length === 0 ? (
                        <Text style={styles.mutedText}>
                          {contributors.length === 0
                            ? (so ? "Marka hore koox ku dar." : "Add someone to the roster first.")
                            : (so ? "Dhammaan xubnaha koox-ka waa loo qoondeeyay." : "Every roster member is already assigned to this cell.")}
                        </Text>
                      ) : (
                        <View style={styles.assignChips}>
                          {assignableContributors.map((ct) => (
                            <Pressable
                              key={ct.contributor_id}
                              style={styles.chip}
                              disabled={assigning === group.targetH3}
                              onPress={() => handleAssignAlso(group, ct)}
                            >
                              <Text style={styles.chipText}>{ct.email}</Text>
                            </Pressable>
                          ))}
                        </View>
                      )}
                      {group.contributors.length > 1 && (
                        <View style={styles.synthesisSection}>
                          <View style={styles.synthesisHeader}>
                            <Text style={[styles.assignSectionLabel, styles.assignAlsoLabel]}>
                              {so ? "Isbarbardhig (AI)" : "Cross-check (AI)"}
                            </Text>
                            <Pressable
                              style={styles.synthesizeBtn}
                              disabled={synthesizing === group.targetH3}
                              onPress={() => handleSynthesize(group)}
                            >
                              {synthesizing === group.targetH3
                                ? <ActivityIndicator color={colors.gold} size="small" />
                                : <Text style={styles.synthesizeBtnText}>
                                    {synthesis[group.targetH3] ? (so ? "Dib u samee" : "Regenerate") : (so ? "Isbarbardhig" : "Synthesize")}
                                  </Text>}
                            </Pressable>
                          </View>
                          {synthesis[group.targetH3] && (
                            <View>
                              <Text style={styles.synthesisAgreement}>
                                {AGREEMENT_LABEL[synthesis[group.targetH3].agreement]?.[so ? "so" : "en"] ?? synthesis[group.targetH3].agreement}
                              </Text>
                              <Text style={styles.synthesisHeadline}>
                                {so ? synthesis[group.targetH3].headline_so : synthesis[group.targetH3].headline}
                              </Text>
                              <Text style={styles.synthesisNarrative}>
                                {so ? synthesis[group.targetH3].narrative_so : synthesis[group.targetH3].narrative}
                              </Text>
                            </View>
                          )}
                        </View>
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
  areaRowButtons: { flexDirection: "row", gap: spacing.xs },
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
  assignSection: { gap: 4, paddingTop: spacing.xs },
  integratedRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: colors.goldSoft, borderRadius: radius.md, borderWidth: 1, borderColor: colors.goldBorder,
    paddingHorizontal: spacing.sm, paddingVertical: 6, marginBottom: spacing.sm,
  },
  integratedLabel: { color: colors.gold, fontSize: 11, fontWeight: "700" },
  integratedValue: { color: colors.gold, fontSize: 11, fontWeight: "800" },
  assignSectionLabel: { color: colors.textFaint, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  assignAlsoLabel: { marginTop: spacing.sm },
  assignChips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, paddingTop: spacing.xs },
  chip: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill,
    paddingHorizontal: spacing.md, paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.goldSoft, borderColor: colors.goldBorder },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextActive: { color: colors.gold, fontWeight: "700" },
  synthesisSection: { marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, gap: 4 },
  synthesisHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  synthesizeBtn: {
    borderWidth: 1, borderColor: colors.goldBorder, backgroundColor: colors.goldSoft,
    borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6, minWidth: 84, alignItems: "center",
  },
  synthesizeBtnText: { color: colors.gold, fontWeight: "700", fontSize: 12 },
  synthesisAgreement: { color: colors.gold, fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: spacing.xs },
  synthesisHeadline: { color: colors.text, fontSize: 13, fontWeight: "700", marginTop: 2 },
  synthesisNarrative: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 3 },
});

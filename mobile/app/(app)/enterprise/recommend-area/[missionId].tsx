// AI Recommended Area — Phase 2 (Solo→Team shared-targeting).
//
// The manager's workflow: locate → request a recommendation from the SAME
// deterministic engine Solo Exploration uses (via team-targeting, a
// read-only call — nothing is created yet) → review the ranked candidates →
// explicitly accept ONE → only then does accept-recommended-area create a
// real exploration_area, linked to this mission.
//
// Reuses the app's existing GPS capture (captureSampleLocation, the same one
// new-sample.tsx uses) with the same manual "lat, lng" paste fallback — no
// new map system. There is no H3 hex-map renderer anywhere in this app yet
// (see manager-mission/[missionId].tsx's own header note), so the review
// step is a ranked list, exactly like that screen's H3-cell list.
import React, { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Alert } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing, radius } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { SectionLabel } from "../../../../components/ui/SectionLabel";
import { captureSampleLocation } from "../../../../lib/enterpriseSamples";
import {
  fetchTeamTargetRecommendation, acceptRecommendedArea, createManualArea,
  type TeamTargetCandidate, type TeamTargetingResult,
} from "../../../../lib/enterprise/missions";
// Same band thresholds every other score readout in the app uses (Phase 3) —
// needed here because `result.current` (see bug note below) carries only a
// raw score, never a band, the way `result.targets[]` entries already do.
import { bandFor } from "../../../../../shared/geo-core/confidence.ts";

type Stage = "locate" | "review" | "confirm";

function shortCell(cell: string): string {
  return `${cell.slice(0, 4)}…${cell.slice(-4)}`;
}

function reasonLabel(r: Record<string, unknown>): string {
  const kind = String(r.kind ?? "");
  switch (kind) {
    case "occurrence": return `${r.commodity} occurrence ${Math.round(Number(r.distanceM ?? 0))} m away`;
    case "association": return `${r.commodity} associated with host rocks here`;
    case "community": return `${r.count} verified find(s) recorded nearby`;
    case "observation": return `${r.label} recorded ${Math.round(Number(r.distanceM ?? 0))} m away`;
    case "fault": return `Fault ${Math.round(Number(r.distanceM ?? 0))} m away`;
    case "contact": return `Contact ${Math.round(Number(r.distanceM ?? 0))} m away`;
    case "intersection": return `Fault/contact intersection ${Math.round(Number(r.distanceM ?? 0))} m away`;
    case "unit": return `Mapped unit: ${r.name}`;
    default: return kind || "evidence";
  }
}

export default function RecommendAreaScreen() {
  const { missionId } = useLocalSearchParams<{ missionId: string }>();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [stage, setStage] = useState<Stage>("locate");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [locating, setLocating] = useState(false);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [result, setResult] = useState<TeamTargetingResult | null>(null);
  const [selected, setSelected] = useState<TeamTargetCandidate | null>(null);
  const [areaName, setAreaName] = useState("");
  const [accepting, setAccepting] = useState(false);
  // True when the manager chose to create the area by hand, with no AI
  // score involved — e.g. after "no evidence found" for a spot they already
  // know matters (a mapped fault, etc; see EVIDENCE_CAVEAT).
  const [manualMode, setManualMode] = useState(false);

  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  const hasValidCoords =
    lat.trim() !== "" && lng.trim() !== "" &&
    Number.isFinite(parsedLat) && Number.isFinite(parsedLng) &&
    parsedLat >= -90 && parsedLat <= 90 && parsedLng >= -180 && parsedLng <= 180;

  async function grabLocation() {
    setLocating(true);
    try {
      const l = await captureSampleLocation();
      if (!l) {
        Alert.alert(
          so ? "Goobta lama helin" : "Location unavailable",
          so ? "Fasax GPS ma jiro — geli xarafaha si gacanta ah." : "No GPS fix — grant location permission or enter coordinates manually.",
        );
        return;
      }
      setLat(String(l.lat));
      setLng(String(l.lng));
    } finally {
      setLocating(false);
    }
  }

  // Accepts "lat, lng" pasted into either field — same UX as new-sample.tsx.
  function onLatChange(v: string) {
    const m = v.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) { setLat(m[1]); setLng(m[2]); return; }
    setLat(v);
  }

  async function requestRecommendation() {
    if (!hasValidCoords) return;
    setLoadingTargets(true);
    try {
      const r = await fetchTeamTargetRecommendation(parsedLat, parsedLng, {});
      setResult(r);
      setStage("review");
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setLoadingTargets(false);
    }
  }

  function chooseTarget(t: TeamTargetCandidate) {
    setSelected(t);
    setManualMode(false);
    setAreaName(`AI Target ${shortCell(t.cell)}`);
    setStage("confirm");
  }

  /**
   * BUG FIX: `team-targeting` ranks NEIGHBORING cells only — `result.current`
   * (the exact queried point's own cell) is deliberately excluded from
   * `targets` (targetingEngine.ts's `rank()`: `kRing(here, rings).filter(c
   * => c !== here)`). The server already tells the client which is actually
   * best via `bestIsHere`, but this screen never read `current`/`bestIsHere`
   * at all — so entering the exact coordinates of a real, on-record
   * occurrence (the best possible answer, sitting right at "here") rendered
   * as "no evidence found", even though the engine had already found it and
   * scored it highly. `current` only carries a raw score (not a full
   * candidate), so the rest of the fields are synthesized for display only —
   * accept() still only ever sends the cell id, never a client-trusted score.
   */
  function chooseCurrent() {
    if (!result) return;
    const synthetic: TeamTargetCandidate = {
      cell: result.current.cell,
      centre: { lat: parsedLat, lng: parsedLng },
      bearingDeg: 0, compass: "",
      distanceM: 0,
      score: result.current.score,
      reportScore: result.current.score,
      band: bandFor(result.current.score),
      reasons: [],
      commodities: [],
      scoredForCommodity: null,
    };
    setSelected(synthetic);
    setManualMode(false);
    setAreaName(so ? `Halkan Qudheeda ${shortCell(result.current.cell)}` : `This Location ${shortCell(result.current.cell)}`);
    setStage("confirm");
  }

  /** No AI score, no evidence requirement — the manager already knows this
   *  location matters. Uses the lat/lng already entered on the locate step. */
  function chooseManual() {
    setSelected(null);
    setManualMode(true);
    setAreaName(so ? "Aag gacanta lagu abuuray" : "Manually created area");
    setStage("confirm");
  }

  async function accept() {
    if (!missionId || !areaName.trim()) return;
    setAccepting(true);
    try {
      if (manualMode) {
        const area = await createManualArea(missionId, areaName.trim(), parsedLat, parsedLng);
        Alert.alert(
          so ? "Aag ayaa la abuuray" : "Area created",
          so
            ? `"${area.name}" waxa lagu abuuray ${area.cellCount} unug oo H3 ah — ma jirin qiimayn AI ah.`
            : `"${area.name}" was created, spanning ${area.cellCount} H3 cells — no AI scoring involved.`,
        );
      } else {
        if (!selected) return;
        const area = await acceptRecommendedArea(missionId, selected.cell, areaName.trim(), selected.scoredForCommodity);
        Alert.alert(
          so ? "Aag ayaa la abuuray" : "Area created",
          so
            ? `"${area.name}" waxa lagu abuuray ${area.cellCount} unug oo H3 ah oo ku wareegsan target-ka.`
            : `"${area.name}" was created, spanning ${area.cellCount} H3 cells around the recommended target.`,
        );
      }
      router.back();
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setAccepting(false);
    }
  }

  const caveat = result?.evidenceCaveat ?? null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => (stage === "locate" ? router.back() : setStage(stage === "confirm" ? "review" : "locate"))}
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{so ? "Aag AI ah oo la Talinayo" : "AI Recommended Area"}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {stage === "locate" && (
          <>
            <SectionLabel>{so ? "Bilowga goobta" : "Starting point"}</SectionLabel>
            <Text style={styles.mutedText}>
              {so
                ? "Geli meesha aad rabto in engine-ku ka bilaabo raadinta target-ka — waxaad isticmaali kartaa GPS-kaaga hadda ama xarafo gacanta ah."
                : "Where should the engine start searching for a target? Use your current GPS position, or enter coordinates manually."}
            </Text>
            <Card style={styles.card}>
              <View style={styles.row}>
                <TextInput
                  style={styles.input}
                  placeholder={so ? "latitude (ama koobi 'lat, lng')" : "latitude (or paste 'lat, lng')"}
                  placeholderTextColor={colors.textFaint}
                  keyboardType="numbers-and-punctuation"
                  value={lat}
                  onChangeText={onLatChange}
                />
                <TextInput
                  style={styles.input}
                  placeholder={so ? "longitude" : "longitude"}
                  placeholderTextColor={colors.textFaint}
                  keyboardType="numbers-and-punctuation"
                  value={lng}
                  onChangeText={setLng}
                />
              </View>
              <Button
                title={so ? "Isticmaal GPS-ka hadda" : "Use current GPS location"}
                variant="outline" size="sm" loading={locating} onPress={grabLocation}
              />
            </Card>
            <Button
              title={so ? "Hel Talooyinka" : "Get Recommendations"}
              disabled={!hasValidCoords}
              loading={loadingTargets}
              onPress={requestRecommendation}
              style={styles.primaryButton}
            />
          </>
        )}

        {stage === "review" && result && (
          <>
            {caveat && (
              <Card style={styles.caveatCard}>
                <Text style={styles.caveatText}>{caveat}</Text>
              </Card>
            )}

            {/* The exact point the manager entered — often the actual best
                answer (e.g. the coordinates ARE a known occurrence), but
                never listed under "Ranked targets" below since that list is
                deliberately neighbors-only. */}
            <SectionLabel>{so ? "Halkan Qudheeda (goobta aad gelisay)" : "This Exact Location"}</SectionLabel>
            <Pressable onPress={chooseCurrent}>
              <Card style={[styles.targetCard, result.bestIsHere && styles.bestHereCard]}>
                <View style={styles.targetHeader}>
                  <Text style={styles.targetCell}>{shortCell(result.current.cell)}</Text>
                  <Text style={[
                    styles.targetScore,
                    bandFor(result.current.score) === "High" && styles.bandHigh,
                    bandFor(result.current.score) === "Moderate" && styles.bandModerate,
                  ]}>
                    {Math.round(result.current.score * 100)}/100 · {bandFor(result.current.score)}
                  </Text>
                </View>
                {result.bestIsHere && (
                  <Text style={styles.bestHereLabel}>
                    {so ? "★ Tanina ka fiican tahay dhammaan target-yada kale" : "★ Better than every ranked target below"}
                  </Text>
                )}
              </Card>
            </Pressable>

            <SectionLabel>{so ? "Target-yada la kala saaray (deriska)" : "Ranked targets (neighbors)"}</SectionLabel>
            {result.targets.length === 0 ? (
              <>
                <Text style={styles.mutedText}>
                  {so
                    ? "Deriska ku xeeran wax caddeyn dheeraad ah lagama helin — server-ku weli ma arki karo fault/terrain/lithology (waa xaddidaad hadda jirta, ma aha khalad). Isticmaal \"Halkan Qudheeda\" kor ku yaal, ama haddii aad shakhsi ahaan ogtahay meel kale oo muhiim ah, aag ka samee gacanta."
                    : "No additional evidence found in the surrounding cells — the server can't yet see structural/terrain/lithology evidence (a known current limitation, not a bug). Use \"This Exact Location\" above, or if you know a different spot matters, create the area by hand."}
                </Text>
                <Button
                  title={so ? "Halkan Aag ka samee (gacanta)" : "Create Area Here (manual)"}
                  variant="outline"
                  onPress={chooseManual}
                  style={styles.primaryButton}
                />
              </>
            ) : (
              result.targets.map((t) => (
                <Pressable key={t.cell} onPress={() => chooseTarget(t)}>
                  <Card style={styles.targetCard}>
                    <View style={styles.targetHeader}>
                      <Text style={styles.targetCell}>{shortCell(t.cell)}</Text>
                      <Text style={[styles.targetScore, t.band === "High" && styles.bandHigh, t.band === "Moderate" && styles.bandModerate]}>
                        {Math.round(t.score * 100)}/100 · {t.band}
                      </Text>
                    </View>
                    <Text style={styles.targetMeta}>
                      {Math.round(t.distanceM)} m {t.compass} {t.commodities.length > 0 ? `· ${t.commodities.join(", ")}` : ""}
                    </Text>
                    {t.reasons.slice(0, 3).map((r, i) => (
                      <Text key={i} style={styles.reasonText}>• {reasonLabel(r)}</Text>
                    ))}
                  </Card>
                </Pressable>
              ))
            )}
          </>
        )}

        {stage === "confirm" && (manualMode || selected) && (
          <>
            <SectionLabel>{so ? "Xaqiiji Aagga" : "Confirm area"}</SectionLabel>
            <Card style={styles.card}>
              {manualMode ? (
                <Text style={styles.mutedText}>
                  {so
                    ? "Aagan gacanta ayaa loo abuurayaa — ma jiro qiimayn AI ah, adiga ayaa go'aansaday in halkan muhiim tahay."
                    : "This area is being created by hand — no AI score, you decided this location matters."}
                </Text>
              ) : (
                <>
                  <Text style={styles.confirmScore}>
                    {Math.round(selected!.score * 100)}/100 · {selected!.band} — {shortCell(selected!.cell)}
                  </Text>
                  <Text style={styles.mutedText}>
                    {so
                      ? "Marka aad xaqiijiso, server-ku dib buu u xisaabin doonaa isku dhafka (score) haddana wax lama isticmaali doono wixii aad ka aragtay bogga hore — waana natiijada ugu dambeysa."
                      : "On accept, the server recomputes this score fresh — nothing you saw on the previous screen is trusted as final."}
                  </Text>
                </>
              )}
              <SectionLabel>{so ? "Magaca Aagga" : "Area name"}</SectionLabel>
              <TextInput
                style={styles.input}
                placeholder={so ? "Magaca aagga" : "Area name"}
                placeholderTextColor={colors.textFaint}
                value={areaName}
                onChangeText={setAreaName}
              />
            </Card>
            {caveat && !manualMode && (
              <Card style={styles.caveatCard}>
                <Text style={styles.caveatText}>{caveat}</Text>
              </Card>
            )}
            <Button
              title={so ? "Xaqiiji oo Samee Aag" : "Accept & Create Area"}
              disabled={!areaName.trim()}
              loading={accepting}
              onPress={accept}
              style={styles.primaryButton}
            />
          </>
        )}
      </ScrollView>
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
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: 40 },
  mutedText: { color: colors.textFaint, fontSize: 12, fontStyle: "italic", marginBottom: spacing.sm },
  card: { gap: spacing.sm, marginBottom: spacing.sm },
  row: { flexDirection: "row", gap: spacing.sm },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: 10, color: colors.text, fontSize: 14, flex: 1,
  },
  primaryButton: { marginTop: spacing.sm },
  caveatCard: { backgroundColor: colors.surfaceAlt, marginBottom: spacing.sm },
  caveatText: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  targetCard: { marginBottom: spacing.sm, gap: 4 },
  bestHereCard: { borderColor: colors.goldBorder, backgroundColor: colors.goldSoft },
  bestHereLabel: { color: colors.gold, fontSize: 11, fontWeight: "700" },
  targetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  targetCell: { color: colors.text, fontSize: 14, fontWeight: "700" },
  targetScore: { color: colors.textMuted, fontSize: 13, fontWeight: "700" },
  bandModerate: { color: colors.gold },
  bandHigh: { color: colors.gold },
  targetMeta: { color: colors.textFaint, fontSize: 12 },
  reasonText: { color: colors.textMuted, fontSize: 12 },
  confirmScore: { color: colors.gold, fontSize: 15, fontWeight: "700" },
});

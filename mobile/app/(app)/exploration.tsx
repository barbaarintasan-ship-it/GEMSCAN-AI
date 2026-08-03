// Exploration Mode — the screen for workflow steps 1–8 (Stage E4).
//
// Everything shown here comes from the orchestrator snapshot; this file holds
// no exploration logic of its own. Three rules from the architecture shape the
// layout more than anything visual:
//
//   Invariant 2 — no unexplained recommendation. The REASON sits next to the
//     bearing, not behind a tap, because a user with no geological training is
//     being asked to walk somewhere.
//   Risk 3 — stale packs. Pack version and age are always visible, so guidance
//     from months-old knowledge is never mistaken for current knowledge.
//   Bilingual — a Somali geologist who reads no English must be able to run a
//     session. Nothing user-facing is hardcoded here, including the REASONS,
//     which arrive STRUCTURED from the engine precisely so they can be rendered
//     in either language rather than as pre-built English sentences.
import React from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { colors, radius, spacing } from "../../lib/theme";
import { ExplorationProvider, useExploration } from "../../lib/exploration/provider";
import type { ExplorationTarget, TargetReason } from "../../lib/geo/targeting.ts";
import { WAYPOINT_TYPES, waypointTypeLabelKey, type WaypointType } from "../../lib/field/waypointTypes";

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export default function ExplorationRoute() {
  const { t } = useTranslation();
  return (
    <ExplorationProvider>
      <Stack.Screen options={{ title: t("field.title") }} />
      <ExplorationScreen />
    </ExplorationProvider>
  );
}

function ExplorationScreen() {
  const { t } = useTranslation();
  const { snapshot: s, actions } = useExploration();
  const running = s.state !== "idle" && s.state !== "ended";

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <PackBanner provenance={s.packProvenance} hasKnowledge={s.hasKnowledge} running={running} />

      {!running ? (
        <StartCard onStart={actions.start} />
      ) : (
        <>
          <StatusLine state={s.state} suspendedBy={s.suspendedBy} />
          <HereCard unit={unitOf(s.context)} cell={s.currentCell} bestIsHere={s.bestIsHere} />

          {s.state === "awaitingEvidence" && (
            <EvidenceCard onCapture={(type: WaypointType) => void actions.captureObservation(type)} />
          )}

          {s.activeTarget ? (
            <TargetCard
              target={s.activeTarget}
              distanceM={s.distanceToTargetM}
              relativeBearing={s.relativeBearingDeg}
            />
          ) : (
            <NoTargetCard hasKnowledge={s.hasKnowledge} />
          )}

          {s.targets.length > 1 && (
            <OtherTargets
              targets={s.targets.filter((x) => x.cell !== s.activeTarget?.cell)}
              onSelect={actions.selectTarget}
            />
          )}

          <View style={styles.row}>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={actions.refresh}>
              <Text style={styles.btnGhostText}>{t("field.actions.refresh")}</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnStop]} onPress={actions.stop}>
              <Text style={styles.btnStopText}>{t("field.actions.end")}</Text>
            </Pressable>
          </View>

          <Text style={styles.meta}>
            {t("field.meta", { evidence: s.evidenceCount, cells: s.visitedCells.length })}
          </Text>
        </>
      )}
    </ScrollView>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────
function StartCard({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.card}>
      <Text style={styles.h1}>{t("field.start.heading")}</Text>
      <Text style={styles.body}>{t("field.start.body")}</Text>
      <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onStart}>
        <Text style={styles.btnPrimaryText}>{t("field.start.button")}</Text>
      </Pressable>
    </View>
  );
}

function StatusLine({ state, suspendedBy }: { state: string; suspendedBy: string | null }) {
  const { t } = useTranslation();
  if (suspendedBy) {
    // Never invent a position: say plainly why guidance is waiting (§3.9).
    const text =
      suspendedBy === "no-fix" ? t("field.status.waitingGps")
      : suspendedBy === "paused" ? t("field.status.paused")
      : t("field.status.sensorError");
    return (
      <View style={[styles.status, styles.statusWarn]}>
        <ActivityIndicator size="small" color={colors.gold} />
        <Text style={styles.statusText}>{text}</Text>
      </View>
    );
  }
  const label =
    state === "orienting" ? t("field.status.orienting")
    : state === "reasoning" ? t("field.status.reasoning")
    : state === "awaitingEvidence" ? t("field.status.arrived")
    : t("field.status.guiding");
  return (
    <View style={styles.status}>
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}

function HereCard({
  unit, cell, bestIsHere,
}: { unit: string | null; cell: string | null; bestIsHere: boolean }) {
  const { t } = useTranslation();
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{t("field.here.label")}</Text>
      <Text style={styles.h2}>{unit ?? t("field.here.noGeology")}</Text>
      {cell ? <Text style={styles.faint}>{t("field.here.cell", { cell })}</Text> : null}
      {bestIsHere ? <Text style={styles.goodNews}>{t("field.here.bestHere")}</Text> : null}
    </View>
  );
}

function TargetCard({
  target, distanceM, relativeBearing,
}: { target: ExplorationTarget; distanceM: number | null; relativeBearing: number | null }) {
  const { t } = useTranslation();
  return (
    <View style={[styles.card, styles.cardGold]}>
      <Text style={styles.label}>{t("field.target.label")}</Text>
      <Text style={styles.h1}>
        {t("field.target.headTo", {
          distance: formatDistance(t, distanceM ?? target.distanceM),
          compass: t(compassKey(target.compass)),
        })}
      </Text>

      <Text style={styles.turn}>
        {relativeBearing == null
          ? t("field.target.bearing", { deg: Math.round(target.bearingDeg) })
          : describeTurn(relativeBearing, t)}
      </Text>

      {/* Invariant 2: the reason travels with the recommendation, in the reader's language. */}
      <Text style={styles.label}>{t("field.target.why")}</Text>
      {target.reasons.map((r, i) => (
        <Text key={reasonKey(r, i)} style={styles.reason}>{"•"} {renderReason(r, t)}</Text>
      ))}

      {target.commodities.length > 0 ? (
        <Text style={styles.faint}>
          {t("field.target.lookingFor", { commodities: target.commodities.join(", ") })}
        </Text>
      ) : null}
      <Text style={styles.faint}>
        {t("field.target.confidence", { band: t(bandKey(target.band)) })}
      </Text>
    </View>
  );
}

function NoTargetCard({ hasKnowledge }: { hasKnowledge: boolean }) {
  const { t } = useTranslation();
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>
        {hasKnowledge ? t("field.none.noStronger") : t("field.none.noKnowledge")}
      </Text>
      <Text style={styles.body}>
        {hasKnowledge ? t("field.none.noStrongerBody") : t("field.none.noKnowledgeBody")}
      </Text>
    </View>
  );
}

function EvidenceCard({ onCapture }: { onCapture: (type: WaypointType) => void }) {
  const { t } = useTranslation();
  return (
    <View style={[styles.card, styles.cardGold]}>
      <Text style={styles.h2}>{t("field.evidence.heading")}</Text>
      <Text style={styles.body}>{t("field.evidence.body")}</Text>
      <View style={styles.chips}>
        {WAYPOINT_TYPES.map((type) => (
          <Pressable key={type} style={styles.chip} onPress={() => onCapture(type)}>
            <Text style={styles.chipText}>{t(waypointTypeLabelKey(type))}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function OtherTargets({
  targets, onSelect,
}: { targets: ExplorationTarget[]; onSelect: (cell: string) => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{t("field.target.otherOptions")}</Text>
      {targets.map((x) => (
        <Pressable key={x.cell} style={styles.otherRow} onPress={() => onSelect(x.cell)}>
          <Text style={styles.otherTitle}>
            {t("field.target.headTo", {
              distance: formatDistance(t, x.distanceM),
              compass: t(compassKey(x.compass)),
            })}
          </Text>
          <Text style={styles.otherReason} numberOfLines={2}>
            {x.reasons[0] ? renderReason(x.reasons[0], t) : ""}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function PackBanner({
  provenance, hasKnowledge, running,
}: {
  provenance: { packVersion: string; ageDays: number; stale: boolean } | null;
  hasKnowledge: boolean;
  running: boolean;
}) {
  const { t } = useTranslation();
  if (!running) return null;
  if (!hasKnowledge || !provenance) {
    return (
      <View style={[styles.banner, styles.bannerWarn]}>
        <Text style={styles.bannerText}>{t("field.pack.none")}</Text>
      </View>
    );
  }
  // Risk 3: age is always visible, so stale knowledge is never mistaken for current.
  return (
    <View style={[styles.banner, provenance.stale && styles.bannerWarn]}>
      <Text style={styles.bannerText}>
        {t(provenance.stale ? "field.pack.stale" : "field.pack.info", {
          version: provenance.packVersion,
          days: provenance.ageDays,
        })}
      </Text>
    </View>
  );
}

// ── Formatting ──────────────────────────────────────────────────────────────
function unitOf(ctx: { geology?: { unit?: string } } | null): string | null {
  return ctx?.geology?.unit ?? null;
}

const compassKey = (c: string): string => "field.compass." + c;
const bandKey = (b: string): string => "field.band." + b;
const reasonKey = (r: TargetReason, i: number): string => r.kind + "-" + String(i);

/**
 * Distances go through i18n so the UNIT WORD is translatable: "m" is not
 * "mitir", and a Somali reader should never meet an English abbreviation.
 */
function formatDistance(t: TFunc, m: number): string {
  return m >= 1000
    ? t("field.distance.km", { value: (m / 1000).toFixed(1) })
    : t("field.distance.m", { value: Math.round(m) });
}

function describeTurn(rel: number, t: TFunc): string {
  const d = Math.round(Math.abs(rel));
  if (d <= 15) return t("field.target.straight");
  if (d >= 165) return t("field.target.turnAround");
  return rel > 0 ? t("field.target.turnRight", { deg: d }) : t("field.target.turnLeft", { deg: d });
}

/**
 * Renders a structured reason in the active language.
 *
 * The engine reports WHAT it found; this decides how to say it. That split is
 * exactly what lets a Somali geologist read the same reasoning an English one
 * does, instead of a translated shell wrapped around English geology.
 */
function renderReason(r: TargetReason, t: TFunc): string {
  switch (r.kind) {
    case "occurrence":
      return t("field.reason.occurrence", {
        commodity: r.commodity,
        distance: formatDistance(t, r.distanceM),
      });
    case "association":
      return t("field.reason.association", { commodity: r.commodity });
    case "community":
      return t("field.reason.community", { count: r.count });
    case "observation":
      return t("field.reason.observation", {
        label: t(waypointTypeLabelKey(r.label as WaypointType)),
        distance: formatDistance(t, r.distanceM),
      });
    case "fault":
      return t("field.reason.fault", { distance: formatDistance(t, r.distanceM) });
    case "contact":
      return t("field.reason.contact", { distance: formatDistance(t, r.distanceM) });
    case "intersection":
      return t("field.reason.intersection", { distance: formatDistance(t, r.distanceM) });
    case "unit":
      return t("field.reason.unit", { name: r.name });
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxxl },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardGold: { borderColor: colors.goldBorder, backgroundColor: colors.goldSoft },

  h1: { color: colors.text, fontSize: 26, fontWeight: "800" },
  h2: { color: colors.text, fontSize: 18, fontWeight: "700" },
  body: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  label: { color: colors.textFaint, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  faint: { color: colors.textFaint, fontSize: 12 },
  reason: { color: colors.text, fontSize: 14, lineHeight: 20 },
  turn: { color: colors.gold, fontSize: 16, fontWeight: "700" },
  goodNews: { color: colors.confidenceHigh, fontSize: 13, fontWeight: "600" },
  meta: { color: colors.textFaint, fontSize: 12, textAlign: "center" },

  status: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    borderRadius: radius.pill, backgroundColor: colors.surfaceAlt,
  },
  statusWarn: { backgroundColor: colors.goldSoft },
  statusText: { color: colors.textMuted, fontSize: 13 },

  banner: {
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    borderRadius: radius.md, backgroundColor: colors.surfaceAlt,
  },
  bannerWarn: { backgroundColor: colors.goldSoft, borderWidth: 1, borderColor: colors.goldBorder },
  bannerText: { color: colors.textMuted, fontSize: 12 },

  row: { flexDirection: "row", gap: spacing.md },
  btn: {
    flex: 1, paddingVertical: spacing.md, borderRadius: radius.pill, alignItems: "center",
  },
  btnPrimary: { backgroundColor: colors.gold },
  btnPrimaryText: { color: "#1A1A1D", fontSize: 15, fontWeight: "800" },
  btnGhost: { borderWidth: 1, borderColor: colors.border },
  btnGhostText: { color: colors.textMuted, fontSize: 15, fontWeight: "600" },
  btnStop: { borderWidth: 1, borderColor: colors.border },
  btnStopText: { color: colors.danger, fontSize: 15, fontWeight: "600" },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.xs },
  chip: {
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.goldBorder,
    backgroundColor: colors.surface,
  },
  chipText: { color: colors.text, fontSize: 13, fontWeight: "600" },

  otherRow: {
    paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.borderSubtle, gap: 2,
  },
  otherTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  otherReason: { color: colors.textFaint, fontSize: 12 },
});

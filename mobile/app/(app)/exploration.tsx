// Exploration Mode — the screen for workflow steps 1–8 (Stage E4).
//
// Everything shown here comes from the orchestrator snapshot; this file holds
// no exploration logic of its own. Two rules from the architecture shape the
// layout more than anything else:
//
//   Invariant 2 — no unexplained recommendation. The REASON sits next to the
//     bearing, not behind a tap, because a user with no geological training is
//     being asked to walk somewhere.
//   Risk 3 — stale packs. Pack version and age are always visible, so guidance
//     from months-old knowledge is never mistaken for current knowledge.
import React from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { colors, radius, spacing } from "../../lib/theme";
import { ExplorationProvider, useExploration } from "../../lib/exploration/provider";
import { describeTarget, type ExplorationTarget } from "../../lib/geo/targeting.ts";

export default function ExplorationRoute() {
  return (
    <ExplorationProvider>
      <Stack.Screen options={{ title: "Exploration" }} />
      <ExplorationScreen />
    </ExplorationProvider>
  );
}

function ExplorationScreen() {
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
            <EvidenceCard onRecord={() => void actions.recordEvidence()} />
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
              targets={s.targets.filter((t) => t.cell !== s.activeTarget?.cell)}
              onSelect={actions.selectTarget}
            />
          )}

          <View style={styles.row}>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={actions.refresh}>
              <Text style={styles.btnGhostText}>Refresh</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnStop]} onPress={actions.stop}>
              <Text style={styles.btnStopText}>End session</Text>
            </Pressable>
          </View>

          <Text style={styles.meta}>
            {s.evidenceCount} evidence captured · {s.visitedCells.length} cells assessed
          </Text>
        </>
      )}
    </ScrollView>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────
function StartCard({ onStart }: { onStart: () => void }) {
  return (
    <View style={styles.card}>
      <Text style={styles.h1}>Start Exploration</Text>
      <Text style={styles.body}>
        The app will read your position, work out the geology beneath you, and guide you toward the
        most promising ground nearby. It works with no signal.
      </Text>
      <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onStart}>
        <Text style={styles.btnPrimaryText}>Start Exploration</Text>
      </Pressable>
    </View>
  );
}

function StatusLine({ state, suspendedBy }: { state: string; suspendedBy: string | null }) {
  if (suspendedBy) {
    // Never invent a position: say plainly why guidance is waiting (§3.9).
    const text =
      suspendedBy === "no-fix" ? "Waiting for GPS…"
      : suspendedBy === "paused" ? "Paused — guidance resumes when you do"
      : "Location unavailable — guidance paused";
    return (
      <View style={[styles.status, styles.statusWarn]}>
        <ActivityIndicator size="small" color={colors.gold} />
        <Text style={styles.statusText}>{text}</Text>
      </View>
    );
  }
  const label =
    state === "orienting" ? "Working out where you are…"
    : state === "reasoning" ? "Updating from your evidence…"
    : state === "awaitingEvidence" ? "You have arrived"
    : "Guiding";
  return (
    <View style={styles.status}>
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}

function HereCard({
  unit, cell, bestIsHere,
}: { unit: string | null; cell: string | null; bestIsHere: boolean }) {
  return (
    <View style={styles.card}>
      <Text style={styles.label}>WHERE YOU ARE</Text>
      <Text style={styles.h2}>{unit ?? "No mapped geology here"}</Text>
      {cell && <Text style={styles.faint}>Cell {cell}</Text>}
      {bestIsHere && (
        <Text style={styles.goodNews}>
          This is the most promising ground nearby — worth working before moving on.
        </Text>
      )}
    </View>
  );
}

function TargetCard({
  target, distanceM, relativeBearing,
}: { target: ExplorationTarget; distanceM: number | null; relativeBearing: number | null }) {
  return (
    <View style={[styles.card, styles.cardGold]}>
      <Text style={styles.label}>GO HERE NEXT</Text>
      <Text style={styles.h1}>{formatDistance(distanceM ?? target.distanceM)} {target.compass}</Text>

      <Text style={styles.turn}>
        {relativeBearing == null
          ? `Bearing ${Math.round(target.bearingDeg)}°`
          : describeTurn(relativeBearing)}
      </Text>

      {/* Invariant 2: the reason travels with the recommendation. */}
      <Text style={styles.label}>WHY</Text>
      {target.reasons.map((r) => (
        <Text key={r} style={styles.reason}>• {r}</Text>
      ))}

      {target.commodities.length > 0 && (
        <Text style={styles.faint}>Looking for: {target.commodities.join(", ")}</Text>
      )}
      <Text style={styles.faint}>Confidence {target.band.toLowerCase()}</Text>
    </View>
  );
}

function NoTargetCard({ hasKnowledge }: { hasKnowledge: boolean }) {
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>
        {hasKnowledge ? "No stronger ground nearby" : "No geological knowledge for this area"}
      </Text>
      <Text style={styles.body}>
        {hasKnowledge
          ? "Nothing within range scores highly enough to send you there. Work this ground, or move on and refresh."
          : "This app has no offline knowledge covering where you are, so it will not guess a direction."}
      </Text>
    </View>
  );
}

function EvidenceCard({ onRecord }: { onRecord: () => void }) {
  return (
    <View style={[styles.card, styles.cardGold]}>
      <Text style={styles.h2}>You have arrived</Text>
      <Text style={styles.body}>
        Record what you can see — an outcrop photo, a specimen scan, or an observation. Your evidence
        changes what the app recommends next.
      </Text>
      <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onRecord}>
        <Text style={styles.btnPrimaryText}>Record evidence here</Text>
      </Pressable>
    </View>
  );
}

function OtherTargets({
  targets, onSelect,
}: { targets: ExplorationTarget[]; onSelect: (cell: string) => void }) {
  return (
    <View style={styles.card}>
      <Text style={styles.label}>OTHER OPTIONS</Text>
      {targets.map((t) => (
        <Pressable key={t.cell} style={styles.otherRow} onPress={() => onSelect(t.cell)}>
          <Text style={styles.otherTitle}>{formatDistance(t.distanceM)} {t.compass}</Text>
          <Text style={styles.otherReason} numberOfLines={2}>{describeTarget(t)}</Text>
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
  if (!running) return null;
  if (!hasKnowledge || !provenance) {
    return (
      <View style={[styles.banner, styles.bannerWarn]}>
        <Text style={styles.bannerText}>No knowledge pack installed — guidance unavailable</Text>
      </View>
    );
  }
  // Risk 3: age is always visible, so stale knowledge is never mistaken for current.
  return (
    <View style={[styles.banner, provenance.stale && styles.bannerWarn]}>
      <Text style={styles.bannerText}>
        Knowledge v{provenance.packVersion} · {provenance.ageDays} days old
        {provenance.stale ? " · may be out of date" : ""}
      </Text>
    </View>
  );
}

// ── Formatting ──────────────────────────────────────────────────────────────
function unitOf(ctx: { geology?: { unit?: string } } | null): string | null {
  return ctx?.geology?.unit ?? null;
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function describeTurn(rel: number): string {
  const d = Math.round(Math.abs(rel));
  if (d <= 15) return "Straight ahead";
  if (d >= 165) return "Turn around";
  return `Turn ${rel > 0 ? "right" : "left"} ${d}°`;
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

  otherRow: {
    paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.borderSubtle, gap: 2,
  },
  otherTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  otherReason: { color: colors.textFaint, fontSize: 12 },
});

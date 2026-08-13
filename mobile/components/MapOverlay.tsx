// Controls that float over the exploration map.
//
// Presentational only — every one of these takes a callback and renders state
// it was handed. The map itself is a canvas inside a WebView, so its controls
// live out here as real native buttons: they stay responsive while the canvas
// is mid-redraw, and they hit the platform's touch targets rather than the
// page's.
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "../lib/theme";

/**
 * The session bar, floating ON the map rather than above it.
 *
 * It used to be a normal header in the layout, which cost about 90 px of map on
 * every phone — the single biggest reason the screen read as a dashboard with a
 * map in it. Over the map it costs nothing: the ground runs under it to the top
 * of the screen, and the controls are still where a thumb expects them.
 */
export function MapTopBar({
  title, status, online, busy, onBack, onEnd, top,
}: {
  title: string;
  status: string;
  online: boolean;
  busy?: boolean;
  onBack: () => void;
  onEnd?: () => void;
  /** Safe-area inset, so the bar clears the notch without a layout header. */
  top: number;
}) {
  return (
    <View style={[styles.topBar, { top: top + 6 }]} pointerEvents="box-none">
      <Pressable onPress={onBack} hitSlop={10} style={styles.topBtn}>
        <Ionicons name="chevron-back" size={22} color={colors.text} />
      </Pressable>
      <View style={styles.topPill}>
        <View style={[styles.dot, online ? styles.dotOnline : styles.dotOffline]} />
        <Text style={styles.topTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.topStatus} numberOfLines={1}>{status}</Text>
        {busy ? <Ionicons name="cloud-download-outline" size={13} color={colors.textFaint} /> : null}
      </View>
      {onEnd ? (
        <Pressable onPress={onEnd} hitSlop={10} style={styles.topBtn}>
          <Ionicons name="stop-circle-outline" size={22} color={colors.danger} />
        </Pressable>
      ) : <View style={styles.topBtn} />}
    </View>
  );
}

/**
 * What the receiver is reporting, on the map itself.
 *
 * Deliberately shows the accuracy the platform gave, to the tenth of a metre
 * while it is under ten — a receiver reporting ±1.5 m and one reporting ±2 m are
 * telling a geologist different things about whether that outcrop position is
 * worth recording, and rounding both to "±2 m" throws that away.
 */
export function GpsChip({ text, warn, onPress }: { text: string; warn?: boolean; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.gpsChip, warn && styles.gpsChipWarn, pressed && styles.pressed]}>
      <Ionicons name={warn ? "warning" : "location"} size={12} color={warn ? colors.gold : "#22C55E"} />
      <Text style={[styles.gpsChipText, warn && styles.gpsChipTextWarn]}>{text}</Text>
    </Pressable>
  );
}

/**
 * Left rail: the controls reached for most often while walking.
 *
 * It positions ITSELF against the map. It used to be handed to the screen to
 * position, inside a wrapper that had no size of its own — and on Android a
 * child drawn outside its parent's bounds is drawn but never touched. The rail
 * was visible and completely dead. Anything absolutely positioned over this map
 * must own its own offsets for that reason.
 */
export function MapRail({
  items, top,
}: {
  items: Array<{ icon: keyof typeof Ionicons.glyphMap; label: string; active?: boolean; onPress: () => void }>;
  /** Distance from the top of the map, past the bar and the guidance pill. */
  top: number;
}) {
  return (
    <View style={[styles.rail, { top }]}>
      {items.map((it) => (
        <Pressable
          key={it.label}
          onPress={it.onPress}
          style={({ pressed }) => [styles.railBtn, it.active && styles.railBtnActive, pressed && styles.pressed]}
        >
          <Ionicons name={it.icon} size={20} color={it.active ? colors.gold : colors.text} />
          <Text style={[styles.railLabel, it.active && styles.railLabelActive]} numberOfLines={1}>
            {it.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Round control, used for zoom, 3D and locate. */
export function RoundBtn({
  icon, label, onPress, active, size = 48,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  label?: string;
  onPress: () => void;
  active?: boolean;
  size?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.round,
        { width: size, height: size, borderRadius: size / 2 },
        active && styles.roundActive,
        pressed && styles.pressed,
      ]}
    >
      {icon ? <Ionicons name={icon} size={22} color={active ? colors.gold : colors.text} /> : null}
      {label ? <Text style={[styles.roundLabel, active && styles.roundLabelActive]}>{label}</Text> : null}
    </Pressable>
  );
}

/**
 * Compass.
 *
 * The needle shows which way NORTH is, so a rotated map can still be read.
 * Tapping it returns the map to north-up, which is the only reliable way back
 * once a two-finger twist has left it at an angle.
 */
/**
 * The compass, and the only thing on the map that points at the target.
 *
 * THREE FACTS, EACH FROM A DIFFERENT SOURCE, AND NONE OF THEM INVENTED:
 *
 *   the red/white needle   where NORTH is, from the map's own rotation.
 *   the gold arrow         the geodesic bearing to whatever is being navigated
 *                          to — a destination, the active target, or the nearest
 *                          mapped lead. Drawn at `bearing - mapRotation`, so it
 *                          keeps pointing at the ground truth however the map is
 *                          twisted. Absent when there is nothing to point at:
 *                          an arrow with no target would be decoration.
 *   the ring               amber when the magnetometer says it needs calibrating.
 *                          A heading can be reported with confidence and be
 *                          thirty degrees wrong, and in heading-up mode that
 *                          error rotates the whole map. It is not hidden.
 *
 * Tapping aligns the map to the direction of travel, and tapping again returns it
 * to north-up. `headingUp` is passed in rather than held here, because the map
 * owns the rotation and two places holding it is how the old code ended up with
 * four disagreeing rotation conventions.
 */
export function Compass({
  rotationDeg, headingDeg, targetBearingDeg, needsCalibration, headingUp, onPress,
}: {
  rotationDeg: number;
  /** Device true heading, or null when the magnetometer has reported nothing. */
  headingDeg: number | null;
  /** Geodesic bearing to the thing being navigated to, or null if none. */
  targetBearingDeg: number | null;
  needsCalibration: boolean;
  headingUp: boolean;
  onPress: () => void;
}) {
  // Nothing to align to. The control stays visible — it still shows where north
  // is — but it must not offer a rotation it cannot perform.
  const canAlign = headingDeg != null;

  return (
    <Pressable
      onPress={onPress}
      disabled={!canAlign && !headingUp}
      style={({ pressed }) => [
        styles.compass,
        headingUp && styles.compassHeadingUp,
        needsCalibration && styles.compassUncalibrated,
        pressed && styles.pressed,
      ]}
    >
      {targetBearingDeg != null ? (
        <View
          style={[styles.compassRing, { transform: [{ rotate: `${targetBearingDeg - rotationDeg}deg` }] }]}
          pointerEvents="none"
        >
          <View style={styles.targetArrow} />
        </View>
      ) : null}
      <View style={{ transform: [{ rotate: `${-rotationDeg}deg` }] }}>
        <View style={styles.needleN} />
        <View style={styles.needleS} />
      </View>
    </Pressable>
  );
}

/** The recommendation, pinned above the map so it is never scrolled away. */
export function TargetPill({
  title, subtitle, tone = "good", onPress,
}: {
  title: string;
  subtitle?: string;
  tone?: "good" | "plain" | "warn";
  onPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.pill, pressed && styles.pressed]}>
      <Ionicons name="navigate" size={18} color={colors.gold} />
      <View style={styles.pillText}>
        <Text style={styles.pillTitle} numberOfLines={1}>{title}</Text>
        {subtitle ? (
          <Text
            style={[
              styles.pillSub,
              tone === "good" && styles.pillGood,
              tone === "warn" && styles.pillWarn,
            ]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * Scale bar.
 *
 * Drawn from the map's actual metres-per-pixel, and snapped to a round distance
 * so the bar states a number a person can use. A map used to judge a walk needs
 * one; a map that only looks like one is worse than no map.
 */
export function ScaleBar({ metresPerPx, bottom = spacing.md }: { metresPerPx: number; bottom?: number }) {
  if (!Number.isFinite(metresPerPx) || metresPerPx <= 0) return null;
  const targetPx = 92;
  const raw = metresPerPx * targetPx;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const nice = n >= 5 ? 5 * pow : n >= 2 ? 2 * pow : pow;
  const px = nice / metresPerPx;
  const label = nice >= 1000 ? `${+(nice / 1000).toFixed(nice % 1000 ? 1 : 0)} km` : `${Math.round(nice)} m`;

  return (
    <View style={[styles.scaleWrap, { bottom }]}>
      <Text style={styles.scaleLabel}>{label}</Text>
      <View style={[styles.scaleBar, { width: px }]}>
        <View style={styles.scaleTick} />
        <View style={styles.scaleTickRight} />
      </View>
    </View>
  );
}

export interface LayerRow {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  /** Shown under the label: what the layer IS and where it comes from. */
  note?: string;
  /** True when the layer needs a connection to arrive for the first time. */
  online?: boolean;
}

export interface LayerGroup {
  title: string;
  rows: LayerRow[];
}

/**
 * Layer switches, grouped and scrollable.
 *
 * There are now more than twenty of them — backdrop, geology, terrain and the
 * session's own overlays — and a flat list of that length is a wall. Grouping is
 * not decoration here: it is what lets someone turn the whole backdrop off to
 * read structure without hunting for four scattered switches.
 *
 * Each row states its SOURCE, because a geologist deciding whether to trust a
 * line needs to know whether it came from Macrostrat, from MRDS, or from a DEM.
 */
export function LayerPanel({
  layers, onToggle, onClose, groups, title, maxHeight, top, offline, offlineNote,
}: {
  layers: Record<string, boolean>;
  onToggle: (key: string) => void;
  onClose: () => void;
  title: string;
  groups: LayerGroup[];
  maxHeight: number;
  /** Own offset from the top of the map — see the note on MapRail. */
  top: number;
  /** True when there is no connection — online layers say so rather than lying. */
  offline?: boolean;
  offlineNote?: string;
}) {
  return (
    <View style={[styles.layerPanel, { maxHeight, top }]}>
      <View style={styles.layerHead}>
        <Text style={styles.layerTitle}>{title}</Text>
        <Pressable onPress={onClose} hitSlop={10}>
          <Ionicons name="close" size={20} color={colors.textMuted} />
        </Pressable>
      </View>
      <ScrollView showsVerticalScrollIndicator={false}>
        {groups.map((g) => (
          <View key={g.title}>
            <Text style={styles.layerGroup}>{g.title}</Text>
            {g.rows.map((l) => {
              const on = layers[l.key];
              return (
                <Pressable
                  key={l.key}
                  onPress={() => onToggle(l.key)}
                  style={({ pressed }) => [styles.layerRow, pressed && styles.pressed]}
                >
                  <View style={[styles.layerSwatch, { backgroundColor: on ? l.color : "transparent", borderColor: l.color }]}>
                    <Ionicons name={l.icon} size={14} color={on ? "#0B0B0C" : l.color} />
                  </View>
                  <View style={styles.layerTextWrap}>
                    <Text style={[styles.layerLabel, !on && styles.layerLabelOff]}>{l.label}</Text>
                    {l.note || (l.online && offline) ? (
                      <Text style={styles.layerNote} numberOfLines={1}>
                        {l.online && offline ? offlineNote ?? "" : l.note}
                      </Text>
                    ) : null}
                  </View>
                  <Ionicons
                    name={on ? "eye" : "eye-off"}
                    size={18}
                    color={on ? colors.text : colors.textFaint}
                  />
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.65 },

  rail: { position: "absolute", left: spacing.md, gap: spacing.sm },
  railBtn: {
    width: 58, height: 58, borderRadius: radius.lg,
    backgroundColor: "rgba(11,11,12,0.82)",
    borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center", gap: 2,
  },
  railBtnActive: { borderColor: colors.goldBorder, backgroundColor: "rgba(201,162,39,0.16)" },
  railLabel: { color: colors.text, fontSize: 9, fontWeight: "600" },
  railLabelActive: { color: colors.gold },

  round: {
    backgroundColor: "rgba(11,11,12,0.82)",
    borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center",
  },
  roundActive: { borderColor: colors.goldBorder, backgroundColor: "rgba(201,162,39,0.16)" },
  roundLabel: { color: colors.text, fontSize: 13, fontWeight: "700" },
  roundLabelActive: { color: colors.gold },

  compass: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: "rgba(11,11,12,0.82)",
    borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center",
  },
  // Aligned to the direction of travel rather than to north — a different mode,
  // so it looks different.
  compassHeadingUp: { borderColor: colors.gold },
  // The heading may be confidently wrong. Said on the control that uses it.
  compassUncalibrated: { borderColor: "#E0A02F" },
  // Full-size overlay whose child sits at the top centre, so rotating it swings
  // the arrow around the compass rim at the correct bearing.
  compassRing: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center", justifyContent: "flex-start", paddingTop: 2,
  },
  targetArrow: {
    width: 0, height: 0, borderLeftWidth: 5, borderRightWidth: 5, borderBottomWidth: 8,
    borderLeftColor: "transparent", borderRightColor: "transparent",
    borderBottomColor: colors.gold,
  },
  // Two triangles meeting at the centre: red to north, white to south.
  needleN: {
    width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 13,
    borderLeftColor: "transparent", borderRightColor: "transparent", borderBottomColor: "#E03A2F",
  },
  needleS: {
    width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 13,
    borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: "#F5F1E8",
  },

  pill: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    alignSelf: "center",
    backgroundColor: "rgba(11,11,12,0.9)",
    borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.lg,
    maxWidth: "78%",
  },
  pillText: { flexShrink: 1 },
  pillTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  pillSub: { color: colors.textMuted, fontSize: 12 },
  pillGood: { color: "#22C55E" },
  pillWarn: { color: colors.gold },

  scaleWrap: { position: "absolute", left: spacing.md },
  scaleLabel: { color: colors.text, fontSize: 11, fontWeight: "600", marginBottom: 3 },
  scaleBar: { height: 8, borderBottomWidth: 2, borderColor: colors.text, justifyContent: "space-between", flexDirection: "row" },
  scaleTick: { width: 2, height: 8, backgroundColor: colors.text },
  scaleTickRight: { width: 2, height: 8, backgroundColor: colors.text },

  layerPanel: {
    position: "absolute", left: spacing.md, right: spacing.md,
    backgroundColor: "rgba(11,11,12,0.97)",
    borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md,
  },
  layerHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  layerTitle: { color: colors.gold, fontSize: 12, fontWeight: "700", letterSpacing: 0.6 },
  layerGroup: {
    color: colors.textFaint, fontSize: 10, fontWeight: "700", letterSpacing: 0.8,
    marginTop: spacing.md, marginBottom: 2, textTransform: "uppercase",
  },
  layerRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 7 },
  layerSwatch: {
    width: 28, height: 28, borderRadius: radius.sm, borderWidth: 1.5,
    alignItems: "center", justifyContent: "center",
  },
  layerTextWrap: { flex: 1 },
  layerLabel: { color: colors.text, fontSize: 14 },
  layerNote: { color: colors.textFaint, fontSize: 10 },
  layerLabelOff: { color: colors.textFaint },

  topBar: {
    position: "absolute", left: spacing.md, right: spacing.md,
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
  },
  topBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: "rgba(11,11,12,0.86)",
    borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center",
  },
  topPill: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(11,11,12,0.86)",
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md, height: 40,
  },
  topTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
  topStatus: { color: colors.textFaint, fontSize: 11, flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotOnline: { backgroundColor: "#22C55E" },
  dotOffline: { backgroundColor: colors.textFaint },

  gpsChip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: "rgba(11,11,12,0.86)",
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm, paddingVertical: 5,
  },
  gpsChipWarn: { borderColor: colors.goldBorder, backgroundColor: "rgba(201,162,39,0.18)" },
  gpsChipText: { color: colors.text, fontSize: 11, fontWeight: "600" },
  gpsChipTextWarn: { color: colors.gold },
});

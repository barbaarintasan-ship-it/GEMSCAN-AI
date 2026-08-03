// Controls that float over the exploration map.
//
// Presentational only — every one of these takes a callback and renders state
// it was handed. The map itself is a canvas inside a WebView, so its controls
// live out here as real native buttons: they stay responsive while the canvas
// is mid-redraw, and they hit the platform's touch targets rather than the
// page's.
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "../lib/theme";

/** Left rail: the four things reached for most often while walking. */
export function MapRail({
  items,
}: {
  items: Array<{ icon: keyof typeof Ionicons.glyphMap; label: string; active?: boolean; onPress: () => void }>;
}) {
  return (
    <View style={styles.rail}>
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
export function Compass({ rotationDeg, onPress }: { rotationDeg: number; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.compass, pressed && styles.pressed]}>
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
export function ScaleBar({ metresPerPx }: { metresPerPx: number }) {
  if (!Number.isFinite(metresPerPx) || metresPerPx <= 0) return null;
  const targetPx = 92;
  const raw = metresPerPx * targetPx;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const nice = n >= 5 ? 5 * pow : n >= 2 ? 2 * pow : pow;
  const px = nice / metresPerPx;
  const label = nice >= 1000 ? `${+(nice / 1000).toFixed(nice % 1000 ? 1 : 0)} km` : `${Math.round(nice)} m`;

  return (
    <View style={styles.scaleWrap}>
      <Text style={styles.scaleLabel}>{label}</Text>
      <View style={[styles.scaleBar, { width: px }]}>
        <View style={styles.scaleTick} />
        <View style={styles.scaleTickRight} />
      </View>
    </View>
  );
}

/** Layer switches, in the order the mockup lists them. */
export function LayerPanel({
  layers, onToggle, onClose, labels, title,
}: {
  layers: Record<string, boolean>;
  onToggle: (key: string) => void;
  onClose: () => void;
  title: string;
  labels: Array<{ key: string; label: string; icon: keyof typeof Ionicons.glyphMap; color: string }>;
}) {
  return (
    <View style={styles.layerPanel}>
      <View style={styles.layerHead}>
        <Text style={styles.layerTitle}>{title}</Text>
        <Pressable onPress={onClose} hitSlop={10}>
          <Ionicons name="close" size={20} color={colors.textMuted} />
        </Pressable>
      </View>
      {labels.map((l) => {
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
            <Text style={[styles.layerLabel, !on && styles.layerLabelOff]}>{l.label}</Text>
            <Ionicons
              name={on ? "eye" : "eye-off"}
              size={18}
              color={on ? colors.text : colors.textFaint}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.65 },

  rail: { position: "absolute", left: spacing.md, top: spacing.md, gap: spacing.sm },
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

  scaleWrap: { position: "absolute", left: spacing.md, bottom: spacing.md },
  scaleLabel: { color: colors.text, fontSize: 11, fontWeight: "600", marginBottom: 3 },
  scaleBar: { height: 8, borderBottomWidth: 2, borderColor: colors.text, justifyContent: "space-between", flexDirection: "row" },
  scaleTick: { width: 2, height: 8, backgroundColor: colors.text },
  scaleTickRight: { width: 2, height: 8, backgroundColor: colors.text },

  layerPanel: {
    position: "absolute", left: spacing.md, right: spacing.md, top: spacing.md,
    backgroundColor: "rgba(11,11,12,0.96)",
    borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md,
  },
  layerHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  layerTitle: { color: colors.gold, fontSize: 12, fontWeight: "700", letterSpacing: 0.6 },
  layerRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  layerSwatch: {
    width: 28, height: 28, borderRadius: radius.sm, borderWidth: 1.5,
    alignItems: "center", justifyContent: "center",
  },
  layerLabel: { color: colors.text, fontSize: 14, flex: 1 },
  layerLabelOff: { color: colors.textFaint },
});

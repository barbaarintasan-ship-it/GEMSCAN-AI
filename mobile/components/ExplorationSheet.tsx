// The exploration bottom sheet.
//
// Collapsed it answers the only question a walking geologist has — which way,
// how far, how sure, and why — in one glance, without covering the map.
// Expanded it becomes the reading surface: interpretation, the evidence behind
// the recommendation, and the actions.
//
// Dragged, not toggled: a thumb on the handle moves it, and a flick settles it
// to whichever detent it was heading for. Implemented on Animated and
// PanResponder, both already in React Native — a field app should not gain a
// gesture-handler dependency for one sheet.
import React from "react";
import {
  Animated, PanResponder, StyleSheet, Text, View, ScrollView, Pressable,
} from "react-native";
import { colors, radius, spacing } from "../lib/theme";

export const SHEET_COLLAPSED_H = 208;

export function ExplorationSheet({
  expandedHeight, header, children, expanded, onExpandedChange,
}: {
  expandedHeight: number;
  /** Always visible: the four-up readout and the one-line recommendation. */
  header: React.ReactNode;
  /** Revealed on expand. */
  children: React.ReactNode;
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
}) {
  const travel = Math.max(0, expandedHeight - SHEET_COLLAPSED_H);
  // 0 = collapsed, `travel` = fully open. Animating the sheet's HEIGHT would
  // relayout its contents on every frame; translating it does not.
  const y = React.useRef(new Animated.Value(0)).current;
  const at = React.useRef(0);

  React.useEffect(() => {
    const to = expanded ? travel : 0;
    Animated.spring(y, {
      toValue: to, useNativeDriver: true, bounciness: 2, speed: 14,
    }).start();
    at.current = to;
  }, [expanded, travel, y]);

  const pan = React.useMemo(
    () =>
      PanResponder.create({
        // Claim the gesture only once it is clearly a vertical drag, so a tap on
        // a button inside the header still reaches the button.
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_e, g) => {
          const next = Math.max(0, Math.min(travel, at.current - g.dy));
          y.setValue(next);
        },
        onPanResponderRelease: (_e, g) => {
          const next = Math.max(0, Math.min(travel, at.current - g.dy));
          // A flick decides on its own; otherwise the nearer detent wins.
          const open = g.vy < -0.4 ? true : g.vy > 0.4 ? false : next > travel / 2;
          onExpandedChange(open);
        },
      }),
    [travel, y, onExpandedChange],
  );

  return (
    <Animated.View
      style={[
        styles.sheet,
        { height: expandedHeight, transform: [{ translateY: Animated.subtract(new Animated.Value(travel), y) }] },
      ]}
    >
      <View {...pan.panHandlers}>
        <View style={styles.grabWrap}><View style={styles.grab} /></View>
        {header}
      </View>
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
        scrollEnabled={expanded}
      >
        {children}
      </ScrollView>
    </Animated.View>
  );
}

/** The four-up readout: distance, direction, confidence, reason. */
export function SheetStats({
  items,
}: {
  items: Array<{ value: string; label: string; tone?: "gold" | "good" | "plain"; icon?: React.ReactNode }>;
}) {
  return (
    <View style={styles.stats}>
      {items.map((s, i) => (
        <View key={s.label} style={[styles.stat, i > 0 && styles.statDivider]}>
          <View style={styles.statTop}>
            {s.icon}
            <Text
              style={[
                styles.statValue,
                s.tone === "good" && styles.statGood,
                s.tone === "plain" && styles.statPlain,
              ]}
              numberOfLines={2}
            >
              {s.value}
            </Text>
          </View>
          <Text style={styles.statLabel}>{s.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** A titled block inside the expanded sheet. */
export function SheetSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function SheetAction({
  icon, label, sub, onPress, tone = "plain", disabled,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  onPress: () => void;
  tone?: "plain" | "gold" | "primary";
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.action,
        tone === "gold" && styles.actionGold,
        tone === "primary" && styles.actionPrimary,
        disabled && styles.actionDisabled,
        pressed && styles.actionPressed,
      ]}
    >
      {icon}
      <Text style={[styles.actionLabel, tone === "gold" && styles.actionLabelGold]} numberOfLines={2}>
        {label}
      </Text>
      {sub ? <Text style={styles.actionSub}>{sub}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0, right: 0, bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderColor: colors.border,
    // Lifted off the map so the boundary reads even over bright satellite.
    shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 }, elevation: 16,
  },
  grabWrap: { alignItems: "center", paddingTop: spacing.sm, paddingBottom: spacing.xs },
  grab: { width: 44, height: 4, borderRadius: 2, backgroundColor: colors.border },

  stats: { flexDirection: "row", paddingHorizontal: spacing.md, paddingTop: spacing.xs },
  stat: { flex: 1, paddingHorizontal: spacing.sm },
  statDivider: { borderLeftWidth: 1, borderLeftColor: colors.border },
  statTop: { flexDirection: "row", alignItems: "center", gap: 6 },
  statValue: { color: colors.text, fontSize: 19, fontWeight: "700", flexShrink: 1 },
  statGood: { color: "#22C55E" },
  statPlain: { fontSize: 14, fontWeight: "600" },
  statLabel: { color: colors.textFaint, fontSize: 11, marginTop: 2 },

  body: { flex: 1 },
  bodyContent: { padding: spacing.md, paddingBottom: spacing.xl },

  section: { marginBottom: spacing.lg },
  sectionTitle: {
    color: "#4A90E2", fontSize: 12, fontWeight: "700",
    letterSpacing: 0.6, marginBottom: spacing.sm,
  },

  action: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: spacing.md, paddingHorizontal: spacing.sm,
    alignItems: "center", gap: 6,
  },
  actionGold: { borderColor: colors.goldBorder, backgroundColor: colors.goldSoft },
  actionPrimary: { backgroundColor: colors.gold, borderColor: colors.gold },
  actionDisabled: { opacity: 0.4 },
  actionPressed: { opacity: 0.7 },
  actionLabel: { color: colors.text, fontSize: 12, fontWeight: "600", textAlign: "center" },
  actionLabelGold: { color: colors.gold },
  actionSub: { color: colors.textFaint, fontSize: 10 },
});

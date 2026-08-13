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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, spacing } from "../lib/theme";

/**
 * How much of a 6–7 inch screen the sheet is allowed to take when collapsed.
 *
 * Four numbers and one line of advice — target, distance, direction, confidence,
 * and what to do about them. Everything else is behind the drag. The old height
 * fitted three lines of prose and a chevron, which on a 6" phone was a quarter
 * of the map given over to text that could wait.
 */
export const SHEET_COLLAPSED_H = 168;

/**
 * Where the sheet's content is allowed to stop, in each state.
 *
 * THE BUG THIS EXISTS FOR — reported from the field with screenshots.
 *
 * The sheet is anchored at `bottom: 0` and TRANSLATED down to collapse it, so its
 * own bottom edge is only at the bottom of the SCREEN when it is fully open.
 * Collapsed, that edge sits `travel` pixels below the screen. A `paddingBottom`
 * on the sheet therefore protects the navigation strip in one state and nothing
 * at all in the other — which is exactly what was seen: the layout was correct
 * expanded, and FIELD DIAGNOSTICS rendered behind Android's navigation buttons
 * the moment the sheet was collapsed.
 *
 * Content flows from the sheet's TOP, and the navigation strip is at a fixed
 * position on the SCREEN. The distance between those two changes as the sheet
 * moves, so no single constant can satisfy both states — the inset has to be
 * applied at a different place depending on where the sheet currently is:
 *
 *   collapsed  the visible window is the sheet's top `168 + inset`. The header
 *              fills it, so the header carries the inset and stops at 168.
 *   expanded   the sheet's bottom IS the screen's bottom, so the sheet carries
 *              it and the scroll viewport ends above the buttons.
 *
 * Returned from one function so the two are impossible to change independently,
 * and so the invariant can be tested without a renderer.
 */
export function sheetInsets(bottomInset: number, expanded: boolean): {
  header: number; sheet: number;
} {
  return expanded
    ? { header: 0, sheet: bottomInset }
    : { header: bottomInset, sheet: bottomInset };
}

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
  const insets = useSafeAreaInsets();
  // Where the inset goes depends on where the sheet IS — see sheetInsets. The
  // dark panel still runs to the screen edge behind the buttons; only the content
  // stops above them.
  const pad = sheetInsets(insets.bottom, expanded);
  // The collapsed WINDOW is the content height plus the strip the buttons cover.
  // The window grows by the inset; the content inside it does not.
  const collapsedH = SHEET_COLLAPSED_H + insets.bottom;
  const travel = Math.max(0, expandedHeight - collapsedH);
  // 0 = collapsed, `travel` = fully open. Animating the sheet's HEIGHT would
  // relayout its contents on every frame; translating it does not.
  const y = React.useRef(new Animated.Value(0)).current;
  const at = React.useRef(0);
  // The resting offset, as an animated value that exists ONCE. Building it
  // inline made a fresh Animated.Value on every render of a screen that
  // re-renders on every GPS fix.
  const base = React.useMemo(() => new Animated.Value(travel), [travel]);
  const offset = React.useMemo(() => Animated.subtract(base, y), [base, y]);

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
        { height: expandedHeight, paddingBottom: pad.sheet, transform: [{ translateY: offset }] },
      ]}
    >
      {/* The header carries the inset while the sheet is DOWN. Collapsed, the
          sheet's own bottom edge is below the screen, so its padding is not on
          screen to protect anything — the header is the last thing above the
          navigation buttons, and it is what has to stop short of them. */}
      <View {...pan.panHandlers} style={{ paddingBottom: pad.header }}>
        <Pressable onPress={() => onExpandedChange(!expanded)} style={styles.grabWrap} hitSlop={8}>
          <View style={styles.grab} />
        </Pressable>
        {header}
      </View>
      <ScrollView
        style={styles.body}
        // The last row of a long report — and the actions on the arrived card —
        // must be scrollable CLEAR of the navigation buttons, not merely rendered
        // above them. The inset is added to the scroll content's own padding so
        // the surface still runs to the screen edge and only the content stops.
        contentContainerStyle={[styles.bodyContent, { paddingBottom: spacing.xl + pad.sheet }]}
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

/**
 * One fact and its value.
 *
 * Used by the identify panel, where every row is a pack field. A row whose
 * value is missing renders as an explicit "not recorded" rather than
 * disappearing — a geologist needs to know the difference between "this unit has
 * no age" and "we did not ask".
 */
export function SheetRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, muted && styles.rowValueMuted]} numberOfLines={3}>{value}</Text>
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

  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, paddingVertical: 4 },
  rowLabel: { color: colors.textFaint, fontSize: 12, width: 104 },
  rowValue: { color: colors.text, fontSize: 13, flex: 1, lineHeight: 19 },
  rowValueMuted: { color: colors.textFaint, fontStyle: "italic" },

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

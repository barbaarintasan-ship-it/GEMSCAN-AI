// Standardized button — every screen should use this instead of one-off
// Pressable + StyleSheet combos, so sizes/radius/typography/press-feedback
// are identical everywhere. Purely presentational: it has no knowledge of
// what it's wired to (payment, auth, scan, etc).
import React, { useRef } from "react";
import {
  Animated,
  Pressable,
  Text,
  View,
  ActivityIndicator,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
  type GestureResponderEvent,
} from "react-native";
import { colors, radius, spacing, shadow } from "../../lib/theme";

export type ButtonVariant = "primary" | "secondary" | "outline" | "danger" | "ghost";
export type ButtonSize = "md" | "sm";

type Props = {
  title: string;
  onPress?: (e: GestureResponderEvent) => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const VARIANT: Record<ButtonVariant, { container: ViewStyle; textColor: string }> = {
  primary: {
    container: { backgroundColor: colors.gold, ...shadow.button },
    textColor: "#0B0B0C",
  },
  secondary: {
    container: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.textFaint },
    textColor: colors.text,
  },
  outline: {
    container: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.gold },
    textColor: colors.gold,
  },
  danger: {
    container: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.dangerStrong },
    textColor: colors.dangerStrong,
  },
  ghost: {
    container: { backgroundColor: "transparent" },
    textColor: colors.gold,
  },
};

export function Button({
  title,
  onPress,
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  icon,
  style,
  accessibilityLabel,
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const isDisabled = disabled || loading;
  const v = VARIANT[variant];

  function onPressIn() {
    Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, speed: 50, bounciness: 0 }).start();
  }
  function onPressOut() {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 6 }).start();
  }

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={[
        styles.base,
        size === "sm" ? styles.sizeSm : styles.sizeMd,
        v.container,
        isDisabled && styles.disabled,
        { transform: [{ scale }] },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.textColor} size="small" />
      ) : (
        <View style={styles.content}>
          {icon}
          <Text style={[styles.label, size === "sm" && styles.labelSm, { color: v.textColor }]}>{title}</Text>
        </View>
      )}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  sizeMd: { paddingVertical: 15, paddingHorizontal: spacing.xl },
  sizeSm: { paddingVertical: 10, paddingHorizontal: spacing.lg },
  disabled: { opacity: 0.45 },
  content: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  label: { fontWeight: "700", fontSize: 15 },
  labelSm: { fontSize: 13 },
});

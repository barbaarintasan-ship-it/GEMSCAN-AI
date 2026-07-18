import React from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius, spacing, shadow } from "../../lib/theme";

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  noPadding?: boolean;
  accent?: boolean; // gold-tinted border, for highlighted/primary cards
};

export function Card({ children, style, noPadding, accent }: Props) {
  return (
    <View
      style={[
        styles.card,
        accent && styles.accent,
        noPadding && styles.noPadding,
        shadow.card,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  accent: { borderColor: colors.goldBorder, backgroundColor: colors.goldSoft },
  noPadding: { padding: 0 },
});

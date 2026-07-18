import React from "react";
import { Text, StyleSheet, type StyleProp, type TextStyle } from "react-native";
import { type as t } from "../../lib/theme";

export function SectionLabel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  return <Text style={[styles.label, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  label: { ...t.label, marginTop: 16, marginBottom: 4 },
});

// "Choose Explanation Style" sheet — shown once, before the user's first
// scan, then remembered (see lib/explanationStyle.ts). Changeable any time in
// Settings. Visually mirrors ScanTypeChooser.tsx (same bottom-sheet modal,
// Pressable option rows, bilingual L() helper) but has no locked/credits
// state — both styles are always free to pick.
import React from "react";
import { Modal, View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import type { ExplanationStyle } from "../lib/scanUpload";

type Props = {
  visible: boolean;
  onChoose: (style: ExplanationStyle) => void;
};

export default function ExplanationStyleChooser({ visible, onChoose }: Props) {
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const L = (en: string, s: string) => (so ? s : en);

  return (
    <Modal transparent visible={visible} animationType="slide">
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{L("Choose Explanation Style", "Dooro Habka Sharaxaadda")}</Text>
          <Text style={styles.subtitle}>
            {L(
              "How would you like GemScan to explain your results? You can change this any time in Settings.",
              "Sideed jeceshahay in GemScan kuu sharaxo natiijooyinkaaga? Waxaad ka beddeli kartaa mar kasta Settings.",
            )}
          </Text>

          <Pressable style={styles.option} onPress={() => onChoose("simple")} accessibilityRole="button">
            <Text style={styles.optIcon}>🌱</Text>
            <View style={styles.optBody}>
              <Text style={styles.optTitle}>{L("Simple", "Fudud")}</Text>
              <Text style={styles.optLine}>
                {L(
                  "Plain-English explanations, easy for beginners",
                  "Sharaxaad fudud oo Ingiriis ah, u fudud bilowga",
                )}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#8A8A8E" />
          </Pressable>

          <Pressable style={[styles.option, styles.optionExpert]} onPress={() => onChoose("expert")} accessibilityRole="button">
            <Text style={styles.optIcon}>🔬</Text>
            <View style={styles.optBody}>
              <Text style={styles.optTitle}>{L("Expert", "Khibrad")}</Text>
              <Text style={styles.optLine}>
                {L(
                  "Full technical gemological report, for collectors & professionals",
                  "Warbixin farsamo oo buuxda, loogu talagalay ururiyayaasha & xirfadleyda",
                )}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#C9A227" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#161618",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    gap: 12,
    borderTopWidth: 1,
    borderColor: "#2A2A2C",
  },
  title: { fontSize: 18, fontWeight: "800", color: "#F5F1E8", textAlign: "center" },
  subtitle: { fontSize: 12.5, color: "#C9C9CC", lineHeight: 18, textAlign: "center", marginBottom: 4 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#1F1F22",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#2A2A2C",
    padding: 14,
  },
  optionExpert: { borderColor: "#C9A227" },
  optIcon: { fontSize: 24 },
  optBody: { flex: 1, gap: 3 },
  optTitle: { color: "#F5F1E8", fontWeight: "800", fontSize: 15 },
  optLine: { color: "#C9C9CC", fontSize: 12.5, lineHeight: 18 },
});

// "Choose Scan Type" sheet shown before a scan runs.
//
//   🔍 Standard Scan — one cheap AI model, everyday use, unlimited-ish.
//   💎 Deep Scan     — the 3-AI ensemble, spends ONE Deep Scan credit.
//
// PAYMENT ARCHITECTURE: this app NEVER sells anything in-app. When Deep Scan
// credits run out we only DISPLAY the state and, on Android/web, link OUT to the
// website to buy more (hidden on iOS per App Store Guideline 3.1.1). No IAP, no
// billing SDK, no in-app purchase flow.
import React from "react";
import { Modal, View, Text, Pressable, StyleSheet, Linking } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { EXTERNAL_PURCHASES_ENABLED, PAYMENT_URL } from "../lib/appLinks";
import type { ScanType } from "../lib/scanUpload";

type Props = {
  visible: boolean;
  remaining: number; // Deep Scan credits remaining (read-only, from backend).
  recommendDeep?: boolean; // smart recommendation for likely-valuable items.
  onChoose: (type: ScanType) => void;
  onClose: () => void;
};

export default function ScanTypeChooser({ visible, remaining, recommendDeep, onChoose, onClose }: Props) {
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const L = (en: string, s: string) => (so ? s : en);
  const hasCredits = remaining > 0;

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{L("Choose Scan Type", "Dooro Nooca Baaritaanka")}</Text>

          {recommendDeep && (
            <View style={styles.reco}>
              <Ionicons name="sparkles" size={14} color="#C9A227" />
              <Text style={styles.recoText}>
                {L(
                  "This item may have significant value. We recommend Deep Scan for higher confidence.",
                  "Shaygani wuxuu qiimo weyn yeelan karaa. Waxaan kugula talinaynaa Deep Scan si kalsooni sare loo helo.",
                )}
              </Text>
            </View>
          )}

          {/* Standard */}
          <Pressable style={styles.option} onPress={() => onChoose("standard")} accessibilityRole="button">
            <Text style={styles.optIcon}>🔍</Text>
            <View style={styles.optBody}>
              <Text style={styles.optTitle}>{L("Standard Scan", "Baaritaan Caadi ah")}</Text>
              <Text style={styles.optLine}>
                {L("Fast identification · everyday use", "Aqoonsi degdeg · isticmaal maalinle")}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#8A8A8E" />
          </Pressable>

          {/* Deep */}
          {hasCredits ? (
            <Pressable style={[styles.option, styles.optionDeep]} onPress={() => onChoose("deep")} accessibilityRole="button">
              <Text style={styles.optIcon}>💎</Text>
              <View style={styles.optBody}>
                <Text style={styles.optTitle}>{L("Deep Scan", "Baaritaan Qoto Dheer")}</Text>
                <Text style={styles.optLine}>
                  {L("3-AI expert analysis · higher confidence · uses 1 credit", "3 AI khibrad · kalsooni sare · isticmaal 1 credit")}
                </Text>
                <Text style={styles.credits}>
                  {L("Deep Scan Credits", "Credits Deep Scan")}: {remaining} {L("remaining", "hadhay")}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#C9A227" />
            </Pressable>
          ) : (
            <View style={[styles.option, styles.optionLocked]}>
              <Text style={styles.optIcon}>💎</Text>
              <View style={styles.optBody}>
                <Text style={styles.optTitle}>{L("Deep Scan — credits finished", "Deep Scan — credits dhammaaday")}</Text>
                <Text style={styles.optLine}>
                  {L("Your Deep Scan credits are finished.", "Credits-kaaga Deep Scan waa dhammaaday.")}
                </Text>
                {EXTERNAL_PURCHASES_ENABLED && (
                  <Pressable style={styles.buyBtn} onPress={() => Linking.openURL(PAYMENT_URL)} accessibilityRole="link">
                    <Text style={styles.buyText}>{L("Unlock Deep Scan on the website", "Fur Deep Scan website-ka")}</Text>
                  </Pressable>
                )}
                <Text style={styles.hint}>
                  {L("You can continue with a Standard Scan above.", "Waxaad ku sii wadi kartaa Standard Scan kore.")}
                </Text>
              </View>
            </View>
          )}

          <Pressable style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>{L("Cancel", "Jooji")}</Text>
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
  reco: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    backgroundColor: "rgba(201,162,39,0.12)",
    borderRadius: 10,
    padding: 10,
  },
  recoText: { flex: 1, color: "#E8E2D2", fontSize: 12.5, lineHeight: 18 },
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
  optionDeep: { borderColor: "#C9A227" },
  optionLocked: { opacity: 0.9 },
  optIcon: { fontSize: 24 },
  optBody: { flex: 1, gap: 3 },
  optTitle: { color: "#F5F1E8", fontWeight: "800", fontSize: 15 },
  optLine: { color: "#C9C9CC", fontSize: 12.5, lineHeight: 18 },
  credits: { color: "#C9A227", fontSize: 12.5, fontWeight: "700", marginTop: 2 },
  buyBtn: {
    marginTop: 8,
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 10,
    alignItems: "center",
  },
  buyText: { color: "#0B0B0C", fontWeight: "800", fontSize: 13 },
  hint: { color: "#8A8A8E", fontSize: 11.5, marginTop: 6 },
  cancel: { paddingVertical: 10, alignItems: "center" },
  cancelText: { color: "#8A8A8E", fontWeight: "700", fontSize: 14 },
});

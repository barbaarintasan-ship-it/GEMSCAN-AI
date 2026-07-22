// UpdateGate: on app launch, checks whether a newer version is published and,
// if so, shows a prompt linking to the Play Store. A "forced" update (installed
// version below app_config.min_version) hides the "Later" button so the user
// must update to continue. Rendered once at the app root.
import React, { useEffect, useState } from "react";
import { Modal, View, Text, Pressable, StyleSheet, Linking } from "react-native";
import { useTranslation } from "react-i18next";
import { checkForUpdate, type AppUpdateInfo } from "../lib/appUpdate";

export default function UpdateGate() {
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    checkForUpdate().then((r) => {
      if (active && r) setInfo(r);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!info || dismissed) return null;

  const message = so ? info.message.so : info.message.en;

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={() => {
        if (!info.forced) setDismissed(true);
      }}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.logo}>💎 LuulScan</Text>
          <Text style={styles.title}>{so ? "Nooc cusub ayaa jira" : "Update available"}</Text>
          <Text style={styles.body}>{message}</Text>

          <Pressable
            style={styles.primary}
            onPress={() => Linking.openURL(info.storeUrl)}
            accessibilityRole="button"
          >
            <Text style={styles.primaryText}>{so ? "Cusboonaysii hadda" : "Update now"}</Text>
          </Pressable>

          {!info.forced && (
            <Pressable style={styles.later} onPress={() => setDismissed(true)}>
              <Text style={styles.laterText}>{so ? "Mar dambe" : "Later"}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#161618",
    borderWidth: 1,
    borderColor: "#C9A227",
    borderRadius: 18,
    padding: 22,
    gap: 10,
    alignItems: "center",
  },
  logo: { fontSize: 22, fontWeight: "900", color: "#C9A227" },
  title: { fontSize: 18, fontWeight: "800", color: "#F5F1E8", textAlign: "center" },
  body: { fontSize: 14, color: "#C9C9CC", textAlign: "center", lineHeight: 20, marginBottom: 4 },
  primary: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
    width: "100%",
  },
  primaryText: { color: "#0B0B0C", fontWeight: "800", fontSize: 15 },
  later: { paddingVertical: 10, alignItems: "center", width: "100%" },
  laterText: { color: "#8A8A8E", fontWeight: "700", fontSize: 14 },
});

// CommunityStats
//
// Home-screen footer with two LIVE community counters — registered users and
// confirmed valuable gems scanned — pulled from the backend (usePublicStats)
// and shown with an attractive count-up animation. Read-only social proof; no
// personal data. Renders nothing until the first real numbers arrive, so it
// never flashes zeros.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Animated, Easing } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { usePublicStats } from "../lib/publicStats";

// Count from 0 → target with an easeOutCubic curve when the target first loads.
function useCountUp(target: number, duration = 1400): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!target || target <= 0) {
      setValue(0);
      return;
    }
    let raf = 0;
    const start = Date.now();
    const tick = () => {
      const p = Math.min((Date.now() - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

function StatTile({
  icon,
  color,
  value,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  value: number;
  label: string;
}) {
  const count = useCountUp(value);
  return (
    <View style={styles.tile}>
      <Ionicons name={icon} size={22} color={color} />
      <Text style={styles.number}>{count.toLocaleString()}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

export function CommunityStats() {
  const { data } = usePublicStats();
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (data) {
      Animated.timing(fade, {
        toValue: 1,
        duration: 500,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    }
  }, [data, fade]);

  // Don't render until we have real numbers — avoids a flash of "0".
  if (!data) return null;

  return (
    <Animated.View style={[styles.card, { opacity: fade }]}>
      <Text style={styles.heading}>{so ? "Bulshada GemScan" : "The GemScan community"}</Text>
      <View style={styles.row}>
        <StatTile
          icon="people"
          color="#6Fb0ff"
          value={data.registeredUsers}
          label={so ? "isticmaale diiwaangashan" : "registered users"}
        />
        <View style={styles.divider} />
        <StatTile
          icon="diamond"
          color="#C9A227"
          value={data.confirmedGems}
          label={so ? "dhagax qaali ah oo la xaqiijiyay" : "valuable gems confirmed"}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#141315",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#242123",
    padding: 16,
    marginTop: 6,
    gap: 12,
  },
  heading: {
    fontSize: 12,
    color: "#8A8A8E",
    textTransform: "uppercase",
    letterSpacing: 1,
    fontWeight: "700",
    textAlign: "center",
  },
  row: { flexDirection: "row", alignItems: "flex-start", justifyContent: "center" },
  tile: { flex: 1, alignItems: "center", gap: 5, paddingHorizontal: 6 },
  divider: { width: 1, alignSelf: "stretch", backgroundColor: "#242123", marginVertical: 2 },
  number: { fontSize: 28, fontWeight: "900", color: "#C9A227" },
  label: { fontSize: 11, color: "#C9C9CC", textAlign: "center", lineHeight: 15 },
});

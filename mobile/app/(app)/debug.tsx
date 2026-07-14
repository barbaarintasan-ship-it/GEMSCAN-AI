// Hidden Debug / Diagnostics screen (reached by tapping the version number 5×
// in Settings). Surfaces the device-compatibility state, live metrics and the
// recent stage log so scanner failures are inspectable on any device without a
// wired debugger.
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { Stack } from "expo-router";
import { diag, type GpuState } from "../../lib/diagnostics";

const GPU_COLOR: Record<GpuState, string> = {
  unknown: "#C9A227",
  available: "#2E7D32",
  disabled: "#E4685D",
};

export default function DebugScreen() {
  const [, force] = useState(0);
  // Refresh periodically so the log/metrics stay live while a scan runs.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const m = diag.getMetrics();
  const gpu = diag.gpuState();
  const logs = diag.getLogs();

  const rows: [string, string][] = [
    ["GPU available", gpu === "available" ? "yes" : gpu === "disabled" ? "no (disabled)" : "unknown"],
    ["CPU fallback active", m.cpuFallbackActive ? "yes" : "no"],
    ["OpenGL status", m.openGlStatus],
    ["TensorFlow status", m.tensorflowStatus],
    ["Camera resolution", m.cameraResolution ?? "—"],
    ["Camera FPS", m.cameraFps ?? "—"],
    ["Image dimensions", m.imageDimensions ?? "—"],
    ["Upload size", m.uploadSizeKb != null ? `${m.uploadSizeKb} KB` : "—"],
    ["Analysis engine", m.currentProvider ?? "—"],
    ["Last scan time", m.lastScanMs != null ? `${m.lastScanMs} ms` : "—"],
  ];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Diagnostics" }} />

      <View style={[styles.badge, { backgroundColor: GPU_COLOR[gpu] }]}>
        <Text style={styles.badgeText}>
          GPU: {gpu.toUpperCase()}
          {gpu === "disabled" ? " · running CPU-only" : ""}
        </Text>
      </View>

      <Text style={styles.section}>Device / pipeline</Text>
      <View style={styles.card}>
        {rows.map(([k, v]) => (
          <View style={styles.row} key={k}>
            <Text style={styles.k}>{k}</Text>
            <Text style={styles.v}>{v}</Text>
          </View>
        ))}
      </View>

      <View style={styles.headerRow}>
        <Text style={styles.section}>Stage log (newest first)</Text>
        <Pressable onPress={() => { diag.clear(); force((n) => n + 1); }}>
          <Text style={styles.clear}>Clear</Text>
        </Pressable>
      </View>
      <View style={styles.card}>
        {logs.length === 0 ? (
          <Text style={styles.empty}>No events yet. Run a scan.</Text>
        ) : (
          logs.map((l, i) => (
            <Text key={`${l.t}-${i}`} style={[styles.log, l.level === "error" && styles.logError]}>
              {new Date(l.t).toLocaleTimeString()} · {l.stage}
              {l.detail ? ` — ${l.detail}` : ""}
            </Text>
          ))
        )}
      </View>

      <Text style={styles.note}>
        This screen is diagnostic only. GPU/OpenGL failures automatically switch the
        scanner to CPU-only; they never block scanning.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B0B0C" },
  content: { padding: 20, gap: 12 },
  badge: { borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, alignSelf: "flex-start" },
  badgeText: { color: "#0B0B0C", fontWeight: "800", fontSize: 13 },
  section: { color: "#8A8A8E", fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginTop: 6 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  clear: { color: "#C9A227", fontSize: 13, marginTop: 6 },
  card: { backgroundColor: "#161618", borderRadius: 12, padding: 12, gap: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  k: { color: "#C9C9CC", fontSize: 13, flex: 1 },
  v: { color: "#F5F1E8", fontSize: 13, fontWeight: "600", textAlign: "right", flex: 1 },
  log: { color: "#C9C9CC", fontSize: 11, fontFamily: "monospace" },
  logError: { color: "#E4685D" },
  empty: { color: "#8A8A8E", fontSize: 13 },
  note: { color: "#8A8A8E", fontSize: 11, lineHeight: 16, marginTop: 4 },
});

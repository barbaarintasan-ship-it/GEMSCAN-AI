// Hidden Debug / Diagnostics screen (reached by tapping the version number 5×
// in Settings). Surfaces the device-compatibility state, live metrics and the
// recent stage log so scanner failures are inspectable on any device without a
// wired debugger.
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, Share, Platform, Switch } from "react-native";
import { Stack } from "expo-router";
import { diag, type GpuState } from "../../lib/diagnostics";
import { FieldSessionProvider, useFieldSession } from "../../lib/field/provider";
import { WALKING_PROFILE } from "../../lib/field/types";
import { runPackSelfCheck, type PackSelfCheck } from "../../lib/geo/packSelfCheck";

const GPU_COLOR: Record<GpuState, string> = {
  unknown: "#C9A227",
  available: "#2E7D32",
  disabled: "#E4685D",
};

export default function DebugScreen() {
  const [, force] = useState(0);
  // The pack answers for itself, on this device. Everything else that verifies
  // it runs on a development machine, and the one failure that mattered only
  // ever appeared on a phone.
  const [pack, setPack] = useState<PackSelfCheck | null>(null);
  useEffect(() => { void runPackSelfCheck().then(setPack); }, []);
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

      <View style={[styles.badge, { backgroundColor: pack ? (pack.ok ? "#2E7D32" : "#E4685D") : "#C9A227" }]}>
        <Text style={styles.badgeText}>
          {pack ? (pack.ok ? "KNOWLEDGE PACK: OK" : "KNOWLEDGE PACK: FAILED") : "KNOWLEDGE PACK: checking…"}
        </Text>
      </View>

      <Text style={styles.section}>Knowledge pack</Text>
      <View style={styles.card}>
        {pack ? (
          <>
            <View style={styles.row}>
              <Text style={styles.k}>Result</Text>
              <Text style={styles.v}>{pack.summary}</Text>
            </View>
            {([
              ["Manifest found", pack.manifestFound ? "yes" : "no"],
              ["Files shipped", `${pack.filesShipped} of ${pack.filesDeclared} declared`],
              ["Load state", pack.loadState],
              ["Pack version", pack.packVersion ?? "—"],
              ["Geological units", String(pack.counts.geology)],
              ["MRDS occurrences", String(pack.counts.occurrences)],
              ["Mapped faults", String(pack.counts.faults)],
              ["Terrain cells", String(pack.counts.terrain)],
              ["Geology at Mogadishu", pack.probeUnit ?? "NONE — pack cannot answer"],
            ] as [string, string][]).map(([k, v]) => (
              <View style={styles.row} key={k}>
                <Text style={styles.k}>{k}</Text>
                <Text style={styles.v}>{v}</Text>
              </View>
            ))}
            {pack.problem ? (
              <View style={styles.row}>
                <Text style={styles.k}>Problem</Text>
                <Text style={[styles.v, { color: "#E4685D" }]}>{pack.problem}</Text>
              </View>
            ) : null}
          </>
        ) : (
          <Text style={styles.v}>Running self-check…</Text>
        )}
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

      {/* Field Exploration Engine — Phase 1 diagnostics (available in release for testing). */}
      <FieldSessionProvider>
        <FieldEngineSection />
      </FieldSessionProvider>

      <Text style={styles.note}>
        This screen is diagnostic only. GPU/OpenGL failures automatically switch the
        scanner to CPU-only; they never block scanning.
      </Text>
    </ScrollView>
  );
}

// ── Field Engine (P1) dev section ───────────────────────────────────────────
// Every row below is read from ONE report object, and Export serialises that
// same object — the screen and the JSON cannot drift apart.
function FieldEngineSection() {
  const { snapshot: s, controller, actions } = useFieldSession();
  const rec = controller.recorder;
  const report = controller.diagnosticsReport({
    os: Platform.OS,
    version: String(Platform.Version),
  });
  const { counters, timings, accuracy: acc, services, session, config } = report;
  const subs = services.subscriptions;
  const audit = report.cleanupAudit;
  const trip = report.tripwire;
  const m = s.machine;

  const fix = report.lastFix;
  const fixAge = fix ? Math.round((Date.now() - fix.timestamp) / 1000) : null;
  const stateLabel = session.state;

  const onExport = () => {
    void Share.share({ message: JSON.stringify(report, null, 2) });
  };

  const fieldRows: [string, string][] = [
    ["Session state", stateLabel],
    ["Session id", session.id ?? "—"],
    ["Recording", report.recorderEnabled ? "on" : "OFF (counters frozen)"],
    ["Permission", session.permission ? `${session.permission.granted ? "granted" : "denied"}${session.permission.granted && !session.permission.preciseGranted ? " (approximate)" : ""}` : "—"],
    ["GPS status", services.locationStatus],
    ["Last fix", fix ? `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)} ±${fix.accuracy ?? "?"}m · ${fixAge}s${fix.provisional ? " · ≈provisional" : ""}` : "—"],
    ["Fix accuracy (min/med/max)", acc ? `${acc.min} / ${acc.median} / ${acc.max} m` : "—"],
    ["Heading status", services.headingStatus],
    ["Heading", report.lastHeading ? `${Math.round(report.lastHeading.trueHeading)}°${report.lastHeading.needsCalibration ? " · calibrate!" : ""}` : "—"],
    ["Subscriptions (pos/head/app)", `${subs.position}/${subs.heading}/${subs.appState}`],
    ["Profile", `${config.profile.name} · balanced · ${config.profile.distanceIntervalM}m/${config.profile.timeIntervalMs}ms · hdg ${config.headingGate.minDeltaDeg}°/${config.headingGate.minIntervalMs}ms`],
    ["Fixes (total/prov/lowAcc)", `${counters.fixesTotal}/${counters.fixesProvisional}/${counters.fixesLowAccuracy}`],
    ["Heading raw→emitted", `${counters.headingRaw}→${counters.headingEmitted}`],
    ["Dispatches", String(counters.dispatches)],
    ["Errors / retries / cycles", `${counters.errors}/${counters.watchRetries}/${counters.startStopCycles}`],
    ["Pauses u/s · resumes", `${counters.pausesUser}/${counters.pausesSystem} · ${counters.resumes}`],
    ["First fix (prov/fresh)", `${timings.provisionalFixMs ?? "—"} / ${timings.freshFixMs ?? "—"} ms`],
    ["Permission dialog", timings.permissionMs != null ? `${timings.permissionMs} ms` : "—"],
    ["Avg fix interval", timings.avgFixIntervalMs != null ? `${Math.round(timings.avgFixIntervalMs / 100) / 10}s` : "—"],
    ["Resume→fix", timings.resumeToFixMs != null ? `${timings.resumeToFixMs} ms` : "—"],
  ];

  const transitions = report.transitions.slice(-8).reverse();
  const lifecycle = report.lifecycle.slice(-10).reverse();

  // ── Phase 1.1 Battery Test Mode ───────────────────────────────────────────
  // Independent GPS / heading switches for real-device battery comparison.
  // ON/OFF is derived from the ACTUAL subscription count (not a local boolean),
  // so the display can never disagree with reality. Uses only interfaces P1
  // already exposes (controller.location / controller.heading) — Phase 1
  // behaviour is untouched.
  const gpsOn = subs.position > 0;
  const headingOn = subs.heading > 0;
  // Toggles apply while a session owns the listeners; outside a session a raw
  // watch would have no consumer, so they stay disabled.
  const sensorsToggleable = m.state === "active" || m.state === "paused";

  const toggleGps = (v: boolean) => {
    rec.log(`battery test: GPS ${v ? "on" : "off"}`);
    if (v) void controller.location.start(WALKING_PROFILE);
    else controller.location.stop();
  };
  const toggleHeading = (v: boolean) => {
    rec.log(`battery test: heading ${v ? "on" : "off"}`);
    if (v) void controller.heading.start();
    else controller.heading.stop();
  };

  return (
    <>
      <Text style={styles.section}>Battery test mode (P1.1)</Text>
      <View style={styles.card}>
        <View style={styles.feToggleRow}>
          <View>
            <Text style={styles.v}>GPS</Text>
            <Text style={styles.feToggleHint}>{controller.location.getStatus()}</Text>
          </View>
          <View style={styles.feToggleRight}>
            <View style={[styles.feStateChip, { backgroundColor: gpsOn ? "#2E7D32" : "#2A2A2C" }]}>
              <Text style={styles.badgeText}>{gpsOn ? "ON" : "OFF"}</Text>
            </View>
            <Switch
              value={gpsOn}
              disabled={!sensorsToggleable}
              onValueChange={toggleGps}
              trackColor={{ false: "#2A2A2C", true: "rgba(46,125,50,0.5)" }}
              thumbColor={gpsOn ? "#2E7D32" : "#8A8A8E"}
            />
          </View>
        </View>
        <View style={styles.feDivider} />
        <View style={styles.feToggleRow}>
          <View>
            <Text style={styles.v}>Heading</Text>
            <Text style={styles.feToggleHint}>{controller.heading.getStatus()}</Text>
          </View>
          <View style={styles.feToggleRight}>
            <View style={[styles.feStateChip, { backgroundColor: headingOn ? "#2E7D32" : "#2A2A2C" }]}>
              <Text style={styles.badgeText}>{headingOn ? "ON" : "OFF"}</Text>
            </View>
            <Switch
              value={headingOn}
              disabled={!sensorsToggleable}
              onValueChange={toggleHeading}
              trackColor={{ false: "#2A2A2C", true: "rgba(46,125,50,0.5)" }}
              thumbColor={headingOn ? "#2E7D32" : "#8A8A8E"}
            />
          </View>
        </View>
        <View style={styles.feDivider} />
        {([
          ["Session state", stateLabel],
          ["Active subscriptions", `pos ${subs.position} · hdg ${subs.heading} · app ${subs.appState}`],
          ["GPS fixes this session", `${counters.fixesTotal} total · ${session.fixCount} non-provisional`],
          ["Heading raw→emitted", `${counters.headingRaw}→${counters.headingEmitted}`],
        ] as [string, string][]).map(([k, v]) => (
          <View style={styles.row} key={k}>
            <Text style={styles.k}>{k}</Text>
            <Text style={styles.v}>{v}</Text>
          </View>
        ))}
      </View>
      {!sensorsToggleable && (
        <Text style={styles.feToggleHint}>Start a session to enable the sensor switches.</Text>
      )}

      <Text style={styles.section}>Field Engine (P1)</Text>
      <View style={styles.card}>
        {fieldRows.map(([k, v]) => (
          <View style={styles.row} key={k}>
            <Text style={styles.k}>{k}</Text>
            <Text style={styles.v}>{v}</Text>
          </View>
        ))}
      </View>

      {/* Cleanup badges (spec Part 11.5) */}
      <View style={styles.feChipRow}>
        <View style={[styles.feChip, { backgroundColor: trip.violated ? "#E4685D" : "#2E7D32" }]}>
          <Text style={styles.badgeText}>{trip.violated ? "POST-STOP EVENT" : "TRIPWIRE OK"}</Text>
        </View>
        {audit && (
          <View style={[styles.feChip, { backgroundColor: audit.pass ? "#2E7D32" : "#E4685D" }]}>
            <Text style={styles.badgeText}>CLEANUP {audit.pass ? "PASS" : "FAIL"}</Text>
          </View>
        )}
      </View>
      {audit && !audit.pass && (
        <View style={styles.card}>
          {audit.checks.filter((c) => !c.pass).map((c) => (
            <Text key={c.name} style={styles.logError}>✗ {c.name}</Text>
          ))}
        </View>
      )}

      <View style={styles.feChipRow}>
        {[
          ["Start", actions.start], ["Pause", actions.pause], ["Resume", actions.resume],
          ["Stop", actions.stop], ["Retry", actions.retry], ["Export", onExport],
        ].map(([label, fn]) => (
          <Pressable key={label as string} style={styles.feBtn} onPress={fn as () => void}>
            <Text style={styles.feBtnText}>{label as string}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.section}>Transition log (newest first)</Text>
      <View style={styles.card}>
        {transitions.length === 0 ? (
          <Text style={styles.empty}>No transitions yet. Tap Start.</Text>
        ) : (
          transitions.map((t, i) => (
            <Text key={`${t.t}-${i}`} style={styles.log}>
              {new Date(t.t).toLocaleTimeString()} · {t.from} —{t.event}→ {t.to} ({t.dwellMs}ms)
            </Text>
          ))
        )}
      </View>

      <Text style={styles.section}>Lifecycle log (newest first)</Text>
      <View style={styles.card}>
        {lifecycle.length === 0 ? (
          <Text style={styles.empty}>No lifecycle events yet. Tap Start.</Text>
        ) : (
          lifecycle.map((l, i) => (
            <Text key={`${l.t}-${i}`} style={[styles.log, l.ignored && styles.logError]}>
              {new Date(l.t).toLocaleTimeString()} · {l.ignored ? "⊘ " : ""}{l.msg}
            </Text>
          ))
        )}
      </View>
    </>
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
  // Field Engine (P1) dev section
  feChipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  feChip: { borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 },
  feBtn: {
    backgroundColor: "#161618", borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14,
    borderWidth: 1, borderColor: "#2A2A2C",
  },
  feBtnText: { color: "#C9A227", fontSize: 13, fontWeight: "700" },
  // Battery test mode (P1.1)
  feToggleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
  feToggleRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  feToggleHint: { color: "#8A8A8E", fontSize: 11, marginTop: 2 },
  feStateChip: { borderRadius: 999, paddingVertical: 3, paddingHorizontal: 10, minWidth: 44, alignItems: "center" },
  feDivider: { height: 1, backgroundColor: "#2A2A2C" },
});

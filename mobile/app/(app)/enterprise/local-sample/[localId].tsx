// A sample this device is still holding, viewable with no signal at all.
//
// "All locally created samples must be visible, searchable, editable and viewable
// while offline." The collection covers the first three. This is the fourth: the
// record as the device holds it — the photographs, the fix, the observations, and
// an honest statement of where it is in the pipeline.
//
// Deliberately NOT the server detail screen. That screen renders an analysis, a
// review and a discussion, none of which exist yet for a sample the server has
// never seen; pointing it at a local id would 404, and faking its sections would
// be the app claiming an assessment nobody has made.
//
// Reads only. Editing goes back through the capture form, which owns validation.
import React from "react";
import {
  ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing, type as t } from "../../../../lib/theme";
import { localSamples, useSampleSync } from "../../../../lib/samples/store";
import { pushPendingSamples } from "../../../../lib/samples/pendingSampleSync";
import type { LocalSample } from "../../../../lib/samples/localSampleStore";
import { useIsOnline } from "../../../../lib/network";

export default function LocalSampleScreen() {
  const { localId } = useLocalSearchParams<{ localId: string }>();
  const insets = useSafeAreaInsets();
  const isOnline = useIsOnline();
  const sync = useSampleSync();
  const [sample, setSample] = React.useState<LocalSample | null | undefined>(undefined);

  // Re-read on every store change: the sample may be filed while this screen is
  // open, and it should say so without being reopened.
  React.useEffect(() => {
    const store = localSamples();
    const read = () => setSample(store.get(String(localId)) ?? null);
    const off = store.subscribe(read);
    void store.load().then(read);
    return off;
  }, [localId]);

  if (sample === undefined) {
    return <View style={styles.center}><ActivityIndicator color={colors.gold} /></View>;
  }
  if (sample === null) {
    return (
      <View style={styles.center}>
        <Text style={styles.body}>This sample is no longer held on the device.</Text>
        <Pressable style={styles.btn} onPress={() => router.back()}>
          <Text style={styles.btnText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const p = sample.payload;
  const filed = sample.state === "uploaded";

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl }}
    >
      <Text style={styles.title}>{p.name || "Unnamed sample"}</Text>

      {/* WHERE IT IS. Not "submitted" until it is — the app does not claim work
          it has not done. */}
      <View style={[styles.state, filed ? styles.stateGood : styles.stateHeld]}>
        <Ionicons
          name={filed ? "cloud-done-outline" : sync.uploading ? "cloud-upload-outline" : "phone-portrait-outline"}
          size={16}
          color={filed ? "#22C55E" : colors.gold}
        />
        <Text style={[styles.stateText, filed && styles.stateTextGood]}>
          {filed
            ? "Filed with the server. Analysis runs there."
            : sync.uploading
              ? "Filing now…"
              : isOnline
                ? "Held on this device — filing shortly"
                : "Held on this device — will be filed when there is a connection"}
        </Text>
      </View>

      {sample.lastError && !filed ? (
        // The reason, stated as a retry rather than a failure: the sample is safe.
        <Text style={styles.retry}>Last attempt: {sample.lastError} · will retry</Text>
      ) : null}

      <Section title="PHOTOGRAPHS">
        {sample.photos.length === 0 ? (
          <Text style={styles.faint}>None attached.</Text>
        ) : (
          <View style={styles.photos}>
            {sample.photos.map((photo, i) => (
              <View key={photo.localUri + i} style={styles.photoWrap}>
                {/* From app-owned storage, so this renders with no signal and
                    survives the OS clearing its caches. */}
                <Image source={{ uri: photo.localUri }} style={styles.photo} />
                <Text style={styles.photoRole}>
                  {photo.role}
                  {photo.storagePath ? " · uploaded" : ""}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Section>

      <Section title="POSITION">
        <Row k="Latitude" v={p.lat.toFixed(6)} />
        <Row k="Longitude" v={p.lng.toFixed(6)} />
        {/* As the receiver reported it, unrounded. */}
        <Row k="GPS accuracy" v={p.gps_accuracy_m == null ? "not reported" : `±${p.gps_accuracy_m} m`} />
        <Row k="Source" v={p.gps_source ?? "gps"} />
        <Row k="Collected" v={new Date(p.collected_at ?? sample.createdAt).toLocaleString()} />
      </Section>

      <Section title="OBSERVATIONS">
        <Row k="Rock class" v={p.observations?.rock?.rock_class || "not recorded"} />
        <Row
          k="Minerals"
          v={p.observations?.minerals?.length ? p.observations.minerals.map((m) => m.mineral).join(", ") : "not recorded"}
        />
        <Row k="Field notes" v={p.field_observations || "not recorded"} />
      </Section>

      <Section title="PROVENANCE">
        <Row k="Local id" v={sample.localId} />
        <Row k="Server id" v={sample.serverId ?? "not filed yet"} />
        <Row k="Expedition" v={sample.expeditionSessionId ?? "not part of a walk"} />
        <Row k="Analysis" v={sample.aiState} />
      </Section>

      {filed && sample.serverId ? (
        <Pressable
          style={styles.btn}
          onPress={() => router.replace(`/(app)/enterprise/sample/${sample.serverId}`)}
        >
          <Ionicons name="document-text-outline" size={18} color="#0B0B0C" />
          <Text style={styles.btnText}>Open the full report</Text>
        </Pressable>
      ) : (
        <Pressable
          style={[styles.btn, !isOnline && styles.btnDisabled]}
          disabled={!isOnline}
          onPress={() => {
            void pushPendingSamples(localSamples(), isOnline).then((r) => {
              if (r.failed > 0) {
                Alert.alert(
                  "Still held on the device",
                  "The upload did not get through. The sample is safe here and will be retried automatically.",
                );
              }
            });
          }}
        >
          <Ionicons name="cloud-upload-outline" size={18} color="#0B0B0C" />
          <Text style={styles.btnText}>{isOnline ? "Try filing now" : "Waiting for a connection"}</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.k}>{k}</Text>
      <Text style={styles.v} selectable>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.lg },
  title: { ...t.title, color: colors.text, marginBottom: spacing.md },

  state: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.sm,
  },
  stateHeld: { borderColor: colors.goldBorder, backgroundColor: colors.goldSoft },
  stateGood: { borderColor: "rgba(34,197,94,0.35)", backgroundColor: "rgba(34,197,94,0.08)" },
  stateText: { ...t.body, color: colors.gold, flex: 1 },
  stateTextGood: { color: "#22C55E" },
  retry: { ...t.caption, color: colors.textFaint, marginBottom: spacing.md },

  section: { marginTop: spacing.lg },
  sectionTitle: { ...t.caption, color: "#4A90E2", fontWeight: "700", letterSpacing: 0.6, marginBottom: spacing.sm },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, paddingVertical: 4 },
  k: { ...t.caption, color: colors.textFaint, width: 112 },
  v: { ...t.body, color: colors.text, flex: 1 },
  body: { ...t.body, color: colors.textMuted, textAlign: "center" },
  faint: { ...t.caption, color: colors.textFaint },

  photos: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  photoWrap: { width: 104 },
  photo: { width: 104, height: 104, borderRadius: radius.md, backgroundColor: colors.surfaceSunken },
  photoRole: { ...t.caption, color: colors.textFaint, marginTop: 2 },

  btn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm,
    backgroundColor: colors.gold, borderRadius: radius.lg, paddingVertical: spacing.md,
    marginTop: spacing.xl,
  },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
});

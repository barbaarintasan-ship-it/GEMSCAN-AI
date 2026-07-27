// Enterprise › New Sample (Sprint 4.2 owner beta).
// Minimal field-capture form: GPS fix (auto), optional photos, mineral
// observations, rock notes → POST /enterprise-samples. On success it pops back
// to My Samples. No org/mission/verification concepts — just enough to test the
// end-to-end submission pipeline.
import React, { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, ScrollView, StyleSheet, Pressable, Image, Alert, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { colors, spacing, radius, type as t } from "../../../lib/theme";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { SectionLabel } from "../../../components/ui/SectionLabel";
import {
  captureSampleLocation,
  submitSample,
  uploadSampleMedia,
  type MediaRole,
  type MineralObservationInput,
  type SampleMediaInput,
} from "../../../lib/enterpriseSamples";

type Photo = { uri: string; role: MediaRole };

export default function NewSampleScreen() {
  const [loc, setLoc] = useState<{ lat: number; lng: number; gps_accuracy_m?: number } | null>(null);
  const [locating, setLocating] = useState(true);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [minerals, setMinerals] = useState<MineralObservationInput[]>([]);
  const [mineralDraft, setMineralDraft] = useState("");
  const [rockClass, setRockClass] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const grabLocation = useCallback(async () => {
    setLocating(true);
    try {
      const l = await captureSampleLocation();
      if (!l) Alert.alert("Location unavailable", "Grant location permission to capture a GPS fix.");
      setLoc(l);
    } finally {
      setLocating(false);
    }
  }, []);

  useEffect(() => { grabLocation(); }, [grabLocation]);

  const addPhoto = useCallback(async () => {
    const result = await ImagePicker.launchCameraAsync({ quality: 1 });
    if (result.canceled || !result.assets?.[0]) return;
    // First photo is the wide "context" shot; the rest are close-ups.
    const role: MediaRole = photos.length === 0 ? "context" : "surface_closeup";
    setPhotos((p) => [...p, { uri: result.assets[0].uri, role }]);
  }, [photos.length]);

  const addMineral = useCallback(() => {
    const name = mineralDraft.trim();
    if (!name) return;
    setMinerals((m) => [...m, { mineral: name }]);
    setMineralDraft("");
  }, [mineralDraft]);

  const canSubmit = !!loc && !submitting;

  const onSubmit = useCallback(async () => {
    if (!loc) {
      Alert.alert("GPS required", "Capture a location fix before submitting.");
      return;
    }
    setSubmitting(true);
    try {
      // Upload any photos first, then submit the sample referencing their paths.
      const media: SampleMediaInput[] = [];
      for (const p of photos) media.push(await uploadSampleMedia(p.uri, p.role));

      const { sample_id } = await submitSample({
        lat: loc.lat,
        lng: loc.lng,
        gps_accuracy_m: loc.gps_accuracy_m,
        gps_source: "gps",
        field_observations: notes.trim() || undefined,
        observations: {
          rock: rockClass.trim() ? { rock_class: rockClass.trim() } : null,
          minerals,
        },
        media,
      });
      router.replace(`/(app)/enterprise/sample/${sample_id}`);
    } catch (e) {
      Alert.alert("Submission failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }, [loc, photos, minerals, rockClass, notes]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* Location */}
      <SectionLabel>Location</SectionLabel>
      <Card>
        {locating ? (
          <View style={styles.locRow}><ActivityIndicator color={colors.gold} /><Text style={styles.locText}>Getting GPS fix…</Text></View>
        ) : loc ? (
          <View style={styles.locRow}>
            <Ionicons name="location" size={20} color={colors.gold} />
            <View style={{ flex: 1 }}>
              <Text style={styles.locCoords}>{loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}</Text>
              <Text style={styles.locAcc}>{loc.gps_accuracy_m != null ? `±${loc.gps_accuracy_m} m accuracy` : "accuracy unknown"}</Text>
            </View>
            <Pressable onPress={grabLocation} hitSlop={8}><Ionicons name="refresh" size={20} color={colors.textMuted} /></Pressable>
          </View>
        ) : (
          <Pressable style={styles.locRow} onPress={grabLocation}>
            <Ionicons name="location-outline" size={20} color={colors.danger} />
            <Text style={[styles.locText, { color: colors.danger }]}>No fix — tap to retry</Text>
          </Pressable>
        )}
      </Card>

      {/* Photos */}
      <SectionLabel>Photos ({photos.length})</SectionLabel>
      <View style={styles.photoRow}>
        {photos.map((p, i) => (
          <View key={i} style={styles.thumbWrap}>
            <Image source={{ uri: p.uri }} style={styles.thumb} />
            <Pressable style={styles.thumbX} onPress={() => setPhotos((cur) => cur.filter((_, j) => j !== i))} hitSlop={6}>
              <Ionicons name="close" size={13} color={colors.text} />
            </Pressable>
          </View>
        ))}
        <Pressable style={styles.addPhoto} onPress={addPhoto}>
          <Ionicons name="camera-outline" size={24} color={colors.gold} />
          <Text style={styles.addPhotoText}>Add</Text>
        </Pressable>
      </View>

      {/* Minerals */}
      <SectionLabel>Minerals observed</SectionLabel>
      <Card>
        <View style={styles.inlineRow}>
          <TextInput
            style={styles.input}
            value={mineralDraft}
            onChangeText={setMineralDraft}
            placeholder="e.g. quartz"
            placeholderTextColor={colors.textFaint}
            onSubmitEditing={addMineral}
            returnKeyType="done"
          />
          <Button title="Add" variant="outline" size="sm" onPress={addMineral} />
        </View>
        {minerals.length > 0 && (
          <View style={styles.chips}>
            {minerals.map((m, i) => (
              <Pressable key={i} style={styles.chip} onPress={() => setMinerals((cur) => cur.filter((_, j) => j !== i))}>
                <Text style={styles.chipText}>{m.mineral}</Text>
                <Ionicons name="close" size={13} color={colors.textMuted} />
              </Pressable>
            ))}
          </View>
        )}
      </Card>

      {/* Rock + notes */}
      <SectionLabel>Host rock (optional)</SectionLabel>
      <TextInput
        style={styles.inputBlock}
        value={rockClass}
        onChangeText={setRockClass}
        placeholder="e.g. granite, basalt, quartz vein"
        placeholderTextColor={colors.textFaint}
      />

      <SectionLabel>Field notes (optional)</SectionLabel>
      <TextInput
        style={[styles.inputBlock, styles.multiline]}
        value={notes}
        onChangeText={setNotes}
        placeholder="What did you see in the field?"
        placeholderTextColor={colors.textFaint}
        multiline
      />

      <Button
        title={submitting ? "Submitting…" : "Submit Sample"}
        variant="primary"
        loading={submitting}
        disabled={!canSubmit}
        onPress={onSubmit}
        style={{ marginTop: spacing.xl }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  locRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  locText: { ...t.body },
  locCoords: { ...t.subheading },
  locAcc: { ...t.caption, marginTop: 2 },
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  thumbWrap: { width: 72, height: 72 },
  thumb: { width: 72, height: 72, borderRadius: radius.md },
  thumbX: {
    position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 11,
    backgroundColor: colors.surfaceSunken, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: colors.border,
  },
  addPhoto: {
    width: 72, height: 72, borderRadius: radius.md, borderWidth: 1, borderColor: colors.goldBorder,
    borderStyle: "dashed", alignItems: "center", justifyContent: "center", gap: 2,
  },
  addPhotoText: { ...t.caption, color: colors.gold },
  inlineRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  input: {
    flex: 1, backgroundColor: colors.surfaceSunken, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.border, color: colors.text, paddingHorizontal: spacing.md, paddingVertical: 10,
  },
  inputBlock: {
    backgroundColor: colors.surfaceAlt, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    color: colors.text, paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  multiline: { minHeight: 88, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.goldSoft,
    borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.goldBorder,
  },
  chipText: { ...t.bodySmall, color: colors.text },
});

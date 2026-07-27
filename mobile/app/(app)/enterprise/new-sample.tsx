// Enterprise › New Sample (Sprint 4.2.1 — production field capture).
//
// Slice 1 scope: required Sample Name, auto-populated read-only Collector card,
// live required-field validation (Submit disabled until complete — §4), draft
// autosave to AsyncStorage (so a Take-Photo round trip or an accidental back
// never loses field data — §18/§19), and an unsaved-changes guard on exit.
// GPS richness (§2) and photo categories (§3) arrive in the next slices.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, StyleSheet, Pressable, Image, Alert, ActivityIndicator } from "react-native";
import { router, useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { colors, spacing, radius, type as t } from "../../../lib/theme";
import { useAuth } from "../../../lib/auth";
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

const DRAFT_KEY = "enterprise:new-sample:draft";
type GpsFix = { lat: number; lng: number; gps_accuracy_m?: number };
type DraftShape = {
  name: string; photos: string[]; minerals: MineralObservationInput[];
  rockClass: string; notes: string; loc: GpsFix | null;
};

// Photo role is derived by position: the first photo is the field-context shot,
// the rest are specimen close-ups. Full category picker comes in Slice 3.
function roleForIndex(i: number): MediaRole {
  return i === 0 ? "context" : "surface_closeup";
}

export default function NewSampleScreen() {
  const navigation = useNavigation();
  const { session } = useAuth();

  const [name, setName] = useState("");
  const [loc, setLoc] = useState<GpsFix | null>(null);
  const [locating, setLocating] = useState(true);
  const [photos, setPhotos] = useState<string[]>([]);
  const [minerals, setMinerals] = useState<MineralObservationInput[]>([]);
  const [mineralDraft, setMineralDraft] = useState("");
  const [rockClass, setRockClass] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [restored, setRestored] = useState(false);
  const submittedRef = useRef(false);

  // ── Draft persistence: restore once on mount, then autosave on every change ──
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(DRAFT_KEY);
        if (raw) {
          const d = JSON.parse(raw) as DraftShape;
          setName(d.name ?? ""); setPhotos(d.photos ?? []); setMinerals(d.minerals ?? []);
          setRockClass(d.rockClass ?? ""); setNotes(d.notes ?? ""); setLoc(d.loc ?? null);
        }
      } catch { /* ignore corrupt draft */ }
      setRestored(true);
    })();
  }, []);

  useEffect(() => {
    if (!restored) return; // don't overwrite the stored draft before it's loaded
    const d: DraftShape = { name, photos, minerals, rockClass, notes, loc };
    AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(d)).catch(() => {});
  }, [restored, name, photos, minerals, rockClass, notes, loc]);

  const clearDraft = useCallback(() => AsyncStorage.removeItem(DRAFT_KEY).catch(() => {}), []);

  const grabLocation = useCallback(async () => {
    setLocating(true);
    try {
      const l = await captureSampleLocation();
      if (!l) Alert.alert("Location unavailable", "Grant location permission to capture a GPS fix.");
      if (l) setLoc(l);
    } finally {
      setLocating(false);
    }
  }, []);

  // Capture a fix on first entry only if we didn't restore one.
  useEffect(() => { if (restored && !loc) grabLocation(); }, [restored]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!(name.trim() || photos.length || minerals.length || rockClass.trim() || notes.trim());

  // ── Unsaved-changes guard (§19) ─────────────────────────────────────────────
  useEffect(() => {
    const sub = navigation.addListener("beforeRemove", (e: any) => {
      if (!dirty || submittedRef.current || submitting) return;
      e.preventDefault();
      Alert.alert("Unsaved sample", "You have unsaved field data.", [
        { text: "Continue Editing", style: "cancel" },
        { text: "Save Draft", onPress: () => navigation.dispatch(e.data.action) }, // draft already autosaved
        { text: "Discard", style: "destructive", onPress: () => { clearDraft(); navigation.dispatch(e.data.action); } },
      ]);
    });
    return sub;
  }, [navigation, dirty, submitting, clearDraft]);

  // Take a new photo OR pick existing ones from the gallery (§3). System pickers:
  // native back arrow + hardware back work and they return automatically.
  const pickFrom = useCallback(async (mode: "camera" | "library") => {
    const result = mode === "camera"
      ? await ImagePicker.launchCameraAsync({ quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsMultipleSelection: true,
          quality: 1,
        });
    if (result.canceled) return;
    const uris = (result.assets ?? []).map((a) => a.uri).filter(Boolean);
    if (uris.length) setPhotos((p) => [...p, ...uris]);
  }, []);

  const addPhoto = useCallback(() => {
    Alert.alert("Add photo", undefined, [
      { text: "Take Photo", onPress: () => pickFrom("camera") },
      { text: "Choose from Library", onPress: () => pickFrom("library") },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [pickFrom]);

  const addMineral = useCallback(() => {
    const m = mineralDraft.trim();
    if (!m) return;
    setMinerals((cur) => [...cur, { mineral: m }]);
    setMineralDraft("");
  }, [mineralDraft]);

  // ── Validation (§4): mirrors the server checks; Submit disabled until all pass ─
  const checks = useMemo(() => [
    { key: "name", label: "Sample name", ok: !!name.trim() },
    { key: "gps", label: "GPS fix", ok: !!loc },
    { key: "context", label: "Field-context photo", ok: photos.length >= 1 },
    { key: "closeup", label: "Specimen close-up photo", ok: photos.length >= 2 },
    { key: "rock", label: "Host rock", ok: !!rockClass.trim() },
    { key: "mineral", label: "At least one mineral", ok: minerals.length >= 1 },
  ], [name, loc, photos.length, rockClass, minerals.length]);
  const canSubmit = checks.every((c) => c.ok) && !submitting;

  const onSubmit = useCallback(async () => {
    if (!loc || !canSubmit) return;
    setSubmitting(true);
    try {
      const media: SampleMediaInput[] = [];
      for (let i = 0; i < photos.length; i++) media.push(await uploadSampleMedia(photos[i], roleForIndex(i)));

      const { sample_id } = await submitSample({
        name: name.trim(),
        lat: loc.lat, lng: loc.lng, gps_accuracy_m: loc.gps_accuracy_m, gps_source: "gps",
        collected_at: new Date().toISOString(),
        field_observations: notes.trim() || undefined,
        observations: { rock: { rock_class: rockClass.trim() }, minerals },
        media,
      });
      submittedRef.current = true;
      await clearDraft();
      router.replace(`/(app)/enterprise/sample/${sample_id}`);
    } catch (e) {
      Alert.alert("Submission failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }, [loc, canSubmit, photos, name, notes, rockClass, minerals, clearDraft]);

  const collectorName = (session?.user?.user_metadata?.display_name as string | undefined)?.trim()
    || session?.user?.email?.split("@")[0] || "—";

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* Sample Name (§1) */}
      <SectionLabel>Sample name *</SectionLabel>
      <TextInput
        style={styles.inputBlock}
        value={name}
        onChangeText={setName}
        placeholder="e.g. Milxa Quartz Vein 01"
        placeholderTextColor={colors.textFaint}
        returnKeyType="done"
      />

      {/* Collector (§5) — auto, read-only */}
      <SectionLabel>Collector</SectionLabel>
      <Card>
        <View style={styles.collectorRow}>
          <View style={styles.collectorAvatar}><Ionicons name="person" size={18} color={colors.gold} /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.collectorName}>{collectorName}</Text>
            <Text style={styles.collectorMeta}>{session?.user?.email ?? ""}</Text>
          </View>
          <View style={styles.rolePill}><Text style={styles.rolePillText}>Owner</Text></View>
        </View>
      </Card>

      {/* Location */}
      <SectionLabel>Location *</SectionLabel>
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
      <SectionLabel>Photos ({photos.length}) *</SectionLabel>
      <Text style={styles.hint}>First photo = field context (wide). Add at least one close-up.</Text>
      <View style={styles.photoRow}>
        {photos.map((uri, i) => (
          <View key={i} style={styles.thumbWrap}>
            <Image source={{ uri }} style={styles.thumb} />
            <View style={styles.roleTag}><Text style={styles.roleTagText}>{i === 0 ? "context" : "close-up"}</Text></View>
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

      {/* Host rock (§4 required) */}
      <SectionLabel>Host rock *</SectionLabel>
      <TextInput
        style={styles.inputBlock}
        value={rockClass}
        onChangeText={setRockClass}
        placeholder="e.g. granite, basalt, quartz vein"
        placeholderTextColor={colors.textFaint}
      />

      {/* Minerals */}
      <SectionLabel>Minerals observed *</SectionLabel>
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

      {/* Field notes */}
      <SectionLabel>Field notes (optional)</SectionLabel>
      <TextInput
        style={[styles.inputBlock, styles.multiline]}
        value={notes}
        onChangeText={setNotes}
        placeholder="What did you see in the field?"
        placeholderTextColor={colors.textFaint}
        multiline
      />

      {/* Required checklist (§4) */}
      <SectionLabel>Required to submit</SectionLabel>
      <Card>
        {checks.map((c) => (
          <View key={c.key} style={styles.checkRow}>
            <Ionicons
              name={c.ok ? "checkmark-circle" : "ellipse-outline"}
              size={18}
              color={c.ok ? colors.success : colors.textFaint}
            />
            <Text style={[styles.checkText, c.ok && { color: colors.text }]}>{c.label}</Text>
          </View>
        ))}
      </Card>

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
  hint: { ...t.caption, marginBottom: spacing.sm },
  locRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  locText: { ...t.body },
  locCoords: { ...t.subheading },
  locAcc: { ...t.caption, marginTop: 2 },
  collectorRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  collectorAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.goldSoft, alignItems: "center", justifyContent: "center" },
  collectorName: { ...t.subheading },
  collectorMeta: { ...t.caption, marginTop: 2 },
  rolePill: { backgroundColor: colors.goldSoft, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.goldBorder },
  rolePillText: { ...t.caption, color: colors.gold },
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  thumbWrap: { width: 72, height: 72 },
  thumb: { width: 72, height: 72, borderRadius: radius.md },
  roleTag: { position: "absolute", bottom: 3, left: 3, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  roleTagText: { fontSize: 9, color: "#fff", fontWeight: "700" },
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
  checkRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 5 },
  checkText: { ...t.body, color: colors.textMuted },
});

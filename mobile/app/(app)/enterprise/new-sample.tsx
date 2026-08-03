// Enterprise › New Sample (Sprint 4.2.1 — production field capture).
//
// Slice 1 scope: required Sample Name, auto-populated read-only Collector card,
// live required-field validation (Submit disabled until complete — §4), draft
// autosave to AsyncStorage (so a Take-Photo round trip or an accidental back
// never loses field data — §18/§19), and an unsaved-changes guard on exit.
// GPS richness (§2) and photo categories (§3) arrive in the next slices.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, StyleSheet, Pressable, Image, Alert, ActivityIndicator } from "react-native";
import { router, useNavigation, useLocalSearchParams, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { colors, spacing, radius, type as t } from "../../../lib/theme";
import { useAuth } from "../../../lib/auth";
import { supabase } from "../../../lib/supabase";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { SectionLabel } from "../../../components/ui/SectionLabel";
import {
  captureSampleLocation,
  submitSample,
  editSample,
  getSample,
  sampleIsEditable,
  uploadSampleMedia,
  type MediaRole,
  type MineralObservationInput,
  type SampleMediaInput,
} from "../../../lib/enterpriseSamples";

import { takeCapturedPhotos } from "../../../lib/captureHandoff";

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
  // Edit mode: /enterprise/new-sample?edit=<sampleId>. Prefills from the existing
  // sample and PUTs instead of POSTing. No AsyncStorage draft in edit mode — the
  // server copy is the source of truth.
  const { edit, from, lat, lng } = useLocalSearchParams<{
    edit?: string; from?: string; lat?: string; lng?: string;
  }>();
  // Opened from a running exploration session. The session is still alive
  // behind this screen — this is a push, not a replace — so finishing here
  // returns to the live map rather than starting anything new.
  const fromExploration = from === "exploration";
  const isEdit = !!edit;
  // Maps an already-uploaded photo's display URI → its Storage path, so on save we
  // reuse kept photos (never re-upload/​re-download them) and only upload new ones.
  const [uploadedByUri, setUploadedByUri] = useState<Record<string, string>>({});
  const [loadingSample, setLoadingSample] = useState(isEdit);
  // Preserved across an edit so re-submitting never rewrites the collection date.
  const [collectedAt, setCollectedAt] = useState<string | null>(null);

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
  const insets = useSafeAreaInsets();
  const [gpsSource, setGpsSource] = useState<"gps" | "manual">("gps");
  const [showManual, setShowManual] = useState(false);
  const [manualLat, setManualLat] = useState("");
  const [manualLng, setManualLng] = useState("");

  // ── Edit mode: prefill from the existing sample (no draft involved) ──────────
  useEffect(() => {
    if (!isEdit || !edit) return;
    (async () => {
      try {
        const s = await getSample(String(edit));
        if (!sampleIsEditable(s.status)) {
          Alert.alert(
            "Cannot edit",
            "A geologist has already reviewed this sample, so it can no longer be edited.",
            [{ text: "OK", onPress: () => router.back() }],
          );
          return;
        }
        setName(s.name ?? "");
        setCollectedAt(s.collected_at ?? null);
        setNotes(s.field_observations ?? "");
        setRockClass(s.rock_observation?.[0]?.rock_class ?? "");
        setMinerals((s.mineral_observation ?? []).map((m) => ({ mineral: m.mineral, confidence: m.confidence ?? undefined })));
        const l = s.sample_location?.[0];
        if (l?.gps_accuracy_m != null) setGpsSource(l.provenance === "manual" ? "manual" : "gps");
        // Coordinates aren't returned by the detail select; keep the stored fix by
        // reading it back from the map cell is lossy, so we require a fresh/manual
        // fix only if the user changes location. Prefill a placeholder from h3 center
        // is avoided — instead we mark loc from the sample's stored accuracy if present.
        // Resolve signed URLs for existing photos and remember their storage paths.
        const uris: string[] = [];
        const map: Record<string, string> = {};
        for (const m of s.sample_media ?? []) {
          const { data } = await supabase.storage.from("scan-images").createSignedUrl(m.storage_path, 3600);
          if (data?.signedUrl) { uris.push(data.signedUrl); map[data.signedUrl] = m.storage_path; }
        }
        setPhotos(uris);
        setUploadedByUri(map);
        // We don't get lat/lng back in the detail payload, so fetch a fresh GPS fix
        // in the background as a sensible default; the user can re-fix or enter manually.
        const fix = await captureSampleLocation();
        if (fix) setLoc(fix);
      } catch (e) {
        Alert.alert("Failed to load sample", e instanceof Error ? e.message : "Unknown error", [
          { text: "OK", onPress: () => router.back() },
        ]);
      } finally {
        setLoadingSample(false);
        setRestored(true);
      }
    })();
  }, [isEdit, edit]);

  // ── Draft persistence (NEW samples only): restore once, then autosave ────────
  useEffect(() => {
    if (isEdit) return; // edit mode prefills from the server, never the local draft
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
  }, [isEdit]);

  useEffect(() => {
    if (isEdit || !restored) return; // never persist an edit session to the new-sample draft
    const d: DraftShape = { name, photos, minerals, rockClass, notes, loc };
    AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(d)).catch(() => {});
  }, [isEdit, restored, name, photos, minerals, rockClass, notes, loc]);

  const clearDraft = useCallback(() => AsyncStorage.removeItem(DRAFT_KEY).catch(() => {}), []);

  const grabLocation = useCallback(async () => {
    setLocating(true);
    try {
      const l = await captureSampleLocation();
      if (!l) Alert.alert("Location unavailable", "No GPS fix — grant location permission, move to open sky, or enter coordinates manually.");
      if (l) { setLoc(l); setGpsSource("gps"); }
    } finally {
      setLocating(false);
    }
  }, []);

  // Manual coordinate entry (§2). Accepts "lat, lng" pasted into either field.
  const applyManual = useCallback(() => {
    const nums = `${manualLat} ${manualLng}`.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    const [la, ln] = nums;
    if (la == null || ln == null || la < -90 || la > 90 || ln < -180 || ln > 180) {
      Alert.alert("Invalid coordinates", "Enter a valid latitude (-90 to 90) and longitude (-180 to 180).");
      return;
    }
    setLoc({ lat: la, lng: ln });
    setGpsSource("manual");
    setShowManual(false);
  }, [manualLat, manualLng]);

  // Capture a fix on first entry only if we didn't restore one.
  useEffect(() => { if (restored && !loc) grabLocation(); }, [restored]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!(name.trim() || photos.length || minerals.length || rockClass.trim() || notes.trim());

  // ── Unsaved-changes guard (§19) — new samples only (edit has no local draft) ──
  useEffect(() => {
    if (isEdit) return;
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
  }, [isEdit, navigation, dirty, submitting, clearDraft]);

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

  // The field camera hands its photos back through a single in-memory slot and
  // pops. Draining on focus is what makes the round trip feel like one screen
  // rather than a detour — and the slot clears on read, so a re-render cannot
  // attach the same burst twice.
  useFocusEffect(
    useCallback(() => {
      const captured = takeCapturedPhotos();
      if (captured.length) setPhotos((p) => [...p, ...captured.map((c) => c.uri)]);
    }, []),
  );

  const openFieldCamera = useCallback((needs?: string[]) => {
    router.push({
      pathname: "/(app)/enterprise/field-camera",
      ...(needs?.length ? { params: { need: needs.join(",") } } : {}),
    });
  }, []);

  const addPhoto = useCallback(() => {
    Alert.alert("Add photo", undefined, [
      // The geological camera first: it is the one with focus lock, burst and
      // full sensor resolution. The system picker stays for photos already taken.
      { text: "Field Camera", onPress: () => openFieldCamera() },
      { text: "Quick Photo", onPress: () => pickFrom("camera") },
      { text: "Choose from Library", onPress: () => pickFrom("library") },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [pickFrom, openFieldCamera]);

  const addMineral = useCallback(() => {
    const m = mineralDraft.trim();
    if (!m) return;
    setMinerals((cur) => [...cur, { mineral: m }]);
    setMineralDraft("");
  }, [mineralDraft]);

  // ── Validation (§4): mirrors the server checks; Submit disabled until all pass ─
  // AI-first: the collector only has to provide name + GPS + photos. Host rock and
  // minerals are optional — the Geological Intelligence Engine determines them.
  const checks = useMemo(() => [
    { key: "name", label: "Sample name", ok: !!name.trim() },
    { key: "gps", label: "GPS location", ok: !!loc },
    { key: "context", label: "Field-context photo", ok: photos.length >= 1 },
    { key: "closeup", label: "Specimen close-up photo", ok: photos.length >= 2 },
  ], [name, loc, photos.length]);
  const canSubmit = checks.every((c) => c.ok) && !submitting;

  const onSubmit = useCallback(async () => {
    if (!loc || !canSubmit) return;
    setSubmitting(true);
    try {
      // Reuse already-uploaded photos (kept on edit); only upload newly added local URIs.
      const media: SampleMediaInput[] = [];
      for (let i = 0; i < photos.length; i++) {
        const kept = uploadedByUri[photos[i]];
        media.push(kept ? { role: roleForIndex(i), storage_path: kept } : await uploadSampleMedia(photos[i], roleForIndex(i)));
      }

      const payload = {
        name: name.trim(),
        lat: loc.lat, lng: loc.lng, gps_accuracy_m: loc.gps_accuracy_m, gps_source: gpsSource,
        collected_at: collectedAt ?? new Date().toISOString(), // keep the original date on edit
        field_observations: notes.trim() || undefined,
        observations: { rock: rockClass.trim() ? { rock_class: rockClass.trim() } : null, minerals },
        media,
      };

      let sampleId: string;
      if (isEdit && edit) {
        const r = await editSample(String(edit), payload);
        sampleId = r.sample_id;
      } else {
        const r = await submitSample(payload);
        sampleId = r.sample_id;
        await clearDraft();
      }
      submittedRef.current = true;
      if (fromExploration) {
        // Straight back to the live map, with the sample id carried along so
        // the session can pick up the analysis when it lands. The exploration
        // session is NOT ended and was never replaced — it has been running
        // underneath this screen the whole time. The sample detail is one tap
        // away from the map; forcing it here would break the walking loop.
        router.replace({
          pathname: "/(app)/exploration",
          params: { analysed: sampleId },
        });
      } else {
        router.replace(`/(app)/enterprise/sample/${sampleId}`);
      }
    } catch (e) {
      Alert.alert(isEdit ? "Save failed" : "Submission failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }, [loc, canSubmit, photos, uploadedByUri, name, notes, rockClass, minerals, gpsSource, collectedAt, clearDraft, isEdit, edit, fromExploration]);

  const collectorName = (session?.user?.user_metadata?.display_name as string | undefined)?.trim()
    || session?.user?.email?.split("@")[0] || "—";

  // Reflect edit vs. create in the native header title.
  useEffect(() => {
    navigation.setOptions?.({ title: isEdit ? "Edit Sample" : "New Sample" });
  }, [navigation, isEdit]);

  if (loadingSample) {
    return (
      <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={colors.gold} />
        <Text style={[styles.hint, { marginTop: spacing.md }]}>Loading sample…</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: spacing.xl }]}
      keyboardShouldPersistTaps="handled"
    >
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
              <Text style={styles.locAcc}>
                {gpsSource === "manual" ? "entered manually" : loc.gps_accuracy_m != null ? `±${loc.gps_accuracy_m} m accuracy` : "accuracy unknown"}
              </Text>
            </View>
            <Pressable onPress={grabLocation} hitSlop={8}><Ionicons name="refresh" size={20} color={colors.textMuted} /></Pressable>
          </View>
        ) : (
          <View style={styles.locRow}>
            <Ionicons name="location-outline" size={20} color={colors.danger} />
            <Text style={[styles.locText, { color: colors.danger, flex: 1 }]}>No GPS fix yet</Text>
            <Pressable onPress={grabLocation} hitSlop={8}><Ionicons name="refresh" size={20} color={colors.gold} /></Pressable>
          </View>
        )}

        <Pressable style={styles.manualToggle} onPress={() => setShowManual((v) => !v)} hitSlop={6}>
          <Ionicons name={showManual ? "chevron-up" : "create-outline"} size={15} color={colors.textMuted} />
          <Text style={styles.manualToggleText}>{showManual ? "Hide manual entry" : "Enter coordinates manually"}</Text>
        </Pressable>
        {showManual && (
          <View style={styles.manualBox}>
            <TextInput
              style={[styles.input, { marginBottom: spacing.sm }]}
              value={manualLat}
              onChangeText={setManualLat}
              placeholder="latitude  (or paste “lat, lng”)"
              placeholderTextColor={colors.textFaint}
            />
            <View style={styles.inlineRow}>
              <TextInput
                style={styles.input}
                value={manualLng}
                onChangeText={setManualLng}
                placeholder="longitude"
                placeholderTextColor={colors.textFaint}
              />
              <Button title="Apply" variant="outline" size="sm" onPress={applyManual} />
            </View>
          </View>
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
      <Pressable style={styles.fieldCamBtn} onPress={() => openFieldCamera()}>
        <Ionicons name="camera" size={20} color="#0B0B0C" />
        <Text style={styles.fieldCamText}>Open field camera</Text>
      </Pressable>

      {/* Optional geology — the AI determines these (§6). */}
      <View style={styles.aiNote}>
        <Ionicons name="sparkles-outline" size={15} color={colors.gold} />
        <Text style={styles.aiNoteText}>Host rock and minerals are optional — the AI identifies them. Add what you know.</Text>
      </View>

      {/* Host rock (optional) */}
      <SectionLabel>Host rock (optional)</SectionLabel>
      <TextInput
        style={styles.inputBlock}
        value={rockClass}
        onChangeText={setRockClass}
        placeholder="e.g. granite, basalt, quartz vein"
        placeholderTextColor={colors.textFaint}
      />

      {/* Minerals (optional) */}
      <SectionLabel>Minerals (optional)</SectionLabel>
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

    </ScrollView>

    {/* Sticky action bar — Submit is always visible, above the nav bar (§16). */}
    <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
      {!canSubmit && (
        <Text style={styles.footerHint}>
          {checks.filter((c) => !c.ok).length} of {checks.length} required left
        </Text>
      )}
      <Button
        title={submitting ? (isEdit ? "Saving…" : "Submitting…") : (isEdit ? "Save & Re-analyze" : "Submit Sample")}
        variant="primary"
        loading={submitting}
        disabled={!canSubmit}
        onPress={onSubmit}
      />
    </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  footer: {
    paddingHorizontal: spacing.lg, paddingTop: spacing.md,
    backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: colors.border,
  },
  footerHint: { ...t.caption, color: colors.textFaint, textAlign: "center", marginBottom: spacing.sm },
  hint: { ...t.caption, marginBottom: spacing.sm },
  manualToggle: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  manualToggleText: { ...t.bodySmall, color: colors.textMuted },
  manualBox: { marginTop: spacing.sm },
  aiNote: { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: colors.goldSoft, borderRadius: radius.md, borderWidth: 1, borderColor: colors.goldBorder, padding: spacing.md, marginTop: spacing.md },
  aiNoteText: { ...t.bodySmall, color: colors.text, flex: 1 },
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
  fieldCamBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm,
    backgroundColor: colors.gold, borderRadius: radius.lg,
    paddingVertical: spacing.md, marginTop: spacing.sm,
  },
  fieldCamText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
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

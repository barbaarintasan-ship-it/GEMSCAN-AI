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
import { useIsOnline } from "../../../lib/network";
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
import { takeScanHandoff, type ScanHandoff } from "../../../lib/scanToSampleHandoff";
import { putAnalysedSample } from "../../../lib/exploration/analysisHandoff";
import {
  currentExpeditionSessionId, currentMissionId,
} from "../../../lib/exploration/currentExpedition";
import { localSamples } from "../../../lib/samples/store";
import { pushPendingSamples } from "../../../lib/samples/pendingSampleSync";

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
  // The REAL connectivity — it was already here, and the uploader was being told
  // `true` regardless. That turned an offline save into an immediate doomed
  // upload: it failed with "Network request failed", the failure was recorded
  // against the sample, and the collection displayed it as an error on a sample
  // that had in fact been saved perfectly.
  const isOnline = useIsOnline();
  // Edit mode: /enterprise/new-sample?edit=<sampleId>. Prefills from the existing
  // sample and PUTs instead of POSTing. No AsyncStorage draft in edit mode — the
  // server copy is the source of truth.
  const { edit, from, lat, lng, enterpriseMissionId, assignmentH3 } = useLocalSearchParams<{
    edit?: string; from?: string; lat?: string; lng?: string;
    // Team Mission Mode (Phase 2C/My Mission screen) — set only when reached
    // from "My Mission › Submit Evidence" for a specific assigned H3 cell.
    // Unrelated to the solo field_mission_id below; kept as separate params
    // so the two systems can never be confused at the navigation layer either.
    enterpriseMissionId?: string; assignmentH3?: string;
  }>();
  // Opened from a running exploration session. The session is still alive
  // behind this screen — this is a push, not a replace — so finishing here
  // returns to the live map rather than starting anything new.
  const fromExploration = from === "exploration";
  // Opened from a scan result (Scan → Sample bridge). The scan's identification
  // pre-fills the Host rock as an AI CANDIDATE (method='ai', editable), and the
  // server reuses the scan's photographs (see scan_id in the submit payload).
  // Drained ONCE into state so a re-render can't re-apply or lose it.
  const [scanHandoff] = useState<ScanHandoff | null>(() => (from === "scan" ? takeScanHandoff() : null));
  const fromScan = from === "scan";
  // Provenance of the Host rock value: 'ai' = the scan's guess (shown unconfirmed);
  // 'field' = the collector typed/owned it. Sent to submit_sample.
  const [rockMethod, setRockMethod] = useState<"field" | "ai">("field");
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
  /** Held for the whole of one submission, released only on a path that failed. */
  const submitLock = useRef(false);
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
    // A scan-sourced sample is a fresh, specific intent: pre-fill the Host rock
    // from the scan (as an editable AI candidate) and IGNORE any leftover draft,
    // which would otherwise clobber the identification with a stale rock name.
    if (fromScan) {
      if (scanHandoff) {
        setName(scanHandoff.rockName);
        setRockClass(scanHandoff.rockName);
        setRockMethod("ai");
      }
      setRestored(true);
      return;
    }
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
  }, [isEdit, fromScan, scanHandoff]);

  useEffect(() => {
    if (isEdit || fromScan || !restored) return; // scan samples never touch the shared draft
    const d: DraftShape = { name, photos, minerals, rockClass, notes, loc };
    AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(d)).catch(() => {});
  }, [isEdit, fromScan, restored, name, photos, minerals, rockClass, notes, loc]);

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
  // A scan-sourced sample reuses the scan's photographs (attached server-side),
  // so the photo minimums are met by the scan, not by re-shooting here.
  const checks = useMemo(() => [
    { key: "name", label: "Sample name", ok: !!name.trim() },
    { key: "gps", label: "GPS location", ok: !!loc },
    { key: "context", label: "Field-context photo", ok: fromScan || photos.length >= 1 },
    { key: "closeup", label: "Specimen close-up photo", ok: fromScan || photos.length >= 2 },
  ], [name, loc, photos.length, fromScan]);
  const canSubmit = checks.every((c) => c.ok) && !submitting;

  const onSubmit = useCallback(async () => {
    if (!loc || !canSubmit) return;
    // A SYNCHRONOUS guard, and it has to be synchronous.
    //
    // `canSubmit` and the button's `disabled` are both derived from `submitting`,
    // which is React state — it does not change until the next render. Two taps
    // inside one frame therefore both saw `canSubmit === true` and both ran, and
    // localSampleStore.create() mints a FRESH localId per call, so each tap
    // became a different idempotency key and the server had no way to tell them
    // apart. That is how one outcrop reached the collection three times, all
    // stamped 09:12:24, while every other sample was filed once.
    //
    // The ref changes on the spot, before any await, so the second tap returns.
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);

    const payloadBase = {
      name: name.trim(),
      lat: loc.lat, lng: loc.lng, gps_accuracy_m: loc.gps_accuracy_m, gps_source: gpsSource,
      collected_at: collectedAt ?? new Date().toISOString(), // keep the original date on edit
      field_observations: notes.trim() || undefined,
      observations: {
        rock: rockClass.trim() ? { rock_class: rockClass.trim(), method: rockMethod } : null,
        minerals,
      },
      // Scan → Sample: the server reuses THIS scan's photos (copied to the
      // sample's own storage) so the user never re-shoots the rock.
      scan_id: fromScan ? scanHandoff?.scanId : undefined,
      /**
       * WHICH WORKFLOW THIS SAMPLE BELONGS TO, and therefore what the analysis is
       * allowed to infer from it.
       *
       * Opened from a running exploration session, this is a mission's evidence
       * and the full engine applies. Opened from My Samples, it is a specimen
       * somebody collected — visual identification and mineral knowledge only, no
       * mapped geology, no nearby occurrences, no structural context.
       *
       * Decided HERE, at capture, from how the screen was reached. Deriving it on
       * the server from whether an expedition happened to be open would file a
       * rock picked up on the way home as mission evidence.
       */
      origin: (fromExploration || enterpriseMissionId ? "exploration" : "personal") as "personal" | "exploration",
      field_mission_id: fromExploration ? currentMissionId() : null,
      // Team Mission Mode — which enterprise.exploration_mission this evidence
      // belongs to. Deliberately NOT sending assignment_h3 here: the server
      // (enterprise-samples/handler.ts's buildPayload) always recomputes it
      // from the ACTUAL submitted GPS, never a client-sent value — the
      // `assignmentH3` param above is display-only (shown in the banner
      // below) so the field worker can confirm which cell they're on.
      enterprise_mission_id: enterpriseMissionId || undefined,
    };

    /**
     * OFFLINE FIRST — a new sample is written to the device before the network is
     * touched at all.
     *
     * This used to upload the photographs, post the record, and show
     * "Submission failed · try again" the moment either step could not reach the
     * server. In a wadi that is every time, and "try again" is advice the
     * geologist cannot take. The sample is now saved complete — metadata, GPS,
     * observations and the photographs themselves — and filed when there is a
     * signal, by lib/samples/pendingSampleSync.
     *
     * Editing an EXISTING server sample is deliberately left alone: it revises a
     * row that is already on the server, which is a different operation from
     * creating one, and it is not what a geologist does mid-traverse.
     */
    if (!isEdit) {
      try {
        const local = await localSamples().create({
          payload: payloadBase,
          photos: photos.map((uri, i) => ({ uri, role: roleForIndex(i) })),
          // Attributes the sample to the walk it was taken on (Slice 2).
          expeditionSessionId: currentExpeditionSessionId(),
          // Sealed at capture, from whoever is signed in now. Filing later
          // under a different account must never reattribute this.
          collectedBy: session?.user
            ? { userId: session.user.id, email: session.user.email ?? null }
            : null,
        });
        await clearDraft();
        submittedRef.current = true;

        // Try immediately ONLY if there is a connection. Passing `true`
        // unconditionally — which this did — starts a doomed upload the moment a
        // sample is taken offline: it fails with "Network request failed", spends
        // a retry, and stamps that message onto a sample that is perfectly
        // intact. Offline, the sync hook picks it up when the signal returns.
        void pushPendingSamples(localSamples(), isOnline).catch(() => {});

        if (fromExploration) {
          putAnalysedSample(local.serverId ?? local.localId);
          router.back();
        } else {
          router.replace("/(app)/enterprise/samples");
        }
        return;
      } catch (e) {
        // Only a storage failure can land here — the network is not involved.
        Alert.alert(
          "Could not save the sample",
          e instanceof Error ? e.message : "The device could not write the sample.",
        );
        // Released so the geologist can correct and try again.

        submitLock.current = false;
        setSubmitting(false);
        return;
      }
    }

    try {
      // Reuse already-uploaded photos (kept on edit); only upload newly added local URIs.
      const media: SampleMediaInput[] = [];
      for (let i = 0; i < photos.length; i++) {
        const kept = uploadedByUri[photos[i]];
        media.push(kept ? { role: roleForIndex(i), storage_path: kept } : await uploadSampleMedia(photos[i], roleForIndex(i)));
      }

      const payload = { ...payloadBase, media };

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
        // BACK to the live map, not "replace with a new one". The map is a layout
        // route that has been running underneath this screen the whole time
        // (Architecture v2 §0.2), so popping returns to the same session, the
        // same target, the same track and the same map camera. `replace` used to
        // mount a SECOND exploration screen on top of the first — a second
        // provider and a second GPS watch — which only looked like it worked.
        //
        // The sample id goes in a slot rather than a URL parameter, because
        // there is no longer a navigation event to hang it on. Same pattern the
        // camera already uses to hand photographs to this form.
        putAnalysedSample(sampleId);
        router.back();
      } else {
        router.replace(`/(app)/enterprise/sample/${sampleId}`);
      }
    } catch (e) {
      Alert.alert(isEdit ? "Save failed" : "Submission failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      // Released so the geologist can correct and try again.

      submitLock.current = false;
      setSubmitting(false);
    }
  }, [loc, canSubmit, photos, uploadedByUri, name, notes, rockClass, rockMethod, minerals, gpsSource, collectedAt, clearDraft, isEdit, edit, fromExploration, fromScan, scanHandoff, isOnline]);

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
      {/* Team Mission Mode context — display only; the server independently
          re-derives and re-validates both the mission membership and the
          actual H3 cell from the GPS at submit time. */}
      {enterpriseMissionId ? (
        <Card accent style={styles.missionBanner}>
          <Ionicons name="flag-outline" size={16} color={colors.gold} />
          <Text style={styles.missionBannerText}>
            {assignmentH3 ? `Mission evidence — cell ${assignmentH3.slice(0, 9)}…` : "Mission evidence"}
          </Text>
        </Card>
      ) : null}

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

      {/* Photos — reused from the scan when opened from a scan result. */}
      {fromScan ? (
        <View style={styles.aiNote}>
          <Ionicons name="images-outline" size={15} color={colors.gold} />
          <Text style={styles.aiNoteText}>Your scan's photos will be used for this sample — no need to add more.</Text>
        </View>
      ) : (
        <>
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
        </>
      )}

      {/* Optional geology — the AI determines these (§6). */}
      <View style={styles.aiNote}>
        <Ionicons name="sparkles-outline" size={15} color={colors.gold} />
        <Text style={styles.aiNoteText}>Host rock and minerals are optional — the AI identifies them. Add what you know.</Text>
      </View>

      {/* Host rock — pre-filled from the scan as an editable AI candidate. */}
      <SectionLabel>Host rock (optional)</SectionLabel>
      {fromScan && rockMethod === "ai" && (
        <View style={styles.aiCandidateNote}>
          <Ionicons name="sparkles" size={13} color={colors.gold} />
          <Text style={styles.aiCandidateText}>
            {`AI candidate from your scan${scanHandoff ? ` · ${Math.round((scanHandoff.confidence ?? 0) * 100)}% confidence` : ""} — unconfirmed. Correct it if you know the rock.`}
          </Text>
        </View>
      )}
      <TextInput
        style={styles.inputBlock}
        value={rockClass}
        onChangeText={(v) => { setRockClass(v); setRockMethod("field"); }}
        placeholder="e.g. granite, basalt, quartz vein"
        placeholderTextColor={colors.textFaint}
      />
      {fromScan && !!scanHandoff?.alternatives?.length && (
        <View style={styles.altChips}>
          {scanHandoff.alternatives.map((alt) => (
            <Pressable key={alt} style={styles.altChip} onPress={() => { setRockClass(alt); setRockMethod("ai"); }}>
              <Text style={styles.altChipText}>{alt}</Text>
            </Pressable>
          ))}
        </View>
      )}

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
  missionBanner: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.lg },
  missionBannerText: { color: colors.gold, fontSize: 13, fontWeight: "700" },
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
  aiCandidateNote: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: spacing.xs },
  aiCandidateText: { ...t.caption, color: colors.textFaint, flex: 1 },
  altChips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.xs },
  altChip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  altChipText: { ...t.caption, color: colors.text },
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

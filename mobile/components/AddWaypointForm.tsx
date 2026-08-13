// Recording a field observation, deliberately.
//
// This replaced a one-tap button that wrote `type: "outcrop"` and nothing else. A
// geologist standing on a vein has more to say than that, and the thing the AI
// needs most — what was seen, whether a sample was bagged, what the bag is called —
// had nowhere to go.
//
// WHAT THIS FORM DOES NOT COLLECT
//
// Coordinates. GPS is read from the live fix inside `WaypointService.capture`, and
// there is no field for it: a typed position is a position nobody can check, and
// the whole value of a field record is that it was taken where it says.
//
// It also does not collect `missionId`. That is derived inside the orchestrator
// from the live mission, so this form cannot supply it, omit it, or contradict it.
//
// NOTES ARE OBSERVATIONS, NOT FACTS
//
// The placeholder says so, and the AI prompt says so again downstream. "I think this
// is gold" is a hypothesis to be assessed — the one thing this system must never do
// is promote it to a finding on its way through.
import React from "react";
import {
  Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { colors, radius, spacing } from "../lib/theme";
import {
  COLLECTION_METHODS, SAMPLE_TYPES, WAYPOINT_TYPES,
  collectionMethodLabelKey, nextSampleId, sampleTypeLabelKey, waypointTypeLabelKey,
  isUsableCoordinate,
  type CollectionMethod, type SampleType, type Waypoint, type WaypointType,
} from "../lib/field/waypointTypes";
import { FieldCamera } from "./FieldCamera";
import type { TFunc } from "../lib/exploration/format";

export interface AddWaypointResult {
  type: WaypointType;
  notes: string;
  sample: {
    sampleId: string;
    sampleType: SampleType;
    collectionMethod: CollectionMethod;
    description: string;
  } | null;
  photoUris: string[];
  /**
   * A coordinate somebody else supplied, when this is not a place the geologist
   * is standing. Null for every ordinary field observation.
   */
  reportedAt: { lat: number; lng: number } | null;
}

export function AddWaypointForm({
  visible, existingWaypoints, now, onCancel, onSave, onPickPhotos, t,
}: {
  visible: boolean;
  /** Read only to generate the next sample id — never written to from here. */
  existingWaypoints: readonly Waypoint[];
  now: () => number;
  onCancel: () => void;
  onSave: (r: AddWaypointResult) => void;
  /** Opens the camera/library. Returns the uris it produced. */
  onPickPhotos: () => Promise<string[]>;
  t: TFunc;
}) {
  const [type, setType] = React.useState<WaypointType>("outcrop");
  const [notes, setNotes] = React.useState("");
  const [hasSample, setHasSample] = React.useState(false);
  const [sampleId, setSampleId] = React.useState("");
  const [sampleType, setSampleType] = React.useState<SampleType>("rock");
  const [method, setMethod] = React.useState<CollectionMethod>("outcrop");
  const [description, setDescription] = React.useState("");
  const [photoUris, setPhotoUris] = React.useState<string[]>([]);
  const [reported, setReported] = React.useState(false);
  const [latText, setLatText] = React.useState("");
  const [lngText, setLngText] = React.useState("");
  const reportedAt = React.useMemo(() => {
    if (!reported) return null;
    const lat = Number(latText.trim());
    const lng = Number(lngText.trim());
    return isUsableCoordinate(lat, lng) ? { lat, lng } : null;
  }, [reported, latText, lngText]);
  const [busy, setBusy] = React.useState(false);
  /**
   * The geological camera, over this form rather than instead of it.
   *
   * Rendered inside the same Modal, so the observation being written survives the
   * photographs being taken. Navigating to the camera as a route would put it
   * BEHIND this modal — and closing the modal first would throw away notes typed
   * by someone standing on an outcrop, which is the one thing this form must
   * never do.
   */
  const [cameraOpen, setCameraOpen] = React.useState(false);

  // A fresh form every time it opens. Carrying the last observation's notes into
  // the next one is how a field record acquires a sentence about the wrong rock.
  React.useEffect(() => {
    if (!visible) return;
    setType("outcrop");
    setNotes("");
    setHasSample(false);
    setSampleType("rock");
    setMethod("outcrop");
    setDescription("");
    setPhotoUris([]);
    setBusy(false);
    setCameraOpen(false);
  }, [visible]);

  // Generated when the switch is turned on, then EDITABLE — the geologist may
  // already have a numbering scheme, and an id that disagrees with the label on the
  // bag is worse than no id at all.
  const turnSampleOn = () => {
    setHasSample(true);
    if (!sampleId) setSampleId(nextSampleId(existingWaypoints, now()));
  };

  const addPhotos = async () => {
    setBusy(true);
    try {
      const uris = await onPickPhotos();
      if (uris.length > 0) setPhotoUris((p) => [...p, ...uris]);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    onSave({
      type,
      notes: notes.trim(),
      sample: hasSample
        ? {
            sampleId: sampleId.trim() || nextSampleId(existingWaypoints, now()),
            sampleType,
            collectionMethod: method,
            description: description.trim(),
          }
        : null,
      photoUris,
      reportedAt,
    });
  };

  // The camera takes the whole modal while it is up. The form's state is untouched
  // behind it — this is a different view of the same open observation, not a
  // different screen.
  if (visible && cameraOpen) {
    return (
      <Modal visible animationType="fade" onRequestClose={() => setCameraOpen(false)}>
        <FieldCamera
          onDone={(photos) => {
            if (photos.length > 0) setPhotoUris((p) => [...p, ...photos.map((c) => c.uri)]);
            setCameraOpen(false);
          }}
          onCancel={() => setCameraOpen(false)}
        />
      </Modal>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{t("field.addWaypoint.title")}</Text>
          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            {/* GPS is not offered as a field. It is read from the live fix. */}
            <Text style={styles.gpsNote}>{t("field.addWaypoint.gpsAutomatic")}</Text>

            <Text style={styles.label}>{t("field.addWaypoint.type")}</Text>
            <View style={styles.chips}>
              {WAYPOINT_TYPES.map((wt) => (
                <Chip
                  key={wt}
                  label={t(waypointTypeLabelKey(wt))}
                  active={type === wt}
                  onPress={() => setType(wt)}
                />
              ))}
            </View>

            <Text style={styles.label}>{t("field.addWaypoint.hasSample")}</Text>
            <View style={styles.chips}>
              <Chip label={t("common.no")} active={!hasSample} onPress={() => setHasSample(false)} />
              <Chip label={t("common.yes")} active={hasSample} onPress={turnSampleOn} />
            </View>

            {hasSample ? (
              <View style={styles.sampleBox}>
                <Text style={styles.label}>{t("field.addWaypoint.sampleId")}</Text>
                <TextInput
                  style={styles.input}
                  value={sampleId}
                  onChangeText={setSampleId}
                  autoCapitalize="characters"
                  placeholderTextColor={colors.textFaint}
                />
                <Text style={styles.hint}>{t("field.addWaypoint.sampleIdHint")}</Text>

                <Text style={styles.label}>{t("field.addWaypoint.sampleType")}</Text>
                <View style={styles.chips}>
                  {SAMPLE_TYPES.map((st) => (
                    <Chip
                      key={st}
                      label={t(sampleTypeLabelKey(st))}
                      active={sampleType === st}
                      onPress={() => setSampleType(st)}
                    />
                  ))}
                </View>

                <Text style={styles.label}>{t("field.addWaypoint.collectionMethod")}</Text>
                <View style={styles.chips}>
                  {COLLECTION_METHODS.map((cm) => (
                    <Chip
                      key={cm}
                      label={t(collectionMethodLabelKey(cm))}
                      active={method === cm}
                      onPress={() => setMethod(cm)}
                    />
                  ))}
                </View>

                <Text style={styles.label}>{t("field.addWaypoint.sampleDescription")}</Text>
                <TextInput
                  style={[styles.input, styles.multiline]}
                  value={description}
                  onChangeText={setDescription}
                  multiline
                  placeholder={t("field.addWaypoint.sampleDescriptionPlaceholder")}
                  placeholderTextColor={colors.textFaint}
                />
              </View>
            ) : null}

            <Text style={styles.label}>{t("field.addWaypoint.observation")}</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={notes}
              onChangeText={setNotes}
              multiline
              placeholder={t("field.addWaypoint.observationPlaceholder")}
              placeholderTextColor={colors.textFaint}
            />
            {/* Said on the form, not only in the prompt: the geologist should know
                their words are recorded as an observation and assessed as one. */}
            <Text style={styles.hint}>{t("field.addWaypoint.observationHint")}</Text>

            {/* SOMEBODY ELSE'S GROUND.
                Off by default, and it must stay that way: the ordinary case is a
                geologist standing on the rock, and a position typed by hand is one
                nobody can check. Turned on, it says so — in the record, in the
                package and to the model — so a colleague's photograph is never
                read back as something this phone witnessed. */}
            <Text style={styles.label}>{t("field.addWaypoint.reportedTitle")}</Text>
            <View style={styles.chips}>
              {[false, true].map((v) => (
                <Pressable
                  key={String(v)}
                  style={[styles.chip, reported === v && styles.chipActive]}
                  onPress={() => setReported(v)}
                  accessibilityRole="button"
                >
                  <Text style={[styles.chipText, reported === v && styles.chipTextActive]}>
                    {t(v ? "field.addWaypoint.reportedYes" : "field.addWaypoint.reportedNo")}
                  </Text>
                </Pressable>
              ))}
            </View>
            {reported ? (
              <>
                <View style={styles.coordRow}>
                  <TextInput
                    style={[styles.input, styles.coord]}
                    value={latText}
                    onChangeText={setLatText}
                    placeholder={t("field.addWaypoint.latitude")}
                    placeholderTextColor={colors.textMuted}
                    keyboardType="numbers-and-punctuation"
                    autoCorrect={false}
                  />
                  <TextInput
                    style={[styles.input, styles.coord]}
                    value={lngText}
                    onChangeText={setLngText}
                    placeholder={t("field.addWaypoint.longitude")}
                    placeholderTextColor={colors.textMuted}
                    keyboardType="numbers-and-punctuation"
                    autoCorrect={false}
                  />
                </View>
                <Text style={styles.hint}>
                  {reportedAt
                    ? t("field.addWaypoint.reportedOk", {
                        lat: reportedAt.lat.toFixed(5), lng: reportedAt.lng.toFixed(5),
                      })
                    : t("field.addWaypoint.reportedNeedsCoords")}
                </Text>
              </>
            ) : null}

            <Text style={styles.label}>
              {t("field.addWaypoint.photos", { count: photoUris.length })}
            </Text>
            {/* The geological camera first. It is the one with the zoom stops,
                focus lock, burst and full sensor resolution — and the evidence
                photographed here is what the AI is later asked to read, so the
                system picker being the only option was the worst image the phone
                could produce standing in for the most important one. */}
            <Pressable
              style={[styles.btn, styles.btnCamera]}
              onPress={() => setCameraOpen(true)}
              disabled={busy}
            >
              <Text style={styles.btnCameraText}>{t("field.addWaypoint.fieldCamera")}</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, styles.btnGhost]}
              onPress={() => void addPhotos()}
              disabled={busy}
            >
              <Text style={styles.btnGhostText}>{t("field.addWaypoint.addPhoto")}</Text>
            </Pressable>
            <Text style={styles.hint}>{t("field.addWaypoint.photoHint")}</Text>
          </ScrollView>

          <View style={styles.actions}>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={onCancel}>
              <Text style={styles.btnGhostText}>{t("common.cancel")}</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={save} disabled={busy}>
              <Text style={styles.btnPrimaryText}>{t("field.addWaypoint.save")}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, active && styles.chipActive]}
      hitSlop={4}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  coordRow: { flexDirection: "row", gap: spacing.sm },
  coord: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.bg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: spacing.md, maxHeight: "88%", gap: spacing.sm,
  },
  scroll: { flexGrow: 0 },
  title: { color: colors.text, fontSize: 15, fontWeight: "800", letterSpacing: 0.4 },
  gpsNote: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginBottom: spacing.xs },
  label: {
    color: colors.gold, fontSize: 11, fontWeight: "700", letterSpacing: 0.5,
    marginTop: spacing.md, marginBottom: 4,
  },
  hint: { color: colors.textFaint, fontSize: 10, lineHeight: 15, marginTop: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: {
    paddingHorizontal: spacing.md, paddingVertical: 6,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
  },
  chipActive: { borderColor: colors.gold, backgroundColor: "rgba(212,175,55,0.14)" },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextActive: { color: colors.gold, fontWeight: "700" },
  sampleBox: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: spacing.sm, marginTop: spacing.xs,
  },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.sm, paddingVertical: 8,
    color: colors.text, fontSize: 13,
  },
  multiline: { minHeight: 68, textAlignVertical: "top" },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  btn: {
    flex: 1, paddingVertical: spacing.sm, borderRadius: radius.md, alignItems: "center",
  },
  btnPrimary: { backgroundColor: colors.gold },
  btnPrimaryText: { color: "#1A1A1A", fontSize: 13, fontWeight: "800", letterSpacing: 0.4 },
  btnGhost: { borderWidth: 1, borderColor: colors.border },
  btnGhostText: { color: colors.text, fontSize: 13, fontWeight: "700" },
  btnCamera: {
    borderWidth: 1, borderColor: colors.gold,
    backgroundColor: "rgba(212,175,55,0.14)", marginBottom: spacing.xs,
  },
  btnCameraText: { color: colors.gold, fontSize: 13, fontWeight: "800", letterSpacing: 0.3 },
});

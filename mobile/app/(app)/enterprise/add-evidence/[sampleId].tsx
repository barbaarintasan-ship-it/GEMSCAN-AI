// Add Structured Evidence — Phase 6 (Solo→Team shared-targeting).
//
// The same five categories Solo's own User Geological Evidence form
// captures (mobile/lib/field/structuredEvidenceTypes.ts): laboratory/assay,
// ground geophysics, detailed mapping, remote sensing, expert/field
// observation. Deliberately a SEPARATE screen from new-sample.tsx, reachable
// from an already-submitted sample's detail page — assay results in
// particular routinely come back days after the field visit, long after
// the sample itself was submitted.
//
// Essential fields only, not the full richness of Solo's forms (which cover
// many more optional fields) — this lands the end-to-end pipeline (capture →
// server-enforced verification gate → storage) for all five categories;
// growing each form's field set is incremental work on top of this, not a
// second pipeline.
import React, { useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, TextInput, Alert, Switch } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing, radius } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { SectionLabel } from "../../../../components/ui/SectionLabel";
import {
  addSampleStructuredEvidence,
  type StructuredEvidenceType, type EvidenceVerificationStatus,
} from "../../../../lib/enterpriseSamples";

const TYPES: { key: StructuredEvidenceType; en: string; so: string }[] = [
  { key: "assay", en: "Laboratory / assay", so: "Shaybaar / falanqayn" },
  { key: "geophysics", en: "Ground geophysics", so: "Juqraafi-dhabta" },
  { key: "mapping", en: "Detailed mapping", so: "Khariidadaynta faahfaahsan" },
  { key: "remote_sensing", en: "Remote sensing", so: "Dareen fog" },
  { key: "field_observation", en: "Expert / field observation", so: "Aragtida khabiirka" },
];

const STATUSES: { key: EvidenceVerificationStatus; en: string; so: string }[] = [
  { key: "user_reported", en: "User-reported", so: "Isticmaale ayaa soo sheegay" },
  { key: "expert_verified", en: "Expert-verified", so: "Khabiir ayaa xaqiijiyay" },
  { key: "lab_verified", en: "Lab-verified", so: "Shaybaar ayaa xaqiijiyay" },
];

export default function AddEvidenceScreen() {
  const { sampleId } = useLocalSearchParams<{ sampleId: string }>();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [type, setType] = useState<StructuredEvidenceType>("assay");
  const [status, setStatus] = useState<EvidenceVerificationStatus>("user_reported");
  const [labAccredited, setLabAccredited] = useState(false);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Assay
  const [element, setElement] = useState("");
  const [result, setResult] = useState("");
  const [unit, setUnit] = useState("g/t");
  const [labName, setLabName] = useState("");
  // Geophysics
  const [surveyType, setSurveyType] = useState("magnetics");
  const [anomalyPresent, setAnomalyPresent] = useState(false);
  const [anomalyDescription, setAnomalyDescription] = useState("");
  // Mapping
  const [hostLithology, setHostLithology] = useState("");
  const [veinType, setVeinType] = useState("");
  const [gossan, setGossan] = useState(false);
  const [sulfides, setSulfides] = useState(false);
  // Remote sensing
  const [source, setSource] = useState("sentinel2");
  const [interpretation, setInterpretation] = useState("");
  // Field observation
  const [visibleMineral, setVisibleMineral] = useState(false);
  const [quartzVein, setQuartzVein] = useState(false);
  const [gossanRust, setGossanRust] = useState(false);
  const [shearing, setShearing] = useState(false);
  const [oldWorkings, setOldWorkings] = useState(false);

  function buildPayload(): Record<string, unknown> {
    switch (type) {
      case "assay":
        return { element: element.trim(), result: result.trim() === "" ? null : Number(result), unit, labName: labName.trim() };
      case "geophysics":
        return { surveyType, anomalyPresent, anomalyDescription: anomalyDescription.trim() };
      case "mapping":
        return { hostLithology: hostLithology.trim(), veinType: veinType.trim(), gossan, sulfides };
      case "remote_sensing":
        return { source, interpretation: interpretation.trim() };
      case "field_observation":
        return { visibleMineral, quartzVein, gossanRust, shearing, oldWorkings };
    }
  }

  function hasContent(): boolean {
    switch (type) {
      case "assay": return element.trim() !== "" || result.trim() !== "";
      case "geophysics": return anomalyPresent || anomalyDescription.trim() !== "";
      case "mapping": return hostLithology.trim() !== "" || veinType.trim() !== "" || gossan || sulfides;
      case "remote_sensing": return interpretation.trim() !== "";
      case "field_observation": return visibleMineral || quartzVein || gossanRust || shearing || oldWorkings;
    }
  }

  async function handleSave() {
    if (!sampleId || !hasContent()) return;
    setSaving(true);
    try {
      await addSampleStructuredEvidence(sampleId, type, buildPayload(), {
        verificationStatus: status, labAccredited, notes: notes.trim() || undefined,
      });
      Alert.alert(so ? "Waa la kaydiyay" : "Saved", so ? "Caddeynta ayaa lagu daray." : "Evidence added.");
      router.back();
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{so ? "Ku Dar Caddeyn" : "Add Evidence"}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <SectionLabel>{so ? "Nooca caddeynta" : "Evidence type"}</SectionLabel>
        <View style={styles.chips}>
          {TYPES.map((tOpt) => (
            <Pressable key={tOpt.key} style={[styles.chip, type === tOpt.key && styles.chipActive]} onPress={() => setType(tOpt.key)}>
              <Text style={[styles.chipText, type === tOpt.key && styles.chipTextActive]}>{so ? tOpt.so : tOpt.en}</Text>
            </Pressable>
          ))}
        </View>

        <Card style={styles.card}>
          {type === "assay" && (
            <>
              <TextInput style={styles.input} placeholder={so ? "Curiyaha (tus. Au)" : "Element (e.g. Au)"} placeholderTextColor={colors.textFaint} value={element} onChangeText={setElement} />
              <View style={styles.row}>
                <TextInput style={[styles.input, styles.flex1]} placeholder={so ? "Natiijada" : "Result"} placeholderTextColor={colors.textFaint} keyboardType="numeric" value={result} onChangeText={setResult} />
                <TextInput style={[styles.input, { width: 90 }]} placeholder="g/t" placeholderTextColor={colors.textFaint} value={unit} onChangeText={setUnit} />
              </View>
              <TextInput style={styles.input} placeholder={so ? "Magaca shaybaarka" : "Lab name"} placeholderTextColor={colors.textFaint} value={labName} onChangeText={setLabName} />
            </>
          )}
          {type === "geophysics" && (
            <>
              <TextInput style={styles.input} placeholder={so ? "Nooca sahanka (tus. magnetics)" : "Survey type (e.g. magnetics)"} placeholderTextColor={colors.textFaint} value={surveyType} onChangeText={setSurveyType} />
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>{so ? "Wax kale oo cajiib ah ayaa jira" : "Anomaly present"}</Text>
                <Switch value={anomalyPresent} onValueChange={setAnomalyPresent} />
              </View>
              <TextInput style={styles.input} placeholder={so ? "Sharaxaad" : "Description"} placeholderTextColor={colors.textFaint} value={anomalyDescription} onChangeText={setAnomalyDescription} multiline />
            </>
          )}
          {type === "mapping" && (
            <>
              <TextInput style={styles.input} placeholder={so ? "Dhagxanta martida ah" : "Host lithology"} placeholderTextColor={colors.textFaint} value={hostLithology} onChangeText={setHostLithology} />
              <TextInput style={styles.input} placeholder={so ? "Nooca xidhka (vein)" : "Vein type"} placeholderTextColor={colors.textFaint} value={veinType} onChangeText={setVeinType} />
              <View style={styles.switchRow}><Text style={styles.switchLabel}>Gossan</Text><Switch value={gossan} onValueChange={setGossan} /></View>
              <View style={styles.switchRow}><Text style={styles.switchLabel}>{so ? "Sulfide-yo" : "Sulfides"}</Text><Switch value={sulfides} onValueChange={setSulfides} /></View>
            </>
          )}
          {type === "remote_sensing" && (
            <>
              <TextInput style={styles.input} placeholder={so ? "Isha (tus. sentinel2)" : "Source (e.g. sentinel2)"} placeholderTextColor={colors.textFaint} value={source} onChangeText={setSource} />
              <TextInput style={styles.input} placeholder={so ? "Fasiraadda" : "Interpretation"} placeholderTextColor={colors.textFaint} value={interpretation} onChangeText={setInterpretation} multiline />
            </>
          )}
          {type === "field_observation" && (
            <>
              <View style={styles.switchRow}><Text style={styles.switchLabel}>{so ? "Macdan la arki karo" : "Visible mineral"}</Text><Switch value={visibleMineral} onValueChange={setVisibleMineral} /></View>
              <View style={styles.switchRow}><Text style={styles.switchLabel}>{so ? "Xidh Quartz ah" : "Quartz vein"}</Text><Switch value={quartzVein} onValueChange={setQuartzVein} /></View>
              <View style={styles.switchRow}><Text style={styles.switchLabel}>Gossan / rust</Text><Switch value={gossanRust} onValueChange={setGossanRust} /></View>
              <View style={styles.switchRow}><Text style={styles.switchLabel}>{so ? "Shearing" : "Shearing"}</Text><Switch value={shearing} onValueChange={setShearing} /></View>
              <View style={styles.switchRow}><Text style={styles.switchLabel}>{so ? "Shaqooyin hore" : "Old workings"}</Text><Switch value={oldWorkings} onValueChange={setOldWorkings} /></View>
            </>
          )}
        </Card>

        <SectionLabel>{so ? "Xaqiijinta" : "Verification"}</SectionLabel>
        <View style={styles.chips}>
          {STATUSES.map((sOpt) => (
            <Pressable key={sOpt.key} style={[styles.chip, status === sOpt.key && styles.chipActive]} onPress={() => setStatus(sOpt.key)}>
              <Text style={[styles.chipText, status === sOpt.key && styles.chipTextActive]}>{so ? sOpt.so : sOpt.en}</Text>
            </Pressable>
          ))}
        </View>
        {status === "lab_verified" && (
          <Card style={styles.card}>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>
                {so ? "Shaybaarku waa mid la ansixiyay (accredited)" : "This lab is an accredited lab"}
              </Text>
              <Switch value={labAccredited} onValueChange={setLabAccredited} />
            </View>
            {!labAccredited && (
              <Text style={styles.mutedText}>
                {so
                  ? "Haddii aan la calaamadin, xaqiijintu waxay noqon doontaa 'khabiir ayaa xaqiijiyay' — server-ku sidaas ayuu si toos ah u xaqiijinayaa."
                  : "Without this, verification is stored as 'expert-verified' — the server enforces this automatically."}
              </Text>
            )}
          </Card>
        )}

        <SectionLabel>{so ? "Fiiro gaar ah" : "Notes"}</SectionLabel>
        <TextInput style={[styles.input, styles.inputMultiline]} placeholder={so ? "Fiiro (ikhtiyaari)" : "Notes (optional)"} placeholderTextColor={colors.textFaint} value={notes} onChangeText={setNotes} multiline />

        <Button
          title={so ? "Kaydi Caddeynta" : "Save Evidence"}
          disabled={!hasContent()}
          loading={saving}
          onPress={handleSave}
          style={styles.saveButton}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: 40 },
  card: { gap: spacing.sm, marginBottom: spacing.sm },
  row: { flexDirection: "row", gap: spacing.sm },
  flex1: { flex: 1 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: 10, color: colors.text, fontSize: 14,
  },
  inputMultiline: { minHeight: 70, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  chipActive: { backgroundColor: colors.goldSoft, borderColor: colors.goldBorder },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextActive: { color: colors.gold, fontWeight: "700" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  switchLabel: { color: colors.text, fontSize: 13, flexShrink: 1, paddingRight: spacing.sm },
  mutedText: { color: colors.textFaint, fontSize: 11, fontStyle: "italic" },
  saveButton: { marginTop: spacing.sm },
});

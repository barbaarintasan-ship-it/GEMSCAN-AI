// User Geological Evidence — five optional sections a geologist fills in with
// what they already know, before or during a field investigation. No section is
// required, and nothing here requires a PDF or certificate: the point is to
// capture what someone actually has, entered as structured answers.
//
// ONE ENTRY PER SECTION PER SAVE. Saving appends whichever sections have
// content to the mission's evidence record (structuredEvidenceTypes.ts already
// models each section as an array) — opening this form again adds another
// entry rather than overwriting the last one, the same "capture, don't
// overwrite" rule AddWaypointForm already follows for waypoints.
//
// WHAT THIS FORM DOES NOT DECIDE. It never sets a verification tier directly —
// `verificationStatus`/`mappingConfidence`/`confidence` here are the SOURCE's own
// claim, and structuredEvidenceSource.ts is the only place that claim is gated
// against an actual `labAccredited` flag before it can reach a scoring tier.
import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "../lib/theme";
import { ChoiceGroup, type ChoiceOption } from "./ui/ChoiceGroup";
import {
  ASSAY_UNITS, GEOPHYSICS_SURVEY_TYPES, REMOTE_SENSING_SOURCES, VERIFICATION_STATUSES,
  type AssayEntry, type GeophysicsEntry, type MappingEntry, type RemoteSensingEntry,
  type FieldObservationEntry, type VerificationStatus, type AssayUnit,
  type GeophysicsSurveyType, type RemoteSensingSource, type StructuredEvidenceResult,
} from "../lib/field/structuredEvidenceTypes";
import type { TFunc } from "../lib/exploration/format";

type SectionKey = "assay" | "geophysics" | "mapping" | "remoteSensing" | "field";

function verificationOptions(t: TFunc): ChoiceOption[] {
  return VERIFICATION_STATUSES.map((v) => ({ value: v, label: t(`field.evidenceForm.verification.${v}`) }));
}

function idFor(prefix: string, now: number): string {
  return `${prefix}-${now}-${Math.round(Math.random() * 1e6)}`;
}

function SectionHeader({
  label, expanded, onToggle, hint,
}: { label: string; expanded: boolean; onToggle: () => void; hint?: string }) {
  return (
    <Pressable style={styles.sectionHeader} onPress={onToggle} accessibilityRole="button">
      <View style={styles.sectionHeaderText}>
        <Text style={styles.sectionTitle}>{label}</Text>
        {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
      </View>
      <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={20} color={colors.textFaint} />
    </Pressable>
  );
}

function Field({
  label, value, onChangeText, placeholder, keyboardType, multiline,
}: {
  label: string; value: string; onChangeText: (v: string) => void; placeholder?: string;
  keyboardType?: "default" | "numeric"; multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        keyboardType={keyboardType ?? "default"}
        multiline={!!multiline}
      />
    </View>
  );
}

function BoolChip({ label, value, onToggle }: { label: string; value: boolean; onToggle: () => void }) {
  return (
    <Pressable
      style={[styles.boolChip, value && styles.boolChipOn]}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
    >
      {value ? <Ionicons name="checkmark" size={14} color={colors.gold} /> : null}
      <Text style={[styles.boolChipText, value && styles.boolChipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function StructuredEvidenceForm({
  visible, commodity, now, onCancel, onSave, t,
}: {
  visible: boolean;
  commodity: string | null;
  now: () => number;
  onCancel: () => void;
  onSave: (r: StructuredEvidenceResult) => void;
  t: TFunc;
}) {
  const [expanded, setExpanded] = React.useState<Record<SectionKey, boolean>>({
    assay: false, geophysics: false, mapping: false, remoteSensing: false, field: false,
  });
  const toggle = (k: SectionKey) => setExpanded((e) => ({ ...e, [k]: !e[k] }));

  // A. Laboratory / assay
  const [element, setElement] = React.useState("");
  const [result, setResult] = React.useState("");
  const [unit, setUnit] = React.useState<AssayUnit>("g/t");
  const [sampleType, setSampleType] = React.useState("");
  const [assaySampleId, setAssaySampleId] = React.useState("");
  const [samplingDate, setSamplingDate] = React.useState("");
  const [assayVerification, setAssayVerification] = React.useState<VerificationStatus>("user_reported");
  const [labAccredited, setLabAccredited] = React.useState(false);
  const [labName, setLabName] = React.useState("");
  const [assayNotes, setAssayNotes] = React.useState("");

  // B. Ground geophysics
  const [surveyType, setSurveyType] = React.useState<GeophysicsSurveyType>("magnetics");
  const [anomalyPresent, setAnomalyPresent] = React.useState(false);
  const [anomalyDescription, setAnomalyDescription] = React.useState("");
  const [magnitude, setMagnitude] = React.useState("");
  const [surveyArea, setSurveyArea] = React.useState("");
  const [geophysicsInterpretation, setGeophysicsInterpretation] = React.useState("");
  const [geophysicsVerification, setGeophysicsVerification] = React.useState<VerificationStatus>("user_reported");
  const [geophysicsNotes, setGeophysicsNotes] = React.useState("");

  // C. Detailed geological mapping
  const [hostLithology, setHostLithology] = React.useState("");
  const [rockType, setRockType] = React.useState("");
  const [formationUnit, setFormationUnit] = React.useState("");
  const [mapAlteration, setMapAlteration] = React.useState("");
  const [veinType, setVeinType] = React.useState("");
  const [veinWidthM, setVeinWidthM] = React.useState("");
  const [veinOrientation, setVeinOrientation] = React.useState("");
  const [strikeDeg, setStrikeDeg] = React.useState("");
  const [dipDeg, setDipDeg] = React.useState("");
  const [mapFault, setMapFault] = React.useState(false);
  const [shearZone, setShearZone] = React.useState(false);
  const [fold, setFold] = React.useState(false);
  const [breccia, setBreccia] = React.useState(false);
  const [mapGossan, setMapGossan] = React.useState(false);
  const [mapSulfides, setMapSulfides] = React.useState(false);
  const [visibleMineralization, setVisibleMineralization] = React.useState("");
  const [mineralAssemblage, setMineralAssemblage] = React.useState("");
  const [structuralRelationship, setStructuralRelationship] = React.useState("");
  const [mappingConfidence, setMappingConfidence] = React.useState<VerificationStatus>("user_reported");
  const [mappingNotes, setMappingNotes] = React.useState("");

  // D. Remote sensing
  const [rsSource, setRsSource] = React.useState<RemoteSensingSource>("sentinel2");
  const [alterationAnomaly, setAlterationAnomaly] = React.useState("");
  const [spectralAnomaly, setSpectralAnomaly] = React.useState("");
  const [structuralAnomaly, setStructuralAnomaly] = React.useState("");
  const [lineamentInterpretation, setLineamentInterpretation] = React.useState("");
  const [areaCovered, setAreaCovered] = React.useState("");
  const [rsInterpretation, setRsInterpretation] = React.useState("");
  const [rsConfidence, setRsConfidence] = React.useState<VerificationStatus>("user_reported");
  const [rsNotes, setRsNotes] = React.useState("");

  // E. Expert / field observation
  const [visibleMineral, setVisibleMineral] = React.useState(false);
  const [quartzVein, setQuartzVein] = React.useState(false);
  const [gossanRust, setGossanRust] = React.useState(false);
  const [fieldSulfides, setFieldSulfides] = React.useState(false);
  const [fieldAlteration, setFieldAlteration] = React.useState(false);
  const [shearing, setShearing] = React.useState(false);
  const [faultExposure, setFaultExposure] = React.useState(false);
  const [oldWorkings, setOldWorkings] = React.useState(false);
  const [activeArtisanalMining, setActiveArtisanalMining] = React.useState(false);
  const [pits, setPits] = React.useState(false);
  const [shafts, setShafts] = React.useState(false);
  const [adits, setAdits] = React.useState(false);
  const [tailings, setTailings] = React.useState(false);
  const [historicalProduction, setHistoricalProduction] = React.useState(false);
  const [localMiningEvidence, setLocalMiningEvidence] = React.useState(false);
  const [otherObservations, setOtherObservations] = React.useState("");
  const [expertInterpretation, setExpertInterpretation] = React.useState("");
  const [fieldConfidence, setFieldConfidence] = React.useState<VerificationStatus>("user_reported");
  const [fieldNotes, setFieldNotes] = React.useState("");
  // "Specifically checked and absent" — the ONLY source of negative evidence
  // in the whole system. Left unchecked by default, which produces nothing —
  // never inferred from a positive checkbox above simply being untouched.
  const [absentAlteration, setAbsentAlteration] = React.useState(false);
  const [absentSulfides, setAbsentSulfides] = React.useState(false);
  const [absentQuartzVein, setAbsentQuartzVein] = React.useState(false);
  const [absentVisibleMineralization, setAbsentVisibleMineralization] = React.useState(false);
  const [absentFavorableStructure, setAbsentFavorableStructure] = React.useState(false);
  const [absentGeochemicalAnomaly, setAbsentGeochemicalAnomaly] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    setExpanded({ assay: false, geophysics: false, mapping: false, remoteSensing: false, field: false });
    setElement(""); setResult(""); setUnit("g/t"); setSampleType(""); setAssaySampleId("");
    setSamplingDate(""); setAssayVerification("user_reported"); setLabAccredited(false);
    setLabName(""); setAssayNotes("");
    setSurveyType("magnetics"); setAnomalyPresent(false); setAnomalyDescription("");
    setMagnitude(""); setSurveyArea(""); setGeophysicsInterpretation("");
    setGeophysicsVerification("user_reported"); setGeophysicsNotes("");
    setHostLithology(""); setRockType(""); setFormationUnit(""); setMapAlteration("");
    setVeinType(""); setVeinWidthM(""); setVeinOrientation(""); setStrikeDeg(""); setDipDeg("");
    setMapFault(false); setShearZone(false); setFold(false); setBreccia(false);
    setMapGossan(false); setMapSulfides(false); setVisibleMineralization("");
    setMineralAssemblage(""); setStructuralRelationship(""); setMappingConfidence("user_reported");
    setMappingNotes("");
    setRsSource("sentinel2"); setAlterationAnomaly(""); setSpectralAnomaly("");
    setStructuralAnomaly(""); setLineamentInterpretation(""); setAreaCovered("");
    setRsInterpretation(""); setRsConfidence("user_reported"); setRsNotes("");
    setVisibleMineral(false); setQuartzVein(false); setGossanRust(false); setFieldSulfides(false);
    setFieldAlteration(false); setShearing(false); setFaultExposure(false); setOldWorkings(false);
    setActiveArtisanalMining(false); setPits(false); setShafts(false); setAdits(false);
    setTailings(false); setHistoricalProduction(false); setLocalMiningEvidence(false);
    setOtherObservations(""); setExpertInterpretation(""); setFieldConfidence("user_reported");
    setFieldNotes("");
    setAbsentAlteration(false); setAbsentSulfides(false); setAbsentQuartzVein(false);
    setAbsentVisibleMineralization(false); setAbsentFavorableStructure(false);
    setAbsentGeochemicalAnomaly(false);
  }, [visible]);

  function save() {
    const at = now();
    const num = (s: string): number | null => {
      const n = Number(s.trim());
      return s.trim() !== "" && Number.isFinite(n) ? n : null;
    };

    const assay: AssayEntry | null = element.trim() && num(result) != null ? {
      id: idFor("assay", at), element: element.trim(), result: num(result), unit,
      sampleType: sampleType.trim(), sampleId: assaySampleId.trim(), location: null,
      samplingDate: samplingDate.trim() || null, verificationStatus: assayVerification,
      labAccredited, labName: labName.trim(), notes: assayNotes.trim(),
    } : null;

    const geophysics: GeophysicsEntry | null = anomalyPresent || anomalyDescription.trim() ? {
      id: idFor("geophysics", at), surveyType, anomalyPresent, anomalyDescription: anomalyDescription.trim(),
      magnitude: num(magnitude), surveyArea: surveyArea.trim(), location: null,
      interpretation: geophysicsInterpretation.trim(), verificationStatus: geophysicsVerification,
      notes: geophysicsNotes.trim(),
    } : null;

    const hasMappingContent = hostLithology.trim() || rockType.trim() || formationUnit.trim() ||
      mapAlteration.trim() || veinType.trim() || mapFault || shearZone || fold || breccia ||
      mapGossan || mapSulfides || visibleMineralization.trim() || mineralAssemblage.trim();
    const mapping: MappingEntry | null = hasMappingContent ? {
      id: idFor("mapping", at), hostLithology: hostLithology.trim(), rockType: rockType.trim(),
      formationUnit: formationUnit.trim(), alteration: mapAlteration.trim(), veinType: veinType.trim(),
      veinWidthM: num(veinWidthM), veinOrientation: veinOrientation.trim(), strikeDeg: num(strikeDeg),
      dipDeg: num(dipDeg), fault: mapFault, shearZone, fold, breccia, gossan: mapGossan,
      sulfides: mapSulfides, visibleMineralization: visibleMineralization.trim(),
      mineralAssemblage: mineralAssemblage.trim(), structuralRelationship: structuralRelationship.trim(),
      mappingConfidence, notes: mappingNotes.trim(),
    } : null;

    const hasRsContent = alterationAnomaly.trim() || spectralAnomaly.trim() ||
      structuralAnomaly.trim() || lineamentInterpretation.trim() || rsInterpretation.trim();
    const remoteSensing: RemoteSensingEntry | null = hasRsContent ? {
      id: idFor("rs", at), source: rsSource, alterationAnomaly: alterationAnomaly.trim(),
      spectralAnomaly: spectralAnomaly.trim(), structuralAnomaly: structuralAnomaly.trim(),
      lineamentInterpretation: lineamentInterpretation.trim(), imageDate: null,
      areaCovered: areaCovered.trim(), interpretation: rsInterpretation.trim(),
      confidence: rsConfidence, notes: rsNotes.trim(),
    } : null;

    const hasConfirmedAbsent = absentAlteration || absentSulfides || absentQuartzVein ||
      absentVisibleMineralization || absentFavorableStructure || absentGeochemicalAnomaly;
    const hasFieldContent = visibleMineral || quartzVein || gossanRust || fieldSulfides ||
      fieldAlteration || shearing || faultExposure || oldWorkings || activeArtisanalMining ||
      pits || shafts || adits || tailings || historicalProduction || localMiningEvidence ||
      otherObservations.trim() || expertInterpretation.trim() || hasConfirmedAbsent;
    const fieldObservation: FieldObservationEntry | null = hasFieldContent ? {
      id: idFor("field", at), visibleMineral, quartzVein, gossanRust, sulfides: fieldSulfides,
      alteration: fieldAlteration, shearing, faultExposure, oldWorkings, activeArtisanalMining,
      pits, shafts, adits, tailings, historicalProduction, localMiningEvidence,
      otherObservations: otherObservations.trim(), expertInterpretation: expertInterpretation.trim(),
      confidence: fieldConfidence, notes: fieldNotes.trim(),
      ...(hasConfirmedAbsent ? {
        confirmedAbsent: {
          ...(absentAlteration ? { alteration: true } : {}),
          ...(absentSulfides ? { sulfides: true } : {}),
          ...(absentQuartzVein ? { quartzVein: true } : {}),
          ...(absentVisibleMineralization ? { visibleMineralization: true } : {}),
          ...(absentFavorableStructure ? { favorableStructure: true } : {}),
          ...(absentGeochemicalAnomaly ? { geochemicalAnomaly: true } : {}),
        },
      } : {}),
    } : null;

    onSave({ assay, geophysics, mapping, remoteSensing, fieldObservation });
  }

  const hasAnything = element.trim() || anomalyPresent || anomalyDescription.trim() ||
    hostLithology.trim() || rockType.trim() || mapFault || mapGossan || mapSulfides ||
    alterationAnomaly.trim() || rsInterpretation.trim() || visibleMineral || quartzVein ||
    gossanRust || fieldSulfides || oldWorkings || activeArtisanalMining ||
    absentAlteration || absentSulfides || absentQuartzVein || absentVisibleMineralization ||
    absentFavorableStructure || absentGeochemicalAnomaly;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{t("field.evidenceForm.title")}</Text>
          <Pressable onPress={onCancel} accessibilityRole="button">
            <Ionicons name="close" size={24} color={colors.textMuted} />
          </Pressable>
        </View>
        <Text style={styles.subtitle}>{t("field.evidenceForm.subtitle")}</Text>
        {commodity ? <Text style={styles.commodity}>{t("field.evidenceForm.commodity", { commodity })}</Text> : null}

        <ScrollView contentContainerStyle={styles.scroll}>
          {/* A. Laboratory / assay */}
          <SectionHeader
            label={t("field.evidenceForm.assay.title")} expanded={expanded.assay}
            onToggle={() => toggle("assay")} hint={t("field.evidenceForm.assay.hint")}
          />
          {expanded.assay && (
            <View style={styles.sectionBody}>
              <Field label={t("field.evidenceForm.assay.element")} value={element} onChangeText={setElement}
                placeholder={t("field.evidenceForm.assay.elementPlaceholder")} />
              <Field label={t("field.evidenceForm.assay.result")} value={result} onChangeText={setResult}
                keyboardType="numeric" placeholder="0.0" />
              <Text style={styles.fieldLabel}>{t("field.evidenceForm.assay.unit")}</Text>
              <ChoiceGroup layout="chips" value={unit} onChange={(v) => setUnit(v as AssayUnit)}
                options={ASSAY_UNITS.map((u) => ({ value: u, label: u }))} />
              <Field label={t("field.evidenceForm.assay.sampleType")} value={sampleType} onChangeText={setSampleType} />
              <Field label={t("field.evidenceForm.assay.sampleId")} value={assaySampleId} onChangeText={setAssaySampleId} />
              <Field label={t("field.evidenceForm.assay.samplingDate")} value={samplingDate} onChangeText={setSamplingDate}
                placeholder="YYYY-MM-DD" />
              <Text style={styles.fieldLabel}>{t("field.evidenceForm.verificationLabel")}</Text>
              <ChoiceGroup layout="chips" value={assayVerification}
                onChange={(v) => setAssayVerification(v as VerificationStatus)} options={verificationOptions(t)} />
              <BoolChip label={t("field.evidenceForm.assay.labAccredited")} value={labAccredited}
                onToggle={() => setLabAccredited((v) => !v)} />
              <Text style={styles.helperText}>{t("field.evidenceForm.assay.labAccreditedHelp")}</Text>
              <Field label={t("field.evidenceForm.assay.labName")} value={labName} onChangeText={setLabName} />
              <Field label={t("field.evidenceForm.notes")} value={assayNotes} onChangeText={setAssayNotes} multiline />
            </View>
          )}

          {/* B. Ground geophysics */}
          <SectionHeader
            label={t("field.evidenceForm.geophysics.title")} expanded={expanded.geophysics}
            onToggle={() => toggle("geophysics")} hint={t("field.evidenceForm.geophysics.hint")}
          />
          {expanded.geophysics && (
            <View style={styles.sectionBody}>
              <Text style={styles.fieldLabel}>{t("field.evidenceForm.geophysics.surveyType")}</Text>
              <ChoiceGroup layout="chips" value={surveyType}
                onChange={(v) => setSurveyType(v as GeophysicsSurveyType)}
                options={GEOPHYSICS_SURVEY_TYPES.map((s) => ({ value: s, label: t(`field.evidenceForm.geophysics.type.${s}`) }))} />
              <BoolChip label={t("field.evidenceForm.geophysics.anomalyPresent")} value={anomalyPresent}
                onToggle={() => setAnomalyPresent((v) => !v)} />
              <Field label={t("field.evidenceForm.geophysics.anomalyDescription")} value={anomalyDescription}
                onChangeText={setAnomalyDescription} multiline />
              <Field label={t("field.evidenceForm.geophysics.magnitude")} value={magnitude} onChangeText={setMagnitude}
                keyboardType="numeric" />
              <Field label={t("field.evidenceForm.geophysics.surveyArea")} value={surveyArea} onChangeText={setSurveyArea} />
              <Field label={t("field.evidenceForm.geophysics.interpretation")} value={geophysicsInterpretation}
                onChangeText={setGeophysicsInterpretation} multiline />
              <Text style={styles.fieldLabel}>{t("field.evidenceForm.verificationLabel")}</Text>
              <ChoiceGroup layout="chips" value={geophysicsVerification}
                onChange={(v) => setGeophysicsVerification(v as VerificationStatus)} options={verificationOptions(t)} />
              <Field label={t("field.evidenceForm.notes")} value={geophysicsNotes} onChangeText={setGeophysicsNotes} multiline />
            </View>
          )}

          {/* C. Detailed geological mapping */}
          <SectionHeader
            label={t("field.evidenceForm.mapping.title")} expanded={expanded.mapping}
            onToggle={() => toggle("mapping")} hint={t("field.evidenceForm.mapping.hint")}
          />
          {expanded.mapping && (
            <View style={styles.sectionBody}>
              <Field label={t("field.evidenceForm.mapping.hostLithology")} value={hostLithology} onChangeText={setHostLithology} />
              <Field label={t("field.evidenceForm.mapping.rockType")} value={rockType} onChangeText={setRockType} />
              <Field label={t("field.evidenceForm.mapping.formationUnit")} value={formationUnit} onChangeText={setFormationUnit} />
              <Field label={t("field.evidenceForm.mapping.alteration")} value={mapAlteration} onChangeText={setMapAlteration} />
              <Field label={t("field.evidenceForm.mapping.veinType")} value={veinType} onChangeText={setVeinType} />
              <Field label={t("field.evidenceForm.mapping.veinWidth")} value={veinWidthM} onChangeText={setVeinWidthM} keyboardType="numeric" />
              <Field label={t("field.evidenceForm.mapping.veinOrientation")} value={veinOrientation} onChangeText={setVeinOrientation} />
              <Field label={t("field.evidenceForm.mapping.strike")} value={strikeDeg} onChangeText={setStrikeDeg} keyboardType="numeric" />
              <Field label={t("field.evidenceForm.mapping.dip")} value={dipDeg} onChangeText={setDipDeg} keyboardType="numeric" />
              <View style={styles.chipRow}>
                <BoolChip label={t("field.evidenceForm.mapping.fault")} value={mapFault} onToggle={() => setMapFault((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.mapping.shearZone")} value={shearZone} onToggle={() => setShearZone((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.mapping.fold")} value={fold} onToggle={() => setFold((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.mapping.breccia")} value={breccia} onToggle={() => setBreccia((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.mapping.gossan")} value={mapGossan} onToggle={() => setMapGossan((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.mapping.sulfides")} value={mapSulfides} onToggle={() => setMapSulfides((v) => !v)} />
              </View>
              <Field label={t("field.evidenceForm.mapping.visibleMineralization")} value={visibleMineralization}
                onChangeText={setVisibleMineralization} multiline />
              <Field label={t("field.evidenceForm.mapping.mineralAssemblage")} value={mineralAssemblage} onChangeText={setMineralAssemblage} />
              <Field label={t("field.evidenceForm.mapping.structuralRelationship")} value={structuralRelationship}
                onChangeText={setStructuralRelationship} multiline />
              <Text style={styles.fieldLabel}>{t("field.evidenceForm.verificationLabel")}</Text>
              <ChoiceGroup layout="chips" value={mappingConfidence}
                onChange={(v) => setMappingConfidence(v as VerificationStatus)} options={verificationOptions(t)} />
              <Field label={t("field.evidenceForm.notes")} value={mappingNotes} onChangeText={setMappingNotes} multiline />
            </View>
          )}

          {/* D. Remote sensing */}
          <SectionHeader
            label={t("field.evidenceForm.remoteSensing.title")} expanded={expanded.remoteSensing}
            onToggle={() => toggle("remoteSensing")} hint={t("field.evidenceForm.remoteSensing.hint")}
          />
          {expanded.remoteSensing && (
            <View style={styles.sectionBody}>
              <Text style={styles.fieldLabel}>{t("field.evidenceForm.remoteSensing.source")}</Text>
              <ChoiceGroup layout="chips" value={rsSource} onChange={(v) => setRsSource(v as RemoteSensingSource)}
                options={REMOTE_SENSING_SOURCES.map((s) => ({ value: s, label: t(`field.evidenceForm.remoteSensing.sourceOption.${s}`) }))} />
              <Field label={t("field.evidenceForm.remoteSensing.alterationAnomaly")} value={alterationAnomaly}
                onChangeText={setAlterationAnomaly} multiline />
              <Field label={t("field.evidenceForm.remoteSensing.spectralAnomaly")} value={spectralAnomaly}
                onChangeText={setSpectralAnomaly} multiline />
              <Field label={t("field.evidenceForm.remoteSensing.structuralAnomaly")} value={structuralAnomaly}
                onChangeText={setStructuralAnomaly} multiline />
              <Field label={t("field.evidenceForm.remoteSensing.lineamentInterpretation")} value={lineamentInterpretation}
                onChangeText={setLineamentInterpretation} multiline />
              <Text style={styles.helperText}>{t("field.evidenceForm.remoteSensing.lineamentHelp")}</Text>
              <Field label={t("field.evidenceForm.remoteSensing.areaCovered")} value={areaCovered} onChangeText={setAreaCovered} />
              <Field label={t("field.evidenceForm.remoteSensing.interpretation")} value={rsInterpretation}
                onChangeText={setRsInterpretation} multiline />
              <Text style={styles.fieldLabel}>{t("field.evidenceForm.verificationLabel")}</Text>
              <ChoiceGroup layout="chips" value={rsConfidence}
                onChange={(v) => setRsConfidence(v as VerificationStatus)} options={verificationOptions(t)} />
              <Field label={t("field.evidenceForm.notes")} value={rsNotes} onChangeText={setRsNotes} multiline />
            </View>
          )}

          {/* E. Expert / field observation */}
          <SectionHeader
            label={t("field.evidenceForm.field.title")} expanded={expanded.field}
            onToggle={() => toggle("field")} hint={t("field.evidenceForm.field.hint")}
          />
          {expanded.field && (
            <View style={styles.sectionBody}>
              <View style={styles.chipRow}>
                <BoolChip label={t("field.evidenceForm.field.visibleMineral")} value={visibleMineral} onToggle={() => setVisibleMineral((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.quartzVein")} value={quartzVein} onToggle={() => setQuartzVein((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.gossanRust")} value={gossanRust} onToggle={() => setGossanRust((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.sulfides")} value={fieldSulfides} onToggle={() => setFieldSulfides((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.alteration")} value={fieldAlteration} onToggle={() => setFieldAlteration((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.shearing")} value={shearing} onToggle={() => setShearing((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.faultExposure")} value={faultExposure} onToggle={() => setFaultExposure((v) => !v)} />
              </View>
              <Text style={styles.fieldLabel}>{t("field.evidenceForm.field.miningEvidenceLabel")}</Text>
              <View style={styles.chipRow}>
                <BoolChip label={t("field.evidenceForm.field.oldWorkings")} value={oldWorkings} onToggle={() => setOldWorkings((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.activeArtisanalMining")} value={activeArtisanalMining} onToggle={() => setActiveArtisanalMining((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.pits")} value={pits} onToggle={() => setPits((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.shafts")} value={shafts} onToggle={() => setShafts((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.adits")} value={adits} onToggle={() => setAdits((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.tailings")} value={tailings} onToggle={() => setTailings((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.historicalProduction")} value={historicalProduction} onToggle={() => setHistoricalProduction((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.localMiningEvidence")} value={localMiningEvidence} onToggle={() => setLocalMiningEvidence((v) => !v)} />
              </View>
              <Text style={styles.fieldLabel}>{t("field.evidenceForm.field.confirmedAbsentLabel")}</Text>
              <Text style={styles.helperText}>{t("field.evidenceForm.field.confirmedAbsentHelp")}</Text>
              <View style={styles.chipRow}>
                <BoolChip label={t("field.evidenceForm.field.absentAlteration")} value={absentAlteration} onToggle={() => setAbsentAlteration((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.absentSulfides")} value={absentSulfides} onToggle={() => setAbsentSulfides((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.absentQuartzVein")} value={absentQuartzVein} onToggle={() => setAbsentQuartzVein((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.absentVisibleMineralization")} value={absentVisibleMineralization} onToggle={() => setAbsentVisibleMineralization((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.absentFavorableStructure")} value={absentFavorableStructure} onToggle={() => setAbsentFavorableStructure((v) => !v)} />
                <BoolChip label={t("field.evidenceForm.field.absentGeochemicalAnomaly")} value={absentGeochemicalAnomaly} onToggle={() => setAbsentGeochemicalAnomaly((v) => !v)} />
              </View>
              <Field label={t("field.evidenceForm.field.otherObservations")} value={otherObservations}
                onChangeText={setOtherObservations} multiline />
              <Field label={t("field.evidenceForm.field.expertInterpretation")} value={expertInterpretation}
                onChangeText={setExpertInterpretation} multiline />
              <Text style={styles.fieldLabel}>{t("field.evidenceForm.verificationLabel")}</Text>
              <ChoiceGroup layout="chips" value={fieldConfidence}
                onChange={(v) => setFieldConfidence(v as VerificationStatus)} options={verificationOptions(t)} />
              <Field label={t("field.evidenceForm.notes")} value={fieldNotes} onChangeText={setFieldNotes} multiline />
            </View>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable style={styles.cancelButton} onPress={onCancel} accessibilityRole="button">
            <Text style={styles.cancelText}>{t("common.cancel")}</Text>
          </Pressable>
          <Pressable
            style={[styles.saveButton, !hasAnything && styles.saveButtonDisabled]}
            onPress={save} disabled={!hasAnything} accessibilityRole="button"
          >
            <Text style={styles.saveText}>{t("field.evidenceForm.save")}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.sm,
  },
  title: { color: colors.text, fontSize: 19, fontWeight: "800" },
  subtitle: { color: colors.textMuted, fontSize: 13, paddingHorizontal: spacing.lg, lineHeight: 18 },
  commodity: { color: colors.gold, fontSize: 12.5, fontWeight: "700", paddingHorizontal: spacing.lg, paddingTop: 4 },
  scroll: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  sectionHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.border, padding: spacing.lg, marginTop: spacing.sm,
  },
  sectionHeaderText: { flex: 1, gap: 2 },
  sectionTitle: { color: colors.text, fontWeight: "800", fontSize: 15 },
  sectionHint: { color: colors.textFaint, fontSize: 12, lineHeight: 16 },
  sectionBody: {
    backgroundColor: colors.surfaceAlt, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.borderSubtle, padding: spacing.lg, gap: spacing.sm, marginTop: -spacing.xs,
  },
  field: { gap: 4 },
  fieldLabel: { color: colors.textMuted, fontSize: 12.5, fontWeight: "700" },
  input: {
    backgroundColor: colors.surfaceSunken, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.borderSubtle, color: colors.text, paddingHorizontal: spacing.md,
    paddingVertical: 10, fontSize: 14,
  },
  inputMultiline: { minHeight: 60, textAlignVertical: "top" },
  helperText: { color: colors.textFaint, fontSize: 11.5, lineHeight: 15, fontStyle: "italic" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  boolChip: {
    flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: spacing.md,
    paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceSunken,
    borderWidth: 1, borderColor: colors.borderSubtle, alignSelf: "flex-start",
  },
  boolChipOn: { backgroundColor: colors.goldSoft, borderColor: colors.goldBorder },
  boolChipText: { color: colors.textMuted, fontWeight: "600", fontSize: 13 },
  boolChipTextOn: { color: colors.gold },
  footer: {
    flexDirection: "row", gap: spacing.md, padding: spacing.lg,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  cancelButton: {
    flex: 1, alignItems: "center", paddingVertical: 14, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
  },
  cancelText: { color: colors.textMuted, fontWeight: "700" },
  saveButton: { flex: 2, alignItems: "center", paddingVertical: 14, borderRadius: radius.lg, backgroundColor: colors.gold },
  saveButtonDisabled: { opacity: 0.4 },
  saveText: { color: colors.bg, fontWeight: "800" },
});

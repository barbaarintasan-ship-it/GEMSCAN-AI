// Artifact Verification wizard — a second, OPTIONAL stage offered from
// results.tsx's "Artifact Verification" card. Collects a structured
// questionnaire (find location, buried/surface, found-with-others, cleaned,
// material, condition, inscriptions, size/weight, age claim) plus extra
// photos. The questionnaire itself stays free; the final verdict (evidence
// score, identification, era/culture, authenticity, PDF) is a $5 premium
// report gated behind a paywall. The single AI call (verify-artifact-value)
// is DEFERRED until a payment webhook marks the purchase 'paid'. Never reruns
// or replaces the original scan.
//
// Mirrors verify-gold.tsx structurally, against its own tables.
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  Linking,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useTranslation } from "react-i18next";
import {
  startArtifactVerification,
  saveArtifactVerificationProgress,
  uploadArtifactVerificationImage,
  markArtifactVerificationSubmitted,
  startArtifactReportPurchase,
  getArtifactReportPurchase,
  getArtifactVerificationVerdict,
  requestArtifactReEvaluation,
  getLocalArtifactDraft,
  setLocalArtifactDraft,
  clearLocalArtifactDraft,
  type ArtifactVerificationAnswers,
  type ArtifactVerificationImagePaths,
  type ArtifactVerificationImageLabel,
  type ArtifactVerificationVerdict,
  type ArtifactReportPurchase,
} from "../../../lib/artifactVerification";
import { EXTERNAL_PURCHASES_ENABLED, buildArtifactReportPaymentUrl } from "../../../lib/appLinks";
import { generateAndShareArtifactVerificationPdf } from "../../../lib/artifactVerificationPdfReport";
import { supabase } from "../../../lib/supabase";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { ConfidenceBadge } from "../../../components/ui/ConfidenceBadge";
import { ChoiceGroup } from "../../../components/ui/ChoiceGroup";
import { colors, spacing, radius, type as typo } from "../../../lib/theme";

type Opt = { value: string; en: string; so: string };

type ChoiceStepDef = {
  kind: "choice";
  key: keyof ArtifactVerificationAnswers;
  titleEn: string;
  titleSo: string;
  subtitleEn?: string;
  subtitleSo?: string;
  options: Opt[];
  layout?: "list" | "chips";
};
type TextStepDef = {
  kind: "text";
  key: keyof ArtifactVerificationAnswers;
  titleEn: string;
  titleSo: string;
  subtitleEn?: string;
  subtitleSo?: string;
  placeholderEn: string;
  placeholderSo: string;
};
type SizeStepDef = { kind: "size"; titleEn: string; titleSo: string };
type PhotosStepDef = { kind: "photos"; titleEn: string; titleSo: string; subtitleEn?: string; subtitleSo?: string };
type SubmitStepDef = { kind: "submit"; titleEn: string; titleSo: string };
type StepDef = ChoiceStepDef | TextStepDef | SizeStepDef | PhotosStepDef | SubmitStepDef;

const STEPS: StepDef[] = [
  {
    kind: "text",
    key: "foundLocation",
    titleEn: "Where was it found?",
    titleSo: "Xaggee laga helay?",
    subtitleEn: "Region, town, or type of place (e.g. old ruins, riverbank, farm). This context matters a lot.",
    subtitleSo: "Gobol, magaalo, ama nooca goobta (tusaale: burbur qadiimi ah, webi qarkiis, beer). Xogtani aad bay muhiim u tahay.",
    placeholderEn: "e.g. near old coastal ruins",
    placeholderSo: "tusaale: burbur xeebeed oo qadiimi ah",
  },
  {
    kind: "choice",
    key: "buriedInGround",
    titleEn: "Was it buried in the ground?",
    titleSo: "Miyuu dhulka ku aasnaa?",
    options: [
      { value: "fully_buried", en: "Fully buried / dug up", so: "Gebi ahaan way aasnayd / waa la qoday" },
      { value: "partially_buried", en: "Partly buried", so: "Qayb ahaan ayay aasnayd" },
      { value: "surface", en: "Lying on the surface", so: "Dhulka dushiisa ayay saarnayd" },
      { value: "purchased_or_inherited", en: "Purchased / inherited (not found)", so: "La iibsaday / la dhaxlay (lama helin)" },
      { value: "not_sure", en: "Not sure", so: "Ma hubo" },
    ],
  },
  {
    kind: "choice",
    key: "foundWithOtherObjects",
    titleEn: "Was it found together with other objects?",
    titleSo: "Ma la socday shay kale markii la helay?",
    subtitleEn: "e.g. other fragments, bones, coins, pottery nearby.",
    subtitleSo: "tusaale: burburro kale, lafo, qadaadiic, dheryo agteeda ah.",
    options: [
      { value: "yes", en: "Yes", so: "Haa" },
      { value: "no", en: "No", so: "Maya" },
      { value: "not_sure", en: "Not sure", so: "Ma hubo" },
    ],
  },
  {
    kind: "text",
    key: "otherObjectsNote",
    titleEn: "What else was found nearby? (optional)",
    titleSo: "Maxaa kale oo agteeda laga helay? (ikhtiyaari)",
    placeholderEn: "e.g. pottery pieces and bones",
    placeholderSo: "tusaale: burburro dhery iyo lafo",
  },
  {
    kind: "choice",
    key: "cleaned",
    titleEn: "Has it been cleaned?",
    titleSo: "Ma la nadiifiyey?",
    subtitleEn: "Cleaning can remove important evidence — tell us honestly.",
    subtitleSo: "Nadiifintu waxay ka saari kartaa caddayn muhiim ah — si daacad ah noo sheeg.",
    options: [
      { value: "heavily_cleaned", en: "Yes, cleaned/scrubbed a lot", so: "Haa, aad baa loo nadiifiyey/xoqay" },
      { value: "lightly_cleaned", en: "Lightly wiped", so: "Wax yar ayaa la tirtiray" },
      { value: "not_cleaned", en: "No, left as found", so: "Maya, sidii la helay ayay tahay" },
      { value: "not_sure", en: "Not sure", so: "Ma hubo" },
    ],
  },
  {
    kind: "choice",
    key: "material",
    titleEn: "What does it appear to be made of?",
    titleSo: "Muxuu u eg yahay in laga sameeyay?",
    layout: "chips",
    options: [
      { value: "pottery_ceramic", en: "Pottery / ceramic", so: "Dhoobo / fakhaar" },
      { value: "metal", en: "Metal", so: "Bir" },
      { value: "stone", en: "Stone", so: "Dhagax" },
      { value: "bone_ivory", en: "Bone / ivory", so: "Laf / foolmaroodi" },
      { value: "glass", en: "Glass", so: "Muraayad" },
      { value: "wood", en: "Wood", so: "Alwaax / qori" },
      { value: "mixed_other", en: "Mixed / other", so: "Isku dhafan / kale" },
      { value: "unknown", en: "Unknown", so: "Lama oga" },
    ],
  },
  {
    kind: "choice",
    key: "condition",
    titleEn: "Overall condition",
    titleSo: "Xaaladda guud",
    options: [
      { value: "intact", en: "Intact / whole", so: "Dhamaystiran / oo aan jabin" },
      { value: "fragment", en: "A fragment / broken piece", so: "Burbur / gabal jaban" },
      { value: "worn_eroded", en: "Worn / eroded", so: "Duugoobay / nabtay" },
    ],
  },
  {
    kind: "choice",
    key: "hasInscriptions",
    titleEn: "Are there any inscriptions, symbols, or marks?",
    titleSo: "Ma jiraan wax qoraal, astaamo, ama calaamado ah?",
    subtitleEn: "If yes, photograph them clearly in the photo step — we'll try to read them.",
    subtitleSo: "Haddii ay jiraan, si cad ugu sawir tallaabada sawirrada — waan isku dayi doonnaa inaan akhrino.",
    options: [
      { value: "yes", en: "Yes", so: "Haa" },
      { value: "no", en: "No", so: "Maya" },
      { value: "not_sure", en: "Not sure", so: "Ma hubo" },
    ],
  },
  {
    kind: "size",
    titleEn: "Size & Weight (optional)",
    titleSo: "Cabbirka & Miisaanka (ikhtiyaari)",
  },
  {
    kind: "text",
    key: "ageClaim",
    titleEn: "What age do you believe it is? (optional)",
    titleSo: "Immisa jir ayaad u malaynaysaa? (ikhtiyaari)",
    subtitleEn: "What you were told, or your own guess — clearly marked as a claim, not proof.",
    subtitleSo: "Waxa lagu sheegay, ama qiyaastaada — waxaa loo qaadan doonaa sheegasho, ma aha caddayn.",
    placeholderEn: "e.g. said to be very old / hundreds of years",
    placeholderSo: "tusaale: waxaa la yidhi aad bay u duug tahay / boqollaal sano",
  },
  {
    kind: "photos",
    titleEn: "Verification Photos (optional)",
    titleSo: "Sawirro Xaqiijin (ikhtiyaari)",
    subtitleEn:
      "Photograph every side, the front, the back, the base, inside if hollow, any broken areas, and a close-up of any inscription. Include something for scale (a coin or ruler) if you can.",
    subtitleSo:
      "Sawir dhinac kasta, hore, dambe, salka, gudaha haddii uu godan yahay, meelaha jaban, iyo sawir dhow oo qoraal kasta ah. Ku dar shay cabbir muujinaya (qadaadiic ama masatar) haddii aad awoodid.",
  },
  {
    kind: "submit",
    titleEn: "Final Artifact Verification",
    titleSo: "Xaqiijinta Ugu Dambaysa ee Aathaarta",
  },
];

const PHOTO_LABELS: { key: ArtifactVerificationImageLabel; en: string; so: string }[] = [
  { key: "macro", en: "Close-up", so: "Sawir dhow" },
  { key: "front", en: "Front", so: "Hore" },
  { key: "back", en: "Back", so: "Dambe" },
  { key: "base", en: "Base / bottom", so: "Salka / hoose" },
  { key: "inside", en: "Inside", so: "Gudaha" },
  { key: "broken", en: "Broken area", so: "Meel jaban" },
  { key: "inscription", en: "Inscription", so: "Qoraalka" },
  { key: "scale", en: "With scale", so: "Cabbir la socdo" },
];

const RECOMMENDATION_LABELS: Record<string, { en: string; so: string }> = {
  likely_genuine_antiquity: { en: "Likely Genuine Antiquity", so: "Waxay u badan tahay Aathaar Dhab ah" },
  likely_historical_but_common: { en: "Likely Historical but Common", so: "Taariikhi ah laakiin caadi ah" },
  likely_modern_reproduction: { en: "Likely Modern Reproduction", so: "Waxay u badan tahay Nuqul Casri ah" },
  likely_replica_or_souvenir: { en: "Likely Replica / Souvenir", so: "Waxay u badan tahay Nuqul / Xusuus" },
  likely_natural_object_not_artifact: { en: "Likely a Natural Object (Not an Artifact)", so: "Waxay u badan tahay Shay Dabiici ah (Maaha Aathaar)" },
  cannot_determine: { en: "Cannot Determine", so: "Lama go'aamin karo" },
  needs_professional_examination: { en: "Needs Professional Examination", so: "Waxay u baahan tahay Baaritaan Xirfadeed" },
};

const EVIDENCE_SCORE_BANDS: { min: number; en: string; so: string; color: string }[] = [
  { min: 95, en: "Exceptional evidence", so: "Caddayn aad u fiican", color: colors.success },
  { min: 85, en: "Strong evidence", so: "Caddayn xoog leh", color: colors.success },
  { min: 70, en: "Moderate evidence", so: "Caddayn dhexdhexaad ah", color: colors.gold },
  { min: 50, en: "Limited evidence", so: "Caddayn xaddidan", color: colors.gold },
  { min: 0, en: "Insufficient evidence", so: "Caddayn aan ku filnayn", color: colors.dangerStrong },
];

function evidenceScoreBand(score: number) {
  return EVIDENCE_SCORE_BANDS.find((b) => score >= b.min) ?? EVIDENCE_SCORE_BANDS[EVIDENCE_SCORE_BANDS.length - 1];
}

export default function ArtifactVerificationScreen() {
  const { scanId } = useLocalSearchParams<{ scanId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const L = (en: string, soText: string) => (so ? soText : en);

  const [loadingSession, setLoadingSession] = useState(true);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<ArtifactVerificationAnswers>({});
  const [textDraft, setTextDraft] = useState<Record<string, string>>({});
  const [weightText, setWeightText] = useState("");
  const [sizeText, setSizeText] = useState("");
  const [imagePaths, setImagePaths] = useState<ArtifactVerificationImagePaths>({});
  const [uploadingLabel, setUploadingLabel] = useState<ArtifactVerificationImageLabel | null>(null);
  const [creatingPurchase, setCreatingPurchase] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [purchase, setPurchase] = useState<ArtifactReportPurchase | null>(null);
  const [verdict, setVerdict] = useState<ArtifactVerificationVerdict | null>(null);
  const [verdictGeneratedAt, setVerdictGeneratedAt] = useState<string>(new Date().toISOString());
  const [photoStoragePath, setPhotoStoragePath] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [hasEditedAfterVerdict, setHasEditedAfterVerdict] = useState(false);
  const [reEvaluating, setReEvaluating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!scanId) return;
    (async () => {
      try {
        const sessionData = await startArtifactVerification(scanId);
        setVerificationId(sessionData.id);
        setImagePaths(sessionData.imagePaths);

        const { data: img } = await supabase
          .from("scan_images")
          .select("original_storage_path")
          .eq("scan_id", scanId)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        const path = (img as { original_storage_path?: string } | null)?.original_storage_path;
        if (path) setPhotoStoragePath(path);

        if (sessionData.status === "completed") {
          const [p, v] = await Promise.all([
            getArtifactReportPurchase(sessionData.id),
            getArtifactVerificationVerdict(sessionData.id),
          ]);
          setPurchase(p);
          setAnswers(sessionData.answers);
          hydrateInputs(sessionData.answers);
          if (v) {
            setVerdict(v.verdict);
            setVerdictGeneratedAt(v.createdAt);
          }
          setStepIndex(STEPS.length - 1);
        } else {
          const draft = await getLocalArtifactDraft(scanId);
          const resolvedAnswers = draft?.answers ?? sessionData.answers;
          setAnswers(resolvedAnswers);
          hydrateInputs(resolvedAnswers);
          setStepIndex(Math.min(draft?.stepIndex ?? 0, STEPS.length - 1));

          if (sessionData.status === "submitted") {
            const p = await getArtifactReportPurchase(sessionData.id);
            setPurchase(p);
            if (p?.status === "paid") {
              const v = await getArtifactVerificationVerdict(sessionData.id);
              if (v) {
                setVerdict(v.verdict);
                setVerdictGeneratedAt(v.createdAt);
              }
            }
          }
        }
      } catch (err) {
        setErrorMsg((err as Error).message);
      } finally {
        setLoadingSession(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanId]);

  function hydrateInputs(a: ArtifactVerificationAnswers) {
    setTextDraft({
      foundLocation: a.foundLocation ?? "",
      otherObjectsNote: a.otherObjectsNote ?? "",
      ageClaim: a.ageClaim ?? "",
    });
    if (a.weightValue != null) setWeightText(String(a.weightValue));
    if (a.approxSizeCm != null) setSizeText(String(a.approxSizeCm));
  }

  useEffect(() => {
    if (loadingSession || !verificationId || !scanId || verdict || purchase) return;
    if (stepIndex !== STEPS.length - 1) return;
    (async () => {
      setCreatingPurchase(true);
      setErrorMsg(null);
      try {
        await markArtifactVerificationSubmitted(verificationId);
        const p = await startArtifactReportPurchase(verificationId, scanId);
        setPurchase(p);
        await clearLocalArtifactDraft(scanId);
      } catch (err) {
        setErrorMsg((err as Error).message);
      } finally {
        setCreatingPurchase(false);
      }
    })();
  }, [stepIndex, verificationId, scanId, verdict, purchase, loadingSession]);

  function persist(nextStepIndex: number, nextAnswers: ArtifactVerificationAnswers, nextImagePaths: ArtifactVerificationImagePaths) {
    if (scanId) setLocalArtifactDraft(scanId, { stepIndex: nextStepIndex, answers: nextAnswers }).catch(() => {});
    if (verificationId) saveArtifactVerificationProgress(verificationId, nextAnswers, nextImagePaths).catch(() => {});
  }

  function goNext() {
    const next = Math.min(stepIndex + 1, STEPS.length - 1);
    setStepIndex(next);
    persist(next, answers, imagePaths);
  }
  function goBack() {
    const prev = Math.max(stepIndex - 1, 0);
    setStepIndex(prev);
    persist(prev, answers, imagePaths);
  }

  function setAnswer(key: keyof ArtifactVerificationAnswers, value: string | number | undefined) {
    setAnswers((prev) => {
      const next = { ...prev, [key]: value };
      persist(stepIndex, next, imagePaths);
      return next;
    });
  }

  function onTextChange(key: keyof ArtifactVerificationAnswers, text: string) {
    setTextDraft((prev) => ({ ...prev, [key]: text }));
    setAnswer(key, text.trim() === "" ? undefined : text);
  }

  function onNumberChange(key: "weightValue" | "approxSizeCm", setText: (t: string) => void, text: string) {
    setText(text);
    if (text.trim() === "") {
      setAnswer(key, undefined);
      return;
    }
    const n = Number(text);
    if (Number.isFinite(n)) setAnswer(key, n);
  }

  async function handleCapturePhoto(label: ArtifactVerificationImageLabel) {
    if (!scanId || uploadingLabel) return;
    const result = await ImagePicker.launchCameraAsync({ quality: 1 });
    if (result.canceled || result.assets.length === 0) return;
    setUploadingLabel(label);
    setErrorMsg(null);
    try {
      const path = await uploadArtifactVerificationImage(scanId, label, result.assets[0].uri);
      setImagePaths((prev) => {
        const next = { ...prev, [label]: path };
        persist(stepIndex, answers, next);
        return next;
      });
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setUploadingLabel(null);
    }
  }

  function handlePay() {
    if (!purchase) return;
    Linking.openURL(buildArtifactReportPaymentUrl(purchase.id)).catch(() => {});
  }

  async function handleCheckPaymentStatus() {
    if (!verificationId) return;
    setCheckingStatus(true);
    setErrorMsg(null);
    try {
      const p = await getArtifactReportPurchase(verificationId);
      if (p) setPurchase(p);
      if (p?.status === "paid") {
        const v = await getArtifactVerificationVerdict(verificationId);
        if (v) {
          setVerdict(v.verdict);
          setVerdictGeneratedAt(v.createdAt);
        }
      }
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setCheckingStatus(false);
    }
  }

  async function handleDownloadPdf() {
    if (!verdict || !verificationId) return;
    setPdfBusy(true);
    setErrorMsg(null);
    try {
      let freshPhotoUri: string | null = null;
      if (photoStoragePath) {
        const { data: signed } = await supabase.storage
          .from("scan-images")
          .createSignedUrl(photoStoragePath, 3600);
        freshPhotoUri = signed?.signedUrl ?? null;
      }
      const rec = RECOMMENDATION_LABELS[verdict.recommendation] ?? RECOMMENDATION_LABELS.cannot_determine;
      await generateAndShareArtifactVerificationPdf(
        {
          scanId,
          verificationId,
          generatedAt: verdictGeneratedAt,
          photoUri: freshPhotoUri,
          verdict,
          recommendationLabel: L(rec.en, rec.so),
        },
        so ? "so" : "en",
      );
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setPdfBusy(false);
    }
  }

  function handleEditAnswers() {
    setVerdict(null);
    setHasEditedAfterVerdict(true);
    setStepIndex(0);
  }

  async function handleReEvaluate() {
    if (!verificationId) return;
    setReEvaluating(true);
    setErrorMsg(null);
    try {
      const v = await requestArtifactReEvaluation(verificationId);
      setVerdict(v);
      setVerdictGeneratedAt(new Date().toISOString());
      setHasEditedAfterVerdict(false);
    } catch (err) {
      const message = (err as Error).message;
      setErrorMsg(
        message.toLowerCase().includes("evaluation limit reached")
          ? L(
              "You've used all 3 included evaluations for this report.",
              "Waxaad isticmaashay dhammaan 3-da qiimayn ee ku jira warbixintan.",
            )
          : message,
      );
    } finally {
      setReEvaluating(false);
    }
  }

  if (loadingSession) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.gold} size="large" />
      </View>
    );
  }

  const step = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  return (
    <ScrollView contentContainerStyle={[styles.container, { paddingBottom: 32 + insets.bottom }]}>
      <Text style={styles.progressText}>
        {L(`Step ${stepIndex + 1} of ${STEPS.length}`, `Tallaabo ${stepIndex + 1} ee ${STEPS.length}`)}
      </Text>

      {step.kind === "choice" && (
        <Card style={styles.stepCard}>
          <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
          {step.subtitleEn && <Text style={styles.stepSubtitle}>{L(step.subtitleEn, step.subtitleSo!)}</Text>}
          <ChoiceGroup
            layout={step.layout}
            options={step.options.map((o) => ({ value: o.value, label: L(o.en, o.so) }))}
            value={answers[step.key] as string | undefined}
            onChange={(v) => setAnswer(step.key, v)}
          />
        </Card>
      )}

      {step.kind === "text" && (
        <Card style={styles.stepCard}>
          <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
          {step.subtitleEn && <Text style={styles.stepSubtitle}>{L(step.subtitleEn, step.subtitleSo!)}</Text>}
          <TextInput
            style={styles.textInput}
            placeholder={L(step.placeholderEn, step.placeholderSo)}
            placeholderTextColor={colors.textFaint}
            value={textDraft[step.key] ?? ""}
            onChangeText={(t) => onTextChange(step.key, t)}
            multiline
          />
        </Card>
      )}

      {step.kind === "size" && (
        <Card style={styles.stepCard}>
          <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
          <Text style={styles.stepSubtitle}>
            {L("Roughly how big and how heavy is it?", "Qiyaastii intee le'eg yahay oo culeyskiisu maxay yahay?")}
          </Text>
          <TextInput
            style={styles.textInput}
            keyboardType="decimal-pad"
            placeholder={L("Largest size (cm)", "Cabbirka ugu weyn (cm)")}
            placeholderTextColor={colors.textFaint}
            value={sizeText}
            onChangeText={(t) => onNumberChange("approxSizeCm", setSizeText, t)}
          />
          <TextInput
            style={styles.textInput}
            keyboardType="decimal-pad"
            placeholder={L("Weight", "Miisaanka")}
            placeholderTextColor={colors.textFaint}
            value={weightText}
            onChangeText={(t) => onNumberChange("weightValue", setWeightText, t)}
          />
          <ChoiceGroup
            layout="chips"
            options={[
              { value: "grams", label: L("grams", "Garaam") },
              { value: "kilograms", label: L("kilograms", "Kiilo") },
            ]}
            value={answers.weightUnit ?? "grams"}
            onChange={(v) => setAnswer("weightUnit", v)}
          />
        </Card>
      )}

      {step.kind === "photos" && (
        <Card style={styles.stepCard}>
          <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
          {step.subtitleEn && <Text style={styles.stepSubtitle}>{L(step.subtitleEn, step.subtitleSo!)}</Text>}
          {errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
          <View style={styles.photoGrid}>
            {PHOTO_LABELS.map(({ key, en, so: soLabel }) => (
              <Pressable
                key={key}
                style={styles.photoTile}
                onPress={() => handleCapturePhoto(key)}
                disabled={uploadingLabel !== null}
                accessibilityRole="button"
              >
                {uploadingLabel === key ? (
                  <ActivityIndicator color={colors.gold} />
                ) : imagePaths[key] ? (
                  <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                ) : (
                  <Ionicons name="camera-outline" size={22} color={colors.textFaint} />
                )}
                <Text style={styles.photoLabel}>{L(en, soLabel)}</Text>
              </Pressable>
            ))}
          </View>
        </Card>
      )}

      {step.kind === "submit" &&
        (verdict ? (
          <View style={{ gap: spacing.md }}>
            <ArtifactVerdictDisplay verdict={verdict} L={L} />
            {errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
            <Button
              title={L("Edit Answers", "Wax ka beddel Jawaabaha")}
              variant="outline"
              icon={<Ionicons name="create-outline" size={18} color={colors.gold} />}
              onPress={handleEditAnswers}
            />
            <Text style={styles.disclaimer}>
              {L(
                "Made a mistake? Edit any answer and get an updated evaluation — free, since you've already paid for this report. Up to 3 evaluations total per report.",
                "Khalad ma samaysay? Wax ka beddel jawaab kasta oo hel qiimayn cusub — bilaash ah, maadaama aad horeyba u bixisay warbixintan. Ugu badnaan 3 qiimayn oo warbixintan ah.",
              )}
            </Text>
            <Button
              title={L("Download / Share PDF Report", "Soo deji / Wadaag Warbixin PDF")}
              variant="outline"
              icon={<Ionicons name="document-text-outline" size={18} color={colors.gold} />}
              onPress={handleDownloadPdf}
              loading={pdfBusy}
            />
            <Text style={styles.disclaimer}>
              {L(
                "Tip: to download it, choose \"Save to Files\" (iOS) or \"Save\"/\"Download\" (Android) in the share menu that opens.",
                "Tallo: si aad u soo dejiso, dooro \"Save to Files\" (iOS) ama \"Save\"/\"Download\" (Android) menu-ga wadaagida oo furma.",
              )}
            </Text>
          </View>
        ) : creatingPurchase || !purchase ? (
          <Card style={styles.stepCard}>
            <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
            <ActivityIndicator color={colors.gold} />
            {errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
          </Card>
        ) : purchase.status === "paid" && hasEditedAfterVerdict ? (
          <Card style={styles.stepCard}>
            <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
            <Text style={styles.stepSubtitle}>
              {L(
                "We'll re-run the evaluation with your updated answers — free, no additional payment.",
                "Waxaan dib u samayn doonaa qiimaynta ee leh jawaabahaaga cusub — bilaash, lacag dheeraad ah lama rabo.",
              )}
            </Text>
            {errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
            <Button
              title={L("Get Updated Evaluation", "Hel Qiimaynta Cusub")}
              variant="primary"
              loading={reEvaluating}
              onPress={handleReEvaluate}
            />
          </Card>
        ) : purchase.status === "paid" ? (
          <Card style={styles.stepCard}>
            <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
            <View style={styles.processingRow}>
              <ActivityIndicator color={colors.gold} />
              <Text style={styles.stepSubtitle}>
                {L(
                  "Payment confirmed — preparing your artifact verification report…",
                  "Lacag-bixinta waa la xaqiijiyay — waxaan diyaarinaynaa warbixintaada xaqiijinta aathaarta…",
                )}
              </Text>
            </View>
            {errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
            <Button
              title={L("Check again", "Mar kale hubi")}
              variant="outline"
              loading={checkingStatus}
              onPress={handleCheckPaymentStatus}
            />
          </Card>
        ) : (
          <ArtifactPaywallCard
            titleEn={step.titleEn}
            titleSo={step.titleSo}
            L={L}
            checkingStatus={checkingStatus}
            errorMsg={errorMsg}
            onPay={handlePay}
            onCheckStatus={handleCheckPaymentStatus}
          />
        ))}

      {!verdict && (
        <View style={styles.navRow}>
          <Button title={L("Back", "Dib")} variant="outline" onPress={goBack} disabled={isFirst} style={{ flex: 1 }} />
          {!isLast && (
            <Button title={L("Next", "Xiga")} variant="primary" onPress={goNext} style={{ flex: 1 }} />
          )}
        </View>
      )}

      {verdict && (
        <Button
          title={L("Back to Results", "Ku noqo Natiijada")}
          variant="outline"
          onPress={() => router.back()}
          style={{ marginTop: spacing.lg }}
        />
      )}
    </ScrollView>
  );
}

// $5 Artifact Verification Report paywall. Buttons only ever open the LuulScan
// website (Linking.openURL) — no in-app charge; EXTERNAL_PURCHASES_ENABLED
// hides the CTA on iOS (App Store Guideline 3.1.1).
function ArtifactPaywallCard({
  titleEn,
  titleSo,
  L,
  checkingStatus,
  errorMsg,
  onPay,
  onCheckStatus,
}: {
  titleEn: string;
  titleSo: string;
  L: (en: string, so: string) => string;
  checkingStatus: boolean;
  errorMsg: string | null;
  onPay: () => void;
  onCheckStatus: () => void;
}) {
  return (
    <Card accent style={styles.stepCard}>
      <Text style={styles.stepTitle}>{L(titleEn, titleSo)}</Text>
      <Text style={styles.stepSubtitle}>
        {L(
          "This item appears to warrant a full Artifact Verification Report.",
          "Shaygan wuxuu u muuqdaa mid u baahan Warbixin Xaqiijin Aathaar oo dhamaystiran.",
        )}
      </Text>
      <Text style={styles.body}>
        {L(
          "We'll combine your original scan with everything you just answered for one final evaluation — evidence score, identification, likely era and culture, authenticity assessment, inscription reading, supporting and conflicting evidence, recommended next steps, and a downloadable PDF.",
          "Waxaan isku dari doonaa baaritaankii hore, jawaabahaaga, iyo dhammaan xogta aad bixisay si aan kuu siino qiimayn kama dambays ah — dhibcaha caddaynta, aqoonsiga, xilliga iyo dhaqanka suurtagalka ah, qiimaynta runnimada, akhrinta qoraalka, caddaynta taageeraysa iyo ka soo horjeedda, tallaabooyinka xiga, iyo warbixin PDF ah oo la soo dejin karo.",
        )}
      </Text>

      {errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}

      {!EXTERNAL_PURCHASES_ENABLED ? (
        <Text style={styles.disclaimer}>
          {L(
            "This report isn't available for purchase in this version of the app.",
            "Warbixintan lama heli karo iibsiga ee nooca app-kan.",
          )}
        </Text>
      ) : (
        <>
          <Button
            title={L("Open the report on the website", "Fur warbixinta website-ka")}
            variant="primary"
            icon={<Ionicons name="open-outline" size={18} color="#0B0B0C" />}
            onPress={() => onPay()}
          />
          <Button
            title={L("I've paid — check status", "Waan bixiyay — hubi xaaladda")}
            variant="outline"
            loading={checkingStatus}
            onPress={onCheckStatus}
          />
        </>
      )}
    </Card>
  );
}

function ArtifactVerdictDisplay({
  verdict,
  L,
}: {
  verdict: ArtifactVerificationVerdict;
  L: (en: string, so: string) => string;
}) {
  const rec = RECOMMENDATION_LABELS[verdict.recommendation] ?? RECOMMENDATION_LABELS.cannot_determine;
  const band = verdict.confidence >= 0.72 ? "high" : verdict.confidence >= 0.45 ? "medium" : "low";
  const evidenceBand = evidenceScoreBand(verdict.evidenceScore);

  return (
    <View style={{ gap: spacing.md }}>
      <Card accent style={styles.stepCard}>
        <Text style={styles.label}>{L("Evidence Score", "Dhibcaha Caddaynta")}</Text>
        <View style={styles.evidenceScoreRow}>
          <Text style={[styles.evidenceScoreValue, { color: evidenceBand.color }]}>
            {verdict.evidenceScore} / 100
          </Text>
          <Text style={[styles.evidenceScoreBand, { color: evidenceBand.color }]}>
            {L(evidenceBand.en, evidenceBand.so)}
          </Text>
        </View>
        <Text style={styles.disclaimer}>
          {L(
            "This is not identification confidence — it reflects how strong and thorough the evidence you provided is (find context, photos, and how consistent they are).",
            "Tani maaha kalsoonida aqoonsiga — waxay muujinaysaa intay u xoog badan tahay caddaynta aad bixisay (xaalka la helay, sawirrada, iyo sida ay isu waafaqsan yihiin).",
          )}
        </Text>
      </Card>

      <Card accent style={styles.stepCard}>
        <Text style={styles.label}>{L("Possible Identification", "Aqoonsiga Suurtagalka ah")}</Text>
        <Text style={styles.verdictTitle}>{verdict.finalIdentification}</Text>
        <ConfidenceBadge pct={verdict.confidence * 100} band={band} size="lg" />
        {!!verdict.probability && <Text style={styles.stepSubtitle}>{verdict.probability}</Text>}
        {!!verdict.reasoning && <Text style={styles.body}>{verdict.reasoning}</Text>}
      </Card>

      <View style={styles.recommendationPill}>
        <Text style={styles.recommendationText}>{L(rec.en, rec.so)}</Text>
      </View>

      {(!!verdict.estimatedEra || !!verdict.estimatedCulture) && (
        <Card style={styles.stepCard}>
          <Text style={styles.sectionTitle}>{L("Likely Era & Culture", "Xilliga & Dhaqanka Suurtagalka")}</Text>
          {!!verdict.estimatedEra && (
            <Text style={styles.body}>
              {L("Era", "Xilliga")}: {verdict.estimatedEra}
            </Text>
          )}
          {!!verdict.estimatedCulture && (
            <Text style={styles.body}>
              {L("Culture", "Dhaqanka")}: {verdict.estimatedCulture}
            </Text>
          )}
        </Card>
      )}

      {!!verdict.inscriptionReading && (
        <Card style={styles.stepCard}>
          <Text style={styles.sectionTitle}>{L("Inscription Reading", "Akhrinta Qoraalka")}</Text>
          <Text style={styles.body}>{verdict.inscriptionReading}</Text>
        </Card>
      )}

      {verdict.supportingEvidence.length > 0 && (
        <Card style={styles.stepCard}>
          <Text style={styles.sectionTitle}>
            {L("Evidence Supporting This Identification", "Caddaynta Taageerta Aqoonsigan")}
          </Text>
          {verdict.supportingEvidence.map((e, i) => (
            <Text key={i} style={styles.bullet}>
              ✓ {e}
            </Text>
          ))}
        </Card>
      )}

      <Card style={styles.stepCard}>
        <Text style={styles.sectionTitle}>
          {L("Evidence Against This Identification", "Caddaynta Ka Soo Horjeedda Aqoonsigan")}
        </Text>
        {verdict.conflictingEvidence.length > 0 ? (
          verdict.conflictingEvidence.map((e, i) => (
            <Text key={i} style={[styles.bullet, { color: colors.dangerStrong }]}>
              ⚠ {e}
            </Text>
          ))
        ) : (
          <Text style={styles.bullet}>
            {L(
              "No significant conflicting evidence was identified.",
              "Ma jirto caddayn muhiim ah oo ka soo horjeedda oo la helay.",
            )}
          </Text>
        )}
      </Card>

      {verdict.mostLikelyAlternatives.length > 0 && (
        <Card style={styles.stepCard}>
          <Text style={styles.sectionTitle}>{L("Most Likely Alternatives", "Ikhtiyaarrada Ugu Suurtagalsan")}</Text>
          {verdict.mostLikelyAlternatives.map((a, i) => (
            <View key={i} style={{ gap: 1 }}>
              <Text style={styles.altLabel}>{a.label}</Text>
              {!!a.note && <Text style={styles.bodySmall}>{a.note}</Text>}
            </View>
          ))}
        </Card>
      )}

      {verdict.recommendedNextSteps.length > 0 && (
        <Card style={styles.stepCard}>
          <Text style={styles.sectionTitle}>{L("Recommended Next Steps", "Tallaabooyinka Xiga ee la Talinayo")}</Text>
          {verdict.recommendedNextSteps.map((stepName, i) => (
            <View key={i} style={styles.testRow}>
              <Ionicons name="arrow-forward-circle-outline" size={15} color={colors.gold} />
              <Text style={styles.bullet}>{stepName}</Text>
            </View>
          ))}
        </Card>
      )}

      {!!verdict.estimatedMarketValue && (
        <Card style={styles.stepCard}>
          <Text style={styles.sectionTitle}>{L("Estimated Value", "Qiimaha (Qiyaas)")}</Text>
          <Text style={styles.body}>{verdict.estimatedMarketValue}</Text>
          <Text style={styles.disclaimer}>
            {L("Qualitative estimate only — not a professional appraisal.", "Qiyaas guud kaliya — maaha qiimayn xirfadeed.")}
          </Text>
        </Card>
      )}

      {/* Cultural-heritage / legal caution — always shown, prominently. */}
      <Card accent style={styles.heritageCard}>
        <View style={styles.verifyHeader}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.gold} />
          <Text style={styles.sectionTitle}>{L("Heritage & Legal Notice", "Ogeysiis Hidaha & Sharci")}</Text>
        </View>
        <Text style={styles.body}>{verdict.heritageLegalNote}</Text>
      </Card>

      {verdict.professionalExaminationRecommended && (
        <Card accent style={styles.stepCard}>
          <View style={styles.verifyHeader}>
            <Ionicons name="school-outline" size={18} color={colors.gold} />
            <Text style={styles.sectionTitle}>{L("Professional Examination Recommended", "Baaritaan Xirfadeed ayaa lagula talinayaa")}</Text>
          </View>
          <Text style={styles.body}>
            {verdict.professionalExaminationNote ||
              L(
                "This is not a substitute for hands-on examination by a museum or archaeologist. This report is never an official certificate.",
                "Tani maaha beddel baaritaan gacan oo matxaf ama cilmi-baare qadiimi ah sameeyo. Warbixintani waligeed maaha shahaado rasmi ah.",
              )}
          </Text>
        </Card>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: colors.bg, padding: spacing.xl, gap: spacing.md },
  centered: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  progressText: { ...typo.label, textAlign: "center" },
  stepCard: { gap: spacing.sm },
  heritageCard: { gap: spacing.sm, borderColor: colors.goldBorder },
  stepTitle: { ...typo.heading },
  stepSubtitle: { ...typo.bodySmall },
  processingRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  body: { ...typo.body },
  bodySmall: { ...typo.bodySmall },
  textInput: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    color: colors.text,
    fontSize: 16,
    minHeight: 48,
  },
  photoGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  photoTile: {
    width: "31%",
    aspectRatio: 1,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: spacing.sm,
  },
  photoLabel: { color: colors.textFaint, fontSize: 11, textAlign: "center" },
  navRow: { flexDirection: "row", gap: spacing.md, marginTop: spacing.lg },
  errorText: { color: colors.dangerStrong, fontSize: 13 },
  label: { ...typo.label },
  verdictTitle: { fontSize: 24, fontWeight: "800", color: colors.text },
  sectionTitle: { ...typo.subheading },
  bullet: { color: colors.textMuted, fontSize: 13.5, lineHeight: 20 },
  altLabel: { color: colors.text, fontWeight: "700", fontSize: 14 },
  disclaimer: { fontSize: 11.5, color: colors.textFaint, marginTop: 2 },
  recommendationPill: {
    alignSelf: "center",
    backgroundColor: colors.goldSoft,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
  },
  recommendationText: { color: colors.gold, fontWeight: "800", fontSize: 14 },
  verifyHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  evidenceScoreRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  evidenceScoreValue: { fontSize: 30, fontWeight: "900" },
  evidenceScoreBand: { fontSize: 14, fontWeight: "700" },
  testRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
});

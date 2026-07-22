// Gold Verification wizard — a second, OPTIONAL stage offered from
// results.tsx's "Gold Verification" card. Collects a structured
// questionnaire (origin, magnet, density, scratch/streak/malleability,
// acid/XRF test results, claimed karat) plus a few extra photos. The
// questionnaire itself stays free; the final verdict (evidence score,
// identification, supporting/conflicting evidence, PDF) is a $5 premium
// report gated behind a paywall — see GoldPaywallCard below. The single
// additional AI call (verify-gold-value) is DEFERRED until a payment webhook
// marks the purchase 'paid' (supabase/functions/gold-report-webhook); this
// screen never calls it directly. Never reruns or replaces the original scan.
//
// Mirrors app/(app)/scan/verify.tsx (Advanced Diamond Verification)
// structurally, but is NOT a shared/parametrized component — kept as its own
// file against its own tables, matching this codebase's convention of
// isolating verification features from each other.
import React, { useEffect, useMemo, useState } from "react";
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
  startGoldVerification,
  saveGoldVerificationProgress,
  uploadGoldVerificationImage,
  markGoldVerificationSubmitted,
  startGoldReportPurchase,
  getGoldReportPurchase,
  getGoldVerificationVerdict,
  requestGoldReEvaluation,
  getLocalGoldDraft,
  setLocalGoldDraft,
  clearLocalGoldDraft,
  estimateDensityGramsPerCm3,
  type GoldVerificationAnswers,
  type GoldVerificationImagePaths,
  type GoldVerificationImageLabel,
  type GoldVerificationVerdict,
  type GoldReportPurchase,
} from "../../../lib/goldVerification";
import { EXTERNAL_PURCHASES_ENABLED, buildGoldReportPaymentUrl } from "../../../lib/appLinks";
import { generateAndShareGoldVerificationPdf } from "../../../lib/goldVerificationPdfReport";
import { supabase } from "../../../lib/supabase";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { ConfidenceBadge } from "../../../components/ui/ConfidenceBadge";
import { ChoiceGroup } from "../../../components/ui/ChoiceGroup";
import { colors, spacing, radius, type as typo } from "../../../lib/theme";

type Opt = { value: string; en: string; so: string };

const YES_NO_NA: Opt[] = [
  { value: "yes", en: "Yes", so: "Haa" },
  { value: "no", en: "No", so: "Maya" },
  { value: "not_tested", en: "Haven't tested", so: "Ma aanan tijaabin" },
];

type ChoiceStepDef = {
  kind: "choice";
  key: keyof GoldVerificationAnswers;
  titleEn: string;
  titleSo: string;
  subtitleEn?: string;
  subtitleSo?: string;
  options: Opt[];
  layout?: "list" | "chips";
};
type DensityStepDef = { kind: "density"; titleEn: string; titleSo: string };
type TextStepDef = {
  kind: "text";
  key: keyof GoldVerificationAnswers;
  titleEn: string;
  titleSo: string;
  subtitleEn?: string;
  subtitleSo?: string;
};
type PhotosStepDef = { kind: "photos"; titleEn: string; titleSo: string; subtitleEn?: string; subtitleSo?: string };
type SubmitStepDef = { kind: "submit"; titleEn: string; titleSo: string };
type StepDef = ChoiceStepDef | DensityStepDef | TextStepDef | PhotosStepDef | SubmitStepDef;

// STEPS is a function of the answers so far, not a static array: the
// "how obtained" question (step 0) branches the rest of the questionnaire —
// a natural find gets the found-location question, a purchased/inherited/
// unknown item gets the acid/XRF jewelry-testing questions instead.
function buildGoldSteps(answers: GoldVerificationAnswers): StepDef[] {
  const steps: StepDef[] = [
    {
      kind: "choice",
      key: "origin",
      titleEn: "How did you obtain this item?",
      titleSo: "Sidee ku heshay shaygan?",
      options: [
        { value: "found_naturally", en: "Found naturally (in the ground, a river, etc.)", so: "Dabiici ahaan ayaan u helay (dhulka, webiga, iwm.)" },
        { value: "purchased", en: "Purchased", so: "Waan soo iibsaday" },
        { value: "inherited", en: "Inherited or gifted", so: "Waan dhaxlay ama hadiyad ayaa la ii siiyay" },
        { value: "unknown", en: "Not sure", so: "Ma hubo" },
      ],
    },
  ];

  if (answers.origin === "found_naturally") {
    steps.push({
      kind: "choice",
      key: "foundLocation",
      titleEn: "Where exactly was it found?",
      titleSo: "Xaggee si sax ah looga helay?",
      options: [
        { value: "river_sediment", en: "River/stream sediment", so: "Ciidda webiga ama durdurka" },
        { value: "soil", en: "Dry soil", so: "Carro qallalan" },
        { value: "quartz_vein", en: "Inside a quartz vein", so: "Gudaha xidid quartz ah" },
        { value: "extracted_from_rock", en: "Broken out of solid rock", so: "Waxaa laga jebiyay dhagax adag" },
      ],
    });
  }

  steps.push(
    {
      kind: "choice",
      key: "magnetAttracts",
      titleEn: "Does a magnet attract it?",
      titleSo: "Miyuu magnetku soo jiitaa?",
      subtitleEn: "Real gold is never magnetic.",
      subtitleSo: "Dahabka saafi ah magnetku ma soo jiito.",
      options: [
        { value: "yes", en: "Yes, attracted", so: "Haa, wuu soo jiitaa" },
        { value: "no", en: "No, not at all", so: "Maya, haba yaraatee ma soo jiito" },
        { value: "not_tested", en: "Haven't tested", so: "Ma aanan tijaabin" },
      ],
    },
    {
      kind: "density",
      titleEn: "Weight & Size",
      titleSo: "Miisaanka iyo Cabbirka",
    },
    {
      kind: "choice",
      key: "scratchesEasily",
      titleEn: "Does it scratch easily with a fingernail/coin?",
      titleSo: "Ma si fudud ayuu ugu xoqmaa ciddi ama lacag bir ah?",
      options: [
        { value: "yes", en: "Yes, easily (soft)", so: "Haa, si fudud ayuu u xoqmaa" },
        { value: "no", en: "No, hard to scratch", so: "Maya, way adag tahay in la xoqo" },
        { value: "not_tested", en: "Haven't tested", so: "Ma aanan tijaabin" },
      ],
    },
    {
      kind: "choice",
      key: "streakColor",
      titleEn: "What color streak does it leave on unglazed tile?",
      titleSo: "Midabkee ayuu uga tagaa xariiqda marka lagu xoqo dhoobo aan la dahaadhin?",
      subtitleEn:
        "Pyrite usually leaves a black or greenish-yellow streak, while real gold usually leaves a yellow-gold streak.",
      subtitleSo:
        "Pyrite badanaa wuxuu reebaa xariiq madow ama jaalle cagaar u janjeedha, halka dahabka dhabta ahi badanaa reebo xariiq jaalle dahabi ah.",
      options: [
        { value: "yellow_gold", en: "Yellow-gold", so: "Jaalle dahabi ah" },
        { value: "greenish_yellow", en: "Greenish-yellow", so: "Jaalle cagaar u janjeedha" },
        { value: "black", en: "Black", so: "Madow" },
        { value: "gray", en: "Gray", so: "Cawl" },
        { value: "not_tested", en: "Haven't tested", so: "Ma aanan tijaabin" },
      ],
    },
    {
      kind: "choice",
      key: "colorConsistentUnderLight",
      titleEn: "Does the color stay the same in sunlight vs. indoor light?",
      titleSo: "Midabku ma isku mid ayuu ahaanayaa iftiinka qorraxda iyo kan gudaha?",
      options: [
        { value: "yes", en: "Yes", so: "Haa" },
        { value: "no", en: "No", so: "Maya" },
        { value: "not_sure", en: "Not sure", so: "Ma hubo" },
      ],
    },
    {
      kind: "choice",
      key: "malleableOrBrittle",
      titleEn: "Does it dent/flatten (soft) or crack/break (brittle) if pressed?",
      titleSo: "Marka la cadaadiyo, ma fidsamaa oo godloobaa mise wuu dildilaacaa ama jabaa?",
      options: [
        { value: "flattens_or_dents", en: "Flattens/dents", so: "Wuu fidsamaa ama godloobaa" },
        { value: "breaks_or_shatters", en: "Cracks/breaks", so: "Wuu dildilaacaa ama jabaa" },
        { value: "not_tested", en: "Haven't tested", so: "Ma aanan tijaabin" },
      ],
    },
  );

  if (answers.origin !== "found_naturally") {
    steps.push(
      {
        kind: "choice",
        key: "acidTestResult",
        titleEn: "Acid Test Result",
        titleSo: "Natiijada Tijaabada Aashitada",
        subtitleEn: "If a jeweler or expert performed an acid test, choose the matching result.",
        subtitleSo: "Haddii dahable ama khabiir uu ku sameeyay tijaabada aashitada, dooro natiijada ku habboon.",
        options: [
          { value: "not_done", en: "Not done", so: "Lama samayn" },
          { value: "no_reaction_passed", en: "Tested, no reaction (passed)", so: "Waa la tijaabiyay, wax falcelin ah ma jirin" },
          { value: "reacted_failed", en: "Tested, reacted (failed)", so: "Waa la tijaabiyay, falcelin ayaa dhacday" },
        ],
      },
      {
        kind: "choice",
        key: "xrfTestDone",
        titleEn: "Have you had an XRF or certified assay done?",
        titleSo: "Ma lagugu sameeyay baaritaan XRF ama qiimayn rasmi ah oo shaybaar?",
        options: [
          { value: "yes", en: "Yes, with report", so: "Haa, waxaana hayaa warbixinta" },
          { value: "no", en: "No", so: "Maya" },
          { value: "not_available", en: "Not available to me", so: "Fursad uma helin" },
        ],
      },
    );
  }

  steps.push(
    {
      kind: "text",
      key: "claimedKarat",
      titleEn: "Stamped markings (750, 18K, 916 if visible)",
      titleSo: "Qor calaamadaha ku qoran haddii ay muuqdaan (tusaale: 750, 18K, 916)",
      subtitleEn: "The system will also try to read this automatically from your photos if visible.",
      subtitleSo: "Nidaamku sidoo kale si toos ah ayuu uga akhrin karaa sawirka haddii calaamaduhu muuqdaan.",
    },
    {
      kind: "photos",
      titleEn: "Verification Photos (optional)",
      titleSo: "Sawirro Xaqiijin (ikhtiyaari)",
      subtitleEn:
        "Add close-up photos from different angles — top, bottom, edges, a flash photo, wet if useful — and a photo of your XRF/lab report if you have one.",
      subtitleSo:
        "Soo geli sawirro dhow (macro), dhinacyada kala duwan, korka, hoose, geesaha, sawir flash leh, sawir qoyan (haddii ku habboon), iyo haddii aad hayso sawirka warbixinta XRF ama shaybaarka.",
    },
    {
      kind: "submit",
      titleEn: "Final Gold Verification",
      titleSo: "Xaqiijinta Ugu Dambaysa ee Dahabka",
    },
  );

  return steps;
}

const PHOTO_LABELS: { key: GoldVerificationImageLabel; en: string; so: string }[] = [
  { key: "macro", en: "Macro", so: "Sawir dhow (Macro)" },
  { key: "side", en: "Side", so: "Dhinaca" },
  { key: "top", en: "Top", so: "Dusha sare" },
  { key: "bottom", en: "Bottom", so: "Hoosta" },
  { key: "edge", en: "Edge", so: "Geeska" },
  { key: "flash", en: "Flash photo", so: "Sawir Flash ah" },
  { key: "wet", en: "Wet (optional)", so: "Sawir qoyan (ikhtiyaari)" },
  { key: "xrfReport", en: "XRF / lab report", so: "Warbixinta XRF/Shaybaarka" },
];

const RECOMMENDATION_LABELS: Record<string, { en: string; so: string }> = {
  likely_natural_gold: { en: "Likely Natural Gold", so: "Waxay u badan tahay Dahab Dabiici ah" },
  likely_gold_bearing_rock: { en: "Likely Gold-Bearing Rock", so: "Waxay u badan tahay Dhagax Dahab Sita" },
  likely_jewelry_gold: { en: "Likely Genuine Jewelry Gold", so: "Waxay u badan tahay Dahab Dhab ah oo Jowharad ah" },
  likely_gold_plated: { en: "Likely Gold-Plated", so: "Waxay u badan tahay Dahab la Dabaqay (Plated)" },
  likely_pyrite_or_fools_gold: { en: "Likely Pyrite (Fool's Gold)", so: "Waxay u badan tahay Pyrite (Dahabka Nacaska)" },
  likely_brass_or_base_metal: { en: "Likely Brass or Base Metal", so: "Waxay u badan tahay Naxaas ama Bir Kale" },
  cannot_determine: { en: "Cannot Determine", so: "Lama go'aamin karo" },
  needs_professional_testing: { en: "Needs Professional Testing", so: "Waxay u baahan tahay Baaritaan Xirfadeed" },
};

// Evidence Score qualitative bands — same thresholds as verify.tsx's
// EVIDENCE_SCORE_BANDS, duplicated deliberately (own file, own tables).
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

export default function GoldVerificationScreen() {
  const { scanId } = useLocalSearchParams<{ scanId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const L = (en: string, soText: string) => (so ? soText : en);

  const [loadingSession, setLoadingSession] = useState(true);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<GoldVerificationAnswers>({});
  const [weightText, setWeightText] = useState("");
  const [lengthText, setLengthText] = useState("");
  const [widthText, setWidthText] = useState("");
  const [heightText, setHeightText] = useState("");
  const [karatText, setKaratText] = useState("");
  const [imagePaths, setImagePaths] = useState<GoldVerificationImagePaths>({});
  const [uploadingLabel, setUploadingLabel] = useState<GoldVerificationImageLabel | null>(null);
  const [creatingPurchase, setCreatingPurchase] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [purchase, setPurchase] = useState<GoldReportPurchase | null>(null);
  const [verdict, setVerdict] = useState<GoldVerificationVerdict | null>(null);
  const [verdictGeneratedAt, setVerdictGeneratedAt] = useState<string>(new Date().toISOString());
  const [photoStoragePath, setPhotoStoragePath] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  // True once the user taps "Edit Answers" on an already-paid report — marks
  // that the next time the submit step has no verdict, it should actively
  // request a fresh (free) evaluation rather than passively wait on the
  // payment webhook (which only ever runs once, for the first payment).
  const [hasEditedAfterVerdict, setHasEditedAfterVerdict] = useState(false);
  const [reEvaluating, setReEvaluating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const STEPS = useMemo(() => buildGoldSteps(answers), [answers.origin]);
  // Clamp: switching branches (e.g. editing the origin answer after already
  // being deep in the jewelry-only steps) can shrink STEPS out from under
  // the current stepIndex.
  const clampedStepIndex = Math.min(stepIndex, STEPS.length - 1);

  useEffect(() => {
    if (!scanId) return;
    (async () => {
      try {
        const sessionData = await startGoldVerification(scanId);
        setVerificationId(sessionData.id);
        setImagePaths(sessionData.imagePaths);

        // Specimen photo, for the PDF export — same lookup verify.tsx uses.
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
            getGoldReportPurchase(sessionData.id),
            getGoldVerificationVerdict(sessionData.id),
          ]);
          setPurchase(p);
          setAnswers(sessionData.answers);
          hydrateNumberInputs(sessionData.answers);
          if (v) {
            setVerdict(v.verdict);
            setVerdictGeneratedAt(v.createdAt);
          }
          setStepIndex(buildGoldSteps(sessionData.answers).length - 1);
        } else {
          const draft = await getLocalGoldDraft(scanId);
          const resolvedAnswers = draft?.answers ?? sessionData.answers;
          setAnswers(resolvedAnswers);
          hydrateNumberInputs(resolvedAnswers);
          setStepIndex(Math.min(draft?.stepIndex ?? 0, buildGoldSteps(resolvedAnswers).length - 1));

          if (sessionData.status === "submitted") {
            const p = await getGoldReportPurchase(sessionData.id);
            setPurchase(p);
            if (p?.status === "paid") {
              const v = await getGoldVerificationVerdict(sessionData.id);
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

  function hydrateNumberInputs(a: GoldVerificationAnswers) {
    if (a.weightValue != null) setWeightText(String(a.weightValue));
    if (a.dimensionsLengthMm != null) setLengthText(String(a.dimensionsLengthMm));
    if (a.dimensionsWidthMm != null) setWidthText(String(a.dimensionsWidthMm));
    if (a.dimensionsHeightMm != null) setHeightText(String(a.dimensionsHeightMm));
    if (a.claimedKarat) setKaratText(a.claimedKarat);
  }

  // Reaching the last step marks the (free) questionnaire submitted and
  // opens a 'pending' report purchase — no AI call happens here.
  useEffect(() => {
    if (loadingSession || !verificationId || !scanId || verdict || purchase) return;
    if (clampedStepIndex !== STEPS.length - 1) return;
    (async () => {
      setCreatingPurchase(true);
      setErrorMsg(null);
      try {
        await markGoldVerificationSubmitted(verificationId);
        const p = await startGoldReportPurchase(verificationId, scanId);
        setPurchase(p);
        await clearLocalGoldDraft(scanId);
      } catch (err) {
        setErrorMsg((err as Error).message);
      } finally {
        setCreatingPurchase(false);
      }
    })();
  }, [clampedStepIndex, STEPS.length, verificationId, scanId, verdict, purchase, loadingSession]);

  function persist(nextStepIndex: number, nextAnswers: GoldVerificationAnswers, nextImagePaths: GoldVerificationImagePaths) {
    if (scanId) setLocalGoldDraft(scanId, { stepIndex: nextStepIndex, answers: nextAnswers }).catch(() => {});
    if (verificationId) saveGoldVerificationProgress(verificationId, nextAnswers, nextImagePaths).catch(() => {});
  }

  function goNext() {
    const next = Math.min(clampedStepIndex + 1, STEPS.length - 1);
    setStepIndex(next);
    persist(next, answers, imagePaths);
  }
  function goBack() {
    const prev = Math.max(clampedStepIndex - 1, 0);
    setStepIndex(prev);
    persist(prev, answers, imagePaths);
  }

  function setAnswer(key: keyof GoldVerificationAnswers, value: string | number | undefined) {
    setAnswers((prev) => {
      const next = { ...prev, [key]: value };
      persist(clampedStepIndex, next, imagePaths);
      return next;
    });
  }

  function onNumberChange(key: keyof GoldVerificationAnswers, setText: (t: string) => void, text: string) {
    setText(text);
    if (text.trim() === "") {
      setAnswer(key, undefined);
      return;
    }
    const n = Number(text);
    if (Number.isFinite(n)) setAnswer(key, n);
  }

  async function handleCapturePhoto(label: GoldVerificationImageLabel) {
    if (!scanId || uploadingLabel) return;
    const result = await ImagePicker.launchCameraAsync({ quality: 1 });
    if (result.canceled || result.assets.length === 0) return;
    setUploadingLabel(label);
    setErrorMsg(null);
    try {
      const path = await uploadGoldVerificationImage(scanId, label, result.assets[0].uri);
      setImagePaths((prev) => {
        const next = { ...prev, [label]: path };
        persist(clampedStepIndex, answers, next);
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
    Linking.openURL(buildGoldReportPaymentUrl(purchase.id)).catch(() => {});
  }

  async function handleCheckPaymentStatus() {
    if (!verificationId) return;
    setCheckingStatus(true);
    setErrorMsg(null);
    try {
      const p = await getGoldReportPurchase(verificationId);
      if (p) setPurchase(p);
      if (p?.status === "paid") {
        const v = await getGoldVerificationVerdict(verificationId);
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
      await generateAndShareGoldVerificationPdf(
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
      const v = await requestGoldReEvaluation(verificationId);
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

  const step = STEPS[clampedStepIndex];
  const isFirst = clampedStepIndex === 0;
  const isLast = clampedStepIndex === STEPS.length - 1;

  const density =
    answers.weightValue != null &&
    answers.dimensionsLengthMm != null &&
    answers.dimensionsWidthMm != null &&
    answers.dimensionsHeightMm != null
      ? estimateDensityGramsPerCm3(
          answers.weightUnit === "ounces" ? answers.weightValue * 28.3495 : answers.weightValue,
          answers.dimensionsLengthMm,
          answers.dimensionsWidthMm,
          answers.dimensionsHeightMm,
        )
      : null;

  return (
    <ScrollView contentContainerStyle={[styles.container, { paddingBottom: 32 + insets.bottom }]}>
      <Text style={styles.progressText}>
        {L(`Step ${clampedStepIndex + 1} of ${STEPS.length}`, `Tallaabo ${clampedStepIndex + 1} ee ${STEPS.length}`)}
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

      {step.kind === "density" && (
        <Card style={styles.stepCard}>
          <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
          <Text style={styles.stepSubtitle}>
            {L(
              "Gold is very heavy for its size (~19.3 g/cm³ pure). Enter the weight and approximate length/width/height to estimate density.",
              "Dahabku aad buu ugu culus yahay cabbirkiisa (~19.3 g/cm³ saafi ah). Geli miisaanka iyo qiyaastii dherer/ballac/dhererka kale si loo qiyaaso xajmiga.",
            )}
          </Text>
          <TextInput
            style={styles.numberInput}
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
              { value: "ounces", label: L("ounces", "Awqiyad") },
            ]}
            value={answers.weightUnit ?? "grams"}
            onChange={(v) => setAnswer("weightUnit", v)}
          />
          <View style={styles.dimensionsRow}>
            <TextInput
              style={[styles.numberInput, styles.dimensionInput]}
              keyboardType="decimal-pad"
              placeholder={L("Length (mm)", "Dherer (mm)")}
              placeholderTextColor={colors.textFaint}
              value={lengthText}
              onChangeText={(t) => onNumberChange("dimensionsLengthMm", setLengthText, t)}
            />
            <TextInput
              style={[styles.numberInput, styles.dimensionInput]}
              keyboardType="decimal-pad"
              placeholder={L("Width (mm)", "Ballac (mm)")}
              placeholderTextColor={colors.textFaint}
              value={widthText}
              onChangeText={(t) => onNumberChange("dimensionsWidthMm", setWidthText, t)}
            />
            <TextInput
              style={[styles.numberInput, styles.dimensionInput]}
              keyboardType="decimal-pad"
              placeholder={L("Height (mm)", "Dhumucda (mm)")}
              placeholderTextColor={colors.textFaint}
              value={heightText}
              onChangeText={(t) => onNumberChange("dimensionsHeightMm", setHeightText, t)}
            />
          </View>
          {density != null && (
            <View style={styles.densityResultBox}>
              <Text style={styles.densityResultValue}>{density.toFixed(2)} g/cm³</Text>
              <Text style={styles.disclaimer}>
                {L(
                  "Rough estimate only (accurate for regular shapes, rough for irregular nuggets) — pure gold is ~19.3 g/cm³.",
                  "Waa qiyaas kaliya (waxay sax u tahay qaababka joogtada ah, waxayna khaldan tahay dhagaxyada aan qaab caadi ahayn) — dahabka saafiga ah wuxuu leeyahay ~19.3 g/cm³.",
                )}
              </Text>
            </View>
          )}
        </Card>
      )}

      {step.kind === "text" && (
        <Card style={styles.stepCard}>
          <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
          {step.subtitleEn && <Text style={styles.stepSubtitle}>{L(step.subtitleEn, step.subtitleSo!)}</Text>}
          <TextInput
            style={styles.numberInput}
            placeholder={L("e.g. 750, 18K", "tusaale: 750, 18K")}
            placeholderTextColor={colors.textFaint}
            value={karatText}
            onChangeText={(t) => {
              setKaratText(t);
              setAnswer(step.key, t.trim() === "" ? undefined : t);
            }}
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
            <GoldVerdictDisplay verdict={verdict} L={L} />
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
                  "Payment confirmed — preparing your gold verification report…",
                  "Lacag-bixinta waa la xaqiijiyay — waxaan diyaarinaynaa warbixintaada xaqiijinta dahabka…",
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
          <GoldPaywallCard
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

// $5 Gold Verification Report paywall. Buttons only ever open the LuulScan
// website (Linking.openURL) — there is no in-app charge, no IAP, and no way
// for this screen to fabricate a "paid" status; EXTERNAL_PURCHASES_ENABLED
// hides the purchase CTA entirely on iOS (App Store Guideline 3.1.1), same
// as PaywallCard in verify.tsx.
function GoldPaywallCard({
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
          "This item appears to warrant a full Gold Verification Report.",
          "Shaygan wuxuu u muuqdaa mid u baahan Warbixin Xaqiijin Dahab oo dhamaystiran.",
        )}
      </Text>
      <Text style={styles.body}>
        {L(
          "We'll combine your original scan with everything you just answered for one final evaluation — evidence score, identification, possible gold type and purity range, supporting and conflicting evidence, recommended next tests, and a downloadable PDF.",
          "Waxaan isku dari doonaa baaritaankii hore, jawaabahaaga, iyo dhammaan xogta aad bixisay si aan kuu siino qiimayn kama dambays ah — dhibcaha caddaynta, aqoonsiga, nooca dahabka iyo qiyaasta saafinimada, caddaynta taageeraysa iyo ka soo horjeedda, baaritaannada xiga ee la talinayo, iyo warbixin PDF ah oo la soo dejin karo.",
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

function GoldVerdictDisplay({ verdict, L }: { verdict: GoldVerificationVerdict; L: (en: string, so: string) => string }) {
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
            "This is not identification confidence — it reflects how strong and thorough the evidence you collected is (tests performed, photos provided, and how consistent they are with each other).",
            "Tani maaha kalsoonida aqoonsiga — waxay muujinaysaa intay u xoog badan tahay oo u dhamaystiran tahay caddaynta aad ururisay (tijaabooyinka la sameeyay, sawirrada la bixiyay, iyo sida ay isu waafaqsan yihiin).",
          )}
        </Text>
      </Card>

      <Card accent style={styles.stepCard}>
        <Text style={styles.label}>{L("Possible Material", "Waxa uu Yahay (Qiyaas)")}</Text>
        <Text style={styles.verdictTitle}>{verdict.finalIdentification}</Text>
        <ConfidenceBadge pct={verdict.confidence * 100} band={band} size="lg" />
        {!!verdict.probability && <Text style={styles.stepSubtitle}>{verdict.probability}</Text>}
        {!!verdict.reasoning && <Text style={styles.body}>{verdict.reasoning}</Text>}
      </Card>

      <View style={styles.recommendationPill}>
        <Text style={styles.recommendationText}>{L(rec.en, rec.so)}</Text>
      </View>

      {verdict.estimatedPurityOptions.length > 0 && (
        <Card style={styles.stepCard}>
          <Text style={styles.sectionTitle}>{L("Estimated Purity Possibilities", "Qiyaasta Saafinimada")}</Text>
          <View style={styles.purityRow}>
            {verdict.estimatedPurityOptions.map((p, i) => (
              <View key={i} style={styles.purityChip}>
                <Text style={styles.purityChipText}>{p}</Text>
              </View>
            ))}
          </View>
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

      {verdict.recommendedNextTests.length > 0 && (
        <Card style={styles.stepCard}>
          <Text style={styles.sectionTitle}>{L("Recommended Next Tests", "Baaritaanada Xiga ee la Talinayo")}</Text>
          {verdict.recommendedNextTests.map((testName, i) => (
            <View key={i} style={styles.testRow}>
              <Ionicons name="flask-outline" size={15} color={colors.gold} />
              <Text style={styles.bullet}>{testName}</Text>
            </View>
          ))}
        </Card>
      )}

      {!!verdict.estimatedMarketValue && (
        <Card style={styles.stepCard}>
          <Text style={styles.sectionTitle}>{L("Estimated Market Value", "Qiimaha Suuqa (Qiyaas)")}</Text>
          <Text style={styles.body}>{verdict.estimatedMarketValue}</Text>
          <Text style={styles.disclaimer}>
            {L("Estimated only — not a professional appraisal.", "Waa qiyaas kaliya — maaha qiimayn xirfadeed.")}
          </Text>
        </Card>
      )}

      {verdict.professionalTestingRecommended && (
        <Card accent style={styles.stepCard}>
          <View style={styles.verifyHeader}>
            <Ionicons name="school-outline" size={18} color={colors.gold} />
            <Text style={styles.sectionTitle}>{L("Professional Testing Recommended", "Baaritaan Xirfadeed ayaa lagula talinayaa")}</Text>
          </View>
          <Text style={styles.body}>
            {verdict.professionalTestingNote ||
              L(
                "This is not a substitute for XRF analysis or a certified assay office. This report is never an official certificate.",
                "Tani maaha beddel falanqaynta XRF ama xafiiska qiimeeyaha rasmiga ah. Warbixintani waligeed maaha shahaado rasmi ah.",
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
  stepTitle: { ...typo.heading },
  stepSubtitle: { ...typo.bodySmall },
  processingRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  body: { ...typo.body },
  bodySmall: { ...typo.bodySmall },
  numberInput: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    color: colors.text,
    fontSize: 16,
  },
  dimensionsRow: { flexDirection: "row", gap: spacing.sm },
  dimensionInput: { flex: 1, padding: spacing.md, fontSize: 14 },
  densityResultBox: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    padding: spacing.md,
    gap: 4,
  },
  densityResultValue: { fontSize: 22, fontWeight: "800", color: colors.gold },
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
  verdictTitle: { fontSize: 26, fontWeight: "800", color: colors.text },
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
  purityRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  purityChip: {
    backgroundColor: colors.goldSoft,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  purityChipText: { color: colors.gold, fontWeight: "800", fontSize: 15 },
  verifyHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  evidenceScoreRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  evidenceScoreValue: { fontSize: 30, fontWeight: "900" },
  evidenceScoreBand: { fontSize: 14, fontWeight: "700" },
  testRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
});

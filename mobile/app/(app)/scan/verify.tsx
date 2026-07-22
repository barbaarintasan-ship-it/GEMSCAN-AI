// Advanced Diamond Verification wizard — a second, OPTIONAL stage offered
// from results.tsx's "Possible High Value Stone Detected" card. Collects a
// structured questionnaire (hardness, transparency, fire, sparkle, shape,
// color, weight, magnet, fog, UV, loupe) plus a few extra photos. The
// questionnaire itself stays free; the final expert verdict (evidence score,
// identification, supporting/conflicting evidence, PDF) is a $5 premium
// report gated behind a paywall — see PaywallCard below. The single
// additional AI call (verify-high-value) is DEFERRED until a payment webhook
// marks the purchase 'paid' (supabase/functions/high-value-report-webhook);
// this screen never calls it directly. Never reruns or replaces the
// original scan.
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
  startVerification,
  saveVerificationProgress,
  uploadVerificationImage,
  markVerificationSubmitted,
  startHighValueReportPurchase,
  getHighValueReportPurchase,
  getVerificationVerdict,
  requestVerificationReEvaluation,
  getLocalDraft,
  setLocalDraft,
  clearLocalDraft,
  type VerificationAnswers,
  type VerificationImagePaths,
  type VerificationImageLabel,
  type VerificationVerdict,
  type HighValueReportPurchase,
} from "../../../lib/diamondVerification";
import { EXTERNAL_PURCHASES_ENABLED, buildHighValueReportPaymentUrl } from "../../../lib/appLinks";
import { generateAndShareVerificationPdf } from "../../../lib/verificationPdfReport";
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
  { value: "not_tested", en: "Not tested", so: "Lama tijaabin" },
];

type ChoiceStepDef = {
  kind: "choice";
  key: keyof VerificationAnswers;
  titleEn: string;
  titleSo: string;
  subtitleEn?: string;
  subtitleSo?: string;
  options: Opt[];
  layout?: "list" | "chips";
};
type WeightStepDef = { kind: "weight"; titleEn: string; titleSo: string };
type PhotosStepDef = { kind: "photos"; titleEn: string; titleSo: string };
type SubmitStepDef = { kind: "submit"; titleEn: string; titleSo: string };
type StepDef = ChoiceStepDef | WeightStepDef | PhotosStepDef | SubmitStepDef;

const STEPS: StepDef[] = [
  {
    kind: "choice",
    key: "scratchesGlass",
    titleEn: "Can the stone scratch glass?",
    titleSo: "Dhagaxani ma xoqi karaa muraayadda?",
    options: YES_NO_NA,
  },
  {
    kind: "choice",
    key: "scratchesSteel",
    titleEn: "Can it scratch steel?",
    titleSo: "Dhagaxani ma xoqi karaa birta?",
    options: YES_NO_NA,
  },
  {
    kind: "choice",
    key: "scratchedByAnotherObject",
    titleEn: "Has another object scratched this stone?",
    titleSo: "Shay kale ma xoqay dhagaxani?",
    options: YES_NO_NA,
  },
  {
    kind: "choice",
    key: "transparency",
    titleEn: "Transparency",
    titleSo: "Hufnaanta",
    options: [
      { value: "transparent", en: "Completely transparent", so: "Gebi ahaanba hufan" },
      { value: "slightly_cloudy", en: "Slightly cloudy", so: "Wax yar oo cawlan" },
      { value: "opaque", en: "Opaque", so: "Aan hufnayn ama nadiif ahayn" },
    ],
  },
  {
    kind: "choice",
    key: "fire",
    titleEn: "Fire (Dispersion)",
    titleSo: "Kala-firdhinta Iftiinka",
    subtitleEn: "When exposed to sunlight or a flashlight, how strong are the rainbow flashes?",
    subtitleSo:
      "Marka qorraxda ama toosh lagu ifiyo, sidee ayay u xoog badan yihiin midabbada qaanso-roobaadka ee ka muuqda dhagaxa gudihiisa?",
    options: [
      { value: "very_strong", en: "Very strong", so: "Aad u xoog badan" },
      { value: "moderate", en: "Moderate", so: "Dhexdhexaad" },
      { value: "weak", en: "Weak", so: "Daciif" },
      { value: "none", en: "None", so: "Midna ama malaha" },
    ],
  },
  {
    kind: "choice",
    key: "sparkle",
    titleEn: "Sparkle",
    titleSo: "Dhalaalka",
    options: [
      { value: "brilliant", en: "Brilliant sparkle", so: "Dhalaal aad u fiican" },
      { value: "moderate", en: "Moderate sparkle", so: "Dhalaal dhexdhexaad ah" },
      { value: "dull", en: "Dull", so: "Aan dhalaalayn" },
    ],
  },
  {
    kind: "choice",
    key: "shape",
    titleEn: "Shape",
    titleSo: "Qaabka",
    options: [
      { value: "rough_crystal", en: "Rough crystal", so: "Kiristaal dabiici ah" },
      { value: "cut_gemstone", en: "Cut gemstone", so: "Dhagax la gooyay ama jabay" },
      { value: "cabochon", en: "Cabochon", so: "Cabochon" },
      { value: "unknown", en: "Unknown", so: "Lama oga" },
    ],
  },
  {
    kind: "choice",
    key: "color",
    titleEn: "Color",
    titleSo: "Midabka",
    layout: "chips",
    options: [
      { value: "colorless", en: "Colorless/White", so: "Midab la'aan/Cad" },
      { value: "yellow", en: "Yellow", so: "Jaalle" },
      { value: "brown", en: "Brown", so: "Bunni" },
      { value: "gray", en: "Gray", so: "Boodhe" },
      { value: "black", en: "Black", so: "Madow" },
      { value: "pink", en: "Pink", so: "Casaan khafiif ah" },
      { value: "blue", en: "Blue", so: "Buluug" },
      { value: "green", en: "Green", so: "Cagaar" },
      { value: "other", en: "Other", so: "Kale" },
    ],
  },
  {
    kind: "weight",
    titleEn: "Weight (optional)",
    titleSo: "Miisaanka (ikhtiyaari) hoos geli miisaanka dhagaxa",
  },
  {
    kind: "choice",
    key: "magnetAttracts",
    titleEn: "Magnet Test",
    titleSo: "Tijaabada Magnetka",
    subtitleEn: "Does a magnet attract it?",
    subtitleSo: "Magnetku ma soo jiitaa dhagaxan?",
    options: YES_NO_NA,
  },
  {
    kind: "choice",
    key: "fogClearTime",
    titleEn: "Fog Test",
    titleSo: "Tijaabada Ceeryaamada",
    subtitleEn: "Breathe onto the stone. How quickly does the fog disappear?",
    subtitleSo:
      "Ku neefso dhagaxa, neefsi aad ceeryaamo ku smaynayso. Intee ayeey ku qaataa inay ceeryaamadu ka baaba'do dhagaxa?",
    options: [
      { value: "immediately", en: "Immediately", so: "Isla markiiba" },
      { value: "1_2_seconds", en: "1-2 seconds", so: "1–2 ilbiriqsi" },
      { value: "longer", en: "Longer", so: "Waqti dheer" },
      { value: "not_tested", en: "Not tested", so: "Lama tijaabin" },
    ],
  },
  {
    kind: "choice",
    key: "uvReaction",
    titleEn: "UV Light (optional)",
    titleSo: "Iftiinka UV ama Qoraxda (ikhtiyaari)",
    subtitleEn: "Reaction under UV light",
    subtitleSo: "Sidee ayuu uga falceliyaa iftiinka UV-ga ama qoraxda marka lagu eego?",
    options: [
      { value: "blue", en: "Blue", so: "Buluug" },
      { value: "green", en: "Green", so: "Cagaar" },
      { value: "yellow", en: "Yellow", so: "Jaalle" },
      { value: "none", en: "None", so: "Midna" },
      { value: "unknown", en: "Unknown", so: "Lama oga" },
    ],
  },
  {
    kind: "choice",
    key: "loupeInclusions",
    titleEn: "Loupe Inspection",
    titleSo: "Baaritaanka Loupe-ka",
    subtitleEn: "What do you see?",
    subtitleSo: "Maxaad ku aragtay?",
    options: [
      { value: "natural_inclusions", en: "Natural inclusions", so: "Waxyaabo dabiici ah oo gudaha ku jira" },
      { value: "perfectly_clean", en: "Perfectly clean", so: "Gebi ahaanba nadiif" },
      { value: "bubbles", en: "Bubbles", so: "Xumbooyin hawo (Bubbles)" },
      { value: "unknown", en: "Unknown", so: "Lama oga" },
    ],
  },
  {
    kind: "photos",
    titleEn: "Additional Photos (optional)",
    titleSo: "Sawirro Dheeraad ah (ikhtiyaari) ka qaad sawiro muuqda oo dheeraad oo hoos soo geli",
  },
  {
    kind: "submit",
    titleEn: "Final Expert Evaluation",
    titleSo: "Qiimaynta Khabiirka ee Kama Dambaysta ah",
  },
];

const PHOTO_LABELS: { key: VerificationImageLabel; en: string; so: string }[] = [
  { key: "macro", en: "Macro", so: "Sawir dhow (Macro)" },
  { key: "side", en: "Side", so: "Dhinaca" },
  { key: "top", en: "Top", so: "Dusha sare" },
  { key: "bottom", en: "Bottom", so: "Hoosta" },
  { key: "edge", en: "Edge", so: "Geeska" },
  { key: "flash", en: "Flash photo", so: "Sawir Flash ah" },
  { key: "wet", en: "Wet (optional)", so: "Sawir dhagaxa qoyan ah (ikhtiyaari)" },
];

const RECOMMENDATION_LABELS: Record<string, { en: string; so: string }> = {
  likely_natural_diamond: { en: "Likely Natural Diamond", so: "Waxay u badan tahay Diamond Dabiici ah" },
  likely_lab_diamond: { en: "Likely Lab-Grown Diamond", so: "Waxay u badan tahay Diamond Shaybaar" },
  likely_moissanite: { en: "Likely Moissanite", so: "Waxay u badan tahay Moissanite" },
  likely_white_sapphire: { en: "Likely White Sapphire", so: "Waxay u badan tahay Sapphire Cad" },
  likely_quartz: { en: "Likely Quartz", so: "Waxay u badan tahay Quartz" },
  cannot_determine: { en: "Cannot Determine", so: "Lama go'aamin karo" },
  needs_professional_testing: { en: "Needs Professional Testing", so: "Waxay u baahan tahay Baaritaan Xirfadeed" },
};

// Evidence Score qualitative bands — this is NOT the AI's identification
// confidence (shown separately as the ConfidenceBadge); it reflects how
// strong/thorough the collected evidence itself is. Computed deterministically
// from the score the AI returned, not re-derived by another AI call.
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

export default function DiamondVerificationScreen() {
  const { scanId } = useLocalSearchParams<{ scanId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const L = (en: string, soText: string) => (so ? soText : en);

  const [loadingSession, setLoadingSession] = useState(true);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<VerificationAnswers>({});
  const [weightText, setWeightText] = useState("");
  const [imagePaths, setImagePaths] = useState<VerificationImagePaths>({});
  const [uploadingLabel, setUploadingLabel] = useState<VerificationImageLabel | null>(null);
  const [creatingPurchase, setCreatingPurchase] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [purchase, setPurchase] = useState<HighValueReportPurchase | null>(null);
  const [verdict, setVerdict] = useState<VerificationVerdict | null>(null);
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

  useEffect(() => {
    if (!scanId) return;
    (async () => {
      try {
        const sessionData = await startVerification(scanId);
        setVerificationId(sessionData.id);
        setImagePaths(sessionData.imagePaths);

        // Specimen photo, for the PDF export — same lookup results.tsx uses
        // (scan_images, earliest first). Store the raw storage PATH, not a
        // signed URL: the user may not download the PDF until well after a
        // trip out to the external payment page and back, and a signed URL
        // minted now would have expired by then — the download handler
        // signs a fresh one right before it's needed instead.
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
          // Also hydrate purchase (not just verdict) — "Edit Answers" relies
          // on `purchase` already being set to know a re-evaluation is free,
          // and without it the create-purchase effect below would otherwise
          // needlessly re-fire on the first edit of a reopened session.
          const [p, v] = await Promise.all([
            getHighValueReportPurchase(sessionData.id),
            getVerificationVerdict(sessionData.id),
          ]);
          setPurchase(p);
          setAnswers(sessionData.answers);
          if (v) {
            setVerdict(v.verdict);
            setVerdictGeneratedAt(v.createdAt);
          }
          setStepIndex(STEPS.length - 1);
        } else {
          const draft = await getLocalDraft(scanId);
          const resolvedAnswers = draft?.answers ?? sessionData.answers;
          setAnswers(resolvedAnswers);
          if (resolvedAnswers.weightValue != null) setWeightText(String(resolvedAnswers.weightValue));
          setStepIndex(Math.min(draft?.stepIndex ?? 0, STEPS.length - 1));

          // Resuming a session that already reached the paywall once — read
          // back its purchase (and verdict, if the payment already went
          // through) instead of creating a duplicate purchase row.
          if (sessionData.status === "submitted") {
            const p = await getHighValueReportPurchase(sessionData.id);
            setPurchase(p);
            if (p?.status === "paid") {
              const v = await getVerificationVerdict(sessionData.id);
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

  // Reaching the last step marks the (free) questionnaire submitted and
  // opens a 'pending' report purchase — no AI call happens here. This
  // replaces the old "tap Get Final Evaluation to run the AI" step: there's
  // nothing left to opt into, the paywall below is the only next action.
  useEffect(() => {
    if (loadingSession || !verificationId || !scanId || verdict || purchase) return;
    if (stepIndex !== STEPS.length - 1) return;
    (async () => {
      setCreatingPurchase(true);
      setErrorMsg(null);
      try {
        await markVerificationSubmitted(verificationId);
        const p = await startHighValueReportPurchase(verificationId, scanId);
        setPurchase(p);
        await clearLocalDraft(scanId);
      } catch (err) {
        setErrorMsg((err as Error).message);
      } finally {
        setCreatingPurchase(false);
      }
    })();
  }, [stepIndex, verificationId, scanId, verdict, purchase, loadingSession]);

  function persist(nextStepIndex: number, nextAnswers: VerificationAnswers, nextImagePaths: VerificationImagePaths) {
    if (scanId) setLocalDraft(scanId, { stepIndex: nextStepIndex, answers: nextAnswers }).catch(() => {});
    if (verificationId) saveVerificationProgress(verificationId, nextAnswers, nextImagePaths).catch(() => {});
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

  function setAnswer(key: keyof VerificationAnswers, value: string | number | undefined) {
    setAnswers((prev) => {
      const next = { ...prev, [key]: value };
      persist(stepIndex, next, imagePaths);
      return next;
    });
  }

  function onWeightChange(text: string) {
    setWeightText(text);
    if (text.trim() === "") {
      setAnswer("weightValue", undefined);
      return;
    }
    const n = Number(text);
    if (Number.isFinite(n)) setAnswer("weightValue", n);
  }

  async function handleCapturePhoto(label: VerificationImageLabel) {
    if (!scanId || uploadingLabel) return;
    const result = await ImagePicker.launchCameraAsync({ quality: 1 });
    if (result.canceled || result.assets.length === 0) return;
    setUploadingLabel(label);
    setErrorMsg(null);
    try {
      const path = await uploadVerificationImage(scanId, label, result.assets[0].uri);
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
    Linking.openURL(buildHighValueReportPaymentUrl(purchase.id)).catch(() => {});
  }

  // "I've paid — check status": re-reads the purchase row (RLS select-own).
  // Not a bypass — it only reflects whatever the payment webhook has
  // actually written; there is no client-side way to mark a purchase paid.
  async function handleCheckPaymentStatus() {
    if (!verificationId) return;
    setCheckingStatus(true);
    setErrorMsg(null);
    try {
      const p = await getHighValueReportPurchase(verificationId);
      if (p) setPurchase(p);
      if (p?.status === "paid") {
        const v = await getVerificationVerdict(verificationId);
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
      // Sign fresh right before use rather than reusing a URL from wizard
      // mount — by the time the user downloads (often after a round trip to
      // the external payment page), an earlier signed URL may have expired.
      let freshPhotoUri: string | null = null;
      if (photoStoragePath) {
        const { data: signed } = await supabase.storage
          .from("scan-images")
          .createSignedUrl(photoStoragePath, 3600);
        freshPhotoUri = signed?.signedUrl ?? null;
      }
      const rec = RECOMMENDATION_LABELS[verdict.recommendation] ?? RECOMMENDATION_LABELS.cannot_determine;
      await generateAndShareVerificationPdf(
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

  // "Edit Answers" from the verdict screen — jumps back into the
  // questionnaire with existing answers still filled in. The purchase stays
  // 'paid', so no new payment is needed; reaching the submit step again will
  // request a fresh (free) evaluation instead of waiting on the webhook.
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
      const v = await requestVerificationReEvaluation(verificationId);
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

      {step.kind === "weight" && (
        <Card style={styles.stepCard}>
          <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
          <TextInput
            style={styles.weightInput}
            keyboardType="decimal-pad"
            placeholder={L("Weight", "Miisaanka")}
            placeholderTextColor={colors.textFaint}
            value={weightText}
            onChangeText={onWeightChange}
          />
          <ChoiceGroup
            layout="chips"
            options={[
              { value: "grams", label: L("grams", "Garaam") },
              { value: "carats", label: L("carats", "Karaad") },
            ]}
            value={answers.weightUnit ?? "grams"}
            onChange={(v) => setAnswer("weightUnit", v)}
          />
        </Card>
      )}

      {step.kind === "photos" && (
        <Card style={styles.stepCard}>
          <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
          <Text style={styles.stepSubtitle}>
            {L(
              "All photos are optional — add whichever you can.",
              "Dhammaan sawirradu waa ikhtiyaari — ku dar inta aad awooddo.",
            )}
          </Text>
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
            <VerdictDisplay verdict={verdict} L={L} />
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
                "We'll re-run the expert evaluation with your updated answers — free, no additional payment.",
                "Waxaan dib u samayn doonaa qiimaynta khibradda ee leh jawaabahaaga cusub — bilaash, lacag dheeraad ah lama rabo.",
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
                  "Payment confirmed — preparing your expert report…",
                  "Lacag-bixinta waa la xaqiijiyay — waxaan diyaarinaynaa warbixintaada khibradda leh…",
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
          <PaywallCard
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

// $5 High-Value Verification Report paywall. Buttons only ever open the
// LuulScan website (Linking.openURL) — there is no in-app charge, no IAP, and
// no way for this screen to fabricate a "paid" status; EXTERNAL_PURCHASES_ENABLED
// hides the purchase CTA entirely on iOS (App Store Guideline 3.1.1), same as
// PremiumGate/UpgradePrompt already do for subscriptions.
function PaywallCard({
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
          "This gemstone appears valuable enough for an advanced expert verification report.",
          "Dhagaxan wuxuu u muuqdaa mid qiimo u leh oo u baahan warbixin khibrad khabiir oo horumarsan.",
        )}
      </Text>
      <Text style={styles.body}>
        {L(
          "We'll combine your original scan with everything you just answered for one final expert evaluation — evidence score, identification, supporting and conflicting evidence, recommended next tests, and a downloadable PDF.",
          "Waxaan isku dari doonaa baaritaankii hore, jawaabahaaga, iyo dhammaan xogta aad bixisay si aan kuu siino qiimayn khabiir oo kama dambays ah — dhibcaha caddaynta, aqoonsiga, caddaynta taageeraysa iyo ka soo horjeedda, baaritaannada xiga ee la talinayo, iyo warbixin PDF ah oo la soo dejin karo.",
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

function VerdictDisplay({ verdict, L }: { verdict: VerificationVerdict; L: (en: string, so: string) => string }) {
  const rec = RECOMMENDATION_LABELS[verdict.recommendation] ?? RECOMMENDATION_LABELS.cannot_determine;
  const band = verdict.confidence >= 0.72 ? "high" : verdict.confidence >= 0.45 ? "medium" : "low";
  const evidenceBand = evidenceScoreBand(verdict.evidenceScore);

  return (
    <View style={{ gap: spacing.md }}>
      {/* Evidence Score — shown first, deliberately distinct from the AI's
          identification confidence below. Not a new AI call: computed from
          the evidenceScore already returned by the single verification
          request, banded client-side. */}
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
            "This is not AI confidence — it reflects how strong and thorough the evidence you collected is (tests performed, photos provided, and how consistent they are with each other).",
            "Tani maaha kalsoonida AI-ga — waxay muujinaysaa intay u xoog badan tahay oo u dhamaystiran tahay caddaynta aad ururisay (tijaabooyinka la sameeyay, sawirrada la bixiyay, iyo sida ay isu waafaqsan yihiin).",
          )}
        </Text>
      </Card>

      <Card accent style={styles.stepCard}>
        <Text style={styles.label}>{L("Final Identification", "Aqoonsiga Kama Dambaysta ah")}</Text>
        <Text style={styles.verdictTitle}>{verdict.finalIdentification}</Text>
        <ConfidenceBadge pct={verdict.confidence * 100} band={band} size="lg" />
        {!!verdict.probability && <Text style={styles.stepSubtitle}>{verdict.probability}</Text>}
        {!!verdict.reasoning && <Text style={styles.body}>{verdict.reasoning}</Text>}
      </Card>

      <View style={styles.recommendationPill}>
        <Text style={styles.recommendationText}>{L(rec.en, rec.so)}</Text>
      </View>

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

      {/* Always shown, even when empty — never hide uncertainty (or its
          absence) by omitting this section. */}
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
            {L(
              "Estimated only — not a professional appraisal.",
              "Waa qiyaas kaliya — maaha qiimayn xirfadeed.",
            )}
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
                "This is not a substitute for GIA/AGL certification or laboratory testing.",
                "Tani maaha beddel shahaado GIA/AGL ah ama baaritaan shaybaar.",
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
  weightInput: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    color: colors.text,
    fontSize: 16,
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
  verifyHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  evidenceScoreRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  evidenceScoreValue: { fontSize: 30, fontWeight: "900" },
  evidenceScoreBand: { fontSize: 14, fontWeight: "700" },
  testRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
});

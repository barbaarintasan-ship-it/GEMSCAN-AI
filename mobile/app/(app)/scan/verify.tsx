// Advanced Diamond Verification wizard — a second, OPTIONAL stage offered
// from results.tsx's "Possible High Value Stone Detected" card. Collects a
// structured questionnaire (hardness, transparency, fire, sparkle, shape,
// color, weight, magnet, fog, UV, loupe) plus a few extra photos, then makes
// ONE additional AI call (verify-high-value) for a final expert verdict.
// Never reruns or replaces the original scan.
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
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
  submitVerification,
  getVerificationVerdict,
  getLocalDraft,
  setLocalDraft,
  clearLocalDraft,
  type VerificationAnswers,
  type VerificationImagePaths,
  type VerificationImageLabel,
  type VerificationVerdict,
} from "../../../lib/diamondVerification";
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
    titleSo: "Dhagaxu ma jeexi karaa muraayadda?",
    options: YES_NO_NA,
  },
  {
    kind: "choice",
    key: "scratchesSteel",
    titleEn: "Can it scratch steel?",
    titleSo: "Ma jeexi karaa bir?",
    options: YES_NO_NA,
  },
  {
    kind: "choice",
    key: "scratchedByAnotherObject",
    titleEn: "Has another object scratched this stone?",
    titleSo: "Shay kale miyuu jeexay dhagaxan?",
    options: YES_NO_NA,
  },
  {
    kind: "choice",
    key: "transparency",
    titleEn: "Transparency",
    titleSo: "Dhaafsanaanta",
    options: [
      { value: "transparent", en: "Completely transparent", so: "Gebi ahaanba dhaafsan" },
      { value: "slightly_cloudy", en: "Slightly cloudy", so: "Xoogaa daruuran" },
      { value: "opaque", en: "Opaque", so: "Aan dhaafsanayn" },
    ],
  },
  {
    kind: "choice",
    key: "fire",
    titleEn: "Fire (Dispersion)",
    titleSo: "Dabka (Kala-firdhinta)",
    subtitleEn: "When exposed to sunlight or a flashlight, how strong are the rainbow flashes?",
    subtitleSo: "Marka qorraxda ama toosh lagu ifiyo, sideed u xoog badan yihiin ifafaalaha qaanso-roobaadka?",
    options: [
      { value: "very_strong", en: "Very strong", so: "Aad u xoog badan" },
      { value: "moderate", en: "Moderate", so: "Dhexdhexaad" },
      { value: "weak", en: "Weak", so: "Daciif" },
      { value: "none", en: "None", so: "Midna" },
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
      { value: "rough_crystal", en: "Rough crystal", so: "Kiristaal ceyriin ah" },
      { value: "cut_gemstone", en: "Cut gemstone", so: "Dhagax la gooyay" },
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
      { value: "gray", en: "Gray", so: "Boodheed" },
      { value: "black", en: "Black", so: "Madow" },
      { value: "pink", en: "Pink", so: "Casaan khafiif" },
      { value: "blue", en: "Blue", so: "Buluug" },
      { value: "green", en: "Green", so: "Cagaar" },
      { value: "other", en: "Other", so: "Kale" },
    ],
  },
  { kind: "weight", titleEn: "Weight (optional)", titleSo: "Miisaanka (ikhtiyaari)" },
  {
    kind: "choice",
    key: "magnetAttracts",
    titleEn: "Magnet Test",
    titleSo: "Tijaabada Magnetka",
    subtitleEn: "Does a magnet attract it?",
    subtitleSo: "Magnet miyuu soo jiitaa?",
    options: YES_NO_NA,
  },
  {
    kind: "choice",
    key: "fogClearTime",
    titleEn: "Fog Test",
    titleSo: "Tijaabada Ceeriggooska",
    subtitleEn: "Breathe onto the stone. How quickly does the fog disappear?",
    subtitleSo: "Neefso dhagaxa. Immisa dhakhso ayuu ceeriggooska ka baxaa?",
    options: [
      { value: "immediately", en: "Immediately", so: "Isla markiiba" },
      { value: "1_2_seconds", en: "1-2 seconds", so: "1-2 ilbiriqsi" },
      { value: "longer", en: "Longer", so: "Waqti dheer" },
      { value: "not_tested", en: "Not tested", so: "Lama tijaabin" },
    ],
  },
  {
    kind: "choice",
    key: "uvReaction",
    titleEn: "UV Light (optional)",
    titleSo: "Iftiinka UV (ikhtiyaari)",
    subtitleEn: "Reaction under UV light",
    subtitleSo: "Falcelinta hoos iftiinka UV",
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
    subtitleSo: "Maxaad aragtaa?",
    options: [
      { value: "natural_inclusions", en: "Natural inclusions", so: "Waxyaalo dabiici ah oo ku jira" },
      { value: "perfectly_clean", en: "Perfectly clean", so: "Gebi ahaanba nadiif" },
      { value: "bubbles", en: "Bubbles", so: "Buufis (bubbles)" },
      { value: "unknown", en: "Unknown", so: "Lama oga" },
    ],
  },
  { kind: "photos", titleEn: "Additional Photos (optional)", titleSo: "Sawirro Dheeraad ah (ikhtiyaari)" },
  { kind: "submit", titleEn: "Final Expert Evaluation", titleSo: "Qiimaynta Khibradda Kama Dambaysta ah" },
];

const PHOTO_LABELS: { key: VerificationImageLabel; en: string; so: string }[] = [
  { key: "macro", en: "Macro", so: "Dhow (Macro)" },
  { key: "side", en: "Side", so: "Dhinaca" },
  { key: "top", en: "Top", so: "Dusha" },
  { key: "bottom", en: "Bottom", so: "Hoosta" },
  { key: "edge", en: "Edge", so: "Xagafka" },
  { key: "flash", en: "Flash photo", so: "Sawir Flash ah" },
  { key: "wet", en: "Wet (optional)", so: "Qoyan (ikhtiyaari)" },
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
  const [submitting, setSubmitting] = useState(false);
  const [verdict, setVerdict] = useState<VerificationVerdict | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!scanId) return;
    (async () => {
      try {
        const sessionData = await startVerification(scanId);
        setVerificationId(sessionData.id);
        setImagePaths(sessionData.imagePaths);

        if (sessionData.status === "completed") {
          const v = await getVerificationVerdict(sessionData.id);
          setAnswers(sessionData.answers);
          setVerdict(v);
          setStepIndex(STEPS.length - 1);
        } else {
          const draft = await getLocalDraft(scanId);
          const resolvedAnswers = draft?.answers ?? sessionData.answers;
          setAnswers(resolvedAnswers);
          if (resolvedAnswers.weightValue != null) setWeightText(String(resolvedAnswers.weightValue));
          setStepIndex(Math.min(draft?.stepIndex ?? 0, STEPS.length - 1));
        }
      } catch (err) {
        setErrorMsg((err as Error).message);
      } finally {
        setLoadingSession(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanId]);

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

  async function handleSubmit() {
    if (!verificationId || !scanId) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const v = await submitVerification(verificationId);
      setVerdict(v);
      await clearLocalDraft(scanId);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setSubmitting(false);
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
              { value: "grams", label: L("grams", "garaam") },
              { value: "carats", label: L("carats", "qiraad") },
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
              "Dhammaan sawirradu waa ikhtiyaari — ku dar kuwa aad awoodo.",
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
          <VerdictDisplay verdict={verdict} L={L} />
        ) : (
          <Card style={styles.stepCard}>
            <Text style={styles.stepTitle}>{L(step.titleEn, step.titleSo)}</Text>
            <Text style={styles.stepSubtitle}>
              {L(
                "We'll combine your original scan with everything you just answered for one final expert evaluation. This may take up to 30 seconds.",
                "Waxaan isku dari doonaa baaritaankaagii hore iyo dhammaan waxa aad ka jawaabtay hal qiimayn khibrad leh oo kama dambays ah. Waxay qaadan kartaa ilaa 30 ilbiriqsi.",
              )}
            </Text>
            {errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
            <Button
              title={L("Get Final Evaluation", "Hel Qiimaynta Kama Dambaysta ah")}
              variant="primary"
              loading={submitting}
              onPress={handleSubmit}
            />
          </Card>
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

// Stage 6 result display + Stage 7 feedback capture.
//
// Reads the persisted `scans.final_result` and ranked `scan_candidates`
// directly from Supabase (RLS-scoped to the caller) rather than relying on
// navigation params, so this screen also works if the user re-opens a past
// scan from history later.
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView, Linking, Image } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import ViewShot from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import { useTranslation } from "react-i18next";
import { supabase } from "../../../lib/supabase";
import { submitScanFeedback } from "../../../lib/scanUpload";
import { INSUFFICIENT_CONFIDENCE_MESSAGE_TEXT } from "../../../lib/constants";
import { estimateValue, type Valuation } from "../../../lib/valuation";
import { EXPERT_WHATSAPP, HIGH_VALUE_THRESHOLD_USD, hasExpertContact } from "../../../lib/expertConfig";
import { useSubscriptionStatus } from "../../../lib/subscription";
import { generateAndSharePdf, type PdfReportData } from "../../../lib/pdfReport";
import type { ExplanationStyle, ExpertExplanationDTO } from "../../../lib/scanUpload";
import { EXTERNAL_PURCHASES_ENABLED, PAYMENT_URL } from "../../../lib/appLinks";
import LocationMap from "../../../components/LocationMap";
import { Card } from "../../../components/ui/Card";
import { ConfidenceBadge } from "../../../components/ui/ConfidenceBadge";
import { Button } from "../../../components/ui/Button";
import { colors, spacing, radius, type as typo } from "../../../lib/theme";

type ScanCandidate = {
  rank: number;
  label: string;
  weighted_confidence: number;
  confidence_band: "low" | "medium" | "high";
  rationale: string;
  rejected_reason: string | null;
};

type ScanRow = {
  status: string;
  created_at: string;
  capture_location: { lat: number; lng: number; acc?: number } | null;
  final_result: {
    bestMatch: string | null;
    confidenceScore: number;
    confidenceBand: "low" | "medium" | "high";
    reasoning: string | null;
    insufficientConfidence: boolean;
    message: string | null;
    suggestions: string[];
    explanationStyle?: ExplanationStyle | null;
    simpleExplanation?: string | null;
    expertExplanation?: ExpertExplanationDTO | null;
    imageObservations?: string | null;
    warnings?: string | null;
    recommendations?: string | null;
  } | null;
};

// Labeled technical fields shown in the Expert view, in display order.
const EXPERT_FIELD_ORDER: { key: keyof ExpertExplanationDTO; label: string; labelSo: string }[] = [
  { key: "mineralSpecies", label: "Mineral species", labelSo: "Nooca macdanta" },
  { key: "variety", label: "Variety", labelSo: "Nooca gaarka ah" },
  { key: "crystalSystem", label: "Crystal system", labelSo: "Nidaamka kiristaalka" },
  { key: "chemicalComposition", label: "Chemical composition", labelSo: "Dhismaha kiimikada" },
  { key: "mohsHardness", label: "Mohs hardness", labelSo: "Adkaanta Mohs" },
  { key: "specificGravity", label: "Specific gravity", labelSo: "Miisaanka gaarka ah" },
  { key: "refractiveIndex", label: "Refractive index", labelSo: "Tirada dib-u-jiitanka" },
  { key: "cleavage", label: "Cleavage", labelSo: "Kala-goynta" },
  { key: "fracture", label: "Fracture", labelSo: "Jabka" },
  { key: "luster", label: "Luster", labelSo: "Dhalaalka" },
  { key: "transparency", label: "Transparency", labelSo: "Dhaafsanaanta" },
  { key: "diagnosticCharacteristics", label: "Diagnostic characteristics", labelSo: "Astaamaha lagu aqoonsado" },
  { key: "geologicalOrigin", label: "Geological origin", labelSo: "Asalka juqraafiga" },
  { key: "commonTreatments", label: "Common treatments", labelSo: "Daaweynta caadiga ah" },
  { key: "syntheticIndicators", label: "Synthetic indicators", labelSo: "Calaamadaha macmalka ah" },
  { key: "commonImitations", label: "Common imitations", labelSo: "Ku-daydka caadiga ah" },
  { key: "confidenceReasoning", label: "Confidence reasoning", labelSo: "Sababta kalsoonida" },
  { key: "recommendedLabTests", label: "Recommended lab tests", labelSo: "Baaritaannada shaybaarka la talinayo" },
  { key: "marketDemand", label: "Market demand", labelSo: "Baahida suuqa" },
  { key: "wholesaleEstimate", label: "Wholesale estimate", labelSo: "Qiyaasta jumlada" },
  { key: "retailEstimate", label: "Retail estimate", labelSo: "Qiyaasta tafaariiqda" },
  { key: "investmentConsiderations", label: "Investment considerations", labelSo: "Tixgelinta maalgashiga" },
];

const BAND_COLOR: Record<string, string> = {
  high: "#2E7D32",
  medium: "#C9A227",
  low: "#8A8A8E",
};

export default function ResultsScreen() {
  const { scanId } = useLocalSearchParams<{ scanId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { i18n } = useTranslation();
  const lang: "en" | "so" = i18n.language === "so" ? "so" : "en";
  const L = (en: string, so: string) => (lang === "so" ? so : en);

  const [scan, setScan] = useState<ScanRow | null>(null);
  const [candidates, setCandidates] = useState<ScanCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [valuation, setValuation] = useState<Valuation | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoReady, setPhotoReady] = useState(false);
  const [sharing, setSharing] = useState(false);
  const shareCardRef = React.useRef<ViewShot>(null);

  // Dual Explanation Modes: which view the user is currently looking at.
  // Initialized from the style the scan was run with, then freely
  // switchable (History reuses this same screen for past scans too).
  const [viewStyle, setViewStyle] = useState<ExplanationStyle>("simple");

  // Professional PDF report (Pro / "Gem Collector" tier only).
  const { data: sub } = useSubscriptionStatus();
  const canPdf = sub?.features?.pdfReports ?? false;
  const [hallmark, setHallmark] = useState<
    { marks: string[]; matchedLabel: string | null; note: string | null } | null
  >(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    if (!scanId) return;
    (async () => {
      const [{ data: scanData }, { data: candidateData }] = await Promise.all([
        supabase
          .from("scans")
          .select("status, final_result, created_at, capture_location")
          .eq("id", scanId)
          .maybeSingle(),
        supabase
          .from("scan_candidates")
          .select("rank, label, weighted_confidence, confidence_band, rationale, rejected_reason")
          .eq("scan_id", scanId)
          .order("rank", { ascending: true }),
      ]);
      const row = scanData as ScanRow | null;
      setScan(row);
      setCandidates((candidateData as ScanCandidate[]) ?? []);
      setIsLoading(false);
      if (row?.final_result?.explanationStyle) {
        setViewStyle(row.final_result.explanationStyle);
      }

      // Load one specimen photo (the front/original of the first image) for the
      // shareable card. The bucket is private, so sign the path.
      const { data: img } = await supabase
        .from("scan_images")
        .select("original_storage_path")
        .eq("scan_id", scanId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      const path = (img as { original_storage_path?: string } | null)?.original_storage_path;
      if (path) {
        const { data: signed } = await supabase.storage
          .from("scan-images")
          .createSignedUrl(path, 3600);
        if (signed?.signedUrl) setPhotoUrl(signed.signedUrl);
      }

      // Hallmark data (jewelry/coins) for the PDF report — only present when the
      // hallmark OCR provider actually transcribed a mark. RLS-scoped to own scan.
      const { data: hm } = await supabase
        .from("scan_ai_responses")
        .select("candidate_label, reasoning, raw_response")
        .eq("scan_id", scanId)
        .eq("provider", "hallmark_ocr")
        .limit(1)
        .maybeSingle();
      if (hm) {
        const raw = (hm as { raw_response?: { marks?: unknown } }).raw_response;
        const marks = Array.isArray(raw?.marks) ? (raw!.marks as string[]) : [];
        const matchedLabel = (hm as { candidate_label?: string | null }).candidate_label ?? null;
        if (marks.length > 0 || matchedLabel) {
          setHallmark({
            marks,
            matchedLabel,
            note: (hm as { reasoning?: string | null }).reasoning ?? null,
          });
        }
      }
    })();
  }, [scanId]);

  // Additive market valuation — a SEPARATE Gemini call that never touches the
  // identification pipeline. Runs once per successful result.
  useEffect(() => {
    const fr = scan?.final_result;
    if (!fr || fr.insufficientConfidence || !fr.bestMatch) return;
    let active = true;
    (async () => {
      const v = await estimateValue(fr.bestMatch as string, fr.confidenceScore, lang);
      if (active) setValuation(v);
    })();
    return () => {
      active = false;
    };
  }, [scan, lang]);

  // Build a COMPLETE, professionally formatted report from everything the app
  // gathered. Reused by the native Share sheet and the WhatsApp expert contact.
  function buildReport(opts: { expertRequest?: boolean } = {}): string {
    const fr = scan?.final_result;
    const alts = candidates.filter((c) => c.rank > 1).map((c) => c.label);
    const pct = Math.round((fr?.confidenceScore ?? 0) * 100);
    const so = lang === "so";
    const when = scan?.created_at ? new Date(scan.created_at).toLocaleString() : "";
    const val = valuation;
    const lines: string[] = [];

    lines.push(so ? "💎 GemScan — Natiijada baaritaanka" : "💎 GemScan — Scan Result", "");
    if (fr?.bestMatch) lines.push(`${so ? "Aqoonsiga" : "Identification"}: ${fr.bestMatch}`);
    lines.push(`${so ? "Kalsooni" : "Confidence"}: ${pct}%`);
    if (val && !val.lowConfidence && (val.minUsd != null || val.typicalUsd != null)) {
      if (val.minUsd != null && val.premiumUsd != null) {
        lines.push(`${so ? "Qiimaha suuqa (qiyaas)" : "Estimated value"}: USD ${Math.round(val.minUsd)}–${Math.round(val.premiumUsd)}`);
      } else if (val.typicalUsd != null) {
        lines.push(`${so ? "Qiimaha suuqa (qiyaas)" : "Estimated value"}: ~USD ${Math.round(val.typicalUsd)}`);
      }
    }
    if (alts.length) lines.push(`${so ? "Ikhtiyaarro kale" : "Other possibilities"}: ${alts.join(", ")}`);
    if (when) lines.push(`${so ? "Waqtiga" : "Scanned"}: ${when}`);

    if (opts.expertRequest) {
      lines.push("", so
        ? "Waxaan rabaa dib-u-eegis khibrad leh. Waxaan ku lifaaqi doonaa sawirradii scan-ka."
        : "I would like a professional review. I will attach my scan photos.");
    } else {
      lines.push("", so
        ? "La aqoonsaday GemScan — aqoonsi khibrad leh oo dhagxaan, dahab & qadaadiic."
        : "Identified with GemScan — expert gemstone, gold & coin identification.");
    }
    return lines.join("\n");
  }

  // Share ONE professional image (the result card = specimen photo + the data,
  // with NO location) to WhatsApp, Email, Messages, or any installed app.
  async function shareResult() {
    if (sharing) return;
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) return;
      const node = shareCardRef.current;
      if (!node?.capture) return;
      const uri = await node.capture();
      await Sharing.shareAsync(uri, {
        mimeType: "image/png",
        dialogTitle: lang === "so" ? "La wadaag natiijada GemScan" : "Share your GemScan result",
      });
    } catch {
      /* capture/share failed or was dismissed — no-op */
    } finally {
      setSharing(false);
    }
  }

  // Generate a professional PDF report and open the native share sheet
  // (WhatsApp, Email, Messages, Save to Files = download). Pro tier only —
  // the button that calls this is not rendered for other tiers.
  async function downloadPdf() {
    const fr = scan?.final_result;
    if (!scanId || !fr || fr.insufficientConfidence || !fr.bestMatch || pdfBusy) return;
    setPdfBusy(true);
    try {
      const alts = candidates.filter((c) => c.rank > 1);
      const data: PdfReportData = {
        scanId,
        createdAt: scan!.created_at,
        bestMatch: fr.bestMatch,
        confidencePct: Math.round(fr.confidenceScore * 100),
        confidenceBand: fr.confidenceBand,
        reasoning: fr.reasoning,
        explanationStyle: viewStyle,
        simpleExplanation: fr.simpleExplanation,
        expertExplanation: fr.expertExplanation,
        alternatives: alts.map((c) => ({
          label: c.label,
          confidencePct: Math.round(c.weighted_confidence * 100),
          band: c.confidence_band,
        })),
        valuation: valuation
          ? {
              minUsd: valuation.minUsd,
              typicalUsd: valuation.typicalUsd,
              premiumUsd: valuation.premiumUsd,
              note: valuation.qualityNote,
              lowConfidence: valuation.lowConfidence,
            }
          : null,
        hallmark,
        images: photoUrl ? [{ uri: photoUrl, caption: L("Specimen photo", "Sawirka shayga") }] : [],
      };
      await generateAndSharePdf(data, lang);
    } catch {
      /* generation/share failed or was dismissed — no-op */
    } finally {
      setPdfBusy(false);
    }
  }

  function openWhatsApp() {
    if (!EXPERT_WHATSAPP) return;
    const text = encodeURIComponent(buildReport({ expertRequest: true }));
    Linking.openURL(`https://wa.me/${EXPERT_WHATSAPP}?text=${text}`).catch(() => {});
  }

  // Open the coarse capture location in the device's map app.
  function openInMaps(lat: number, lng: number, label?: string) {
    const q = label ? `${lat},${lng}(${encodeURIComponent(label)})` : `${lat},${lng}`;
    const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    Linking.openURL(url).catch(() => {
      Linking.openURL(`geo:${lat},${lng}?q=${q}`).catch(() => {});
    });
  }

  async function handleFeedback(wasCorrect: boolean) {
    if (!scanId) return;
    await submitScanFeedback(scanId, { wasCorrect });
    setFeedbackSent(true);
  }

  if (isLoading || !scan) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color="#C9A227" size="large" />
      </View>
    );
  }

  const finalResult = scan.final_result;

  if (!finalResult || finalResult.insufficientConfidence) {
    const suggestions =
      lang === "so"
        ? [
            "Ku dar sawir macro ah oo iftiin fiican leh.",
            "Qaad xaglo dheeraad ah (dusha, hoosta, labada dhinac).",
            "Haddii aad taqaan meesha laga helay, ku dar goobta.",
            "Dahab/qadaadiic: hubi in calaamadaha la daabacay ay cad yihiin.",
          ]
        : finalResult?.suggestions ?? [];
    return (
      <ScrollView contentContainerStyle={[styles.container, { paddingBottom: 32 + insets.bottom }]}>
        <Text style={styles.insufficientTitle}>
          {lang === "so"
            ? "Ma aqoonsan karno shaygan si kalsooni leh sawirrada la heli karo."
            : finalResult?.message ?? INSUFFICIENT_CONFIDENCE_MESSAGE_TEXT}
        </Text>
        <Text style={styles.body}>{L("To improve your result, try:", "Si aad natiijada u wanaajiso, isku day:")}</Text>
        {suggestions.map((s) => (
          <Text key={s} style={styles.suggestion}>
            • {s}
          </Text>
        ))}
        <Pressable style={styles.primaryButton} onPress={() => router.replace("/(app)/scan/capture")}>
          <Text style={styles.primaryButtonText}>{L("Retake Photos", "Dib u qaad sawirro")}</Text>
        </Pressable>
      </ScrollView>
    );
  }

  const alternatives = candidates.filter((c) => c.rank > 1);
  const pct = Math.round(finalResult.confidenceScore * 100);
  const bandWord = (b: "low" | "medium" | "high") =>
    lang === "so" ? { high: "SARE", medium: "DHEXE", low: "HOOSE" }[b] : b.toUpperCase();

  return (
    <>
    <ScrollView contentContainerStyle={[styles.container, { paddingBottom: 32 + insets.bottom }]}>
      <Card accent style={styles.heroCard}>
        <Text style={styles.label}>{L("Best match", "Aqoonsiga ugu fiican")}</Text>
        <Text style={styles.bestMatch}>{finalResult.bestMatch}</Text>
        <ConfidenceBadge pct={pct} band={finalResult.confidenceBand} size="lg" />
        <Text style={styles.body}>
          {L(
            `Identified as the best match with ${pct}% confidence from our expert gemstone analysis.`,
            `Waxaa loo aqoonsaday inuu yahay aqoonsiga ugu fiican, kalsooni ${pct}%, iyada oo lagu saleeyay baaritaankayaga khibradda leh.`,
          )}
        </Text>
      </Card>

      {/* ── Dual Explanation Modes: Simple / Expert ───────────────────────── */}
      {(finalResult.simpleExplanation || finalResult.expertExplanation) && (
        <Card style={styles.explanationCard}>
          {finalResult.simpleExplanation && finalResult.expertExplanation && (
            <View style={styles.styleToggle}>
              <Pressable
                style={[styles.styleToggleOption, viewStyle === "simple" && styles.styleToggleOptionActive]}
                onPress={() => setViewStyle("simple")}
              >
                <Text style={[styles.styleToggleText, viewStyle === "simple" && styles.styleToggleTextActive]}>
                  {L("Simple", "Fudud")}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.styleToggleOption, viewStyle === "expert" && styles.styleToggleOptionActive]}
                onPress={() => setViewStyle("expert")}
              >
                <Text style={[styles.styleToggleText, viewStyle === "expert" && styles.styleToggleTextActive]}>
                  {L("Expert", "Khibrad")}
                </Text>
              </Pressable>
            </View>
          )}

          {viewStyle === "simple" && finalResult.simpleExplanation ? (
            <Text style={styles.body}>{finalResult.simpleExplanation}</Text>
          ) : viewStyle === "expert" && finalResult.expertExplanation ? (
            <View style={{ gap: 8 }}>
              {EXPERT_FIELD_ORDER.map(({ key, label, labelSo }) => {
                const value = finalResult.expertExplanation![key];
                if (!value) return null;
                return (
                  <View key={key} style={styles.expertRow}>
                    <Text style={styles.expertLabel}>{L(label, labelSo)}</Text>
                    <Text style={styles.expertValue}>{value}</Text>
                  </View>
                );
              })}
            </View>
          ) : (
            // Only one style is available (older scan, or the other side
            // wasn't returned) — show whichever we have.
            <Text style={styles.body}>
              {finalResult.simpleExplanation ??
                (finalResult.expertExplanation
                  ? EXPERT_FIELD_ORDER.map(({ key, label, labelSo }) => {
                      const value = finalResult.expertExplanation![key];
                      return value ? `${L(label, labelSo)}: ${value}` : null;
                    })
                      .filter(Boolean)
                      .join("\n")
                  : "")}
            </Text>
          )}

          {!!finalResult.warnings && (
            <View style={styles.explanationCallout}>
              <Ionicons name="alert-circle-outline" size={14} color="#C9A227" />
              <Text style={styles.explanationCalloutText}>{finalResult.warnings}</Text>
            </View>
          )}
          {!!finalResult.recommendations && (
            <View style={styles.explanationCallout}>
              <Ionicons name="bulb-outline" size={14} color={colors.textFaint} />
              <Text style={styles.explanationCalloutText}>{finalResult.recommendations}</Text>
            </View>
          )}
        </Card>
      )}

      {/* Share the result as one image (photo + data, no location). */}
      <Button
        title={L("Share result", "La wadaag natiijada")}
        variant="primary"
        icon={<Ionicons name="share-social-outline" size={18} color="#0B0B0C" />}
        onPress={shareResult}
        loading={sharing}
        disabled={photoUrl != null && !photoReady}
        style={styles.actionButton}
      />

      {/* ── Professional PDF Report (Pro / Gem Collector only) ───────────── */}
      {canPdf ? (
        <Button
          title={L("Download / Share PDF Report", "Soo deji / Wadaag Warbixin PDF")}
          variant="outline"
          icon={<Ionicons name="document-text-outline" size={18} color={colors.gold} />}
          onPress={downloadPdf}
          loading={pdfBusy}
          style={styles.actionButton}
          accessibilityLabel={L("Generate professional PDF report", "Samee warbixin PDF xirfadeed")}
        />
      ) : EXTERNAL_PURCHASES_ENABLED ? (
        // Locked for Free/Explorer (Android/web only — iOS hides the CTA per
        // App Store Guideline 3.1.1).
        <Card accent style={styles.pdfLockedCard}>
          <View style={styles.pdfLockedHeader}>
            <Ionicons name="ribbon" size={16} color="#C9A227" />
            <Text style={styles.pdfLockedTitle}>
              {L("Get a Deep Scan & Verification Certificate (PDF)", "Baaritaan Qoto Dheer iyo Shahaado Caddayn ah (PDF) hel")}
            </Text>
            <View style={styles.proTag}>
              <Text style={styles.proTagText}>PRO</Text>
            </View>
          </View>

          <Text style={styles.body}>
            {L(
              "A branded, professional PDF you can share with a buyer or for insurance:",
              "Warbixin PDF xirfadeed oo summadaysan oo aad la wadaagi karto iibsade ama caymis:",
            )}
          </Text>
          {[
            L("Identification + confidence level", "Aqoonsi + heerka kalsoonida"),
            L("Market value & alternative matches", "Qiimaha suuqa & ikhtiyaarro kale"),
            L("Hallmark details & AI analysis", "Faahfaahin hallmark & falanqayn AI"),
            L("Download, print & share anywhere", "Soo deji, daabac & wadaag meel kasta"),
          ].map((b) => (
            <Text key={b} style={styles.pdfSellBullet}>✓ {b}</Text>
          ))}

          <View style={styles.pdfPriceRow}>
            <Text style={styles.pdfPrice}>USD 14.99</Text>
            <Text style={styles.pdfPriceUnit}>{L("/ year", "/ sannadkii")}</Text>
          </View>

          <Button
            title={L("Buy Professional (Gem Collector)", "Iibso Xirmada Professional (Gem Collector)")}
            variant="primary"
            onPress={() => Linking.openURL(PAYMENT_URL)}
            style={styles.pdfUpgradeButton}
            accessibilityLabel={L("Buy the Professional (Gem Collector) plan", "Iibso xirmada Professional (Gem Collector)")}
          />
        </Card>
      ) : null}

      {/* ── Estimated Market Value (additive AI estimate) ─────────────────── */}
      {valuation && (
        <Card style={styles.valueCard}>
          <View style={styles.valueHeader}>
            <Text style={styles.sectionTitle}>{L("Estimated Market Value", "Qiimaha Suuqa (Qiyaas)")}</Text>
            <View style={styles.estimateChip}>
              <Ionicons name="sparkles-outline" size={11} color={colors.gold} />
              <Text style={styles.estimateChipText}>{L("AI ESTIMATE", "QIYAAS AI")}</Text>
            </View>
          </View>
          {valuation.lowConfidence || (valuation.minUsd == null && valuation.typicalUsd == null) ? (
            <Text style={styles.body}>
              {L(
                "More photographs or laboratory testing are required for an accurate valuation.",
                "Sawirro dheeraad ah ama baaritaan shaybaar ayaa loo baahan yahay qiimayn sax ah.",
              )}
            </Text>
          ) : (
            <>
              {valuation.minUsd != null && valuation.premiumUsd != null && (
                <Text style={styles.valueRange}>
                  USD {Math.round(valuation.minUsd)}–{Math.round(valuation.premiumUsd)}
                </Text>
              )}
              {valuation.typicalUsd != null && (
                <Text style={styles.valueTypical}>
                  {L("Typical value", "Qiimaha caadiga")}: ~USD {Math.round(valuation.typicalUsd)}
                </Text>
              )}
              {valuation.premiumUsd != null && valuation.collectible && (
                <Text style={styles.valuePremium}>
                  {L("Collector quality may exceed", "Tayada uruurinta way dhaafi kartaa")} USD{" "}
                  {Math.round(valuation.premiumUsd)}
                </Text>
              )}
              {!!valuation.qualityNote && <Text style={styles.valueNote}>{valuation.qualityNote}</Text>}
            </>
          )}
          <View style={styles.disclaimerPill}>
            <Ionicons name="information-circle-outline" size={13} color={colors.textFaint} />
            <Text style={styles.disclaimer}>
              {L(
                "This is an AI estimate, not a professional appraisal.",
                "Tani waa qiyaas AI ah, maaha qiimayn xirfadeed.",
              )}
            </Text>
          </View>
        </Card>
      )}

      {/* ── Expert Review Recommended (high-value / rare / collectible) ───── */}
      {valuation &&
        hasExpertContact() &&
        ((valuation.typicalUsd ?? 0) >= HIGH_VALUE_THRESHOLD_USD ||
          valuation.rarity === "rare" ||
          valuation.rarity === "very_rare" ||
          valuation.collectible) && (
          <Card accent style={styles.expertCard}>
            <Text style={styles.expertTitle}>{L("Expert Review Recommended", "Dib-u-eegis Khibrad ah")}</Text>
            <Text style={styles.body}>
              {L(
                "This object may have significant value. We recommend that you contact our gemstone expert for a professional review before selling, cleaning, or modifying the item.",
                "Shaygani wuxuu yeelan karaa qiimo weyn. Waxaan kugula talinaynaa inaad la xiriirto khabiirkayaga dhagxaanta ka hor intaadan iibin, nadiifin, ama wax ka beddelin.",
              )}
            </Text>

            {EXPERT_WHATSAPP ? (
              <Pressable style={styles.whatsappButton} onPress={openWhatsApp}>
                <Text style={styles.whatsappText}>💬 {L("Contact on WhatsApp", "La xiriir WhatsApp")}</Text>
              </Pressable>
            ) : null}

            <Text style={styles.expertHint}>
              {L("For a faster review, please send:", "Si loo dedejiyo, fadlan soo dir:")}
            </Text>
            {[
              L("Original photos", "Sawirrada asalka ah"),
              L("The identification report", "Warbixinta aqoonsiga"),
              L("Additional close-up images", "Sawirro dhow oo dheeraad ah"),
              L("Weight (if known)", "Miisaanka (haddii la ogyahay)"),
              L("Dimensions (if known)", "Cabbirrada (haddii la ogyahay)"),
              L("Country where it was found", "Wadanka laga helay"),
            ].map((item) => (
              <Text key={item} style={styles.expertBullet}>
                • {item}
              </Text>
            ))}
          </Card>
        )}

      {alternatives.length > 0 && (
        <>
          <Text style={[styles.label, { marginTop: 20 }]}>{L("Other possibilities", "Ikhtiyaarro kale")}</Text>
          {alternatives.map((c) => (
            <Card key={c.rank} style={styles.altCard}>
              <Text style={styles.altLabel}>{c.label}</Text>
              <ConfidenceBadge pct={c.weighted_confidence * 100} band={c.confidence_band} size="sm" />
            </Card>
          ))}
        </>
      )}

      {/* ── Where it was found (exact GPS capture location) ──────────────── */}
      {scan.capture_location && (
        <Card style={styles.locCard}>
          <Text style={styles.sectionTitle}>📍 {L("Where it was found", "Goobta laga helay")}</Text>
          <LocationMap
            markers={[
              {
                lat: scan.capture_location.lat,
                lng: scan.capture_location.lng,
                title: finalResult.bestMatch ?? undefined,
              },
            ]}
            height={200}
            zoom={17}
          />
          <View style={styles.locMetaRow}>
            <Text style={styles.locCoords}>
              {scan.capture_location.lat.toFixed(6)}, {scan.capture_location.lng.toFixed(6)}
              {typeof scan.capture_location.acc === "number"
                ? `  ·  ±${scan.capture_location.acc}m`
                : ""}
              {"  ·  "}
              {new Date(scan.created_at).toLocaleString()}
            </Text>
            <Pressable
              style={styles.mapsButton}
              onPress={() =>
                openInMaps(
                  scan.capture_location!.lat,
                  scan.capture_location!.lng,
                  finalResult.bestMatch ?? undefined,
                )
              }
            >
              <Text style={styles.mapsButtonText}>{L("Open in Maps", "Fur Maps")}</Text>
            </Pressable>
          </View>
          <Text style={styles.disclaimer}>
            {L(
              "This is the exact GPS location recorded when the specimen was scanned.",
              "Tani waa goobta GPS-ka saxda ah ee la diiwaangeliyay markii shayga la baaray.",
            )}
          </Text>
        </Card>
      )}

      <Text style={[styles.label, { marginTop: 20 }]}>{L("Was this correct?", "Kani ma saxaa?")}</Text>
      {feedbackSent ? (
        <Text style={styles.body}>{L("Thanks — your feedback helps improve GemScan.", "Mahadsanid — jawaabtaadu waxay ka caawinaysaa hagaajinta GemScan.")}</Text>
      ) : (
        <View style={{ flexDirection: "row", gap: 12 }}>
          <Pressable style={styles.feedbackButton} onPress={() => handleFeedback(true)}>
            <Text style={styles.primaryButtonText}>{L("Yes", "Haa")}</Text>
          </Pressable>
          <Pressable style={styles.feedbackButtonSecondary} onPress={() => handleFeedback(false)}>
            <Text style={styles.secondaryButtonText}>{L("No", "Maya")}</Text>
          </Pressable>
        </View>
      )}

      <Pressable
        style={[styles.primaryButton, { marginTop: 24 }]}
        onPress={() => router.replace("/(app)/scan/capture")}
      >
        <Text style={styles.primaryButtonText}>{L("Scan Another Specimen", "Baar shay kale")}</Text>
      </Pressable>
    </ScrollView>

    {/* Off-screen card captured to a single image for sharing (photo + data,
        no location). Rendered off-screen so it never affects the visible layout. */}
    <View style={styles.offscreen} pointerEvents="none">
      <ViewShot ref={shareCardRef} options={{ format: "png", quality: 0.95 }}>
        <View style={styles.shareCard} collapsable={false}>
          <Text style={styles.scLogo}>💎 GemScan</Text>
          {photoUrl && (
            <Image
              source={{ uri: photoUrl }}
              style={styles.scPhoto}
              resizeMode="cover"
              onLoad={() => setPhotoReady(true)}
              onError={() => setPhotoReady(true)}
            />
          )}
          <Text style={styles.scLabel}>{L("Identification", "Aqoonsiga")}</Text>
          <Text style={styles.scMatch}>{finalResult.bestMatch}</Text>
          <View style={[styles.scBand, { backgroundColor: BAND_COLOR[finalResult.confidenceBand] }]}>
            <Text style={styles.scBandText}>
              {bandWord(finalResult.confidenceBand)} {L("CONFIDENCE", "KALSOONI")} · {pct}%
            </Text>
          </View>
          {valuation && !valuation.lowConfidence && (valuation.minUsd != null || valuation.typicalUsd != null) && (
            <Text style={styles.scValue}>
              {L("Estimated value", "Qiimaha suuqa (qiyaas)")}:{" "}
              {valuation.minUsd != null && valuation.premiumUsd != null
                ? `USD ${Math.round(valuation.minUsd)}–${Math.round(valuation.premiumUsd)}`
                : `~USD ${Math.round(valuation.typicalUsd ?? 0)}`}
            </Text>
          )}
          {alternatives.length > 0 && (
            <Text style={styles.scAlts}>
              {L("Other possibilities", "Ikhtiyaarro kale")}: {alternatives.map((c) => c.label).join(", ")}
            </Text>
          )}
          <Text style={styles.scFooter}>
            {L(
              "Identified with GemScan — expert gemstone, gold & coin identification.",
              "La aqoonsaday GemScan — aqoonsi khibrad leh oo dhagxaan, dahab & qadaadiic.",
            )}
          </Text>
        </View>
      </ViewShot>
    </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: "#0B0B0C", padding: 20, gap: 10 },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  label: { ...typo.label, marginTop: 0, marginBottom: 0 },
  bestMatch: { fontSize: 28, fontWeight: "800", color: colors.text },
  heroCard: { alignItems: "flex-start", gap: spacing.sm, marginBottom: spacing.xs },
  actionButton: { marginTop: spacing.xs },
  explanationCard: { gap: spacing.sm, marginBottom: spacing.xs },
  styleToggle: {
    flexDirection: "row",
    backgroundColor: "#1F1F22",
    borderRadius: 999,
    padding: 3,
    alignSelf: "flex-start",
  },
  styleToggleOption: { paddingVertical: 6, paddingHorizontal: 16, borderRadius: 999 },
  styleToggleOptionActive: { backgroundColor: "#C9A227" },
  styleToggleText: { color: "#C9C9CC", fontWeight: "700", fontSize: 13 },
  styleToggleTextActive: { color: "#0B0B0C" },
  expertRow: { gap: 2 },
  expertLabel: {
    color: colors.gold,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  expertValue: { color: "#F5F1E8", fontSize: 13.5, lineHeight: 19 },
  explanationCallout: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  explanationCalloutText: { flex: 1, color: "#C9C9CC", fontSize: 12.5, lineHeight: 18 },
  pdfLockedCard: { marginTop: spacing.sm, gap: spacing.sm },
  pdfLockedHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  pdfLockedTitle: { color: "#F5F1E8", fontWeight: "800", fontSize: 16, flex: 1, lineHeight: 21 },
  pdfSellBullet: { color: "#E8E2D2", fontSize: 13, lineHeight: 20 },
  pdfPriceRow: { flexDirection: "row", alignItems: "flex-end", gap: 6, marginTop: 4 },
  pdfPrice: { color: "#C9A227", fontSize: 26, fontWeight: "900" },
  pdfPriceUnit: { color: "#8A8A8E", fontSize: 13, fontWeight: "700", marginBottom: 4 },
  proTag: {
    backgroundColor: "#C9A227",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  proTagText: { color: "#0B0B0C", fontWeight: "900", fontSize: 11, letterSpacing: 0.5 },
  pdfUpgradeButton: { marginTop: spacing.xs },
  // Off-screen container: rendered (so it can be captured) but never visible.
  offscreen: { position: "absolute", left: -10000, top: 0 },
  shareCard: {
    width: 380,
    backgroundColor: "#0B0B0C",
    padding: 22,
    gap: 10,
  },
  scLogo: { fontSize: 24, fontWeight: "900", color: "#C9A227" },
  scPhoto: { width: "100%", height: 300, borderRadius: 14, backgroundColor: "#1A1A1D", marginVertical: 4 },
  scLabel: { fontSize: 12, color: "#8A8A8E", textTransform: "uppercase", letterSpacing: 0.5 },
  scMatch: { fontSize: 26, fontWeight: "800", color: "#F5F1E8" },
  scBand: { alignSelf: "flex-start", paddingVertical: 5, paddingHorizontal: 12, borderRadius: 999 },
  scBandText: { color: "#0B0B0C", fontWeight: "800", fontSize: 12 },
  scValue: { fontSize: 16, color: "#C9A227", fontWeight: "700", marginTop: 4 },
  scAlts: { fontSize: 13, color: "#C9C9CC", lineHeight: 19 },
  scFooter: { fontSize: 12, color: "#8A8A8E", fontStyle: "italic", marginTop: 8, lineHeight: 17 },
  insufficientTitle: { fontSize: 18, fontWeight: "700", color: "#F5F1E8" },
  suggestion: { color: "#C9C9CC", fontSize: 13 },
  altCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  altLabel: { color: "#F5F1E8", fontWeight: "600", fontSize: 14, flexShrink: 1, marginRight: spacing.sm },
  altConfidence: { color: "#C9A227", fontSize: 12 },
  primaryButton: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
  secondaryButtonText: { color: "#F5F1E8", fontWeight: "700", fontSize: 15 },
  feedbackButton: {
    flex: 1,
    backgroundColor: "#2E7D32",
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: "center",
  },
  feedbackButtonSecondary: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#8A8A8E",
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: "center",
  },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: "#F5F1E8", marginBottom: 4 },
  valueCard: { marginTop: spacing.lg, gap: 4 },
  valueHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  estimateChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.goldSoft,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  estimateChipText: { color: colors.gold, fontWeight: "800", fontSize: 10, letterSpacing: 0.4 },
  valueRange: { fontSize: 22, fontWeight: "800", color: "#C9A227" },
  valueTypical: { fontSize: 14, color: "#F5F1E8" },
  valuePremium: { fontSize: 13, color: "#C9A227" },
  valueNote: { fontSize: 13, color: "#C9C9CC", lineHeight: 19, marginTop: 4 },
  disclaimer: { fontSize: 12, color: colors.textFaint, lineHeight: 16, flexShrink: 1 },
  disclaimerPill: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  expertCard: { marginTop: spacing.lg, gap: spacing.sm },
  expertTitle: { fontSize: 17, fontWeight: "800", color: "#C9A227" },
  whatsappButton: { backgroundColor: "#25D366", borderRadius: 999, paddingVertical: 14, alignItems: "center", marginTop: 4 },
  whatsappText: { color: "#06381A", fontWeight: "800", fontSize: 15 },
  contactButton: { backgroundColor: "#C9A227", borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  contactText: { color: "#0B0B0C", fontWeight: "800", fontSize: 15 },
  expertHint: { color: "#C9C9CC", fontSize: 13, marginTop: 6, fontWeight: "600" },
  expertBullet: { color: "#C9C9CC", fontSize: 13, lineHeight: 19 },
  locCard: { marginTop: spacing.lg, gap: spacing.sm },
  locMetaRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  locCoords: { flex: 1, color: "#8A8A8E", fontSize: 12 },
  mapsButton: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  mapsButtonText: { color: "#0B0B0C", fontWeight: "800", fontSize: 13 },
});

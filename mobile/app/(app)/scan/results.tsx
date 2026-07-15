// Stage 6 result display + Stage 7 feedback capture.
//
// Reads the persisted `scans.final_result` and ranked `scan_candidates`
// directly from Supabase (RLS-scoped to the caller) rather than relying on
// navigation params, so this screen also works if the user re-opens a past
// scan from history later.
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView, Linking } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { supabase } from "../../../lib/supabase";
import { submitScanFeedback } from "../../../lib/scanUpload";
import { INSUFFICIENT_CONFIDENCE_MESSAGE_TEXT } from "../../../lib/constants";
import { estimateValue, type Valuation } from "../../../lib/valuation";
import { EXPERT_WHATSAPP, HIGH_VALUE_THRESHOLD_USD, hasExpertContact } from "../../../lib/expertConfig";
import LocationMap from "../../../components/LocationMap";

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
  } | null;
};

const BAND_COLOR: Record<string, string> = {
  high: "#2E7D32",
  medium: "#C9A227",
  low: "#8A8A8E",
};

export default function ResultsScreen() {
  const { scanId } = useLocalSearchParams<{ scanId: string }>();
  const router = useRouter();
  const { i18n } = useTranslation();
  const lang: "en" | "so" = i18n.language === "so" ? "so" : "en";
  const L = (en: string, so: string) => (lang === "so" ? so : en);

  const [scan, setScan] = useState<ScanRow | null>(null);
  const [candidates, setCandidates] = useState<ScanCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [valuation, setValuation] = useState<Valuation | null>(null);

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
      setScan(scanData as ScanRow | null);
      setCandidates((candidateData as ScanCandidate[]) ?? []);
      setIsLoading(false);
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

  // Build a COMPLETE report (the data the app gathered) and open WhatsApp with
  // it pre-filled. wa.me links can only carry text, so we include the full
  // identification report and ask the user to attach their scan photos.
  function openWhatsApp() {
    if (!EXPERT_WHATSAPP) return;
    const fr = scan?.final_result;
    const alts = candidates.filter((c) => c.rank > 1).map((c) => c.label);
    const pct = Math.round((fr?.confidenceScore ?? 0) * 100);
    const so = lang === "so";
    const lines: string[] = [];
    if (so) {
      lines.push("Salaan, waa kan natiijada GemScan:", "");
      if (fr?.bestMatch) lines.push(`• Aqoonsiga: ${fr.bestMatch}`);
      lines.push(`• Kalsooni: ${pct}%`);
      if (valuation?.typicalUsd) lines.push(`• Qiimo qiyaasi ah: ~USD ${Math.round(valuation.typicalUsd)}`);
      if (alts.length) lines.push(`• Ikhtiyaarro kale: ${alts.join(", ")}`);
      lines.push("", "Waxaan rabaa dib-u-eegis khibrad leh. Waxaan ku lifaaqi doonaa sawirradii scan-ka.");
    } else {
      lines.push("Hello, here is my GemScan result:", "");
      if (fr?.bestMatch) lines.push(`• Identification: ${fr.bestMatch}`);
      lines.push(`• Confidence: ${pct}%`);
      if (valuation?.typicalUsd) lines.push(`• Estimated value: ~USD ${Math.round(valuation.typicalUsd)}`);
      if (alts.length) lines.push(`• Alternatives: ${alts.join(", ")}`);
      lines.push("", "I would like a professional review. I will attach my scan photos.");
    }
    const text = encodeURIComponent(lines.join("\n"));
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
      <ScrollView contentContainerStyle={styles.container}>
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
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.label}>{L("Best match", "Aqoonsiga ugu fiican")}</Text>
      <Text style={styles.bestMatch}>{finalResult.bestMatch}</Text>
      <View style={[styles.bandPill, { backgroundColor: BAND_COLOR[finalResult.confidenceBand] }]}>
        <Text style={styles.bandPillText}>
          {bandWord(finalResult.confidenceBand)} {L("CONFIDENCE", "KALSOONI")} · {pct}%
        </Text>
      </View>
      <Text style={styles.body}>
        {L(
          `Identified as the best match with ${pct}% confidence from our expert gemstone analysis.`,
          `Waxaa loo aqoonsaday inuu yahay aqoonsiga ugu fiican, kalsooni ${pct}%, iyada oo lagu saleeyay baaritaankayaga khibradda leh.`,
        )}
      </Text>

      {/* ── Estimated Market Value (additive AI estimate) ─────────────────── */}
      {valuation && (
        <View style={styles.valueCard}>
          <Text style={styles.sectionTitle}>{L("Estimated Market Value", "Qiimaha Suuqa (Qiyaas)")}</Text>
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
          <Text style={styles.disclaimer}>
            {L(
              "This valuation is only an estimate based on photographs and should not be considered a professional appraisal.",
              "Qiimayntani waa qiyaas ku saleysan sawirro, lamana tirin karo qiimayn xirfadeed.",
            )}
          </Text>
        </View>
      )}

      {/* ── Expert Review Recommended (high-value / rare / collectible) ───── */}
      {valuation &&
        hasExpertContact() &&
        ((valuation.typicalUsd ?? 0) >= HIGH_VALUE_THRESHOLD_USD ||
          valuation.rarity === "rare" ||
          valuation.rarity === "very_rare" ||
          valuation.collectible) && (
          <View style={styles.expertCard}>
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
          </View>
        )}

      {alternatives.length > 0 && (
        <>
          <Text style={[styles.label, { marginTop: 20 }]}>{L("Other possibilities", "Ikhtiyaarro kale")}</Text>
          {alternatives.map((c) => (
            <View key={c.rank} style={styles.altCard}>
              <Text style={styles.altLabel}>{c.label}</Text>
              <Text style={styles.altConfidence}>
                {Math.round(c.weighted_confidence * 100)}% · {bandWord(c.confidence_band).toLowerCase()}
              </Text>
            </View>
          ))}
        </>
      )}

      {/* ── Where it was found (exact GPS capture location) ──────────────── */}
      {scan.capture_location && (
        <View style={styles.locCard}>
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
        </View>
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
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: "#0B0B0C", padding: 20, gap: 10 },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  label: { fontSize: 13, color: "#8A8A8E", textTransform: "uppercase", letterSpacing: 0.5 },
  bestMatch: { fontSize: 26, fontWeight: "700", color: "#F5F1E8" },
  bandPill: { alignSelf: "flex-start", paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  bandPillText: { color: "#0B0B0C", fontWeight: "700", fontSize: 11 },
  insufficientTitle: { fontSize: 18, fontWeight: "700", color: "#F5F1E8" },
  suggestion: { color: "#C9C9CC", fontSize: 13 },
  altCard: {
    borderWidth: 1,
    borderColor: "#2A2A2C",
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  altLabel: { color: "#F5F1E8", fontWeight: "600", fontSize: 14 },
  altConfidence: { color: "#C9A227", fontSize: 12 },
  altReason: { color: "#8A8A8E", fontSize: 12 },
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
  valueCard: {
    marginTop: 16,
    backgroundColor: "#161618",
    borderRadius: 14,
    padding: 14,
    gap: 4,
  },
  valueRange: { fontSize: 22, fontWeight: "800", color: "#C9A227" },
  valueTypical: { fontSize: 14, color: "#F5F1E8" },
  valuePremium: { fontSize: 13, color: "#C9A227" },
  valueNote: { fontSize: 13, color: "#C9C9CC", lineHeight: 19, marginTop: 4 },
  disclaimer: { fontSize: 11, color: "#8A8A8E", lineHeight: 16, marginTop: 8, fontStyle: "italic" },
  expertCard: {
    marginTop: 16,
    backgroundColor: "rgba(201,162,39,0.12)",
    borderWidth: 1,
    borderColor: "#C9A227",
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  expertTitle: { fontSize: 17, fontWeight: "800", color: "#C9A227" },
  whatsappButton: { backgroundColor: "#25D366", borderRadius: 999, paddingVertical: 14, alignItems: "center", marginTop: 4 },
  whatsappText: { color: "#06381A", fontWeight: "800", fontSize: 15 },
  contactButton: { backgroundColor: "#C9A227", borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  contactText: { color: "#0B0B0C", fontWeight: "800", fontSize: 15 },
  expertHint: { color: "#C9C9CC", fontSize: 13, marginTop: 6, fontWeight: "600" },
  expertBullet: { color: "#C9C9CC", fontSize: 13, lineHeight: 19 },
  locCard: {
    marginTop: 16,
    backgroundColor: "#161618",
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
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

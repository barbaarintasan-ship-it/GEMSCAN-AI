// Stage 6 result display + Stage 7 feedback capture.
//
// Reads the persisted `scans.final_result` and ranked `scan_candidates`
// directly from Supabase (RLS-scoped to the caller) rather than relying on
// navigation params, so this screen also works if the user re-opens a past
// scan from history later.
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { supabase } from "../../../lib/supabase";
import { submitScanFeedback } from "../../../lib/scanUpload";
import { INSUFFICIENT_CONFIDENCE_MESSAGE_TEXT } from "../../../lib/constants";

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

  const [scan, setScan] = useState<ScanRow | null>(null);
  const [candidates, setCandidates] = useState<ScanCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [feedbackSent, setFeedbackSent] = useState(false);

  useEffect(() => {
    if (!scanId) return;
    (async () => {
      const [{ data: scanData }, { data: candidateData }] = await Promise.all([
        supabase.from("scans").select("status, final_result").eq("id", scanId).maybeSingle(),
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
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.insufficientTitle}>
          {finalResult?.message ?? INSUFFICIENT_CONFIDENCE_MESSAGE_TEXT}
        </Text>
        <Text style={styles.body}>To improve your result, try:</Text>
        {(finalResult?.suggestions ?? []).map((s) => (
          <Text key={s} style={styles.suggestion}>
            • {s}
          </Text>
        ))}
        <Pressable style={styles.primaryButton} onPress={() => router.replace("/(app)/scan/capture")}>
          <Text style={styles.primaryButtonText}>Retake Photos</Text>
        </Pressable>
      </ScrollView>
    );
  }

  const best = candidates.find((c) => c.rank === 1);
  const alternatives = candidates.filter((c) => c.rank > 1);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.label}>Best match</Text>
      <Text style={styles.bestMatch}>{finalResult.bestMatch}</Text>
      <View style={[styles.bandPill, { backgroundColor: BAND_COLOR[finalResult.confidenceBand] }]}>
        <Text style={styles.bandPillText}>
          {finalResult.confidenceBand.toUpperCase()} CONFIDENCE ·{" "}
          {(finalResult.confidenceScore * 100).toFixed(0)}%
        </Text>
      </View>
      {best?.rationale && <Text style={styles.body}>{best.rationale}</Text>}

      {alternatives.length > 0 && (
        <>
          <Text style={[styles.label, { marginTop: 20 }]}>Other possibilities</Text>
          {alternatives.map((c) => (
            <View key={c.rank} style={styles.altCard}>
              <Text style={styles.altLabel}>{c.label}</Text>
              <Text style={styles.altConfidence}>
                {(c.weighted_confidence * 100).toFixed(0)}% · {c.confidence_band}
              </Text>
              {c.rejected_reason && <Text style={styles.altReason}>{c.rejected_reason}</Text>}
            </View>
          ))}
        </>
      )}

      <Text style={[styles.label, { marginTop: 20 }]}>Was this correct?</Text>
      {feedbackSent ? (
        <Text style={styles.body}>Thanks — your feedback helps improve GemScan AI.</Text>
      ) : (
        <View style={{ flexDirection: "row", gap: 12 }}>
          <Pressable style={styles.feedbackButton} onPress={() => handleFeedback(true)}>
            <Text style={styles.primaryButtonText}>Yes</Text>
          </Pressable>
          <Pressable style={styles.feedbackButtonSecondary} onPress={() => handleFeedback(false)}>
            <Text style={styles.secondaryButtonText}>No</Text>
          </Pressable>
        </View>
      )}

      <Pressable
        style={[styles.primaryButton, { marginTop: 24 }]}
        onPress={() => router.replace("/(app)/scan/capture")}
      >
        <Text style={styles.primaryButtonText}>Scan Another Specimen</Text>
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
});

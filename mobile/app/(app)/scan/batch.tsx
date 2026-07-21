// BATCH SCAN (Pro / "Gem Collector" only — reuses the existing
// features.batchScanning entitlement; nothing about entitlements, pricing or
// credits is changed here).
//
// Lets the user capture or pick up to MAX_BATCH_ITEMS photos — EACH photo is
// ONE separate object (no multi-object detection inside a single image) —
// choose Standard or Deep Scan ONCE for the whole batch, then processes every
// image SEQUENTIALLY through the exact same pipeline a single scan uses
// (createScan → uploadScanImage → runOrchestration), one item at a time, so
// credits/limits/entitlements are enforced exactly as they are today. Each
// item is saved as a normal, independent scan — it shows up in History like
// any other scan. Results are handed to the Batch Results screen.
import React, { useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView, Image, Linking } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { ImageProcessorGL, type ImageProcessorHandle } from "../../../components/ImageProcessorGL";
import { detectSpecimenBoundingBox, classifyCoarse } from "../../../lib/onDeviceDetection";
import { segmentBackground } from "../../../lib/backgroundSegmentation";
import { getPreciseLocation } from "../../../lib/location";
import {
  createScan,
  uploadScanImage,
  runOrchestration,
  OrchestrationError,
  type ScanLocation,
  type ScanType,
} from "../../../lib/scanUpload";
import { estimateValue, formatValuationRange } from "../../../lib/valuation";
import { useSubscriptionStatus } from "../../../lib/subscription";
import { PAYMENT_URL, EXTERNAL_PURCHASES_ENABLED } from "../../../lib/appLinks";
import ScanTypeChooser from "../../../components/ScanTypeChooser";
import type { BatchItemResult, BatchStopReason } from "../../../lib/batchTypes";
import { ScanTipsCard } from "../../../components/ui/ScanTipsCard";
import { Card } from "../../../components/ui/Card";
import { colors, spacing } from "../../../lib/theme";

const MAX_BATCH_ITEMS = 20;

export default function BatchScanScreen() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const lang: "en" | "so" = i18n.language === "so" ? "so" : "en";
  const L = (en: string, so: string) => (lang === "so" ? so : en);

  const { data: sub } = useSubscriptionStatus();
  const canBatch = sub?.features?.batchScanning ?? false;

  const imageProcessorRef = useRef<ImageProcessorHandle>(null);
  const [images, setImages] = useState<string[]>([]);
  const [phase, setPhase] = useState<"select" | "processing">("select");
  const [chooserVisible, setChooserVisible] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const cancelRef = useRef(false);

  const deepRemaining = sub?.deepScan.remaining ?? 0;

  // ── Pro-only gate (reuses the existing batchScanning entitlement as-is) ──
  if (!canBatch) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.lockedCard}>
          <Ionicons name="layers" size={30} color="#C9A227" />
          <Text style={styles.lockedTitle}>
            {L("Batch Scan is a Gem Collector feature", "Batch Scan waa feature Gem Collector")}
          </Text>
          <Text style={styles.body}>
            {L(
              "Scan up to 20 objects in one session instead of repeating the flow one by one — included with the Gem Collector plan.",
              "Baar ilaa 20 shay hal fadhi ah, halkii aad mar walba ku celin lahayd — wuxuu ku jiraa qorshaha Gem Collector.",
            )}
          </Text>
          {EXTERNAL_PURCHASES_ENABLED && (
            <Pressable style={styles.primaryButton} onPress={() => Linking.openURL(PAYMENT_URL)}>
              <Text style={styles.primaryButtonText}>{L("View plans", "Arag qorshayaasha")}</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    );
  }

  async function handleAddFromGallery() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 1,
      selectionLimit: MAX_BATCH_ITEMS,
    });
    if (result.canceled || result.assets.length === 0) return;
    setImages((prev) => {
      const merged = [...prev];
      for (const asset of result.assets) {
        if (!merged.includes(asset.uri)) merged.push(asset.uri);
      }
      return merged.slice(0, MAX_BATCH_ITEMS);
    });
  }

  // One photo at a time via the system camera UI — the user taps this
  // repeatedly to build up the batch, same permission the live/manual
  // scanners already use (expo-camera's plugin registers it).
  async function handleAddFromCamera() {
    const result = await ImagePicker.launchCameraAsync({ quality: 1 });
    if (result.canceled || result.assets.length === 0) return;
    setImages((prev) => {
      if (prev.length >= MAX_BATCH_ITEMS) return prev;
      const uri = result.assets[0].uri;
      return prev.includes(uri) ? prev : [...prev, uri].slice(0, MAX_BATCH_ITEMS);
    });
  }

  function removeImage(uri: string) {
    setImages((prev) => prev.filter((u) => u !== uri));
  }

  function handleCancel() {
    cancelRef.current = true;
  }

  async function runBatch(scanType: ScanType) {
    setChooserVisible(false);
    setPhase("processing");
    cancelRef.current = false;

    const results: BatchItemResult[] = [];
    let stopReason: BatchStopReason = null;

    // One GPS fix for the whole batch — every item was found/photographed in
    // the same session, and repeating a high-accuracy fix per item would add
    // real delay for no benefit.
    const location: ScanLocation | null = await getPreciseLocation();

    for (let i = 0; i < images.length; i++) {
      if (cancelRef.current) break;

      setProgress({ current: i + 1, total: images.length });
      const uri = images[i];

      try {
        if (!imageProcessorRef.current) throw new Error("Image processor not ready");
        const quality = await imageProcessorRef.current.assessQuality(uri);
        const [detectionBbox, enhanced] = await Promise.all([
          detectSpecimenBoundingBox(uri),
          imageProcessorRef.current.enhance(uri),
        ]);
        const onDeviceHint = await classifyCoarse(enhanced.uri).catch(() => null);

        const scanId = await createScan({ specimenCategory: null, location });
        const segmented = await segmentBackground(enhanced.uri);
        await uploadScanImage(scanId, {
          angle: "front",
          originalUri: uri,
          processedUri: segmented.uri,
          quality,
          detectionBbox,
        });

        const orchestrated = await runOrchestration(scanId, onDeviceHint, scanType);
        const fr = orchestrated.finalResult;

        let valueLabel: string | null = null;
        if (fr.bestMatch && !fr.insufficientConfidence) {
          const val = await estimateValue(fr.bestMatch, fr.confidenceScore, lang).catch(() => null);
          valueLabel = val ? formatValuationRange(val, lang === "so") : null;
        }

        results.push({
          imageUri: uri,
          scanId,
          status: "completed",
          label: fr.bestMatch,
          confidencePct: Math.round(fr.confidenceScore * 100),
          band: fr.confidenceBand,
          valueLabel,
          scanType,
          errorMessage: null,
        });
      } catch (err) {
        if (
          err instanceof OrchestrationError &&
          (err.code === "deep_credits_exhausted" || err.code === "standard_limit_reached")
        ) {
          stopReason = err.code;
          results.push({
            imageUri: uri,
            scanId: null,
            status: "skipped",
            label: null,
            confidencePct: null,
            band: null,
            valueLabel: null,
            scanType,
            errorMessage: err.message,
          });
          break; // Every remaining item would fail identically — stop, don't waste calls.
        }
        results.push({
          imageUri: uri,
          scanId: null,
          status: "failed",
          label: null,
          confidencePct: null,
          band: null,
          valueLabel: null,
          scanType,
          errorMessage: (err as Error).message,
        });
      }
    }

    // Anything left un-attempted (cancelled, or stopped by a limit) is
    // recorded as "skipped" so the results screen accounts for every photo.
    for (let i = results.length; i < images.length; i++) {
      results.push({
        imageUri: images[i],
        scanId: null,
        status: "skipped",
        label: null,
        confidencePct: null,
        band: null,
        valueLabel: null,
        scanType,
        errorMessage: null,
      });
    }

    router.replace({
      pathname: "/(app)/scan/batch-results",
      params: { data: JSON.stringify(results), stopReason: stopReason ?? "" },
    });
  }

  if (phase === "processing") {
    const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
    return (
      <View style={styles.centered}>
        <ImageProcessorGL ref={imageProcessorRef} />
        <Card style={styles.progressCard}>
          <ActivityIndicator color={colors.gold} size="large" />
          <Text style={styles.progressLabel}>
            {L(
              `Scanning ${progress.current} of ${progress.total}…`,
              `Baaritaan ${progress.current} ee ${progress.total}…`,
            )}
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${pct}%` }]} />
          </View>
        </Card>
        <Pressable style={styles.cancelButton} onPress={handleCancel}>
          <Text style={styles.cancelButtonText}>{L("Cancel remaining", "Jooji intii hadhay")}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <ImageProcessorGL ref={imageProcessorRef} />
      <Text style={styles.heading}>{L("Batch Scan", "Batch Scan")}</Text>
      <Text style={styles.body}>
        {L(
          `Take or choose up to ${MAX_BATCH_ITEMS} photos — one object per photo. You'll pick Standard or Deep Scan once, then every photo is processed in order.`,
          `Sawir ama dooro ilaa ${MAX_BATCH_ITEMS} sawir — hal shay sawir kasta. Hal mar ayaad dooranaysaa Standard ama Deep Scan, ka dibna sawir kastaa si kala horreysa ayaa loo baarayaa.`,
        )}
      </Text>

      <ScanTipsCard />

      {images.length > 0 && (
        <View style={styles.grid}>
          {images.map((uri) => (
            <View key={uri} style={styles.thumbWrap}>
              <Image source={{ uri }} style={styles.thumb} />
              <Pressable
                style={styles.removeBadge}
                onPress={() => removeImage(uri)}
                hitSlop={8}
                accessibilityLabel={L("Remove image", "Ka saar sawirka")}
              >
                <Ionicons name="close" size={16} color="#F5F1E8" />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.counter}>
        {images.length} / {MAX_BATCH_ITEMS} {L("selected", "la doortay")}
      </Text>

      {images.length < MAX_BATCH_ITEMS && (
        <View style={styles.addRow}>
          <Pressable style={styles.secondaryButton} onPress={handleAddFromCamera}>
            <Ionicons name="camera-outline" size={18} color="#C9A227" />
            <Text style={styles.secondaryButtonText}>{L("Take Photo", "Sawir Qaad")}</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={handleAddFromGallery}>
            <Ionicons name="images-outline" size={18} color="#C9A227" />
            <Text style={styles.secondaryButtonText}>{L("From Gallery", "Maktabadda")}</Text>
          </Pressable>
        </View>
      )}

      {images.length > 0 && (
        <Pressable style={styles.primaryButton} onPress={() => setChooserVisible(true)}>
          <Text style={styles.primaryButtonText}>
            {L(`Scan all ${images.length}`, `Baar dhammaan ${images.length}`)}
          </Text>
        </Pressable>
      )}

      <ScanTypeChooser
        visible={chooserVisible}
        remaining={deepRemaining}
        recommendDeep={false}
        onChoose={runBatch}
        onClose={() => setChooserVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: "#0B0B0C", padding: 24, gap: 14 },
  centered: {
    flex: 1,
    backgroundColor: "#0B0B0C",
    padding: 24,
    gap: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  heading: { fontSize: 20, fontWeight: "700", color: "#F5F1E8" },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  progressCard: { width: "100%", alignItems: "center", gap: spacing.md },
  progressLabel: { color: colors.text, fontWeight: "700", fontSize: 15, textAlign: "center" },
  progressTrack: {
    width: "100%", height: 6, borderRadius: 3, backgroundColor: colors.surfaceSunken, overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: colors.gold, borderRadius: 3 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  thumbWrap: { width: 84, alignItems: "center" },
  thumb: { width: 84, height: 84, borderRadius: 12, backgroundColor: "#1A1A1D" },
  removeBadge: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#E4685D",
    alignItems: "center",
    justifyContent: "center",
  },
  counter: { color: "#8A8A8E", fontSize: 12 },
  addRow: { flexDirection: "row", gap: 10 },
  secondaryButton: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
  },
  secondaryButtonText: { color: "#C9A227", fontWeight: "700", fontSize: 14 },
  primaryButton: { backgroundColor: "#C9A227", borderRadius: 999, paddingVertical: 16, alignItems: "center" },
  primaryButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 16 },
  cancelButton: { marginTop: 8, paddingVertical: 10, paddingHorizontal: 20 },
  cancelButtonText: { color: "#E4685D", fontWeight: "700", fontSize: 14, textDecorationLine: "underline" },
  lockedCard: {
    backgroundColor: "rgba(201,162,39,0.12)",
    borderWidth: 1,
    borderColor: "#C9A227",
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
    gap: 10,
  },
  lockedTitle: { color: "#F5F1E8", fontWeight: "800", fontSize: 17, textAlign: "center" },
});

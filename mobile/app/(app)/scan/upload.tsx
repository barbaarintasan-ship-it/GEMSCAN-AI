// UPLOAD MODE (secondary).
//
// Two-step, explicit flow (by user request):
//   1. SELECT — pick one or many photos from the gallery. They are shown as
//      thumbnails; the user can remove any and add more. NOTHING is sent yet.
//   2. SEND — only when the user taps "Send for analysis" do we prepare the
//      images (aspect-preserving resize) and run the SAME cloud handoff
//      (createScan → uploadScanImage → runOrchestration) as the other modes.
//
// Picked images map, in order, onto the multi-angle sequence (front, left, …)
// so each satisfies the scan_images unique(scan_id, angle) constraint.
import React, { useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView, Image } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { ImageProcessorGL, type ImageProcessorHandle } from "../../../components/ImageProcessorGL";
import { detectSpecimenBoundingBox, classifyCoarse } from "../../../lib/onDeviceDetection";
import { segmentBackground } from "../../../lib/backgroundSegmentation";
import { getFuzzedLocation } from "../../../lib/location";
import { createScan, uploadScanImage, runOrchestration, type CapturedAngleImage } from "../../../lib/scanUpload";
import { captureException } from "../../../lib/monitoring";
import { LIVE_ANGLE_SEQUENCE } from "../../../lib/liveScanEngine";

const MAX_IMAGES = LIVE_ANGLE_SEQUENCE.length;

export default function UploadScreen() {
  const router = useRouter();
  const imageProcessorRef = useRef<ImageProcessorHandle>(null);
  const [images, setImages] = useState<string[]>([]);
  const [phase, setPhase] = useState<"select" | "processing" | "analyzing">("select");
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function handleAddImages() {
    setErrorText(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 1,
      selectionLimit: MAX_IMAGES,
    });
    if (result.canceled || result.assets.length === 0) return;
    // Append to the current selection, de-duplicated, capped at MAX_IMAGES.
    setImages((prev) => {
      const merged = [...prev];
      for (const asset of result.assets) {
        if (!merged.includes(asset.uri)) merged.push(asset.uri);
      }
      return merged.slice(0, MAX_IMAGES);
    });
  }

  function removeImage(uri: string) {
    setImages((prev) => prev.filter((u) => u !== uri));
  }

  // Only here — after the user explicitly taps Send — is anything prepared or
  // uploaded. Nothing about the photos leaves the device before this.
  async function handleSend() {
    if (images.length === 0) return;
    if (!imageProcessorRef.current) {
      setErrorText("Image processor is still starting — try again in a moment.");
      return;
    }
    setErrorText(null);
    setPhase("processing");
    try {
      const captured: CapturedAngleImage[] = [];
      for (let i = 0; i < images.length; i++) {
        const angle = LIVE_ANGLE_SEQUENCE[i].angle;
        setStatusText(`Preparing image ${i + 1} of ${images.length}…`);
        const uri = images[i];
        const quality = await imageProcessorRef.current.assessQuality(uri);
        const [detectionBbox, enhanced] = await Promise.all([
          detectSpecimenBoundingBox(uri),
          imageProcessorRef.current.enhance(uri),
        ]);
        captured.push({ angle, originalUri: uri, processedUri: enhanced.uri, quality, detectionBbox });
      }

      setPhase("analyzing");
      setStatusText(null);
      const location = await getFuzzedLocation();
      const front = captured.find((c) => c.angle === "front") ?? captured[0];
      const onDeviceHint = await classifyCoarse(front.processedUri);

      const scanId = await createScan({ specimenCategory: null, location });
      for (const image of captured) {
        const segmented = await segmentBackground(image.processedUri);
        await uploadScanImage(scanId, { ...image, processedUri: segmented.uri });
      }
      const orchestrated = await runOrchestration(scanId, onDeviceHint);
      router.replace({ pathname: "/(app)/scan/results", params: { scanId: orchestrated.scanId } });
    } catch (err) {
      captureException(err, { where: "upload.handleSend" });
      setErrorText((err as Error).message);
      setPhase("select");
    }
  }

  if (phase === "processing" || phase === "analyzing") {
    return (
      <View style={styles.centered}>
        <ImageProcessorGL ref={imageProcessorRef} />
        <ActivityIndicator color="#C9A227" size="large" />
        <Text style={styles.body}>
          {phase === "analyzing"
            ? "Sending to the AI and analyzing — this can take up to 30 seconds…"
            : (statusText ?? "Preparing images…")}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <ImageProcessorGL ref={imageProcessorRef} />
      <Text style={styles.heading}>Upload images</Text>
      <Text style={styles.body}>
        Pick one or more photos of the same specimen — different angles improve accuracy. Review
        them below, remove any you don’t want, then tap Send.
      </Text>

      {images.length > 0 && (
        <View style={styles.grid}>
          {images.map((uri, i) => (
            <View key={uri} style={styles.thumbWrap}>
              <Image source={{ uri }} style={styles.thumb} />
              <Pressable
                style={styles.removeBadge}
                onPress={() => removeImage(uri)}
                hitSlop={8}
                accessibilityLabel={`Remove image ${i + 1}`}
              >
                <Ionicons name="close" size={16} color="#F5F1E8" />
              </Pressable>
              <Text style={styles.thumbLabel}>{LIVE_ANGLE_SEQUENCE[i]?.angle ?? ""}</Text>
            </View>
          ))}
        </View>
      )}

      {errorText && <Text style={styles.errorText}>{errorText}</Text>}

      {images.length < MAX_IMAGES && (
        <Pressable style={styles.secondaryButton} onPress={handleAddImages}>
          <Ionicons name="add" size={18} color="#C9A227" />
          <Text style={styles.secondaryButtonText}>
            {images.length === 0 ? "Choose from gallery" : "Add more photos"}
          </Text>
        </Pressable>
      )}

      {images.length > 0 && (
        <Pressable style={styles.primaryButton} onPress={handleSend}>
          <Text style={styles.primaryButtonText}>
            Send {images.length} {images.length === 1 ? "photo" : "photos"} for analysis
          </Text>
        </Pressable>
      )}

      <Pressable style={styles.linkButton} onPress={() => router.replace("/(app)/scan/live")}>
        <Text style={styles.link}>Use the live scanner instead</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: "#0B0B0C", padding: 24, gap: 14 },
  centered: { flex: 1, backgroundColor: "#0B0B0C", padding: 24, gap: 14, justifyContent: "center", alignItems: "center" },
  heading: { fontSize: 20, fontWeight: "700", color: "#F5F1E8" },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  thumbWrap: { width: 96, alignItems: "center" },
  thumb: { width: 96, height: 96, borderRadius: 12, backgroundColor: "#1A1A1D" },
  removeBadge: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#E4685D",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbLabel: { color: "#8A8A8E", fontSize: 11, marginTop: 4, textTransform: "capitalize" },
  errorText: { color: "#E4685D", fontSize: 13 },
  primaryButton: { backgroundColor: "#C9A227", borderRadius: 999, paddingVertical: 16, alignItems: "center" },
  primaryButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 16 },
  secondaryButton: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
  },
  secondaryButtonText: { color: "#C9A227", fontWeight: "700", fontSize: 15 },
  linkButton: { alignItems: "center", paddingVertical: 8 },
  link: { color: "#C9C9CC", fontSize: 13, textDecorationLine: "underline" },
});

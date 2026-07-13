// UPLOAD MODE (secondary).
//
// Lets the user pick one or many images from the gallery instead of live
// scanning. Every picked image runs through the EXACT same on-device pipeline
// (ImageProcessorGL quality + enhance, onDeviceDetection) and the EXACT same
// cloud handoff (createScan → uploadScanImage → runOrchestration) as live/manual
// modes — there is no separate AI path.
//
// Picked images are mapped, in order, onto the multi-angle sequence (front,
// left, right, …) so each satisfies the scan_images unique(scan_id, angle)
// constraint; a single image simply becomes the "front" angle.
import React, { useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { ImageProcessorGL, type ImageProcessorHandle } from "../../../components/ImageProcessorGL";
import { detectSpecimenBoundingBox, classifyCoarse } from "../../../lib/onDeviceDetection";
import { segmentBackground } from "../../../lib/backgroundSegmentation";
import { getFuzzedLocation } from "../../../lib/location";
import { createScan, uploadScanImage, runOrchestration, type CapturedAngleImage } from "../../../lib/scanUpload";
import { captureException } from "../../../lib/monitoring";
import { LIVE_ANGLE_SEQUENCE } from "../../../lib/liveScanEngine";

export default function UploadScreen() {
  const router = useRouter();
  const imageProcessorRef = useRef<ImageProcessorHandle>(null);
  const [phase, setPhase] = useState<"idle" | "processing" | "analyzing">("idle");
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function handlePick() {
    setErrorText(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 1,
      selectionLimit: LIVE_ANGLE_SEQUENCE.length,
    });
    if (result.canceled || result.assets.length === 0) return;

    if (!imageProcessorRef.current) {
      setErrorText("Image processor is still starting — try again in a moment.");
      return;
    }

    setPhase("processing");
    try {
      const assets = result.assets.slice(0, LIVE_ANGLE_SEQUENCE.length);
      const captured: CapturedAngleImage[] = [];

      for (let i = 0; i < assets.length; i++) {
        const angle = LIVE_ANGLE_SEQUENCE[i].angle;
        setStatusText(`Enhancing image ${i + 1} of ${assets.length}…`);
        const uri = assets[i].uri;
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
      captureException(err, { where: "upload.handlePick" });
      setErrorText((err as Error).message);
      setPhase("idle");
    }
  }

  if (phase === "processing" || phase === "analyzing") {
    return (
      <View style={styles.centered}>
        <ImageProcessorGL ref={imageProcessorRef} />
        <ActivityIndicator color="#C9A227" size="large" />
        <Text style={styles.body}>
          {phase === "analyzing"
            ? "Analyzing your specimen — running the AI ensemble. This can take up to 30 seconds…"
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
        Pick one or several photos of the same specimen — different angles improve accuracy. They run
        through the same AI pipeline as a live scan.
      </Text>

      {errorText && <Text style={styles.errorText}>{errorText}</Text>}

      <Pressable style={styles.primaryButton} onPress={handlePick}>
        <Text style={styles.primaryButtonText}>Choose from gallery</Text>
      </Pressable>

      <Pressable style={styles.secondaryButton} onPress={() => router.replace("/(app)/scan/live")}>
        <Text style={styles.link}>Use the live scanner instead</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: "#0B0B0C", padding: 24, gap: 14 },
  centered: { flex: 1, backgroundColor: "#0B0B0C", padding: 24, gap: 14, justifyContent: "center", alignItems: "center" },
  heading: { fontSize: 20, fontWeight: "700", color: "#F5F1E8" },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20, textAlign: "center" },
  errorText: { color: "#E4685D", fontSize: 13 },
  primaryButton: { backgroundColor: "#C9A227", borderRadius: 999, paddingVertical: 16, alignItems: "center" },
  primaryButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 16 },
  secondaryButton: { alignItems: "center", paddingVertical: 8 },
  link: { color: "#C9C9CC", fontSize: 13, textDecorationLine: "underline" },
});

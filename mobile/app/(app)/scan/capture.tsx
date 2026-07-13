// Stage 1: guided multi-angle capture with automatic image quality
// validation (blur / low-light / overexposure), retake guidance, then
// Stage 2 (on-device detect/crop) and Stage 3 (on-device enhancement)
// before handing off to Stage 4-7 (supabase/functions/orchestrate-scan) via
// lib/scanUpload.ts.
import React, { useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useKeepAwake } from "expo-keep-awake";
import { ImageProcessorGL, type ImageProcessorHandle } from "../../../components/ImageProcessorGL";
import { detectSpecimenBoundingBox, classifyCoarse } from "../../../lib/onDeviceDetection";
import { segmentBackground } from "../../../lib/backgroundSegmentation";
import { getFuzzedLocation } from "../../../lib/location";
import {
  createScan,
  uploadScanImage,
  runOrchestration,
  type CapturedAngleImage,
} from "../../../lib/scanUpload";

type AngleStep = {
  key: CapturedAngleImage["angle"];
  label: string;
  instructions: string;
  optional?: boolean;
};

const ANGLE_STEPS: AngleStep[] = [
  { key: "front", label: "Front", instructions: "Center the specimen, facing the camera." },
  { key: "back", label: "Back", instructions: "Flip it around — capture the back." },
  { key: "left", label: "Left side", instructions: "Rotate 90° left." },
  { key: "right", label: "Right side", instructions: "Rotate 90° right." },
  { key: "top", label: "Top", instructions: "Shoot straight down from above." },
  { key: "bottom", label: "Bottom", instructions: "Shoot straight up from below." },
  {
    key: "macro",
    label: "Macro close-up",
    instructions: "Get as close as your camera allows — this helps with fine detail and hallmarks.",
  },
  {
    key: "wet",
    label: "Wet (optional)",
    instructions: "Wetting some specimens reveals truer color/luster. Optional — you can skip this.",
    optional: true,
  },
];

export default function CaptureScreen() {
  const router = useRouter();
  // Hold the screen on while the camera capture flow is open (the user lines up
  // angles without touching the screen; the OS timeout would otherwise dim it).
  useKeepAwake();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const imageProcessorRef = useRef<ImageProcessorHandle>(null);

  const [stepIndex, setStepIndex] = useState(0);
  const [capturedImages, setCapturedImages] = useState<CapturedAngleImage[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [retakeReason, setRetakeReason] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const currentStep = ANGLE_STEPS[stepIndex];
  const isLastStep = stepIndex === ANGLE_STEPS.length - 1;

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.body}>GemScan AI needs camera access to scan specimens.</Text>
        <Pressable style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>Grant camera access</Text>
        </Pressable>
      </View>
    );
  }

  async function handleCapture() {
    if (!cameraRef.current || !imageProcessorRef.current) return;
    setIsBusy(true);
    setRetakeReason(null);

    try {
      setBusyLabel("Checking photo quality…");
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (!photo) throw new Error("Camera did not return a photo");

      const quality = await imageProcessorRef.current.assessQuality(photo.uri);

      const problems: string[] = [];
      if (quality.blurry) problems.push("The photo looks blurry.");
      if (quality.lowLight) problems.push("The photo is too dark.");
      if (quality.overexposed) problems.push("The photo is overexposed.");

      if (problems.length > 0) {
        setRetakeReason(`${problems.join(" ")} Please retake this angle.`);
        setIsBusy(false);
        return;
      }

      setBusyLabel("Enhancing photo…");
      const [detectionBbox, enhanced] = await Promise.all([
        detectSpecimenBoundingBox(photo.uri),
        imageProcessorRef.current.enhance(photo.uri),
      ]);

      const captured: CapturedAngleImage = {
        angle: currentStep.key,
        originalUri: photo.uri,
        processedUri: enhanced.uri,
        quality,
        detectionBbox,
      };

      setCapturedImages((prev) => [...prev.filter((i) => i.angle !== captured.angle), captured]);

      if (!isLastStep) {
        setStepIndex((i) => i + 1);
      }
    } catch (err) {
      setRetakeReason((err as Error).message);
    } finally {
      setIsBusy(false);
      setBusyLabel("");
    }
  }

  function handleSkipOptional() {
    if (currentStep.optional && !isLastStep) {
      setStepIndex((i) => i + 1);
    }
  }

  const requiredStepsDone = ANGLE_STEPS.filter((s) => !s.optional).every((s) =>
    capturedImages.some((c) => c.angle === s.key),
  );

  async function handleAnalyze() {
    setIsAnalyzing(true);
    try {
      const location = await getFuzzedLocation();

      const frontImage = capturedImages.find((c) => c.angle === "front");
      const onDeviceHint = frontImage ? await classifyCoarse(frontImage.processedUri) : null;

      const scanId = await createScan({ specimenCategory: null, location });

      for (const image of capturedImages) {
        // Stage 3's final step: background segmentation. Currently a
        // documented no-op until a segmentation model is bundled (see
        // lib/backgroundSegmentation.ts) — wired in now so nothing else
        // needs to change when it's implemented.
        const segmented = await segmentBackground(image.processedUri);
        await uploadScanImage(scanId, { ...image, processedUri: segmented.uri });
      }

      const result = await runOrchestration(scanId, onDeviceHint);
      router.replace({
        pathname: "/(app)/scan/results",
        params: { scanId: result.scanId },
      });
    } catch (err) {
      setRetakeReason((err as Error).message);
      setIsAnalyzing(false);
    }
  }

  if (isAnalyzing) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color="#C9A227" size="large" />
        <Text style={styles.body}>
          Analyzing your specimen — running the AI ensemble. This can take up to 30 seconds…
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ImageProcessorGL ref={imageProcessorRef} />

      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <Text style={styles.stepCounter}>
          Step {stepIndex + 1} of {ANGLE_STEPS.length}: {currentStep.label}
        </Text>
        <Text style={styles.body}>{currentStep.instructions}</Text>

        <View style={styles.cameraWrapper}>
          <CameraView ref={cameraRef} style={styles.camera} facing="back" />
        </View>

        {retakeReason && <Text style={styles.errorText}>{retakeReason}</Text>}

        {isBusy ? (
          <View style={styles.busyRow}>
            <ActivityIndicator color="#C9A227" />
            <Text style={styles.body}>{busyLabel}</Text>
          </View>
        ) : (
          <>
            <Pressable style={styles.primaryButton} onPress={handleCapture}>
              <Text style={styles.primaryButtonText}>Capture {currentStep.label}</Text>
            </Pressable>

            {currentStep.optional && !isLastStep && (
              <Pressable style={styles.secondaryButton} onPress={handleSkipOptional}>
                <Text style={styles.secondaryButtonText}>Skip this angle</Text>
              </Pressable>
            )}
          </>
        )}

        <Text style={styles.progressSummary}>
          Captured: {capturedImages.map((c) => c.angle).join(", ") || "none yet"}
        </Text>

        {requiredStepsDone && (
          <Pressable style={styles.analyzeButton} onPress={handleAnalyze}>
            <Text style={styles.primaryButtonText}>Analyze Specimen</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0B0B0C", padding: 20, gap: 12 },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  stepCounter: { fontSize: 18, fontWeight: "700", color: "#F5F1E8" },
  cameraWrapper: {
    height: 360,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  camera: { flex: 1 },
  errorText: { color: "#E4685D", fontSize: 13 },
  busyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  primaryButton: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
  secondaryButton: { alignItems: "center", paddingVertical: 8 },
  secondaryButtonText: { color: "#C9C9CC", fontSize: 13, textDecorationLine: "underline" },
  progressSummary: { color: "#8A8A8E", fontSize: 12 },
  analyzeButton: {
    backgroundColor: "#2E7D32",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
});

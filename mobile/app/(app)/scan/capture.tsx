// Stage 1: guided multi-angle capture with automatic image quality
// validation (blur / low-light / overexposure), retake guidance, then
// Stage 2 (on-device detect/crop) and Stage 3 (on-device enhancement)
// before handing off to Stage 4-7 (supabase/functions/orchestrate-scan) via
// lib/scanUpload.ts.
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useTranslation } from "react-i18next";
import { useKeepAwake } from "expo-keep-awake";
import { ImageProcessorGL, type ImageProcessorHandle } from "../../../components/ImageProcessorGL";
import { detectSpecimenBoundingBox, classifyCoarse } from "../../../lib/onDeviceDetection";
import { segmentBackground } from "../../../lib/backgroundSegmentation";
import { getPreciseLocation } from "../../../lib/location";
import {
  createScan,
  uploadScanImage,
  runOrchestration,
  type CapturedAngleImage,
} from "../../../lib/scanUpload";
import { isScanLimitError } from "../../../lib/appLinks";
import { UpgradePrompt } from "../../../components/UpgradePrompt";

type AngleStep = {
  key: CapturedAngleImage["angle"];
  label: string;
  labelSo: string;
  instructions: string;
  instructionsSo: string;
  optional?: boolean;
};

const ANGLE_STEPS: AngleStep[] = [
  { key: "front", label: "Front", labelSo: "Hore", instructions: "Center the specimen, facing the camera.", instructionsSo: "Shayga dhexda dhig, kamerada u soo jeedi." },
  { key: "back", label: "Back", labelSo: "Dambe", instructions: "Flip it around — capture the back.", instructionsSo: "Gadaal u rog — qaad dhabarka." },
  { key: "left", label: "Left side", labelSo: "Dhinaca bidix", instructions: "Rotate 90° left.", instructionsSo: "90° bidix u rog." },
  { key: "right", label: "Right side", labelSo: "Dhinaca midig", instructions: "Rotate 90° right.", instructionsSo: "90° midig u rog." },
  { key: "top", label: "Top", labelSo: "Dusha", instructions: "Shoot straight down from above.", instructionsSo: "Kor ka soo sawir." },
  { key: "bottom", label: "Bottom", labelSo: "Hoosta", instructions: "Shoot straight up from below.", instructionsSo: "Hoos ka soo sawir." },
  {
    key: "macro",
    label: "Macro close-up",
    labelSo: "Dhow (macro)",
    instructions: "Get as close as your camera allows — this helps with fine detail and hallmarks.",
    instructionsSo: "U soo dhawow inta kamerada ku ogolaato — tani waxay caawisaa faahfaahinta iyo calaamadaha.",
  },
  {
    key: "wet",
    label: "Wet (optional)",
    labelSo: "Qoyan (ikhtiyaari)",
    instructions: "Wetting some specimens reveals truer color/luster. Optional — you can skip this.",
    instructionsSo: "Qoyaanku wuxuu muujiyaa midab iyo dhalaal dhab ah. Ikhtiyaari — waad ka boodi kartaa.",
    optional: true,
  },
];

export default function CaptureScreen() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const L = (en: string, soText: string) => (so ? soText : en);
  // Hold the screen on while the camera capture flow is open (the user lines up
  // angles without touching the screen; the OS timeout would otherwise dim it).
  useKeepAwake();
  // Only mount the camera while this screen is focused, so the camera hardware
  // is released for (and acquired cleanly from) the live-scan screen during the
  // handoff. Prevents a black preview when arriving from the live scanner.
  const isFocused = useIsFocused();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const cameraReadyRef = useRef(false);
  const imageProcessorRef = useRef<ImageProcessorHandle>(null);

  // When the screen is unfocused its CameraView unmounts; clear the ready flag
  // so the next focus waits for a fresh onCameraReady before capturing.
  useEffect(() => {
    if (!isFocused) cameraReadyRef.current = false;
  }, [isFocused]);

  // Android's takePictureAsync fails with "failed to capture image" if the
  // preview surface isn't ready yet; wait (bounded) for onCameraReady.
  function waitForCameraReady(timeoutMs = 5000): Promise<boolean> {
    if (cameraReadyRef.current) return Promise.resolve(true);
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (cameraReadyRef.current) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 100);
      };
      check();
    });
  }

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
        <Text style={styles.body}>{L("GemScan needs camera access to scan specimens.", "GemScan wuxuu u baahan yahay kamerada si uu u baaro shayada.")}</Text>
        <Pressable style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>{L("Grant camera access", "Ogolow kamerada")}</Text>
        </Pressable>
      </View>
    );
  }

  async function handleCapture() {
    if (!cameraRef.current || !imageProcessorRef.current) return;
    setIsBusy(true);
    setRetakeReason(null);

    try {
      setBusyLabel(L("Checking photo quality…", "Tayada sawirka waa la hubinayaa…"));
      await waitForCameraReady();
      let photo;
      try {
        photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      } catch {
        // Android occasionally drops the first capture — retry once.
        await new Promise((r) => setTimeout(r, 500));
        photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      }
      if (!photo?.uri) throw new Error("Camera did not return a photo");

      const quality = await imageProcessorRef.current.assessQuality(photo.uri);

      // Quality is ADVISORY only — never block the capture. The on-device GL
      // quality check is unreliable on some devices (it can wrongly report a
      // well-lit, sharp photo as "blurry / too dark"), and a false block makes
      // the app unusable. We keep the photo; the cloud AI judges the real image.
      setBusyLabel(L("Enhancing photo…", "Sawirka waa la wanaajinayaa…"));
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
      const location = await getPreciseLocation();

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
          {L("Identifying your stone — please wait, it may take up to 30 seconds…", "Waa la aqoonsanayaa dhagaxaaga — sug wax yar, waxay qaadan kartaa 30 ilbiriqsi…")}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ImageProcessorGL ref={imageProcessorRef} />

      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <Text style={styles.stepCounter}>
          {L("Step", "Tallaabo")} {stepIndex + 1} {L("of", "ee")} {ANGLE_STEPS.length}: {so ? currentStep.labelSo : currentStep.label}
        </Text>
        <Text style={styles.body}>{so ? currentStep.instructionsSo : currentStep.instructions}</Text>

        <View style={styles.cameraWrapper}>
          {isFocused ? (
            <CameraView
              ref={cameraRef}
              style={styles.camera}
              facing="back"
              onCameraReady={() => {
                cameraReadyRef.current = true;
              }}
            />
          ) : (
            <View style={[styles.camera, styles.cameraPlaceholder]}>
              <ActivityIndicator color="#C9A227" />
            </View>
          )}
        </View>

        {retakeReason &&
          (isScanLimitError(retakeReason) ? (
            <UpgradePrompt />
          ) : (
            <Text style={styles.errorText}>{retakeReason}</Text>
          ))}

        {isBusy ? (
          <View style={styles.busyRow}>
            <ActivityIndicator color="#C9A227" />
            <Text style={styles.body}>{busyLabel}</Text>
          </View>
        ) : (
          <>
            <Pressable style={styles.primaryButton} onPress={handleCapture}>
              <Text style={styles.primaryButtonText}>{L("Capture", "Qaad")} {so ? currentStep.labelSo : currentStep.label}</Text>
            </Pressable>

            {currentStep.optional && !isLastStep && (
              <Pressable style={styles.secondaryButton} onPress={handleSkipOptional}>
                <Text style={styles.secondaryButtonText}>{L("Skip this angle", "Ka bood xagalkan")}</Text>
              </Pressable>
            )}
          </>
        )}

        <Text style={styles.progressSummary}>
          {L("Captured", "La qaaday")}: {capturedImages.map((c) => c.angle).join(", ") || L("none yet", "weli midna")}
        </Text>

        {requiredStepsDone && (
          <Pressable style={styles.analyzeButton} onPress={handleAnalyze}>
            <Text style={styles.primaryButtonText}>{L("Analyze Specimen", "Baar Shayga")}</Text>
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
  cameraPlaceholder: { alignItems: "center", justifyContent: "center", backgroundColor: "#000" },
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

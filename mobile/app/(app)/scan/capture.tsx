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
import { supabase } from "../../../lib/supabase";
import {
  createScan,
  uploadScanImage,
  runOrchestration,
  OrchestrationError,
  mapWithConcurrency,
  type CapturedAngleImage,
  type ScanType,
  type ExplanationStyle,
} from "../../../lib/scanUpload";
import { getStoredExplanationStyle, setExplanationStyle } from "../../../lib/explanationStyle";
import { isScanLimitError } from "../../../lib/appLinks";
import { useSubscriptionStatus } from "../../../lib/subscription";
import ScanTypeChooser from "../../../components/ScanTypeChooser";
import ExplanationStyleChooser from "../../../components/ExplanationStyleChooser";
import type { CoarseClassification } from "../../../lib/onDeviceDetection";
import { ScanTipsCard } from "../../../components/ui/ScanTipsCard";
import { ProgressChecklist, type ProgressStep } from "../../../components/ui/ProgressChecklist";

// Friendly display names for the live per-provider progress line — internal
// provider ids (matching supabase/functions/orchestrate-scan/providers/*.ts
// `name` fields) are never shown to the user as-is.
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  gemini_vision: "Gemini",
  openai_vision: "OpenAI",
  claude_vision: "Claude",
  hallmark_ocr: "Hallmark",
  geological_context: "Geology",
  on_device_classifier: "On-device",
};

// Heuristic for the smart Deep Scan recommendation: does the on-device hint
// look like a high-value material worth the 3-AI ensemble?
const HIGH_VALUE = ["diamond", "ruby", "sapphire", "emerald", "gold", "jade", "opal", "topaz"];
function isHighValueHint(hint: CoarseClassification | null): boolean {
  const label = (hint?.label ?? "").toLowerCase();
  return HIGH_VALUE.some((k) => label.includes(k));
}
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
  const [stage, setStage] = useState<"preparing" | "analyzing" | "finalizing">("preparing");

  // Scan-type chooser (Standard vs Deep). Credits are read-only from the
  // backend; the app never sells anything in-app.
  const { data: sub } = useSubscriptionStatus();
  const [chooserVisible, setChooserVisible] = useState(false);
  const [recommendDeep, setRecommendDeep] = useState(false);
  const [creditsExhausted, setCreditsExhausted] = useState(false);
  const pendingHintRef = useRef<CoarseClassification | null>(null);
  const deepRemaining = creditsExhausted ? 0 : (sub?.deepScan.remaining ?? 0);

  // Dual Explanation Modes: "Choose Explanation Style" is asked once, before
  // the user's first-ever scan, then remembered (lib/explanationStyle.ts).
  const [styleChooserVisible, setStyleChooserVisible] = useState(false);
  const explanationStyleRef = useRef<ExplanationStyle>("simple");

  // Progressive Results: while stage is "analyzing", poll scan_ai_responses
  // for real per-provider progress (orchestrate-scan now persists each
  // provider's row the moment IT settles, not after every provider finishes —
  // see index.ts) so the loading screen reflects actual backend progress
  // instead of a blank wait.
  const [liveProviders, setLiveProviders] = useState<
    { provider: string; label: string | null; failed: boolean }[]
  >([]);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanAbortRef = useRef<AbortController | null>(null);

  function stopProgressPolling() {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }

  function startProgressPolling(scanId: string) {
    stopProgressPolling();
    setLiveProviders([]);
    pollIntervalRef.current = setInterval(async () => {
      const { data } = await supabase
        .from("scan_ai_responses")
        .select("provider, candidate_label, error")
        .eq("scan_id", scanId);
      if (data) {
        setLiveProviders(
          (data as { provider: string; candidate_label: string | null; error: string | null }[]).map(
            (r) => ({ provider: r.provider, label: r.candidate_label, failed: !!r.error }),
          ),
        );
      }
    }, 800);
  }

  // Cleanup on unmount: stop any in-flight polling and abort an in-progress
  // scan request rather than leaving it running after the user's navigated
  // away (saves wasted AI provider calls/cost).
  useEffect(() => {
    return () => {
      stopProgressPolling();
      scanAbortRef.current?.abort();
    };
  }, []);

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

  // Tapping "Analyze" first opens the scan-type chooser. We compute the
  // on-device hint now so we can smart-recommend Deep Scan for likely-valuable
  // items, and reuse it for the actual scan.
  async function openScanChooser() {
    const frontImage = capturedImages.find((c) => c.angle === "front");
    try {
      pendingHintRef.current = frontImage ? await classifyCoarse(frontImage.processedUri) : null;
    } catch {
      pendingHintRef.current = null;
    }
    setRecommendDeep(isHighValueHint(pendingHintRef.current));

    // First-ever scan: ask "Choose Explanation Style" before the scan-type
    // sheet. Already chosen (remembered from Settings or a prior scan): skip
    // straight to the scan-type sheet as before.
    const stored = await getStoredExplanationStyle();
    if (stored) {
      explanationStyleRef.current = stored;
      setChooserVisible(true);
    } else {
      setStyleChooserVisible(true);
    }
  }

  async function handleChooseExplanationStyle(style: ExplanationStyle) {
    explanationStyleRef.current = style;
    setStyleChooserVisible(false);
    setChooserVisible(true);
    // Persist in the background — the scan-type sheet doesn't need to wait.
    setExplanationStyle(style).catch(() => {});
  }

  async function handleAnalyze(scanType: ScanType) {
    setChooserVisible(false);
    setIsAnalyzing(true);
    setStage("preparing");
    try {
      const location = await getPreciseLocation();
      const onDeviceHint = pendingHintRef.current;
      const explanationStyle = explanationStyleRef.current;

      const scanId = await createScan({ specimenCategory: null, location, explanationStyle });

      // Upload every captured angle concurrently (bounded to 3 at once) rather
      // than one at a time — cuts total upload wall-clock time significantly
      // for a full 8-angle scan while keeping at most 3 images' worth of
      // base64 buffers in memory simultaneously.
      await mapWithConcurrency(capturedImages, 3, async (image) => {
        // Stage 3's final step: background segmentation. Currently a
        // documented no-op until a segmentation model is bundled (see
        // lib/backgroundSegmentation.ts) — wired in now so nothing else
        // needs to change when it's implemented.
        const segmented = await segmentBackground(image.processedUri);
        await uploadScanImage(scanId, { ...image, processedUri: segmented.uri });
      });

      setStage("analyzing");
      startProgressPolling(scanId);
      const controller = new AbortController();
      scanAbortRef.current = controller;
      const result = await runOrchestration(scanId, onDeviceHint, scanType, explanationStyle, controller.signal);
      setStage("finalizing");
      router.replace({
        pathname: "/(app)/scan/results",
        params: { scanId: result.scanId },
      });
    } catch (err) {
      setIsAnalyzing(false);
      // Deep Scan credits ran out server-side → reopen the chooser showing 0
      // credits so the user can run a Standard Scan or buy more on the website.
      if (err instanceof OrchestrationError && err.code === "deep_credits_exhausted") {
        setCreditsExhausted(true);
        setChooserVisible(true);
      } else if ((err as Error).name !== "AbortError") {
        // AbortError means the user navigated away — don't surface a "retake"
        // error for a scan they already left.
        setRetakeReason((err as Error).message);
      }
    } finally {
      scanAbortRef.current = null;
      stopProgressPolling();
    }
  }

  if (isAnalyzing) {
    const steps: ProgressStep[] = [
      {
        key: "prep",
        label: L("Preparing photos", "Sawirrada waa la diyaarinayaa"),
        done: stage !== "preparing",
        active: stage === "preparing",
      },
      {
        key: "ai",
        label: L("AI identification & analysis", "Aqoonsi & falanqayn AI"),
        done: stage === "finalizing",
        active: stage === "analyzing",
      },
      {
        key: "final",
        label: L("Preparing your report", "Warbixinta waa la diyaarinayaa"),
        done: false,
        active: stage === "finalizing",
      },
    ];
    return (
      <View style={styles.loadingContainer}>
        <ProgressChecklist steps={steps} />
        {/* Progressive Results: a real, live reflection of which providers
            have actually responded so far (see startProgressPolling above) —
            not a fake animation. Only shown once at least one has settled. */}
        {stage === "analyzing" && liveProviders.length > 0 && (
          <Text style={styles.liveProgress}>
            {liveProviders
              .map((p) => {
                const name = PROVIDER_DISPLAY_NAMES[p.provider] ?? p.provider;
                return p.failed ? `${name} ⚠` : `${name} ✓${p.label ? ` ${p.label}` : ""}`;
              })
              .join("  ·  ")}
          </Text>
        )}
        <Text style={styles.caption}>
          {L("This may take up to 30 seconds.", "Waxay qaadan kartaa ilaa 30 ilbiriqsi.")}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ImageProcessorGL ref={imageProcessorRef} />

      <ScrollView contentContainerStyle={{ flexGrow: 1, gap: 12 }}>
        {stepIndex === 0 && <ScanTipsCard />}

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
          <Pressable style={styles.analyzeButton} onPress={openScanChooser}>
            <Text style={styles.primaryButtonText}>{L("Analyze Specimen", "Baar Shayga")}</Text>
          </Pressable>
        )}
      </ScrollView>

      <ExplanationStyleChooser visible={styleChooserVisible} onChoose={handleChooseExplanationStyle} />

      <ScanTypeChooser
        visible={chooserVisible}
        remaining={deepRemaining}
        recommendDeep={recommendDeep}
        onChoose={handleAnalyze}
        onClose={() => setChooserVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0B0B0C", padding: 20, gap: 12 },
  loadingContainer: {
    flex: 1, backgroundColor: "#0B0B0C", padding: 24, gap: 16,
    alignItems: "center", justifyContent: "center",
  },
  caption: { color: "#8A8A8E", fontSize: 12.5, textAlign: "center" },
  liveProgress: { color: "#C9A227", fontSize: 12, textAlign: "center", fontWeight: "600" },
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

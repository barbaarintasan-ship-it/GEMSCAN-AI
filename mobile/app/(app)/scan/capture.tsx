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
import { ImageProcessorGL, type ImageProcessorHandle, type QualityAssessment } from "../../../components/ImageProcessorGL";
import type { GemstoneDetection } from "../../../lib/gemstoneDetector";
import { detectSpecimenBoundingBox, classifyCoarse } from "../../../lib/onDeviceDetection";
import { segmentBackground } from "../../../lib/backgroundSegmentation";
// Smart Capture quality gate reads the shared on-device GL health flag so it
// only HARD-rejects a shot when the GL quality check is actually reliable on
// this device (never modifies GL — read-only).
import { diag } from "../../../lib/diagnostics";
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
// TEMPORARY: ENTER/EXIT breadcrumbs + memory profiling for the "Preparing
// photos" crash probe.
import { enter, exit, slog, mem } from "../../../lib/scanDiag";
import { isScanLimitError } from "../../../lib/appLinks";
import { useSubscriptionStatus } from "../../../lib/subscription";
import ScanTypeChooser from "../../../components/ScanTypeChooser";
import ExplanationStyleChooser from "../../../components/ExplanationStyleChooser";
import type { CoarseClassification } from "../../../lib/onDeviceDetection";
import { ScanTipsCard } from "../../../components/ui/ScanTipsCard";
import { ProgressChecklist, type ProgressStep } from "../../../components/ui/ProgressChecklist";
import { UpgradePrompt } from "../../../components/UpgradePrompt";

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

type AngleStep = {
  // Reuses one of the existing DB-allowed angle keys (scan_images.angle CHECK
  // constraint), so the new guided vocabulary needs NO schema change — only the
  // user-facing label/instructions/behavior differ from the old raw angles.
  key: CapturedAngleImage["angle"];
  label: string;
  labelSo: string;
  instructions: string;
  instructionsSo: string;
  // Light Reaction shot: enable the camera torch while this step is active.
  torch?: boolean;
  optional?: boolean;
};

// Smart Capture: 5 purposeful evidence shots (Standard mode). Each targets a
// specific gemological signal so the AI gets high-value images rather than 8
// quick same-y ones. Keys map onto existing allowed angle values
// (front/back/left/right/macro) — no migration.
const ANGLE_STEPS: AngleStep[] = [
  {
    key: "front",
    label: "Natural Light — Main View",
    labelSo: "Iftiin Dabiici — Muuqaal Guud",
    instructions: "Place the gemstone in good natural light and capture the main view. Keep it centered; avoid strong shadows and reflections.",
    instructionsSo: "Dhagaxa dhig iftiin dabiici ah oo wanaagsan, qaad muuqaalka guud. Dhexda ku hay; ka fogow hoos-dhaca iyo dhalaalka xoogga leh.",
  },
  {
    key: "back",
    label: "Side / Bottom View",
    labelSo: "Dhinaca / Hoosta",
    instructions: "Rotate the gemstone and capture the side or bottom — this shows thickness, edges, transparency and depth.",
    instructionsSo: "Dhagaxa rog oo qaad dhinaca ama hoosta — tani waxay muujinaysaa dhumucda, geesaha, hufnaanta iyo mooddada.",
  },
  {
    key: "left",
    label: "45° Angle View",
    labelSo: "Xagal 45°",
    instructions: "Tilt to about a 45° angle — captures luster, cut quality and how light behaves on the surface.",
    instructionsSo: "U janjeedhi qiyaastii 45° — waxay qabataa dhalaalka, tayada goynta iyo sida iftiinku dusha ugu dhaqmo.",
  },
  {
    key: "right",
    label: "Light Reaction Test",
    labelSo: "Tijaabada Iftiinka",
    torch: true,
    instructions: "The camera light is ON. Capture from a slight angle to reveal sparkle, star/cat's-eye or moonstone effects — avoid a direct glare covering the stone.",
    instructionsSo: "Iftiinka kamarada waa SHIDAN. Qaad xagal yar si aad u muujiso dhalaalka, saamaynta xiddig/il-bisad ama dayax-dhagax — ka fogow dhalaal toos ah oo dhagaxa daboola.",
  },
  {
    key: "macro",
    label: "Macro Close-Up",
    labelSo: "Macro — Dhow",
    instructions: "Move in close and capture fine surface detail — inclusions, fractures and texture. Hold steady until it looks sharp.",
    instructionsSo: "U soo dhawow oo qaad faahfaahinta dusha — daldaloolo, jab iyo qaraar. Si adag u hay ilaa ay caddaato.",
  },
];

// Detailed / Deep capture adds three more angles on top of the 5 standard
// shots, reusing the remaining DB-allowed angle keys (top/bottom/wet) — still
// no schema change. The wet view is optional (up to 8 total).
const DEEP_EXTRA_STEPS: AngleStep[] = [
  {
    key: "top",
    label: "Top-Down View",
    labelSo: "Muuqaal Kor-hoos",
    instructions: "Shoot straight down from directly above — shows the outline, symmetry and top facets.",
    instructionsSo: "Toos kor uga soo sawir — muujiya qaabka, isku-ekaanta iyo wejiyada sare.",
  },
  {
    key: "bottom",
    label: "Underside / Base",
    labelSo: "Salka / Hoosta",
    instructions: "Capture the base or underside — pavilion, mounting, or any hidden features.",
    instructionsSo: "Qaad salka ama hoosta — hoosta, rakibaadda, ama astaamo qarsoon.",
  },
  {
    key: "wet",
    label: "Wet View (optional)",
    labelSo: "Muuqaal Qoyan (ikhtiyaari)",
    optional: true,
    instructions: "Optional: lightly wet the stone to reveal truer color and luster, then capture. You can skip this.",
    instructionsSo: "Ikhtiyaari: dhagaxa xoogaa qoy si aad u muujiso midab iyo dhalaal dhab ah, kadibna qaad. Waad ka boodi kartaa.",
  },
];

const DEEP_STEPS: AngleStep[] = [...ANGLE_STEPS, ...DEEP_EXTRA_STEPS];

// Live guidance cadence and how many consecutive "ready" frames trigger the
// smart auto-capture (debounces momentary good frames).
const LIVE_TICK_MS = 1300;
const REQUIRED_READY_FRAMES = 2;

type LiveCueKey = "hold" | "light" | "glare" | "closer" | "ready";
const LIVE_CUE_TEXT: Record<LiveCueKey, { en: string; so: string }> = {
  hold: { en: "HOLD STEADY", so: "SI ADAG U HAY" },
  light: { en: "ADD MORE LIGHT", so: "IFTIIN KU DAR" },
  glare: { en: "REDUCE GLARE", so: "YAREE DHALAALKA" },
  closer: { en: "MOVE CLOSER", so: "U SOO DHAWOW" },
  ready: { en: "PERFECT — READY", so: "FIICAN — DIYAAR" },
};

// Pure per-frame verdict from the on-device signals ONLY (no fabricated cues):
//   blur   → focus not locked          → HOLD STEADY
//   dark   → low light                 → ADD MORE LIGHT
//   bright → overexposed / glare       → REDUCE GLARE
//   small  → object too far (coverage) → MOVE CLOSER
//   else   → all conditions satisfied  → READY (auto-capture)
// No "ROTATE" cue: there is no reliable on-device angle/pose signal, so it is
// deliberately omitted rather than faked.
function evaluateFrame(
  quality: QualityAssessment,
  detection: GemstoneDetection,
  isTorchStep: boolean,
  isMacro: boolean,
): { key: LiveCueKey; ready: boolean } {
  if (quality.blurry) return { key: "hold", ready: false };
  if (!isTorchStep && quality.lowLight) return { key: "light", ready: false };
  if (!isTorchStep && quality.overexposed) return { key: "glare", ready: false };
  const minCoverage = isMacro ? 0.28 : 0.16;
  if (detection.signals.coverage < minCoverage) return { key: "closer", ready: false };
  return { key: "ready", ready: true };
}

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

  // Capture depth chosen up front (see the mode selector). null → not chosen
  // yet, so we show the selector before the camera flow.
  const [captureMode, setCaptureMode] = useState<"standard" | "deep" | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [capturedImages, setCapturedImages] = useState<CapturedAngleImage[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [retakeReason, setRetakeReason] = useState<string | null>(null);
  // Smart Capture quality gate: when a shot is hard-rejected, this drives the
  // big centered on-camera message ("IMAGE NOT CLEAR", "IMPROVE LIGHTING"…).
  const [gateMessage, setGateMessage] = useState<{ title: string; hint: string } | null>(null);
  // Continuous live guidance: the current dynamic cue and whether the frame is
  // capture-ready. liveActive turns false on GL-off devices (fall back to
  // static guidance + manual capture).
  const [liveCueKey, setLiveCueKey] = useState<LiveCueKey | null>(null);
  const [liveReady, setLiveReady] = useState(false);
  const [liveActive, setLiveActive] = useState(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [stage, setStage] = useState<"preparing" | "analyzing" | "finalizing">("preparing");

  // Scan-type chooser (Standard vs Deep). Credits are read-only from the
  // backend; the app never sells anything in-app.
  const { data: sub } = useSubscriptionStatus();
  const [chooserVisible, setChooserVisible] = useState(false);
  const [recommendDeep, setRecommendDeep] = useState(false);
  const [creditsExhausted, setCreditsExhausted] = useState(false);
  const pendingHintRef = useRef<CoarseClassification | null>(null);
  // B1 (perf): holds the in-flight GPS fix kicked off at chooser-open so
  // handleAnalyze can await an already-resolved promise instead of blocking the
  // scan on a cold, high-accuracy fix. The scans table has no client UPDATE
  // policy, so location must still be present at insert — we only overlap the
  // acquisition with the on-device hint + the user's chooser interaction.
  const locationPromiseRef = useRef<ReturnType<typeof getPreciseLocation> | null>(null);
  // Refs the live-analysis loop reads so its setTimeout callback never uses
  // stale state/closures (see the live-guidance effect).
  const liveActiveRef = useRef(true);
  const readyStreakRef = useRef(0);
  const isBusyRef = useRef(false);
  const requiredDoneRef = useRef(false);
  const currentStepRef = useRef<AngleStep>(ANGLE_STEPS[0]);
  const finalizeShotRef = useRef<
    (photo: { uri: string; width?: number; height?: number }, q?: QualityAssessment) => Promise<boolean>
  >(async () => false);
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

  // ── Continuous live guidance + smart auto-capture ────────────────────────
  // Samples the preview on a fixed cadence, turns the on-device signals into a
  // dynamic cue (MOVE CLOSER / HOLD STEADY / ADD MORE LIGHT / REDUCE GLARE /
  // READY) and auto-captures once enough consecutive frames are capture-ready.
  // Reuses ImageProcessorGL.analyzeFrame (no GL internals touched) and disables
  // itself the moment analyzeFrame reports GL unavailable, so weak devices fall
  // back to static guidance + the manual Capture button.
  useEffect(() => {
    if (!captureMode || isAnalyzing || !permission?.granted) return;
    liveActiveRef.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!cancelled && liveActiveRef.current) timer = setTimeout(tick, LIVE_TICK_MS);
    };

    async function tick() {
      if (cancelled || !liveActiveRef.current) return;
      // Idle while a shot is being processed, or once all required shots exist.
      if (isBusyRef.current || requiredDoneRef.current) {
        if (requiredDoneRef.current) setLiveCueKey(null);
        schedule();
        return;
      }
      const cam = cameraRef.current;
      const proc = imageProcessorRef.current;
      if (!cam || !proc || !cameraReadyRef.current) {
        schedule();
        return;
      }
      let photo: { uri: string; width?: number; height?: number } | null = null;
      try {
        photo = (await cam.takePictureAsync({ quality: 0.9 })) ?? null;
      } catch {
        schedule();
        return;
      }
      if (cancelled || !photo?.uri) {
        schedule();
        return;
      }
      let res: Awaited<ReturnType<ImageProcessorHandle["analyzeFrame"]>>;
      try {
        res = await proc.analyzeFrame(photo.uri);
      } catch {
        schedule();
        return;
      }
      if (cancelled) return;
      if (res.glUnavailable) {
        // Weak device: turn live analysis off for the session; static guidance +
        // manual capture take over.
        liveActiveRef.current = false;
        setLiveActive(false);
        setLiveCueKey(null);
        return;
      }
      const step = currentStepRef.current;
      const verdict = evaluateFrame(res.quality, res.detection, step.torch === true, step.key === "macro");
      setLiveCueKey(verdict.key);
      setLiveReady(verdict.ready);
      setGateMessage(null);
      if (verdict.ready) {
        readyStreakRef.current += 1;
        if (readyStreakRef.current >= REQUIRED_READY_FRAMES) {
          readyStreakRef.current = 0;
          setIsBusy(true);
          try {
            // Reuse THIS already-analyzed full-res frame — no second capture.
            await finalizeShotRef.current(photo, res.quality);
          } catch {
            /* transient — the next tick retries */
          } finally {
            setIsBusy(false);
            setBusyLabel("");
          }
        }
      } else {
        readyStreakRef.current = 0;
      }
      schedule();
    }

    timer = setTimeout(tick, LIVE_TICK_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureMode, isAnalyzing, permission?.granted]);

  // Standard = the 5 core shots; Deep = 8 (adds top / underside / optional wet).
  const activeSteps = captureMode === "deep" ? DEEP_STEPS : ANGLE_STEPS;
  const currentStep = activeSteps[stepIndex];
  const isLastStep = stepIndex === activeSteps.length - 1;

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

  // Grab one full-quality photo, with the Android one-retry workaround.
  async function grabPhoto(): Promise<{ uri: string; width?: number; height?: number } | null> {
    const cam = cameraRef.current;
    if (!cam) return null;
    try {
      return (await cam.takePictureAsync({ quality: 0.9 })) ?? null;
    } catch {
      // Android occasionally drops the first capture — retry once.
      await new Promise((r) => setTimeout(r, 500));
      try {
        return (await cam.takePictureAsync({ quality: 0.9 })) ?? null;
      } catch {
        return null;
      }
    }
  }

  // Shared finalizer used by BOTH manual capture and smart auto-capture: runs
  // the hybrid quality gate, enhances, detects, saves this angle and advances.
  // `precomputedQuality` lets the auto path reuse the quality the live loop
  // already measured for this exact frame (no second assessment). Returns true
  // when the shot was saved, false when the gate rejected it.
  async function finalizeShot(
    photo: { uri: string; width?: number; height?: number },
    precomputedQuality?: QualityAssessment,
  ): Promise<boolean> {
    const proc = imageProcessorRef.current;
    if (!proc) return false;
    const quality = precomputedQuality ?? (await proc.assessQuality(photo.uri));

    // Smart Capture HYBRID quality gate. HARD-reject a genuinely unusable shot
    // (blurry / too dark / blown out) — BUT only when the on-device GL check is
    // reliable. If GL is disabled/unreliable, fall back to ADVISORY (keep the
    // photo) so a false block can never make the app unusable on weak devices.
    if (!diag.isGpuDisabled()) {
      if (quality.blurry) {
        setGateMessage({
          title: L("IMAGE NOT CLEAR", "SAWIRKU MA CADDA"),
          hint: L("Hold the camera steady and try again.", "Kamarada si adag u hay oo mar kale isku day."),
        });
        return false;
      }
      // Skip the lighting check on the torch step — the light legitimately
      // brightens the frame there.
      if (!currentStep.torch && (quality.lowLight || quality.overexposed)) {
        setGateMessage({
          title: L("IMPROVE LIGHTING", "HAGAAJI IFTIINKA"),
          hint: quality.overexposed
            ? L("Too bright — reduce glare and reflections.", "Aad u dhalaalaya — yaree dhalaalka.")
            : L("Too dark — move to better light.", "Aad u madow — u guur iftiin fiican."),
        });
        return false;
      }
    }

    setBusyLabel(L("Enhancing photo…", "Sawirka waa la wanaajinayaa…"));
    const [detectionBbox, enhanced] = await Promise.all([
      detectSpecimenBoundingBox(photo.uri),
      proc.enhance(photo.uri),
    ]);

    const captured: CapturedAngleImage = {
      angle: currentStep.key,
      originalUri: photo.uri,
      processedUri: enhanced.uri,
      quality,
      detectionBbox,
      // Diagnostic metadata: original capture pixel dimensions (zero cost).
      originalWidth: photo.width,
      originalHeight: photo.height,
    };

    setCapturedImages((prev) => [...prev.filter((i) => i.angle !== captured.angle), captured]);
    setGateMessage(null);
    setLiveCueKey(null);
    readyStreakRef.current = 0;
    if (!isLastStep) setStepIndex((i) => i + 1);
    return true;
  }

  async function handleCapture() {
    if (!cameraRef.current || !imageProcessorRef.current) return;
    setIsBusy(true);
    setRetakeReason(null);
    setGateMessage(null);
    try {
      setBusyLabel(L("Checking photo quality…", "Tayada sawirka waa la hubinayaa…"));
      await waitForCameraReady();
      const photo = await grabPhoto();
      if (!photo?.uri) throw new Error("Camera did not return a photo");
      await finalizeShot(photo);
    } catch (err) {
      setRetakeReason((err as Error).message);
    } finally {
      setIsBusy(false);
      setBusyLabel("");
    }
  }

  const requiredStepsDone = activeSteps.filter((s) => !s.optional).every((s) =>
    capturedImages.some((c) => c.angle === s.key),
  );

  // Keep the live loop's refs pointed at the latest values/closures each render
  // (its setTimeout callback must never read stale state).
  currentStepRef.current = currentStep;
  isBusyRef.current = isBusy;
  requiredDoneRef.current = requiredStepsDone;
  finalizeShotRef.current = finalizeShot;

  // Tapping "Analyze" first opens the scan-type chooser. We compute the
  // on-device hint now so we can smart-recommend Deep Scan for likely-valuable
  // items, and reuse it for the actual scan.
  async function openScanChooser() {
    // B1 (perf): start the GPS fix now, concurrently with the on-device hint
    // below and the chooser the user is about to interact with, so it is almost
    // always already resolved by the time handleAnalyze needs it. Does not
    // change what is stored or when permission is ultimately required.
    locationPromiseRef.current = getPreciseLocation();
    const frontImage = capturedImages.find((c) => c.angle === "front");
    try {
      pendingHintRef.current = frontImage ? await classifyCoarse(frontImage.processedUri) : null;
    } catch {
      pendingHintRef.current = null;
    }
    // Detailed capture also nudges the AI-tier recommendation toward Deep.
    setRecommendDeep(isHighValueHint(pendingHintRef.current) || captureMode === "deep");

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
    enter("preparing stage");
    try {
      // B1 (perf): await the fix already started in openScanChooser (usually
      // resolved by now → near-instant); fall back to a fresh fetch only if it
      // was never started.
      enter("getPreciseLocation");
      const location = await (locationPromiseRef.current ?? getPreciseLocation());
      locationPromiseRef.current = null;
      exit("getPreciseLocation");
      const onDeviceHint = pendingHintRef.current;
      const explanationStyle = explanationStyleRef.current;

      const scanId = await createScan({ specimenCategory: null, location, explanationStyle });

      // Upload every captured angle. Concurrency is deliberately 1 (sequential).
      // Each upload's prepareOriginalForUpload() decodes the FULL-resolution
      // original into a native bitmap (a 12MP photo is ~48MB decoded). Running
      // several at once held that many multi-MB bitmaps in memory at the same
      // time — enough to trigger a native OutOfMemory process kill on low-RAM
      // Android tablets (e.g. the U25 Pro), whose per-app heap is far smaller
      // than the phones this was tested on. That kill is a native crash the JS
      // try/catch below can't catch, so the app just closed during "Preparing
      // photos". Sequential keeps the peak to a single bitmap decode — the same
      // peak the capture step already survives — with NO change to the uploaded
      // image size or quality; only slightly slower for a full 8-angle scan.
      const total = capturedImages.length;
      await mapWithConcurrency(capturedImages, 1, async (image, i) => {
        slog(`Image ${i + 1}/${total} — angle=${image.angle}`);
        mem(`image ${i + 1}/${total} start`);
        // Stage 3's final step: background segmentation. Currently a
        // documented no-op until a segmentation model is bundled (see
        // lib/backgroundSegmentation.ts) — wired in now so nothing else
        // needs to change when it's implemented.
        enter(`angle ${image.angle}: segmentBackground`);
        const segmented = await segmentBackground(image.processedUri);
        exit(`angle ${image.angle}: segmentBackground`);
        await uploadScanImage(scanId, { ...image, processedUri: segmented.uri });
        mem(`image ${i + 1}/${total} done`);
      });
      exit("preparing stage (createScan + all uploads done)");

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
          {L("This may take up to a minute.", "Waxay qaadan kartaa ilaa hal daqiiqo.")}
        </Text>
      </View>
    );
  }

  // Capture-depth selector — shown once, before the camera flow, so the number
  // of guided shots (5 vs 8) is decided up front.
  if (!captureMode) {
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, gap: 14, justifyContent: "center" }}>
          <Text style={styles.stepCounter}>{L("Choose your scan", "Dooro baaritaankaaga")}</Text>
          <Text style={styles.body}>
            {L(
              "Most scans only need the Standard Scan. Deep Scan adds extra optical evidence for tricky, rare, or high-value pieces.",
              "Baaritaannada badankood waxay u baahan yihiin oo kaliya Baaritaanka Caadiga ah. Baaritaanka Qoto-dheer wuxuu ku daraa caddayn dheeraad ah oo loogu talagalay qalab adag, naadir, ama qiimo sare leh.",
            )}
          </Text>

          {/* Standard — the recommended default for most users. */}
          <Pressable style={[styles.modeCard, styles.modeCardRecommended]} onPress={() => setCaptureMode("standard")}>
            <View style={styles.modeCardHeader}>
              <Text style={styles.modeCardTitle}>⚡ {L("Standard Scan", "Baaris Caadi ah")}</Text>
              <View style={styles.recommendedBadge}>
                <Text style={styles.recommendedBadgeText}>{L("RECOMMENDED", "LAGU TALIYEY")}</Text>
              </View>
            </View>
            {[
              L("5 guided photos", "5 sawir oo la hago"),
              L("Faster scan", "Baaris dhaqso badan"),
              L("Best for most gemstones and objects", "Ugu fiican dhagxaanta iyo shayada badankood"),
            ].map((b) => (
              <Text key={b} style={styles.modeBullet}>• {b}</Text>
            ))}
          </Pressable>

          {/* Deep — optional, for valuable / uncertain pieces. */}
          <Pressable style={styles.modeCard} onPress={() => setCaptureMode("deep")}>
            <Text style={styles.modeCardTitle}>💎 {L("Deep Scan", "Baaris Qoto-dheer")}</Text>
            {[
              L("Up to 8 guided photos", "Ilaa 8 sawir oo la hago"),
              L("Additional optical evidence", "Caddayn dheeraad ah oo optical ah"),
              L(
                "Recommended for expensive, rare, or difficult-to-identify gemstones",
                "Loogu talagalay dhagxaan qaali ah, naadir ah, ama adag in la aqoonsado",
              ),
            ].map((b) => (
              <Text key={b} style={styles.modeBullet}>• {b}</Text>
            ))}
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ImageProcessorGL ref={imageProcessorRef} />

      <ScrollView contentContainerStyle={{ flexGrow: 1, gap: 12 }}>
        {stepIndex === 0 && <ScanTipsCard />}

        <Text style={styles.stepCounter}>
          {L("Step", "Tallaabo")} {stepIndex + 1} {L("of", "ee")} {activeSteps.length}
        </Text>

        <View style={styles.cameraWrapper}>
          {isFocused ? (
            <CameraView
              ref={cameraRef}
              style={styles.camera}
              facing="back"
              enableTorch={currentStep.torch === true}
              onCameraReady={() => {
                cameraReadyRef.current = true;
              }}
            />
          ) : (
            <View style={[styles.camera, styles.cameraPlaceholder]}>
              <ActivityIndicator color="#C9A227" />
            </View>
          )}

          {/* Torch-on chip for the Light Reaction shot. */}
          {currentStep.torch && !gateMessage && (
            <View style={styles.torchChip} pointerEvents="none">
              <Text style={styles.torchChipText}>💡 {L("LIGHT ON", "IFTIIN SHIDAN")}</Text>
            </View>
          )}

          {/* Quality-gate reject message — large, high-contrast, centered so the
              user reads the required action within a second. Takes precedence
              over the guidance below. */}
          {gateMessage ? (
            <View style={styles.gateOverlay} pointerEvents="none">
              <View style={styles.gateBadge}>
                <Text style={styles.gateTitle}>{gateMessage.title}</Text>
                <Text style={styles.gateHint}>{gateMessage.hint}</Text>
              </View>
            </View>
          ) : (
            !isBusy && (
              <View style={styles.guidanceOverlay} pointerEvents="none">
                {liveActive && liveCueKey ? (
                  <Text style={[styles.guidanceCue, liveReady ? styles.cueReady : styles.cueCorrect]}>
                    {so ? LIVE_CUE_TEXT[liveCueKey].so : LIVE_CUE_TEXT[liveCueKey].en}
                  </Text>
                ) : (
                  <Text style={styles.guidanceCue}>{so ? currentStep.labelSo : currentStep.label}</Text>
                )}
                <Text style={styles.guidanceInstruction}>
                  {so ? currentStep.instructionsSo : currentStep.instructions}
                </Text>
              </View>
            )
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
  modeCard: {
    backgroundColor: "#161618",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#2A2A2C",
    padding: 18,
    gap: 6,
  },
  // The recommended default gets the gold accent + a subtle highlight so it
  // reads as the obvious choice for most users.
  modeCardRecommended: { borderColor: "#C9A227", borderWidth: 2, backgroundColor: "#1B1810" },
  modeCardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  modeCardTitle: { fontSize: 18, fontWeight: "800", color: "#F5F1E8", flexShrink: 1 },
  recommendedBadge: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  recommendedBadgeText: { color: "#0B0B0C", fontWeight: "900", fontSize: 10.5, letterSpacing: 0.5 },
  modeBullet: { fontSize: 13.5, color: "#C9C9CC", lineHeight: 20 },
  cameraWrapper: {
    height: 360,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  camera: { flex: 1 },
  cameraPlaceholder: { alignItems: "center", justifyContent: "center", backgroundColor: "#000" },
  // Large, high-contrast live guidance anchored to the lower-middle of the
  // camera (not tiny text at the top edge), readable in about a second.
  guidanceOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  guidanceCue: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: 0.4,
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  guidanceInstruction: {
    color: "#F0F0F0",
    fontSize: 13.5,
    fontWeight: "600",
    textAlign: "center",
    marginTop: 4,
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  // Live cue colors: green when the frame is capture-ready, amber while the
  // user still needs to adjust.
  cueReady: { color: "#2EE66E" },
  cueCorrect: { color: "#FFD24A" },
  // Quality-gate reject banner — centered, unmissable.
  gateOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", padding: 20 },
  gateBadge: {
    backgroundColor: "rgba(196,40,40,0.94)",
    borderRadius: 18,
    paddingVertical: 18,
    paddingHorizontal: 22,
    alignItems: "center",
  },
  gateTitle: { color: "#FFFFFF", fontSize: 26, fontWeight: "900", textAlign: "center", letterSpacing: 0.5 },
  gateHint: { color: "#FFFFFF", fontSize: 14.5, fontWeight: "700", textAlign: "center", marginTop: 6 },
  torchChip: {
    position: "absolute",
    top: 12,
    right: 12,
    backgroundColor: "rgba(201,162,39,0.92)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  torchChipText: { color: "#0B0B0C", fontWeight: "900", fontSize: 12, letterSpacing: 0.4 },
  errorText: { color: "#E4685D", fontSize: 13 },
  busyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  primaryButton: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
  progressSummary: { color: "#8A8A8E", fontSize: 12 },
  analyzeButton: {
    backgroundColor: "#2E7D32",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
});

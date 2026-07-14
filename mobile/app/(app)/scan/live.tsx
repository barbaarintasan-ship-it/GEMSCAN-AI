// LIVE GEMSTONE SCANNER (primary experience).
//
// A true real-time AI scanner, not a photo-capture tool. The camera preview is
// always live and continuously analyzed on-device; the user never presses a
// capture button. The flow is:
//
//   1. DETECTION GATE (lib/gemstoneDetector) — before any scanning or AI, each
//      frame is checked for a distinct, gemstone-like object. Until one is held
//      steadily in view we show "No gemstone detected…" and do NOT start
//      identification or spend a single cloud call. This is what rejects an
//      empty scene / random surface up front.
//   2. AUTOMATIC ANGLE CAPTURE (lib/liveScanEngine) — once a gemstone is
//      detected, the pure engine drives live guidance and auto-captures
//      high-quality full-resolution frames as the user slowly rotates the stone
//      (front / sides / top / bottom / macro). No manual multi-photo upload.
//   3. AUTO SCAN LOCK + AI ENSEMBLE (lib/autoScanLock + orchestrate-scan) — as
//      evidence accumulates, a bounded number of cloud evaluations run against
//      ONE reused scan; the Gemini/OpenAI/Claude vision ensemble votes and the
//      scan auto-locks the moment real confidence crosses the backend
//      threshold. Low confidence → keep scanning (never a hallucinated answer).
//
// A professional scanner HUD sits on top: a sweeping scan line, an animated
// frame that tracks the detected object, a live confidence indicator, a scan
// progress percentage, and status narration ("Detecting object…", "Gemstone
// detected", "Capturing angles…", "Analyzing surface…", "Preparing AI
// analysis…").
//
// Reuse contract: capture/enhance/detect/segment/upload/orchestrate are the
// SAME functions the manual capture and upload screens use — this screen only
// changes HOW frames are gathered (live + automatic), not the pipeline they
// feed. Manual upload remains available as a secondary path.
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Easing,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useKeepAwake } from "expo-keep-awake";
import * as FileSystem from "expo-file-system";
import { ImageProcessorGL, type ImageProcessorHandle } from "../../../components/ImageProcessorGL";
import { detectSpecimenBoundingBox, classifyCoarse } from "../../../lib/onDeviceDetection";
import { segmentBackground } from "../../../lib/backgroundSegmentation";
import { getFuzzedLocation } from "../../../lib/location";
import { createScan, uploadScanImage, runOrchestration, type CapturedAngleImage } from "../../../lib/scanUpload";
import { captureException } from "../../../lib/monitoring";
import {
  processFrame,
  createLiveScanState,
  canAnalyze,
  LIVE_ANGLE_SEQUENCE,
  type LiveScanState,
  type Angle,
} from "../../../lib/liveScanEngine";
import {
  decideAutoLock,
  computeEvidenceQuality,
  resolveThreshold,
  keepScanningGuidance,
  AUTO_LOCK_COPY,
  DEFAULT_AUTOLOCK_CONFIG,
} from "../../../lib/autoScanLock";
import {
  REQUIRED_DETECTION_FRAMES,
  SCAN_STATUS_I18N_KEY,
  scanStatusForProgress,
  type GemstoneDetection,
  type DetectionBox,
} from "../../../lib/gemstoneDetector";

// How often we sample the preview for on-device analysis. ~600ms (≈1.6 fps) is
// a deliberate balance: responsive-feeling guidance without hammering the
// camera/GPU/battery. Device-tunable.
const SAMPLE_INTERVAL_MS = 600;

// How many distinct required angles define full evidence coverage — used by the
// Evidence Quality blend. Mirrors the non-optional steps of the live sequence.
const REQUIRED_ANGLE_COUNT = LIVE_ANGLE_SEQUENCE.filter((s) => !s.optional).length;

type Phase = "detecting" | "scanning" | "analyzing" | "locked";

export default function LiveScanScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  // Keep the display awake for the whole live-scan session: the user holds the
  // phone still and never touches the screen while rotating the stone, so the
  // OS screen-timeout would otherwise dim/sleep the display mid-scan. Active
  // only while this screen is mounted; released automatically on unmount.
  useKeepAwake();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  // Android's takePictureAsync fails with "failed to capture image" if called
  // before the preview surface is ready. onCameraReady flips this true.
  const cameraReadyRef = useRef(false);
  const imageProcessorRef = useRef<ImageProcessorHandle>(null);

  // Loop/engine source-of-truth lives in refs (the interval closure must read
  // the latest without re-subscribing); React state mirrors it for the HUD.
  const engineStateRef = useRef<LiveScanState>(createLiveScanState());
  const capturedImagesRef = useRef<CapturedAngleImage[]>([]);
  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detection-gate bookkeeping (Phase 1).
  const phaseRef = useRef<Phase>("detecting");
  const detectFramesRef = useRef(0); // consecutive frames a gemstone was present
  const latestDetectionRef = useRef<GemstoneDetection | null>(null);

  // Auto Scan Lock bookkeeping (all in refs — read inside the loop closure).
  const scanIdRef = useRef<string | null>(null); // ONE reused scan across evals
  const uploadedAnglesRef = useRef<Set<string>>(new Set());
  const lastConfidenceRef = useRef<number | null>(null);
  const evalsUsedRef = useRef(0);
  const anglesAtLastEvalRef = useRef(0);
  const thresholdRef = useRef(DEFAULT_AUTOLOCK_CONFIG.threshold);
  const manualContinueRef = useRef(false); // user chose to keep scanning past a lock

  const [phase, setPhase] = useState<Phase>("detecting");
  const [detectionPresent, setDetectionPresent] = useState(false);
  const [detectionBox, setDetectionBox] = useState<DetectionBox | null>(null);
  const [guidanceText, setGuidanceText] = useState("");
  const [evidence, setEvidence] = useState(0);
  const [evidenceQuality, setEvidenceQuality] = useState(0);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [capturedAngles, setCapturedAngles] = useState<CapturedAngleImage["angle"][]>([]);
  const [canAnalyzeNow, setCanAnalyzeNow] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Set when the on-device GL detection can't run on this device. We then stop
  // the auto-scan loop and let the user drive a reliable manual capture + cloud
  // analysis instead of waiting forever on a detection gate that can't pass.
  const [glUnavailable, setGlUnavailable] = useState(false);

  // ── HUD animations (native-driven, run continuously while the camera is up) ──
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const framePulseAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const sweep = Animated.loop(
      Animated.sequence([
        Animated.timing(scanLineAnim, {
          toValue: 1,
          duration: 1800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(scanLineAnim, {
          toValue: 0,
          duration: 1800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(framePulseAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(framePulseAnim, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    sweep.start();
    pulse.start();
    return () => {
      sweep.stop();
      pulse.stop();
    };
  }, [scanLineAnim, framePulseAnim]);

  useEffect(() => {
    if (!permission?.granted) return;
    runningRef.current = true;
    scheduleTick(0);
    return () => {
      runningRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission?.granted]);

  function setPhaseBoth(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function scheduleTick(delay: number) {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(tick, delay);
  }

  async function tick() {
    if (!runningRef.current) return;
    if (
      busyRef.current ||
      !cameraRef.current ||
      !imageProcessorRef.current ||
      !cameraReadyRef.current
    ) {
      scheduleTick(SAMPLE_INTERVAL_MS);
      return;
    }
    busyRef.current = true;
    try {
      const snap = await cameraRef.current.takePictureAsync({ quality: 0, skipProcessing: true });
      if (!snap?.uri) throw new Error("No preview frame");

      // ONE combined on-device pass → quality (Stage 1) + gemstone detection.
      const { quality: q, detection, glUnavailable: glDown } =
        await imageProcessorRef.current.analyzeFrame(snap.uri);
      // The low-res sampling frame is disposable — a full-res frame is grabbed
      // separately if this angle locks in.
      FileSystem.deleteAsync(snap.uri, { idempotent: true }).catch(() => {});

      // On-device detection can't run on this phone → stop the pointless auto
      // loop and switch to the manual "Scan now" path (reliable: capture →
      // cloud). Without this the detection gate below could never pass and the
      // scanner would sit at 0% forever.
      if (glDown) {
        setGlUnavailable(true);
        runningRef.current = false;
        setGuidanceText("Point the camera at the stone, then tap “Scan now”.");
        return;
      }

      latestDetectionRef.current = detection;
      setDetectionPresent(detection.present);
      setDetectionBox(detection.box);

      // ── PHASE 1: DETECTION GATE ──────────────────────────────────────────
      // Do not run the scan engine or any cloud AI until a gemstone-like object
      // is reliably present. This is the "reject empty scene / non-object" gate.
      if (phaseRef.current === "detecting") {
        if (detection.present) {
          detectFramesRef.current += 1;
          setConfidence(null);
          if (detectFramesRef.current >= REQUIRED_DETECTION_FRAMES) {
            // Gemstone confirmed — begin real scanning.
            setPhaseBoth("scanning");
            setGuidanceText(t("scanner.holdRotate"));
          } else {
            setGuidanceText(t("scanner.detected"));
          }
        } else {
          detectFramesRef.current = 0;
          setGuidanceText(t("scanner.noGemstone"));
        }
        return; // never fall through to capture/eval while gating
      }

      // ── PHASE 2/3: SCANNING + AUTO LOCK ──────────────────────────────────
      const decision = processFrame(engineStateRef.current, q);
      engineStateRef.current = decision.state;

      setEvidence(decision.evidenceStrength);
      setCanAnalyzeNow(canAnalyze(decision.state));
      // Narrate scan progress; fall back to frame guidance for corrective hints.
      setGuidanceText(decision.guidanceText || t("scanner.holdRotate"));

      if (decision.captureAngle) {
        await captureFullFrame(decision.captureAngle);
      }

      // On-device Evidence Quality (image quality × angle coverage) — the
      // signal that gates whether it's worth spending a cloud evaluation yet.
      const eq = computeEvidenceQuality(
        capturedImagesRef.current.map((i) => i.quality.qualityScore),
        capturedImagesRef.current.length,
        REQUIRED_ANGLE_COUNT,
      );
      setEvidenceQuality(eq);

      // Engine says we've collected a full sequence → do the final analysis and
      // hand off to results (unchanged intelligent-stop behaviour).
      if (decision.isComplete) {
        runningRef.current = false;
        await finishAndAnalyze();
        return;
      }

      // Auto Scan Lock: decide whether to lock, spend a bounded cloud eval, or
      // just keep scanning. Skipped entirely once the user has chosen to keep
      // scanning past a lock (they're then in manual control via "Analyze now").
      if (!manualContinueRef.current) {
        const autoDecision = decideAutoLock({
          lastConfidence: lastConfidenceRef.current,
          evidenceQuality: eq,
          capturedAngles: capturedImagesRef.current.length,
          anglesAtLastEval: anglesAtLastEvalRef.current,
          evalsUsed: evalsUsedRef.current,
          config: { ...DEFAULT_AUTOLOCK_CONFIG, threshold: thresholdRef.current },
        });

        if (autoDecision.action === "lock") {
          autoLock();
          return;
        }
        if (autoDecision.action === "evaluate") {
          const conf = await evaluate();
          if (conf !== null && conf >= thresholdRef.current) {
            autoLock();
            return;
          }
          // Below threshold → nudge for more/different evidence.
          setGuidanceText(keepScanningGuidance(eq, capturedImagesRef.current.length));
        }
      }
    } catch (err) {
      // Surface the real error (instead of silently swallowing it) so a stuck
      // scan is diagnosable, while still keeping the loop alive.
      captureException(err, { where: "live.tick" });
      setErrorText(`Scan error: ${(err as Error).message || "unknown"}`);
    } finally {
      busyRef.current = false;
      if (runningRef.current) scheduleTick(SAMPLE_INTERVAL_MS);
    }
  }

  // Wait (bounded) for the camera preview to be ready before capturing.
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

  // Take a full-resolution photo, tolerant of Android's transient
  // "failed to capture image": wait for readiness, then retry once.
  async function takeFullPhoto(): Promise<{ uri: string } | null> {
    const cam = cameraRef.current;
    if (!cam) return null;
    await waitForCameraReady();
    try {
      const p = await cam.takePictureAsync({ quality: 0.9 });
      if (p?.uri) return { uri: p.uri };
    } catch {
      // fall through to a single retry
    }
    await new Promise((r) => setTimeout(r, 500));
    const p2 = await cam.takePictureAsync({ quality: 0.9 });
    return p2?.uri ? { uri: p2.uri } : null;
  }

  async function captureFullFrame(angle: Angle) {
    if (!cameraRef.current || !imageProcessorRef.current) return;
    const photo = await takeFullPhoto();
    if (!photo?.uri) return;

    const quality = await imageProcessorRef.current.assessQuality(photo.uri);
    const [modelBbox, enhanced] = await Promise.all([
      detectSpecimenBoundingBox(photo.uri),
      imageProcessorRef.current.enhance(photo.uri),
    ]);

    // Prefer the trained detector's box when a model is bundled; otherwise fall
    // back to the on-device heuristic detector's box + objectness so the
    // detected-object confidence is still persisted (scan_images.detection_bbox).
    const heuristic = latestDetectionRef.current;
    const detectionBbox =
      modelBbox ??
      (heuristic?.box
        ? { ...heuristic.box, detectorConfidence: heuristic.objectness }
        : null);

    const captured: CapturedAngleImage = {
      angle,
      originalUri: photo.uri,
      processedUri: enhanced.uri,
      quality,
      detectionBbox,
    };
    capturedImagesRef.current = [
      ...capturedImagesRef.current.filter((i) => i.angle !== angle),
      captured,
    ];
    setCapturedAngles(capturedImagesRef.current.map((i) => i.angle));
  }

  // Lazily creates the single reused scan the first time we need to talk to the
  // cloud, so progressive re-evaluations all share ONE scans row (and count
  // once against the free-tier daily limit).
  async function ensureScanId(): Promise<string> {
    if (scanIdRef.current) return scanIdRef.current;
    const location = await getFuzzedLocation();
    const id = await createScan({ specimenCategory: null, location });
    scanIdRef.current = id;
    return id;
  }

  // Uploads only angles not yet uploaded to this scan (scan_images has a unique
  // (scan_id, angle) constraint, so re-uploading the same angle would conflict).
  async function uploadPending(scanId: string): Promise<void> {
    const pending = capturedImagesRef.current.filter(
      (i) => !uploadedAnglesRef.current.has(i.angle),
    );
    for (const image of pending) {
      const segmented = await segmentBackground(image.processedUri);
      await uploadScanImage(scanId, { ...image, processedUri: segmented.uri });
      uploadedAnglesRef.current.add(image.angle);
    }
  }

  // One bounded progressive cloud evaluation. Returns the real ensemble
  // confidence (or null if there was nothing to send). Updates the backend-
  // owned auto-lock threshold from the response.
  async function evaluate(): Promise<number | null> {
    if (capturedImagesRef.current.length === 0) return null;
    setEvaluating(true);
    try {
      const scanId = await ensureScanId();
      await uploadPending(scanId);
      const front =
        capturedImagesRef.current.find((i) => i.angle === "front") ??
        capturedImagesRef.current[0];
      const onDeviceHint = await classifyCoarse(front.processedUri);
      const result = await runOrchestration(scanId, onDeviceHint);

      evalsUsedRef.current += 1;
      anglesAtLastEvalRef.current = capturedImagesRef.current.length;
      const conf = result.finalResult.confidenceScore ?? null;
      lastConfidenceRef.current = conf;
      setConfidence(conf);
      if (typeof result.autoLockThreshold === "number") {
        thresholdRef.current = resolveThreshold(result.autoLockThreshold);
      }
      return conf;
    } finally {
      setEvaluating(false);
    }
  }

  // Auto-lock: the scan finalizes automatically — no button press. The cloud
  // evaluation already ran on scanIdRef, so the result is ready; we show the
  // lock screen and let the user view it or keep scanning.
  function autoLock() {
    runningRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    setPhaseBoth("locked");
  }

  function viewResults() {
    if (scanIdRef.current) {
      router.replace({ pathname: "/(app)/scan/results", params: { scanId: scanIdRef.current } });
    }
  }

  function keepScanning() {
    manualContinueRef.current = true; // suppress further auto-locks
    setPhaseBoth("scanning");
    runningRef.current = true;
    scheduleTick(SAMPLE_INTERVAL_MS);
  }

  // Final analysis path: engine reached a full sequence, or the user tapped
  // "Analyze now". Reuses the same scanId/evaluation machinery, then navigates.
  async function finishAndAnalyze() {
    runningRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    const images = capturedImagesRef.current;
    if (images.length === 0) {
      setErrorText("No usable frames were captured. Try again with better lighting.");
      return;
    }
    setPhaseBoth("analyzing");
    // Track which pipeline stage we're in so a failure names the stage that
    // broke ("Upload failed", "AI analysis failed") rather than surfacing a bare
    // low-level message the user can't act on.
    let stage: "create scan" | "upload" | "AI analysis" = "create scan";
    try {
      const scanId = await ensureScanId();
      stage = "upload";
      await uploadPending(scanId);
      stage = "AI analysis";
      const front = images.find((i) => i.angle === "front") ?? images[0];
      const onDeviceHint = await classifyCoarse(front.processedUri);
      const result = await runOrchestration(scanId, onDeviceHint);
      router.replace({ pathname: "/(app)/scan/results", params: { scanId: result.scanId } });
    } catch (err) {
      captureException(err, { where: "live.finishAndAnalyze", stage });
      const detail = (err as Error).message || "unknown error";
      setErrorText(`${stage} failed: ${detail}`);
      setPhaseBoth("scanning");
    }
  }

  // Manual capture + analyse. Always works — even when on-device detection is
  // unavailable — because it grabs a full-res frame itself if none was
  // auto-captured yet, then runs the same upload → cloud pipeline.
  async function handleAnalyzeNow() {
    runningRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    setErrorText(null);
    if (capturedImagesRef.current.length === 0) {
      setPhaseBoth("analyzing");
      try {
        await captureFullFrame("front");
      } catch (err) {
        setErrorText(`Capture failed: ${(err as Error).message || "unknown error"}`);
        setPhaseBoth("scanning");
        return;
      }
      if (capturedImagesRef.current.length === 0) {
        setErrorText("Could not capture a photo. Make sure the camera is working, then try again.");
        setPhaseBoth("scanning");
        return;
      }
    }
    await finishAndAnalyze();
  }

  if (!permission) return <View style={styles.container} />;

  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Text style={styles.body}>{t("scanner.cameraNeeded")}</Text>
        <Pressable style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>{t("scanner.grantCamera")}</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === "analyzing") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#C9A227" size="large" />
        <Text style={styles.body}>{t("scanner.analyzing")}</Text>
      </View>
    );
  }

  if (phase === "locked") {
    return (
      <View style={styles.centered}>
        <Text style={styles.lockHeadline}>{AUTO_LOCK_COPY.headline}</Text>
        <Text style={styles.body}>{AUTO_LOCK_COPY.sub}</Text>
        {confidence != null && (
          <Text style={styles.confidenceBig}>
            {t("scanner.confidence")} · {Math.round(confidence * 100)}%
          </Text>
        )}
        <Text style={styles.meterLabel}>
          {t("scanner.progress")} · {Math.round(evidence * 100)}%
        </Text>
        <Pressable style={styles.primaryButton} onPress={viewResults}>
          <Text style={styles.primaryButtonText}>{t("scanner.viewResults")}</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={keepScanning}>
          <Text style={styles.link}>{t("scanner.keepScanning")}</Text>
        </Pressable>
      </View>
    );
  }

  // ── Live scanner HUD (detecting + scanning share the same camera overlay) ──
  const gemPresent = detectionPresent || phase === "scanning";

  // Status headline: detection narration before scanning, progress narration
  // during scanning.
  const statusText =
    phase === "detecting"
      ? detectionPresent
        ? t("scanner.detected")
        : t("scanner.detecting")
      : t(SCAN_STATUS_I18N_KEY[scanStatusForProgress(evidence)]);

  const scanLineTranslateY = scanLineAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, screenH],
  });
  const frameOpacity = framePulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.45, 1],
  });

  // Map the normalized detection box to screen space for the animated frame.
  const box = detectionBox;
  const boxStyle = box
    ? {
        left: box.x * screenW,
        top: box.y * screenH,
        width: box.width * screenW,
        height: box.height * screenH,
      }
    : null;

  const progressPct = Math.round(evidence * 100);

  return (
    <View style={styles.container}>
      <ImageProcessorGL ref={imageProcessorRef} />
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        onCameraReady={() => {
          cameraReadyRef.current = true;
        }}
      />

      {/* Floating back control — the live screen has no header, so this is the
          explicit way out of the camera (the Android hardware back also works). */}
      <Pressable
        style={styles.backButton}
        onPress={() => router.back()}
        hitSlop={10}
        accessibilityLabel="Back"
      >
        <Ionicons name="arrow-back" size={24} color="#F5F1E8" />
      </Pressable>

      {/* Sweeping scan line — the signature "scanner" motion. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.scanLine, { transform: [{ translateY: scanLineTranslateY }] }]}
      />

      {/* Animated frame around the detected object (or a centered guide box
          while still detecting). Corner brackets pulse to read as "tracking". */}
      {boxStyle ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.detectionFrame,
            boxStyle,
            { opacity: frameOpacity, borderColor: gemPresent ? "#2E7D32" : "#C9A227" },
          ]}
        >
          <View style={[styles.corner, styles.cornerTL]} />
          <View style={[styles.corner, styles.cornerTR]} />
          <View style={[styles.corner, styles.cornerBL]} />
          <View style={[styles.corner, styles.cornerBR]} />
        </Animated.View>
      ) : (
        <View style={styles.reticleWrap} pointerEvents="none">
          <Animated.View style={[styles.reticle, { opacity: frameOpacity }]} />
        </View>
      )}

      {/* Top: status narration + detection message. */}
      <View style={styles.topBar} pointerEvents="none">
        <View style={styles.statusPill}>
          <View style={[styles.statusDot, { backgroundColor: gemPresent ? "#2E7D32" : "#C9A227" }]} />
          <Text style={styles.statusText}>{statusText}</Text>
        </View>
        {phase === "detecting" && !detectionPresent && (
          <Text style={styles.detectHint}>{t("scanner.noGemstone")}</Text>
        )}
        {guidanceText ? <Text style={styles.guidance}>{guidanceText}</Text> : null}
      </View>

      {/* Bottom: progress + live confidence + captured chips + controls. */}
      <View style={styles.bottomBar}>
        <View style={styles.meterRow}>
          <Text style={styles.meterLabel}>{t("scanner.progress")}</Text>
          <Text style={styles.meterValue}>{progressPct}%</Text>
        </View>
        <View style={styles.meterTrack}>
          <View style={[styles.meterFill, { width: `${progressPct}%` }]} />
        </View>

        <View style={styles.meterRow}>
          <Text style={styles.subMeterLabel}>{t("scanner.confidence")}</Text>
          <Text style={styles.subMeterValue}>
            {evaluating
              ? t("scanner.verifying")
              : confidence != null
                ? `${Math.round(confidence * 100)}%`
                : t("scanner.notChecked")}
          </Text>
        </View>

        <Text style={styles.chips}>
          {t("scanner.captured")}:{" "}
          {capturedAngles.length ? capturedAngles.join(", ") : "…"}
        </Text>

        {glUnavailable && (
          <Text style={styles.noticeText}>
            Live auto-detect isn’t supported on this phone. Point at the stone and tap “Scan now”.
          </Text>
        )}

        {errorText && <Text style={styles.errorText}>{errorText}</Text>}

        {/* Always-available manual path — the reliable capture → cloud flow that
            works regardless of whether on-device detection is running. */}
        <Pressable style={styles.analyzeButton} onPress={handleAnalyzeNow}>
          <Text style={styles.primaryButtonText}>
            {canAnalyzeNow ? t("scanner.analyzeNow") : "Scan now"}
          </Text>
        </Pressable>

        <View style={styles.secondaryRow}>
          <Pressable onPress={() => router.replace("/(app)/scan/upload")}>
            <Text style={styles.link}>{t("scanner.uploadInstead")}</Text>
          </Pressable>
          <Pressable onPress={() => router.replace("/(app)/scan/capture")}>
            <Text style={styles.link}>{t("scanner.manualCapture")}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  backButton: {
    position: "absolute",
    top: 48,
    left: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(11,11,12,0.6)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  centered: { flex: 1, backgroundColor: "#0B0B0C", padding: 24, gap: 14, justifyContent: "center" },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  lockHeadline: { fontSize: 24, fontWeight: "700", color: "#2E7D32" },
  confidenceBig: { fontSize: 18, fontWeight: "700", color: "#C9A227" },

  scanLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: "rgba(201,162,39,0.9)",
    shadowColor: "#C9A227",
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },

  reticleWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  reticle: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: "rgba(201,162,39,0.9)",
    borderRadius: 24,
  },

  detectionFrame: {
    position: "absolute",
    borderWidth: 2,
    borderRadius: 12,
  },
  corner: {
    position: "absolute",
    width: 18,
    height: 18,
    borderColor: "#F5F1E8",
  },
  cornerTL: { top: -2, left: -2, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 12 },
  cornerTR: { top: -2, right: -2, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 12 },
  cornerBL: { bottom: -2, left: -2, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 12 },
  cornerBR: { bottom: -2, right: -2, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 12 },

  topBar: { position: "absolute", top: 48, left: 20, right: 20, alignItems: "center", gap: 8 },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(11,11,12,0.72)",
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: "#F5F1E8", fontSize: 15, fontWeight: "700" },
  detectHint: {
    color: "#F5F1E8",
    fontSize: 13,
    textAlign: "center",
    backgroundColor: "rgba(11,11,12,0.72)",
    borderRadius: 12,
    paddingVertical: 6,
    paddingHorizontal: 12,
    overflow: "hidden",
  },
  guidance: {
    color: "#C9A227",
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowRadius: 6,
  },

  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 20,
    paddingBottom: 32,
    gap: 8,
    backgroundColor: "rgba(11,11,12,0.72)",
  },
  meterRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  meterValue: { color: "#F5F1E8", fontSize: 13, fontWeight: "700" },
  meterTrack: { height: 8, borderRadius: 999, backgroundColor: "#2A2A2C", overflow: "hidden" },
  meterFill: { height: 8, backgroundColor: "#2E7D32" },
  meterLabel: { color: "#C9C9CC", fontSize: 12 },
  subMeterLabel: { color: "#8A8A8E", fontSize: 12 },
  subMeterValue: { color: "#C9A227", fontSize: 12, fontWeight: "600" },
  chips: { color: "#8A8A8E", fontSize: 12 },
  errorText: { color: "#E4685D", fontSize: 13 },
  noticeText: { color: "#C9A227", fontSize: 13, lineHeight: 18 },
  primaryButton: { backgroundColor: "#C9A227", borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  primaryButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
  secondaryButton: { alignItems: "center", paddingVertical: 8 },
  analyzeButton: { backgroundColor: "#2E7D32", borderRadius: 999, paddingVertical: 14, alignItems: "center", marginTop: 4 },
  secondaryRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  link: { color: "#C9C9CC", fontSize: 13, textDecorationLine: "underline" },
});

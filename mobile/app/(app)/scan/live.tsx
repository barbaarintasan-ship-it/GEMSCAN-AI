// LIVE SCAN MODE (primary experience) + INTELLIGENT AUTO SCAN LOCK.
//
// Opens the camera immediately and continuously analyzes the preview on-device:
// every ~600ms it grabs a low-res snapshot, runs the existing
// ImageProcessorGL.assessQuality (Stage 1 blur/exposure), and feeds the result
// into the pure lib/liveScanEngine state machine. The engine drives live
// guidance ("Hold steady", "Move closer", …), auto-captures a full-resolution
// frame when an angle locks in, marches through the multi-angle sequence, and
// decides when enough evidence has been collected.
//
// Layered ON TOP (without redesigning the above) is the Auto Scan Lock system
// (lib/autoScanLock.ts): as evidence accumulates the screen spends a *bounded*
// number of real cloud evaluations against ONE reused scanId, shows the live
// AI confidence + an Evidence Quality indicator, and — the moment the ensemble
// confidence crosses the backend-configured threshold (default 95%) —
// automatically locks with "High confidence achieved." / "Analysis complete."
// The user can still keep scanning or analyze manually.
//
// Reuse contract: capture/enhance/detect/segment/upload/orchestrate are the
// SAME functions the manual capture screen uses. Cost/battery: only the cheap
// on-device quality check runs per frame; a full-resolution capture happens
// only when an angle locks in; cloud calls are capped and stop entirely once
// confidence is high enough (reusing one scanId means re-evals don't consume
// extra daily quota).
import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
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
  nextAngleLabel,
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

// How often we sample the preview for on-device analysis. ~600ms (≈1.6 fps) is
// a deliberate balance: responsive-feeling guidance without hammering the
// camera/GPU/battery. Device-tunable.
const SAMPLE_INTERVAL_MS = 600;

// How many distinct required angles define full evidence coverage — used by the
// Evidence Quality blend. Mirrors the non-optional steps of the live sequence.
const REQUIRED_ANGLE_COUNT = LIVE_ANGLE_SEQUENCE.filter((s) => !s.optional).length;

export default function LiveScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const imageProcessorRef = useRef<ImageProcessorHandle>(null);

  // Loop/engine source-of-truth lives in refs (the interval closure must read
  // the latest without re-subscribing); React state mirrors it for the HUD.
  const engineStateRef = useRef<LiveScanState>(createLiveScanState());
  const capturedImagesRef = useRef<CapturedAngleImage[]>([]);
  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto Scan Lock bookkeeping (all in refs — read inside the loop closure).
  const scanIdRef = useRef<string | null>(null); // ONE reused scan across evals
  const uploadedAnglesRef = useRef<Set<string>>(new Set());
  const lastConfidenceRef = useRef<number | null>(null);
  const evalsUsedRef = useRef(0);
  const anglesAtLastEvalRef = useRef(0);
  const thresholdRef = useRef(DEFAULT_AUTOLOCK_CONFIG.threshold);
  const manualContinueRef = useRef(false); // user chose to keep scanning past a lock

  const [guidanceText, setGuidanceText] = useState("Point the camera at your specimen");
  const [evidence, setEvidence] = useState(0);
  const [evidenceQuality, setEvidenceQuality] = useState(0);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [targetLabel, setTargetLabel] = useState<string | null>("front");
  const [capturedAngles, setCapturedAngles] = useState<CapturedAngleImage["angle"][]>([]);
  const [canAnalyzeNow, setCanAnalyzeNow] = useState(false);
  const [phase, setPhase] = useState<"scanning" | "locked" | "analyzing">("scanning");
  const [errorText, setErrorText] = useState<string | null>(null);

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

  function scheduleTick(delay: number) {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(tick, delay);
  }

  async function tick() {
    if (!runningRef.current) return;
    if (busyRef.current || !cameraRef.current || !imageProcessorRef.current) {
      scheduleTick(SAMPLE_INTERVAL_MS);
      return;
    }
    busyRef.current = true;
    try {
      const snap = await cameraRef.current.takePictureAsync({ quality: 0, skipProcessing: true });
      if (!snap?.uri) throw new Error("No preview frame");

      const q = await imageProcessorRef.current.assessQuality(snap.uri);
      // The low-res sampling frame is disposable — a full-res frame is grabbed
      // separately if this angle locks in.
      FileSystem.deleteAsync(snap.uri, { idempotent: true }).catch(() => {});

      const decision = processFrame(engineStateRef.current, q);
      engineStateRef.current = decision.state;

      setGuidanceText(decision.guidanceText);
      setEvidence(decision.evidenceStrength);
      setTargetLabel(nextAngleLabel(decision.state) ?? null);
      setCanAnalyzeNow(canAnalyze(decision.state));

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
      // Transient (GL not ready yet, a dropped frame): log at breadcrumb level
      // and keep scanning rather than aborting the whole session.
      captureException(err, { where: "live.tick" });
    } finally {
      busyRef.current = false;
      if (runningRef.current) scheduleTick(SAMPLE_INTERVAL_MS);
    }
  }

  async function captureFullFrame(angle: Angle) {
    if (!cameraRef.current || !imageProcessorRef.current) return;
    const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
    if (!photo?.uri) return;

    const quality = await imageProcessorRef.current.assessQuality(photo.uri);
    const [detectionBbox, enhanced] = await Promise.all([
      detectSpecimenBoundingBox(photo.uri),
      imageProcessorRef.current.enhance(photo.uri),
    ]);

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

  // Auto-lock (req 3): the scan finalizes automatically — no button press. The
  // cloud evaluation already ran on scanIdRef, so the result is ready; we show
  // the lock screen and let the user view it or keep scanning (req 7).
  function autoLock() {
    runningRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    setPhase("locked");
  }

  function viewResults() {
    if (scanIdRef.current) {
      router.replace({ pathname: "/(app)/scan/results", params: { scanId: scanIdRef.current } });
    }
  }

  function keepScanning() {
    manualContinueRef.current = true; // suppress further auto-locks
    setPhase("scanning");
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
    setPhase("analyzing");
    try {
      const scanId = await ensureScanId();
      await uploadPending(scanId);
      const front = images.find((i) => i.angle === "front") ?? images[0];
      const onDeviceHint = await classifyCoarse(front.processedUri);
      const result = await runOrchestration(scanId, onDeviceHint);
      router.replace({ pathname: "/(app)/scan/results", params: { scanId: result.scanId } });
    } catch (err) {
      captureException(err, { where: "live.finishAndAnalyze" });
      setErrorText((err as Error).message);
      setPhase("scanning");
    }
  }

  function handleAnalyzeNow() {
    runningRef.current = false;
    void finishAndAnalyze();
  }

  if (!permission) return <View style={styles.container} />;

  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Text style={styles.body}>GemScan AI needs camera access to scan specimens.</Text>
        <Pressable style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>Grant camera access</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === "analyzing") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#C9A227" size="large" />
        <Text style={styles.body}>
          Analyzing your specimen — running the AI ensemble. This can take up to 30 seconds…
        </Text>
      </View>
    );
  }

  if (phase === "locked") {
    return (
      <View style={styles.centered}>
        <Text style={styles.lockHeadline}>{AUTO_LOCK_COPY.headline}</Text>
        <Text style={styles.body}>{AUTO_LOCK_COPY.sub}</Text>
        {confidence != null && (
          <Text style={styles.confidenceBig}>AI confidence · {Math.round(confidence * 100)}%</Text>
        )}
        <Text style={styles.meterLabel}>
          Evidence quality · {Math.round(evidenceQuality * 100)}%
        </Text>
        <Pressable style={styles.primaryButton} onPress={viewResults}>
          <Text style={styles.primaryButtonText}>View results</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={keepScanning}>
          <Text style={styles.link}>Keep scanning</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ImageProcessorGL ref={imageProcessorRef} />
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />

      {/* Center reticle — where to hold the specimen. */}
      <View style={styles.reticleWrap} pointerEvents="none">
        <View style={styles.reticle} />
      </View>

      {/* Top: live guidance. */}
      <View style={styles.topBar} pointerEvents="none">
        <Text style={styles.guidance}>{guidanceText}</Text>
        {targetLabel && <Text style={styles.target}>Now show the {targetLabel}</Text>}
      </View>

      {/* Bottom: evidence meter + live confidence/quality + captured chips + controls. */}
      <View style={styles.bottomBar}>
        <View style={styles.meterTrack}>
          <View style={[styles.meterFill, { width: `${Math.round(evidence * 100)}%` }]} />
        </View>
        <Text style={styles.meterLabel}>Evidence collected · {Math.round(evidence * 100)}%</Text>

        <Text style={styles.subMeterLabel}>
          Evidence quality · {Math.round(evidenceQuality * 100)}%
        </Text>
        <Text style={styles.subMeterLabel}>
          AI confidence ·{" "}
          {evaluating
            ? "verifying…"
            : confidence != null
              ? `${Math.round(confidence * 100)}%`
              : "not yet checked"}
        </Text>

        <Text style={styles.chips}>
          Captured: {capturedAngles.length ? capturedAngles.join(", ") : "scanning…"}
        </Text>

        {errorText && <Text style={styles.errorText}>{errorText}</Text>}

        {canAnalyzeNow && (
          <Pressable style={styles.analyzeButton} onPress={handleAnalyzeNow}>
            <Text style={styles.primaryButtonText}>Analyze now</Text>
          </Pressable>
        )}

        <View style={styles.secondaryRow}>
          <Pressable onPress={() => router.replace("/(app)/scan/upload")}>
            <Text style={styles.link}>Upload images instead</Text>
          </Pressable>
          <Pressable onPress={() => router.replace("/(app)/scan/capture")}>
            <Text style={styles.link}>Manual capture</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  centered: { flex: 1, backgroundColor: "#0B0B0C", padding: 24, gap: 14, justifyContent: "center" },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  lockHeadline: { fontSize: 24, fontWeight: "700", color: "#2E7D32" },
  confidenceBig: { fontSize: 18, fontWeight: "700", color: "#C9A227" },
  reticleWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  reticle: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: "rgba(201,162,39,0.9)",
    borderRadius: 24,
  },
  topBar: { position: "absolute", top: 24, left: 20, right: 20, alignItems: "center", gap: 4 },
  guidance: {
    color: "#F5F1E8",
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowRadius: 6,
  },
  target: { color: "#C9A227", fontSize: 14, fontWeight: "600", textShadowColor: "rgba(0,0,0,0.8)", textShadowRadius: 6 },
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
  meterTrack: { height: 8, borderRadius: 999, backgroundColor: "#2A2A2C", overflow: "hidden" },
  meterFill: { height: 8, backgroundColor: "#2E7D32" },
  meterLabel: { color: "#C9C9CC", fontSize: 12 },
  subMeterLabel: { color: "#8A8A8E", fontSize: 12 },
  chips: { color: "#8A8A8E", fontSize: 12 },
  errorText: { color: "#E4685D", fontSize: 13 },
  primaryButton: { backgroundColor: "#C9A227", borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  primaryButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
  secondaryButton: { alignItems: "center", paddingVertical: 8 },
  analyzeButton: { backgroundColor: "#2E7D32", borderRadius: 999, paddingVertical: 14, alignItems: "center", marginTop: 4 },
  secondaryRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  link: { color: "#C9C9CC", fontSize: 13, textDecorationLine: "underline" },
});

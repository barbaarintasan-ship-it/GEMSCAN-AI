// LIVE SCANNER — production state machine (redesigned per spec).
//
// State flow:
//   initializing → ready → classifying → (rejected | capturing) → analyzing → results
//                                    ↘ (manual fallback → /scan/capture)
//
//   1. INITIALIZING  Camera opens; we WAIT for onCameraReady + a short
//      autofocus/exposure stabilisation delay before enabling scanning. No
//      detection runs before the camera is fully ready.
//   2. READY         A large "Scan Now" button. Scanning starts ONLY on press.
//   3. CLASSIFYING   One on-device MobileNet pass classifies the object. Clearly
//      unsupported objects (food/person/animal/…) are rejected here with NO
//      cloud call. (Stage 1 + cost gate — see lib/objectClassifier.)
//   4. CAPTURING     Guided automatic capture: the app narrates angles and auto-
//      captures full-res frames, keeping only ones that pass quality validation,
//      until enough good evidence exists — then it locks automatically.
//   5. ANALYZING     Only now are the selected images sent to the existing cloud
//      ensemble (Gemini → OpenAI → Claude → orchestrator), unchanged.
//
// Manual capture / upload remain available as fallbacks.
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Image,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useKeepAwake } from "expo-keep-awake";
import { ImageProcessorGL, type ImageProcessorHandle } from "../../../components/ImageProcessorGL";
import { detectSpecimenBoundingBox } from "../../../lib/onDeviceDetection";
import { segmentBackground } from "../../../lib/backgroundSegmentation";
import { getFuzzedLocation } from "../../../lib/location";
import { createScan, uploadScanImage, runOrchestration, type CapturedAngleImage } from "../../../lib/scanUpload";
import { captureException } from "../../../lib/monitoring";
import { LIVE_ANGLE_SEQUENCE } from "../../../lib/liveScanEngine";
import { precheckObject, categoryLabel, type SupportedCategory } from "../../../lib/objectPrecheck";
import { diag } from "../../../lib/diagnostics";

type Phase = "initializing" | "ready" | "classifying" | "rejected" | "capturing" | "analyzing";

// Autofocus/exposure stabilisation delay after the camera signals ready.
const STABILIZE_MS = 1200;
// Guided-capture window and cadence.
const CAPTURE_WINDOW_MS = 20000;
const CAPTURE_GAP_MS = 1500;
const MAX_EVIDENCE = LIVE_ANGLE_SEQUENCE.length; // 8
const MIN_EVIDENCE = 3;

// Rotating capture guidance (spec §6).
const GUIDANCE_EN = [
  "Hold the object centered",
  "Move slowly left",
  "Move slowly right",
  "Tilt upward",
  "Tilt downward",
  "Rotate slowly",
  "Show the top",
  "Show an edge",
];
const GUIDANCE_SO = [
  "Shayga dhexda ku hay",
  "Tartiib u dhaqaaji bidix",
  "Tartiib u dhaqaaji midig",
  "Kor u jeedi",
  "Hoos u jeedi",
  "Tartiib u wareeji",
  "Muuji dusha",
  "Muuji cidhifka",
];

export default function LiveScanScreen() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const lang: "en" | "so" = i18n.language === "so" ? "so" : "en";
  const L = (en: string, so: string) => (lang === "so" ? so : en);
  useKeepAwake();

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const cameraReadyRef = useRef(false);
  const imageProcessorRef = useRef<ImageProcessorHandle>(null);

  const [phase, setPhase] = useState<Phase>("initializing");
  const phaseRef = useRef<Phase>("initializing");
  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const [category, setCategory] = useState<SupportedCategory>("unknown");
  const [guidance, setGuidance] = useState("");
  const [evidence, setEvidence] = useState<string[]>([]);
  const evidenceRef = useRef<string[]>([]);
  const [secondsLeft, setSecondsLeft] = useState(Math.round(CAPTURE_WINDOW_MS / 1000));
  const [errorText, setErrorText] = useState<string | null>(null);
  const [manualOffer, setManualOffer] = useState(false);

  const capturingRef = useRef(false);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stabilizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Camera lifecycle: only leave "initializing" once ready + stabilised ──
  function onCameraReady() {
    cameraReadyRef.current = true;
    diag.log("camera_ready");
    if (stabilizeTimerRef.current) clearTimeout(stabilizeTimerRef.current);
    stabilizeTimerRef.current = setTimeout(() => {
      diag.log("camera_stabilized");
      if (phaseRef.current === "initializing") setPhaseBoth("ready");
    }, STABILIZE_MS);
  }

  useEffect(() => {
    return () => stopTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopTimers() {
    capturingRef.current = false;
    [captureTimerRef, windowTimerRef, stabilizeTimerRef].forEach((r) => {
      if (r.current) clearTimeout(r.current);
    });
    if (countdownRef.current) clearInterval(countdownRef.current);
  }

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

  async function takeFullPhoto(): Promise<string | null> {
    const cam = cameraRef.current;
    if (!cam) return null;
    await waitForCameraReady();
    try {
      const p = await cam.takePictureAsync({ quality: 0.9 });
      if (p?.uri) {
        if (p.width && p.height) {
          diag.setMetric("imageDimensions", `${p.width}×${p.height}`);
          diag.setMetric("cameraResolution", `${p.width}×${p.height}`);
        }
        return p.uri;
      }
    } catch {
      /* retry once */
    }
    await new Promise((r) => setTimeout(r, 400));
    try {
      const p2 = await cam.takePictureAsync({ quality: 0.9 });
      return p2?.uri ?? null;
    } catch {
      return null;
    }
  }

  // ── Stage 1: press Scan Now → classify the object on-device ──────────────
  async function handleScanNow() {
    setErrorText(null);
    setManualOffer(false);
    setPhaseBoth("classifying");
    const uri = await takeFullPhoto();
    if (!uri) {
      setErrorText(L("Could not capture a photo. Try again.", "Sawir lama qaadi karin. Isku day mar kale."));
      setPhaseBoth("ready");
      return;
    }
    // LEVEL 1 (on-device, best-effort) is intentionally NON-BLOCKING: the
    // on-device GL heuristic is unreliable on some devices (it can report a real
    // object as "not present"), so it must never stop a scan. Level 2 (Gemini)
    // is the authoritative gate below.

    // LEVEL 2 (cloud, Gemini only): one cheap category pre-check. Only a
    // confident NOT_SUPPORTED rejects — OpenAI/Claude are never called here.
    diag.begin("object_precheck");
    const verdict = await precheckObject(uri);
    diag.end("object_precheck", `supported=${verdict.supported} category=${verdict.category} available=${verdict.available}`);
    if (!verdict.supported) {
      setPhaseBoth("rejected");
      return;
    }
    setCategory(verdict.category);
    // First good frame is already in hand — seed evidence with it if usable.
    startCapturing(uri);
  }

  // ── Stage 2/3: guided automatic capture with quality validation ──────────
  function startCapturing(seedUri?: string) {
    stopTimers();
    capturingRef.current = true;
    evidenceRef.current = [];
    setEvidence([]);
    setErrorText(null);
    setManualOffer(false);
    setPhaseBoth("capturing");
    diag.log("capture_started");
    setSecondsLeft(Math.round(CAPTURE_WINDOW_MS / 1000));

    countdownRef.current = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    windowTimerRef.current = setTimeout(finishCapturing, CAPTURE_WINDOW_MS);

    if (seedUri) void validateAndKeep(seedUri);
    captureTimerRef.current = setTimeout(captureLoop, CAPTURE_GAP_MS);
  }

  async function validateAndKeep(uri: string) {
    try {
      const q = await imageProcessorRef.current?.assessQuality(uri);
      // Reject unusable frames; keep good ones. (When GL analysis is
      // unavailable, assessQuality passes through as usable — fail open.)
      if (q && (q.blurry || q.lowLight || q.overexposed)) {
        setGuidance(
          L("Hold steady in good light…", "Si adag u hay iftiin fiican…"),
        );
        return;
      }
      if (evidenceRef.current.length >= MAX_EVIDENCE) return;
      evidenceRef.current = [...evidenceRef.current, uri];
      setEvidence(evidenceRef.current);
    } catch {
      /* ignore a single bad frame */
    }
  }

  async function captureLoop() {
    if (!capturingRef.current) return;
    const idx = evidenceRef.current.length;
    setGuidance(L(GUIDANCE_EN[idx % GUIDANCE_EN.length], GUIDANCE_SO[idx % GUIDANCE_SO.length]));

    const uri = await takeFullPhoto();
    if (uri) await validateAndKeep(uri);

    if (!capturingRef.current) return;
    if (evidenceRef.current.length >= MAX_EVIDENCE) {
      finishCapturing();
      return;
    }
    captureTimerRef.current = setTimeout(captureLoop, CAPTURE_GAP_MS);
  }

  // ── Evidence lock: enough good frames (or window elapsed) → submit ───────
  function finishCapturing() {
    stopTimers();
    if (evidenceRef.current.length >= MIN_EVIDENCE) {
      void submitEvidence();
    } else if (evidenceRef.current.length > 0) {
      // Some evidence but below target — still let the user send it.
      void submitEvidence();
    } else {
      // Nothing usable captured → offer manual mode.
      setManualOffer(true);
      setPhaseBoth("ready");
    }
  }

  // ── Stage 4: send selected evidence to the existing cloud ensemble ───────
  async function submitEvidence() {
    const uris = evidenceRef.current.slice(0, MAX_EVIDENCE);
    if (uris.length === 0 || !imageProcessorRef.current) {
      setManualOffer(true);
      setPhaseBoth("ready");
      return;
    }
    setPhaseBoth("analyzing");
    diag.log("capture_completed", `${uris.length} frames`);
    diag.setMetric("cpuFallbackActive", diag.isGpuDisabled());
    const scanStart = Date.now();
    try {
      const captured: CapturedAngleImage[] = [];
      for (let i = 0; i < uris.length; i++) {
        const angle = LIVE_ANGLE_SEQUENCE[i].angle;
        const uri = uris[i];
        const quality = await imageProcessorRef.current.assessQuality(uri);
        const [detectionBbox, enhanced] = await Promise.all([
          detectSpecimenBoundingBox(uri),
          imageProcessorRef.current.enhance(uri),
        ]);
        captured.push({ angle, originalUri: uri, processedUri: enhanced.uri, quality, detectionBbox });
      }
      const location = await getFuzzedLocation();
      const onDeviceHint =
        category !== "unknown" ? { label: category, confidence: 0.5 } : null;
      diag.begin("upload");
      const scanId = await createScan({ specimenCategory: category === "unknown" ? null : category, location });
      for (const image of captured) {
        const segmented = await segmentBackground(image.processedUri);
        await uploadScanImage(scanId, { ...image, processedUri: segmented.uri });
      }
      diag.end("upload");
      diag.begin("cloud_analysis");
      diag.setMetric("currentProvider", "Cloud analysis");
      const orchestrated = await runOrchestration(scanId, onDeviceHint);
      diag.end("cloud_analysis");
      diag.setMetric("lastScanMs", Date.now() - scanStart);
      diag.log("result_displayed");
      router.replace({ pathname: "/(app)/scan/results", params: { scanId: orchestrated.scanId } });
    } catch (err) {
      diag.error("submit_failed", (err as Error).message);
      captureException(err, { where: "live.submitEvidence" });
      setErrorText((err as Error).message || L("Something went wrong.", "Wax baa qaldamay."));
      setPhaseBoth("ready");
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  if (!permission) return <View style={styles.container} />;

  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Text style={styles.body}>{L("GemScan needs camera access to scan.", "GemScan wuxuu u baahan yahay kamerada.")}</Text>
        <Pressable style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>{L("Grant camera access", "Ogolow kamerada")}</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === "analyzing") {
    return (
      <View style={styles.centered}>
        <ImageProcessorGL ref={imageProcessorRef} />
        <ActivityIndicator color="#C9A227" size="large" />
        <Text style={styles.body}>{L("Identifying your specimen — up to 30 seconds…", "Waa la aqoonsanayaa tusaalahaaga — ilaa 30 ilbiriqsi…")}</Text>
      </View>
    );
  }

  if (phase === "rejected") {
    return (
      <View style={styles.centered}>
        <ImageProcessorGL ref={imageProcessorRef} />
        <View style={styles.rejectCard}>
          <View style={styles.rejectIconWrap}>
            <Ionicons name="diamond-outline" size={38} color="#E4685D" />
          </View>
          <Text style={styles.rejectTitle}>
            {L(
              "That doesn't look like a gemstone",
              "Taasi uma ekaanin dhagax qaali ah",
            )}
          </Text>
          <Text style={styles.rejectHint}>
            {L(
              "Point the camera at a gemstone, gold item, coin or artifact — and make sure it fills the frame in good light.",
              "Kamerada ku soo hoggaan dhagax qaali, dahab, lacag ama shay taariikhi ah — oo hubi inuu sawirka buuxiyo iftiin fiican.",
            )}
          </Text>
          <Pressable style={styles.rejectButton} onPress={() => setPhaseBoth("ready")}>
            <Ionicons name="scan-outline" size={18} color="#0B0B0C" />
            <Text style={styles.primaryButtonText}>{L("Try again", "Isku day mar kale")}</Text>
          </Pressable>
          <Pressable style={styles.linkButton} onPress={() => router.back()}>
            <Text style={styles.link}>{L("Back to home", "Ku noqo bogga hore")}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // Camera-backed phases (initializing / ready / classifying / capturing)
  return (
    <View style={styles.container}>
      <ImageProcessorGL ref={imageProcessorRef} />
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" onCameraReady={onCameraReady} />

      <Pressable style={styles.backButton} onPress={() => router.back()} hitSlop={10} accessibilityLabel="Back">
        <Ionicons name="arrow-back" size={24} color="#F5F1E8" />
      </Pressable>

      {/* Top status */}
      <View style={styles.topBar} pointerEvents="none">
        <View style={styles.statusPill}>
          <View style={[styles.statusDot, { backgroundColor: phase === "capturing" ? "#2E7D32" : "#C9A227" }]} />
          <Text style={styles.statusText}>
            {phase === "initializing"
              ? L("Preparing camera…", "Kaamirada ayaa diyaar noqonaysa…")
              : phase === "ready"
                ? L("Ready to scan", "Diyaar u ah baaris")
                : phase === "classifying"
                  ? L("Checking the object…", "Shayga la hubinayaa…")
                  : `${L("Capturing", "Sawir qaadis")} · ${secondsLeft}s`}
          </Text>
        </View>
        {phase === "capturing" && !!guidance && <Text style={styles.guidance}>{guidance}</Text>}
        {phase === "capturing" && category !== "unknown" && (
          <Text style={styles.categoryHint}>{categoryLabel(category, lang)}</Text>
        )}
      </View>

      {/* Center: loading while initializing/classifying */}
      {(phase === "initializing" || phase === "classifying") && (
        <View style={styles.centerOverlay} pointerEvents="none">
          <ActivityIndicator color="#C9A227" size="large" />
        </View>
      )}

      {/* Bottom controls */}
      <View style={styles.bottomBar}>
        {phase === "capturing" && (
          <>
            <View style={styles.evidenceRow}>
              {evidence.map((uri, i) => (
                <View key={uri} style={styles.evidenceItem}>
                  <Image source={{ uri }} style={styles.evidenceThumb} />
                  <Text style={styles.evidenceCheck}>{`${L("Image", "Sawir")} ${i + 1} ✓`}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.count}>
              {evidence.length}/{MAX_EVIDENCE} {L("good photos", "sawir wanaagsan")}
            </Text>
            <Pressable style={styles.primaryButton} onPress={finishCapturing}>
              <Text style={styles.primaryButtonText}>{L("Done — analyze", "Dhammaystir — baar")}</Text>
            </Pressable>
          </>
        )}

        {phase === "ready" && (
          <>
            {errorText && <Text style={styles.errorText}>{errorText}</Text>}
            {manualOffer && (
              <View style={styles.manualCard}>
                <Text style={styles.manualText}>
                  {L(
                    "Automatic capture failed. Would you like to switch to Manual Mode?",
                    "Sawir-qaadista otomaatiga ah way fashilantay. Ma rabtaa inaad u wareegto habka gacanta?",
                  )}
                </Text>
                <Pressable style={styles.secondaryButton} onPress={() => router.replace("/(app)/scan/capture")}>
                  <Text style={styles.secondaryButtonText}>{L("Manual Mode", "Habka Gacanta")}</Text>
                </Pressable>
              </View>
            )}
            <Pressable style={styles.scanNowButton} onPress={handleScanNow}>
              <Ionicons name="scan-outline" size={22} color="#0B0B0C" />
              <Text style={styles.scanNowText}>{L("Scan Now", "Hadda Baar")}</Text>
            </Pressable>
          </>
        )}

        {(phase === "ready" || phase === "capturing") && (
          <View style={styles.secondaryRow}>
            <Pressable onPress={() => router.replace("/(app)/scan/upload")}>
              <Text style={styles.link}>{L("Upload photos", "Sawiro geli")}</Text>
            </Pressable>
            <Pressable onPress={() => router.replace("/(app)/scan/capture")}>
              <Text style={styles.link}>{L("Manual capture", "Sawir gacan")}</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  centered: { flex: 1, backgroundColor: "#0B0B0C", padding: 24, gap: 14, justifyContent: "center", alignItems: "center" },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20, textAlign: "center" },
  rejectCard: {
    backgroundColor: "#141315",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#2a2325",
    padding: 24,
    alignItems: "center",
    gap: 14,
    width: "100%",
    maxWidth: 380,
  },
  rejectIconWrap: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "rgba(228,104,93,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  rejectTitle: { fontSize: 20, fontWeight: "800", color: "#F5F1E8", textAlign: "center", lineHeight: 27 },
  rejectHint: { fontSize: 14, color: "#A9A39A", textAlign: "center", lineHeight: 20 },
  rejectSub: { fontSize: 13, color: "#8A8A8E", textAlign: "center" },
  rejectButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 32,
    marginTop: 4,
    alignSelf: "stretch",
  },

  backButton: {
    position: "absolute", top: 48, left: 16, width: 44, height: 44, borderRadius: 22,
    backgroundColor: "rgba(11,11,12,0.6)", alignItems: "center", justifyContent: "center", zIndex: 10,
  },
  topBar: { position: "absolute", top: 48, left: 20, right: 20, alignItems: "center", gap: 8 },
  statusPill: {
    flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(11,11,12,0.72)",
    borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: "#F5F1E8", fontSize: 15, fontWeight: "700" },
  guidance: {
    color: "#C9A227", fontSize: 15, fontWeight: "700", textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.8)", textShadowRadius: 6,
  },
  categoryHint: { color: "#F5F1E8", fontSize: 13, backgroundColor: "rgba(46,125,50,0.8)", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 12, overflow: "hidden" },

  centerOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },

  bottomBar: {
    position: "absolute", bottom: 0, left: 0, right: 0, padding: 20, paddingBottom: 32, gap: 12,
    backgroundColor: "rgba(11,11,12,0.72)",
  },
  evidenceRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  evidenceItem: { alignItems: "center" },
  evidenceThumb: { width: 54, height: 54, borderRadius: 8, backgroundColor: "#1A1A1D" },
  evidenceCheck: { color: "#2E7D32", fontSize: 10, marginTop: 2, fontWeight: "700" },
  count: { color: "#C9C9CC", fontSize: 13, textAlign: "center" },

  scanNowButton: {
    flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8,
    backgroundColor: "#C9A227", borderRadius: 999, paddingVertical: 18,
  },
  scanNowText: { color: "#0B0B0C", fontWeight: "800", fontSize: 18 },

  primaryButton: { backgroundColor: "#C9A227", borderRadius: 999, paddingVertical: 16, alignItems: "center" },
  primaryButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 16 },
  secondaryButton: { borderWidth: 1, borderColor: "#C9A227", borderRadius: 999, paddingVertical: 12, alignItems: "center", marginTop: 8 },
  secondaryButtonText: { color: "#C9A227", fontWeight: "700", fontSize: 15 },
  manualCard: { backgroundColor: "rgba(26,26,29,0.9)", borderRadius: 14, padding: 14, gap: 6 },
  manualText: { color: "#F5F1E8", fontSize: 14, lineHeight: 20 },

  errorText: { color: "#E4685D", fontSize: 13, textAlign: "center" },
  linkButton: { alignItems: "center", paddingVertical: 8 },
  secondaryRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  link: { color: "#C9C9CC", fontSize: 13, textDecorationLine: "underline" },
});

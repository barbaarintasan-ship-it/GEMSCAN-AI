// LIVE SCANNER — burst-capture model (by user request).
//
// The camera is live; over a ~18-second window the app automatically captures
// several full-resolution frames (no fragile on-device detection gate). Then the
// user REVIEWS the captured photos, removes any poor ones, and taps Send to run
// the SAME cloud pipeline as Upload (createScan → uploadScanImage →
// runOrchestration). This deliberately replaces the old auto-detect / auto-lock
// engine, which depended on an unreliable on-device GL path and left the scan
// stuck at 0%.
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Image,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useKeepAwake } from "expo-keep-awake";
import { ImageProcessorGL, type ImageProcessorHandle } from "../../../components/ImageProcessorGL";
import { detectSpecimenBoundingBox, classifyCoarse } from "../../../lib/onDeviceDetection";
import { segmentBackground } from "../../../lib/backgroundSegmentation";
import { getFuzzedLocation } from "../../../lib/location";
import { createScan, uploadScanImage, runOrchestration, type CapturedAngleImage } from "../../../lib/scanUpload";
import { captureException } from "../../../lib/monitoring";
import { LIVE_ANGLE_SEQUENCE } from "../../../lib/liveScanEngine";

const CAPTURE_WINDOW_MS = 18000; // ~18s capture window (15–20s)
const MAX_PHOTOS = LIVE_ANGLE_SEQUENCE.length; // cap = number of angle slots
const CAPTURE_GAP_MS = 1600; // pause between auto-captures

type Phase = "capturing" | "review" | "analyzing";

export default function LiveScanScreen() {
  const router = useRouter();
  useKeepAwake();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const cameraReadyRef = useRef(false);
  const imageProcessorRef = useRef<ImageProcessorHandle>(null);

  const [phase, setPhase] = useState<Phase>("capturing");
  const [photos, setPhotos] = useState<string[]>([]);
  const photosRef = useRef<string[]>([]);
  const [secondsLeft, setSecondsLeft] = useState(Math.round(CAPTURE_WINDOW_MS / 1000));
  const [errorText, setErrorText] = useState<string | null>(null);

  const capturingRef = useRef(false);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start the capture window once the camera permission is granted.
  useEffect(() => {
    if (!permission?.granted) return;
    startCapturing();
    return () => stopTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission?.granted]);

  function stopTimers() {
    capturingRef.current = false;
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    if (windowTimerRef.current) clearTimeout(windowTimerRef.current);
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

  // Take one full-res photo, tolerant of Android's transient capture failures.
  async function takeFullPhoto(): Promise<string | null> {
    const cam = cameraRef.current;
    if (!cam) return null;
    await waitForCameraReady();
    try {
      const p = await cam.takePictureAsync({ quality: 0.9 });
      if (p?.uri) return p.uri;
    } catch {
      // fall through to a single retry
    }
    await new Promise((r) => setTimeout(r, 400));
    try {
      const p2 = await cam.takePictureAsync({ quality: 0.9 });
      return p2?.uri ?? null;
    } catch {
      return null;
    }
  }

  function startCapturing() {
    stopTimers();
    capturingRef.current = true;
    photosRef.current = [];
    setPhotos([]);
    setErrorText(null);
    setPhase("capturing");
    setSecondsLeft(Math.round(CAPTURE_WINDOW_MS / 1000));

    countdownRef.current = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    // Hard stop at the end of the window regardless of capture pace.
    windowTimerRef.current = setTimeout(finishCapturing, CAPTURE_WINDOW_MS);
    // First capture shortly after the camera warms up.
    captureTimerRef.current = setTimeout(captureLoop, 800);
  }

  async function captureLoop() {
    if (!capturingRef.current) return;
    const uri = await takeFullPhoto();
    if (uri && capturingRef.current) {
      photosRef.current = [...photosRef.current, uri];
      setPhotos(photosRef.current);
    }
    if (!capturingRef.current) return;
    if (photosRef.current.length >= MAX_PHOTOS) {
      finishCapturing();
      return;
    }
    captureTimerRef.current = setTimeout(captureLoop, CAPTURE_GAP_MS);
  }

  // Guarded so the window timer and the max-photos path can't both fire it.
  function finishCapturing() {
    if (!capturingRef.current && phase === "review") return;
    stopTimers();
    setPhase("review");
  }

  function removePhoto(uri: string) {
    photosRef.current = photosRef.current.filter((u) => u !== uri);
    setPhotos(photosRef.current);
  }

  async function handleSend() {
    const uris = photosRef.current;
    if (uris.length === 0 || !imageProcessorRef.current) return;
    setErrorText(null);
    setPhase("analyzing");
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
      captureException(err, { where: "live.handleSend" });
      setErrorText((err as Error).message || "Something went wrong. Please try again.");
      setPhase("review");
    }
  }

  if (!permission) return <View style={styles.container} />;

  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Text style={styles.body}>GemScan AI needs camera access to scan.</Text>
        <Pressable style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>Grant camera access</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === "analyzing") {
    return (
      <View style={styles.centered}>
        <ImageProcessorGL ref={imageProcessorRef} />
        <ActivityIndicator color="#C9A227" size="large" />
        <Text style={styles.body}>Sending to the AI and analyzing — up to 30 seconds…</Text>
      </View>
    );
  }

  // ── REVIEW: show captured photos, remove poor ones, then Send ──────────────
  if (phase === "review") {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.reviewContent}>
        <ImageProcessorGL ref={imageProcessorRef} />
        <Text style={styles.heading}>Review your photos</Text>
        <Text style={styles.body}>
          {photos.length > 0
            ? "Remove any blurry or poor photos, then send the good ones for analysis."
            : "No photos were captured. Try again with the stone well-lit in frame."}
        </Text>

        {photos.length > 0 && (
          <View style={styles.grid}>
            {photos.map((uri, i) => (
              <View key={uri} style={styles.thumbWrap}>
                <Image source={{ uri }} style={styles.thumb} />
                <Pressable
                  style={styles.removeBadge}
                  onPress={() => removePhoto(uri)}
                  hitSlop={8}
                  accessibilityLabel={`Remove photo ${i + 1}`}
                >
                  <Ionicons name="close" size={16} color="#F5F1E8" />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {errorText && <Text style={styles.errorText}>{errorText}</Text>}

        {photos.length > 0 && (
          <Pressable style={styles.primaryButton} onPress={handleSend}>
            <Text style={styles.primaryButtonText}>
              Send {photos.length} {photos.length === 1 ? "photo" : "photos"} for analysis
            </Text>
          </Pressable>
        )}

        <Pressable style={styles.secondaryButton} onPress={startCapturing}>
          <Ionicons name="camera-outline" size={18} color="#C9A227" />
          <Text style={styles.secondaryButtonText}>Scan again</Text>
        </Pressable>

        <View style={styles.secondaryRow}>
          <Pressable onPress={() => router.replace("/(app)/scan/upload")}>
            <Text style={styles.link}>Upload from gallery</Text>
          </Pressable>
          <Pressable onPress={() => router.back()}>
            <Text style={styles.link}>Back</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  // ── CAPTURING: live camera with a countdown + captured count ───────────────
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

      <Pressable style={styles.backButton} onPress={() => router.back()} hitSlop={10} accessibilityLabel="Back">
        <Ionicons name="arrow-back" size={24} color="#F5F1E8" />
      </Pressable>

      <View style={styles.topBar} pointerEvents="none">
        <View style={styles.statusPill}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>Capturing… {secondsLeft}s</Text>
        </View>
        <Text style={styles.guidance}>
          Slowly rotate the stone to show different angles. Keep it well-lit and in focus.
        </Text>
      </View>

      <View style={styles.bottomBar}>
        <Text style={styles.count}>
          {photos.length} of {MAX_PHOTOS} photos captured
        </Text>
        <Pressable style={styles.primaryButton} onPress={finishCapturing}>
          <Text style={styles.primaryButtonText}>Done — review photos</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0B0B0C" },
  centered: { flex: 1, backgroundColor: "#0B0B0C", padding: 24, gap: 14, justifyContent: "center", alignItems: "center" },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  heading: { fontSize: 20, fontWeight: "700", color: "#F5F1E8" },

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
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#2E7D32" },
  statusText: { color: "#F5F1E8", fontSize: 15, fontWeight: "700" },
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
    gap: 12,
    backgroundColor: "rgba(11,11,12,0.72)",
  },
  count: { color: "#F5F1E8", fontSize: 14, textAlign: "center", fontWeight: "600" },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  thumbWrap: { width: 96 },
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
  secondaryRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  link: { color: "#C9C9CC", fontSize: 13, textDecorationLine: "underline" },
  reviewContent: { padding: 24, gap: 14, paddingBottom: 40 },
});

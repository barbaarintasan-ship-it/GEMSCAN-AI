// Field camera — a geological camera, not a photo app.
//
// What a geologist photographs is not what a phone camera is tuned for: a
// quartz vein in flat light, a fresh broken surface held at arm's length, a
// contact between two units that only reads at a distance. So the controls that
// matter here are focus, flash and framing, and they are all one thumb-reach
// from the shutter.
//
// Everything is built on expo-camera, which the app already ships. Two things
// its API does NOT expose are called out rather than faked:
//   • EXPOSURE LOCK — expo-camera 15 has no exposure API at all. Locking focus
//     (below) is real; an "AE-L" button would do nothing, so there is not one.
//   • MACRO — no dedicated macro lens selection either. What genuinely helps at
//     close range is optical zoom plus a locked focus, and both are here.
//
// The capture itself hands photos back through lib/captureHandoff and returns
// to the sample form. This screen owns no sample state and creates nothing on
// the server.
import React from "react";
import {
  ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View,
} from "react-native";
import { CameraView, useCameraPermissions, type FlashMode } from "expo-camera";
import { router, useLocalSearchParams, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius, spacing } from "../../../lib/theme";
import { putCapturedPhotos, type CapturedPhoto } from "../../../lib/captureHandoff";

/** Shots the analysis can ask for by name. The camera only ever shows what was asked. */
export const SHOT_NEEDS = [
  "closer", "angle", "fresh_surface", "wider_context",
  "vein_closeup", "weathered", "mineral_closeup",
] as const;
export type ShotNeed = (typeof SHOT_NEEDS)[number];

/** Frames taken while the shutter is held. */
const BURST_MAX = 6;
const BURST_INTERVAL_MS = 320;

export default function FieldCameraScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { need } = useLocalSearchParams<{ need?: string }>();
  const needs = React.useMemo(
    () => (need ? need.split(",").filter((n) => (SHOT_NEEDS as readonly string[]).includes(n)) : []),
    [need],
  );

  const [permission, requestPermission] = useCameraPermissions();
  const cam = React.useRef<CameraView>(null);

  const [ready, setReady] = React.useState(false);
  const [flash, setFlash] = React.useState<FlashMode>("auto");
  const [torch, setTorch] = React.useState(false);
  const [grid, setGrid] = React.useState(true);
  const [locked, setLocked] = React.useState(false);
  const [zoom, setZoom] = React.useState(0);
  const [pictureSize, setPictureSize] = React.useState<string | undefined>();
  const [shots, setShots] = React.useState<CapturedPhoto[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [activeNeed, setActiveNeed] = React.useState<string | null>(needs[0] ?? null);

  const burst = React.useRef<{ stop: boolean }>({ stop: true });

  React.useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  /**
   * Pick the largest picture size the sensor offers.
   *
   * Default is not the maximum, and a downscaled photo of a sulphide speck is
   * the one thing the analysis cannot recover from. Sizes come back as "WxH"
   * strings, so they are compared by pixel count rather than string order.
   */
  const onCameraReady = React.useCallback(async () => {
    setReady(true);
    try {
      const sizes = await cam.current?.getAvailablePictureSizesAsync();
      if (!sizes?.length) return;
      const best = sizes
        .map((s) => ({ s, px: s.split(/x|\*/i).reduce((a, b) => a * (Number(b) || 0), 1) }))
        .sort((a, b) => b.px - a.px)[0];
      if (best?.px > 0) setPictureSize(best.s);
    } catch {
      // No size list on this device: the default is still a usable photo.
    }
  }, []);

  const shoot = React.useCallback(async (): Promise<CapturedPhoto | null> => {
    if (!cam.current || !ready) return null;
    try {
      const p = await cam.current.takePictureAsync({
        // Not 1. At full quality the sensor writes 7–8 MB per frame, and a
        // traverse with a few bursts fills a field phone — 27 photos on one
        // real sample came to 136 MB. 0.9 roughly halves the file with nothing
        // visible lost on rock, and the copy that is uploaded is resized again
        // by lib/photoBudget anyway.
        quality: 0.9,
        // EXIF carries orientation, and without it a portrait outcrop shot
        // arrives at the analysis rotated.
        exif: true,
        // skipProcessing is deliberately NOT set: it would discard `quality`
        // and leave the orientation ambiguous.
      });
      if (!p?.uri) return null;
      return {
        uri: p.uri, width: p.width, height: p.height,
        need: activeNeed, takenAt: Date.now(),
      };
    } catch {
      return null;
    }
  }, [ready, activeNeed]);

  const single = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const p = await shoot();
    if (p) setShots((prev) => [...prev, p]);
    setBusy(false);
  }, [busy, shoot]);

  /**
   * Burst, while the shutter is held.
   *
   * For a hand-held close-up the difference between a sharp frame and a blurred
   * one is a few hundred milliseconds, so the answer is several frames and let
   * the geologist keep the good one. Capped, because an unbounded burst fills
   * a phone during one traverse.
   */
  const startBurst = React.useCallback(async () => {
    if (busy) return;
    burst.current = { stop: false };
    const token = burst.current;
    setBusy(true);
    for (let i = 0; i < BURST_MAX; i++) {
      if (token.stop) break;
      const p = await shoot();
      if (p) setShots((prev) => [...prev, p]);
      if (token.stop) break;
      await new Promise((r) => setTimeout(r, BURST_INTERVAL_MS));
    }
    setBusy(false);
  }, [busy, shoot]);

  const stopBurst = React.useCallback(() => { burst.current.stop = true; }, []);

  const done = React.useCallback(() => {
    putCapturedPhotos(shots);
    router.back();
  }, [shots]);

  if (!permission) {
    return <View style={styles.fillCentre}><ActivityIndicator color={colors.gold} /></View>;
  }
  if (!permission.granted) {
    return (
      <View style={styles.fillCentre}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.permText}>{t("camera.permission")}</Text>
        <Pressable style={styles.permBtn} onPress={() => void requestPermission()}>
          <Text style={styles.permBtnText}>{t("camera.grant")}</Text>
        </Pressable>
        <Pressable onPress={() => router.back()} style={styles.permGhost}>
          <Text style={styles.permGhostText}>{t("common.back")}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <CameraView
        ref={cam}
        style={StyleSheet.absoluteFill}
        facing="back"
        flash={flash}
        enableTorch={torch}
        zoom={zoom}
        // expo-camera reads this the opposite way round to how it sounds:
        // "on" focuses ONCE and holds it — which is exactly a focus lock — and
        // "off" refocuses whenever the scene changes, i.e. continuous.
        autofocus={locked ? "on" : "off"}
        pictureSize={pictureSize}
        onCameraReady={() => void onCameraReady()}
      />

      {/* Rule-of-thirds grid: what a geologist frames a contact or a vein
          against, and the only reliable way to keep a horizon straight. */}
      {grid ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <View style={[styles.gridLine, styles.gridV, { left: "33.33%" }]} />
          <View style={[styles.gridLine, styles.gridV, { left: "66.66%" }]} />
          <View style={[styles.gridLine, styles.gridH, { top: "33.33%" }]} />
          <View style={[styles.gridLine, styles.gridH, { top: "66.66%" }]} />
        </View>
      ) : null}

      {/* Top bar */}
      <View style={[styles.top, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.iconBtn}>
          <Ionicons name="close" size={24} color={colors.text} />
        </Pressable>

        <View style={styles.topGroup}>
          <Toggle
            icon={flash === "off" ? "flash-off" : flash === "auto" ? "flash-outline" : "flash"}
            active={flash !== "off"}
            label={t(`camera.flash.${flash}`)}
            onPress={() => setFlash(flash === "off" ? "auto" : flash === "auto" ? "on" : "off")}
          />
          <Toggle icon="bulb" active={torch} label={t("camera.torch")} onPress={() => setTorch((v) => !v)} />
          <Toggle icon="grid" active={grid} label={t("camera.grid")} onPress={() => setGrid((v) => !v)} />
          <Toggle
            icon={locked ? "lock-closed" : "lock-open"}
            active={locked}
            label={t("camera.focusLock")}
            onPress={() => setLocked((v) => !v)}
          />
        </View>
      </View>

      {/* What the analysis asked for, if anything. Only ever what it asked for. */}
      {needs.length > 0 ? (
        <View style={[styles.needs, { top: insets.top + 84 }]}>
          <Text style={styles.needsTitle}>{t("camera.needed")}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.needRow}>
            {needs.map((n) => {
              const got = shots.some((s) => s.need === n);
              const on = activeNeed === n;
              return (
                <Pressable
                  key={n}
                  onPress={() => setActiveNeed(n)}
                  style={[styles.needChip, on && styles.needChipOn, got && styles.needChipDone]}
                >
                  <Ionicons
                    name={got ? "checkmark-circle" : "ellipse-outline"}
                    size={14}
                    color={got ? "#22C55E" : on ? colors.gold : colors.textFaint}
                  />
                  <Text style={[styles.needText, on && styles.needTextOn]}>{t(`camera.need.${n}`)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {/* Bottom controls */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + spacing.md }]}>
        <View style={styles.zoomRow}>
          <Ionicons name="search" size={14} color={colors.textFaint} />
          {[0, 0.25, 0.5, 0.75, 1].map((z) => (
            <Pressable
              key={z}
              onPress={() => setZoom(z)}
              style={[styles.zoomChip, zoom === z && styles.zoomChipOn]}
            >
              <Text style={[styles.zoomText, zoom === z && styles.zoomTextOn]}>
                {z === 0 ? t("camera.zoom1x") : `${Math.round(z * 100)}%`}
              </Text>
            </Pressable>
          ))}
        </View>

        {shots.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
            {shots.map((s) => (
              <Pressable
                key={s.uri}
                onLongPress={() => setShots((prev) => prev.filter((x) => x.uri !== s.uri))}
                style={styles.thumbWrap}
              >
                <Image source={{ uri: s.uri }} style={styles.thumb} />
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <View style={styles.shutterRow}>
          <View style={styles.shutterSide}>
            <Text style={styles.count}>{t("camera.count", { n: shots.length })}</Text>
            {shots.length > 0 ? <Text style={styles.hint}>{t("camera.removeHint")}</Text> : null}
          </View>

          <Pressable
            onPress={() => void single()}
            onLongPress={() => void startBurst()}
            onPressOut={stopBurst}
            delayLongPress={320}
            style={({ pressed }) => [styles.shutter, pressed && styles.shutterPressed]}
          >
            <View style={styles.shutterInner}>
              {busy ? <ActivityIndicator color="#0B0B0C" /> : null}
            </View>
          </Pressable>

          <View style={styles.shutterSide}>
            <Pressable
              onPress={done}
              disabled={shots.length === 0}
              style={[styles.doneBtn, shots.length === 0 && styles.doneDisabled]}
            >
              <Text style={styles.doneText}>{t("camera.done")}</Text>
            </Pressable>
          </View>
        </View>
        <Text style={styles.burstHint}>{t("camera.burstHint", { n: BURST_MAX })}</Text>
      </View>
    </View>
  );
}

function Toggle({
  icon, active, label, onPress,
}: { icon: keyof typeof Ionicons.glyphMap; active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.toggle, active && styles.toggleOn]}>
      <Ionicons name={icon} size={18} color={active ? colors.gold : colors.text} />
      <Text style={[styles.toggleText, active && styles.toggleTextOn]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  fillCentre: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xl },

  permText: { color: colors.text, fontSize: 16, textAlign: "center" },
  permBtn: { backgroundColor: colors.gold, borderRadius: radius.lg, paddingVertical: spacing.md, paddingHorizontal: spacing.xxl },
  permBtnText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
  permGhost: { padding: spacing.md },
  permGhostText: { color: colors.textMuted },

  gridLine: { position: "absolute", backgroundColor: "rgba(255,255,255,0.25)" },
  gridV: { top: 0, bottom: 0, width: 1 },
  gridH: { left: 0, right: 0, height: 1 },

  top: {
    position: "absolute", top: 0, left: 0, right: 0,
    paddingHorizontal: spacing.md, paddingBottom: spacing.sm,
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    backgroundColor: "rgba(0,0,0,0.42)",
  },
  topGroup: { flex: 1, flexDirection: "row", justifyContent: "flex-end", gap: spacing.xs },
  iconBtn: { padding: spacing.xs },
  toggle: {
    alignItems: "center", gap: 2,
    paddingVertical: spacing.xs, paddingHorizontal: spacing.sm,
    borderRadius: radius.md, borderWidth: 1, borderColor: "transparent",
  },
  toggleOn: { borderColor: colors.goldBorder, backgroundColor: "rgba(201,162,39,0.16)" },
  toggleText: { color: colors.text, fontSize: 9 },
  toggleTextOn: { color: colors.gold },

  needs: { position: "absolute", left: 0, right: 0, paddingHorizontal: spacing.md },
  needsTitle: { color: colors.gold, fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginBottom: spacing.xs },
  needRow: { gap: spacing.sm, paddingRight: spacing.md },
  needChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(0,0,0,0.6)", borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: spacing.xs, paddingHorizontal: spacing.md,
  },
  needChipOn: { borderColor: colors.goldBorder },
  needChipDone: { opacity: 0.65 },
  needText: { color: colors.text, fontSize: 12 },
  needTextOn: { color: colors.gold, fontWeight: "600" },

  bottom: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    paddingHorizontal: spacing.md, paddingTop: spacing.sm,
    backgroundColor: "rgba(0,0,0,0.55)", gap: spacing.sm,
  },
  zoomRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, justifyContent: "center" },
  zoomChip: {
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border,
    paddingVertical: 4, paddingHorizontal: spacing.md,
  },
  zoomChipOn: { borderColor: colors.goldBorder, backgroundColor: "rgba(201,162,39,0.16)" },
  zoomText: { color: colors.text, fontSize: 11 },
  zoomTextOn: { color: colors.gold, fontWeight: "700" },

  strip: { gap: spacing.sm, paddingVertical: spacing.xs },
  thumbWrap: { borderRadius: radius.sm, overflow: "hidden", borderWidth: 1, borderColor: colors.border },
  thumb: { width: 54, height: 54 },

  shutterRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  shutterSide: { width: 92, gap: 2 },
  count: { color: colors.text, fontSize: 13, fontWeight: "600" },
  hint: { color: colors.textFaint, fontSize: 9 },
  shutter: {
    width: 76, height: 76, borderRadius: 38,
    borderWidth: 4, borderColor: "#FFFFFF",
    alignItems: "center", justifyContent: "center",
  },
  shutterPressed: { opacity: 0.75 },
  shutterInner: {
    width: 58, height: 58, borderRadius: 29, backgroundColor: "#FFFFFF",
    alignItems: "center", justifyContent: "center",
  },
  doneBtn: {
    backgroundColor: colors.gold, borderRadius: radius.lg,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, alignItems: "center",
  },
  doneDisabled: { opacity: 0.35 },
  doneText: { color: "#0B0B0C", fontWeight: "700", fontSize: 14 },
  burstHint: { color: colors.textFaint, fontSize: 10, textAlign: "center" },
});

// The workspace: the map, its controls, and whatever surface is open on top.
//
// ARCHITECTURE V2, PRINCIPLE 0.2 — the map is the operating system. This
// component is mounted by the explore LAYOUT route, so it sits above the
// router's children in the tree and outlives all of them. Opening a site, an
// area, a discovery or the camera changes what floats here; it never rebuilds
// the map, never restarts the session, and never drops the GPS watch.
//
// Presentational by rule. Every value comes from the workspace or the
// exploration engine; this file decides layout, not truth.
import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { colors, spacing } from "../lib/theme";
import { useExploration } from "../lib/exploration/provider";
import { useMapWorkspace, INITIAL_RADIUS_M } from "../lib/exploration/workspace";
import { compassPoint as compassPointOf } from "../../shared/geo-core/geo/spatial.ts";
import { classifyDistance, type RegionalTarget } from "../lib/geo/expedition";
import { roadFactor } from "../lib/geo/roadFactor";
import { ExplorationMap, type CameraRestore, type MapLayers } from "./ExplorationMap";
import {
  Compass, GpsChip, LayerPanel, MapRail, MapTopBar, RoundBtn, ScaleBar, TargetPill,
  type LayerGroup,
} from "./MapOverlay";
import { SHEET_COLLAPSED_H } from "./ExplorationSheet";
import { ATTRIBUTION } from "../lib/geo/tileCache";
import { regionalLabel } from "../lib/exploration/wording";
import {
  compassKey, confidenceBandKey, distanceBandKey, formatAccuracy, formatDistance,
  formatRoadDistance,
  formatTravel, transportShortKey, type TFunc,
} from "../lib/exploration/format";
import type { ExplorationSnapshot } from "../lib/exploration/orchestrator.ts";

export function MapWorkspace({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const { snapshot: s, actions } = useExploration();
  const w = useMapWorkspace();
  const insets = useSafeAreaInsets();

  /**
   * The view the geologist left, if they are coming back.
   *
   * The session outlives this route (see app/_layout.tsx), so the scene, the
   * track and the expedition are all still here — the camera is the one thing
   * that would otherwise reset, and landing back on the opening 2 km view after
   * checking the collection is exactly the kind of lost context principle 0.2
   * forbids. Read from the workspace, which never stopped holding it.
   */
  const restore: CameraRestore | null = w.camera
    ? {
        lat: (w.camera.bbox[1] + w.camera.bbox[3]) / 2,
        lng: (w.camera.bbox[0] + w.camera.bbox[2]) / 2,
        metresPerPx: w.camera.metresPerPx,
        rotationDeg: w.camera.rotationDeg,
      }
    : null;

  // ── What the gold arrow points at ────────────────────────────────────────
  //
  // In the same order of authority the guidance pill uses, so the arrow and the
  // words above it can never disagree: a destination the geologist chose, then
  // the engine's active target, then the nearest thing the pack holds. Every one
  // of these bearings is computed geodesically from the current fix — none is a
  // screen-space guess, and where there is no fix there is no bearing and no
  // arrow.
  const targetBearingDeg =
    s.destinationBearingDeg ??
    s.activeTarget?.bearingDeg ??
    w.readout.regional[0]?.bearingDeg ??
    null;

  // ── Heading-up ───────────────────────────────────────────────────────────
  //
  // A north-up map has to be mentally rotated by whoever is holding it, which is
  // exactly the sum a person walking over broken ground gets wrong. Tapping the
  // compass turns the map so the way they are facing is up; tapping again puts
  // north back. The map owns the rotation — this only says which mode is wanted.
  const [headingUp, setHeadingUp] = React.useState(false);

  const toggleHeadingUp = () => {
    if (headingUp) {
      setHeadingUp(false);
      w.mapRef.current?.setRotation(0);
      return;
    }
    // Refuse rather than pretend: with no heading there is nothing to align to,
    // and rotating to 0 while claiming heading-up would be a lie the map tells.
    if (s.headingDeg == null) return;
    setHeadingUp(true);
    w.mapRef.current?.setRotation(s.headingDeg);
  };

  // Keep the map aligned as they turn. Gated on a whole degree of change: the
  // magnetometer jitters by fractions constantly, and re-rotating the canvas on
  // every one of those was the difference between a map that follows and a map
  // that shivers.
  const alignedTo = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!headingUp || s.headingDeg == null) return;
    const h = Math.round(s.headingDeg);
    if (alignedTo.current === h) return;
    alignedTo.current = h;
    w.mapRef.current?.setRotation(h);
  }, [headingUp, s.headingDeg, w.mapRef]);

  // Dragging the map to north-up by hand, or pressing Centre (which resets to
  // north), leaves the mode claiming something the map is no longer doing.
  React.useEffect(() => {
    if (!headingUp || s.headingDeg == null) return;
    const r = w.camera?.rotationDeg;
    if (r == null) return;
    const off = Math.abs(((r - s.headingDeg + 540) % 360) - 180);
    if (off > 25) setHeadingUp(false);
  }, [headingUp, s.headingDeg, w.camera?.rotationDeg]);

  // Before a session starts there is no position, so there is no map to keep
  // alive. The surface above renders the start card over a plain background.
  if (!w.running) {
    return <View style={styles.screen}>{children}</View>;
  }

  // Under the bar AND under the guidance pill: the pill is centred and wide, and
  // a control the thumb has to hunt behind it is a control that is not there.
  const railTop = insets.top + 108;

  // The collapsed sheet is taller by the navigation bar it has to clear, so
  // every control that sits above it moves with it. Otherwise the sheet grows
  // over the locate button and the scale bar.
  const sheetBottom = SHEET_COLLAPSED_H + insets.bottom;

  return (
    <View style={styles.screen}>
      {/* Full-bleed. The map runs to every edge of the screen and everything
          else floats on it — that is the difference between a field map and a
          dashboard with a map in it. */}
      <View style={styles.mapArea}>
        {w.scene ? (
          <ExplorationMap
            ref={w.mapRef}
            scene={w.scene}
            live={w.live}
            layers={w.layers}
            initialRadiusM={INITIAL_RADIUS_M}
            onCamera={w.onCamera}
            onPick={w.onPick}
            restore={restore}
          />
        ) : (
          <View style={styles.mapWaiting}>
            <ActivityIndicator color={colors.gold} />
            <Text style={styles.mapWaitingText}>
              {w.ready ? t("field.status.waitingGps") : t("field.pack.none")}
            </Text>
          </View>
        )}

        <MapTopBar
          title={t("field.title")}
          status={
            // What the walk owes the server comes FIRST. A geologist who has
            // collected forty observations with no signal needs to know they are
            // held, not discarded (Architecture v2 §0.2) — and needs to know when
            // they have finally landed.
            w.sync.syncing ? t("field.sync.syncing")
              : w.sync.pending > 0 ? t("field.sync.pending", { count: w.sync.pending })
              : w.downloading ? t("field.net.downloading")
              : w.isOnline ? t("field.net.online")
              : t("field.net.offline")
          }
          online={w.isOnline}
          busy={w.downloading}
          onBack={() => router.back()}
          onEnd={actions.stop}
          top={insets.top}
        />

        <View style={[styles.pillWrap, { top: insets.top + 52 }]} pointerEvents="box-none">
          {/* Tapping the pill opens the sheet — the reasoning behind whatever it
              is saying is always one thumb away from the claim itself. */}
          <GuidancePill
            snapshot={s}
            nearest={w.readout.regional[0] ?? null}
            onPress={() => w.setExpanded(true)}
            t={t}
          />
        </View>

        {/* No wrapper. A View that positions this rail but has no size of its own
            leaves every button on it untouchable on Android — the control owns
            its offsets instead. */}
        <MapRail
          top={railTop}
          items={[
            { icon: "layers", label: t("field.map.layers"), active: w.layersOpen, onPress: () => w.setLayersOpen((v) => !v) },
            { icon: "locate", label: t("field.map.centre"), onPress: () => w.mapRef.current?.centre() },
            // Once a destination can be 90 km away, centring on the viewer no
            // longer shows where they are being sent. This pulls back to hold both.
            { icon: "scan", label: t("field.map.frame"), onPress: () => w.mapRef.current?.frameTarget() },
            { icon: "analytics", label: t("field.map.track"), active: w.layers.track, onPress: () => w.setLayers((l) => ({ ...l, track: !l.track })) },
            { icon: "location", label: t("field.map.waypoints"), active: w.layers.waypoints, onPress: () => w.setLayers((l) => ({ ...l, waypoints: !l.waypoints })) },
          ]}
        />

        <View style={[styles.compassWrap, { top: railTop }]}>
          <Compass
            rotationDeg={w.camera?.rotationDeg ?? 0}
            headingDeg={s.headingDeg}
            targetBearingDeg={targetBearingDeg}
            needsCalibration={s.headingNeedsCalibration}
            headingUp={headingUp}
            onPress={toggleHeadingUp}
          />
          {/* What the receiver is reporting, where the eye already is. Tapping
              opens the full GPS block rather than hiding it behind a menu. */}
          <GpsChip
            text={w.fix.accuracyM == null ? t("field.gps.chipNoFix") : formatAccuracy(t, w.fix.accuracyM)}
            warn={w.fix.warn}
            onPress={() => w.setExpanded(true)}
          />
          {/* The build badge that used to sit here is gone. It proved the map was
              hosted by the layout, named the expedition and counted the queue —
              and it covered the map to do it. All three facts are rows in the
              diagnostics panel one drag away (Map OS, Expedition ID, Field
              records), so the map keeps the pixels. */}
        </View>

        <View style={styles.zoomWrap}>
          <RoundBtn icon="add" onPress={() => w.mapRef.current?.zoomBy(1.6)} />
          <RoundBtn icon="remove" onPress={() => w.mapRef.current?.zoomBy(1 / 1.6)} />
          <RoundBtn
            label={t("field.map.satelliteShort")}
            active={w.layers.satellite}
            onPress={() => w.setLayers((l) => ({ ...l, satellite: !l.satellite }))}
          />
        </View>

        <View style={[styles.locateWrap, { bottom: sheetBottom + spacing.md }]}>
          <RoundBtn icon="navigate" onPress={() => w.mapRef.current?.centre()} size={52} />
        </View>

        <ScaleBar
          metresPerPx={w.camera?.metresPerPx ?? INITIAL_RADIUS_M / 400}
          bottom={sheetBottom + spacing.sm}
        />
        {w.hasTiles ? (
          <Text style={[styles.attribution, { bottom: sheetBottom + 2 }]}>{ATTRIBUTION}</Text>
        ) : null}

        {w.layersOpen ? (
          <LayerPanel
            title={t("field.map.layersTitle")}
            layers={w.layers as unknown as Record<string, boolean>}
            onToggle={(k) => w.setLayers((l) => ({ ...l, [k]: !l[k as keyof MapLayers] }))}
            onClose={() => w.setLayersOpen(false)}
            groups={layerGroups(t)}
            top={railTop}
            maxHeight={w.screenHeight - railTop - sheetBottom - 24}
            offline={!w.isOnline}
            offlineNote={t("field.map.offlineLayer")}
          />
        ) : null}
      </View>

      {/* The surface. A sheet, a site, an area, a discovery — whatever the
          router has matched, rendered ON the live map rather than instead of it. */}
      {children}
    </View>
  );
}

function GuidancePill({
  snapshot: s, nearest, onPress, t,
}: { snapshot: ExplorationSnapshot; nearest: RegionalTarget | null; onPress: () => void; t: TFunc }) {
  // Invariant 4: while looking somewhere else, no distance and no direction —
  // both would be measured from a place the reader is not standing.
  if (s.inspecting) {
    return (
      <TargetPill
        title={t("field.location.inspectingBanner", {
          lat: s.inspecting.lat.toFixed(5), lng: s.inspecting.lng.toFixed(5),
        })}
        tone="warn"
      />
    );
  }
  if (s.destination && s.destinationDistanceM != null && s.destinationBearingDeg != null) {
    // A chosen destination carries its band and transport, because at this point
    // it may be a two-day drive and "1.4 km" and "94 km" cannot read the same way
    // on a pill someone glances at while walking.
    // The multiplier THIS device measured, not the compiled-in default: the pill
    // and the sheet must never quote two different journeys for one target.
    const cls = classifyDistance(s.destinationDistanceM, roadFactor().current());
    const road = formatRoadDistance(t, cls.travelDistanceM, cls.roadFactorApplied);
    return (
      <TargetPill
        title={t("field.destination.headTo", {
          distance: formatDistance(t, s.destinationDistanceM),
          compass: t(compassKey(compassPointOf(s.destinationBearingDeg))),
        })}
        // The road distance takes the transport word's place once there is one:
        // "~172 km waddo · 4 h 19" says everything the word did and adds the
        // figure a geologist plans fuel around. The title keeps the straight
        // line, because that is the bearing the map is actually drawing.
        subtitle={`${road ?? t(transportShortKey(cls.transport))} · ${formatTravel(t, cls.travelMinutes)}`}
        tone="warn"
        onPress={onPress}
      />
    );
  }
  if (!s.activeTarget) {
    // The old dead end. There is no target within one leg of a traverse, which
    // is not the same as there being nothing to go to — so the pill names the
    // nearest thing the pack actually holds and offers to navigate to it.
    if (nearest) {
      const c = nearest.distanceClass;
      const road = formatRoadDistance(t, c.travelDistanceM, c.roadFactorApplied);
      return (
        <TargetPill
          title={t("field.destination.headTo", {
            distance: formatDistance(t, nearest.distanceM),
            compass: t(compassKey(nearest.compass)),
          })}
          // The concrete road figure replaces the band name when there is one —
          // "expedition" and "~172 km waddo" say the same thing, and only one of
          // them can be planned around.
          subtitle={`${road ?? t(distanceBandKey(c.band))} · ${regionalLabel(nearest, t)}`}
          tone="plain"
          onPress={onPress}
        />
      );
    }
    return <TargetPill title={t("field.status.noTarget")} tone="plain" onPress={onPress} />;
  }
  return (
    <TargetPill
      title={t("field.target.pill", {
        distance: formatDistance(t, s.distanceToTargetM ?? s.activeTarget.distanceM),
        compass: t(compassKey(s.activeTarget.compass)),
      })}
      subtitle={t("field.target.confidence", { band: t(confidenceBandKey(s.activeTarget.band)) })}
      tone={s.activeTarget.band === "High" ? "good" : "warn"}
      onPress={onPress}
    />
  );
}

/**
 * Every layer the map can draw, grouped by what it is FOR.
 *
 * The source note on each row is not decoration: a geologist deciding whether to
 * trust a line needs to know whether it came from Macrostrat, from MRDS, from a
 * DEM or from their own phone. Layers that need a connection to arrive for the
 * first time are marked, so turning one on with no signal explains itself.
 */
function layerGroups(t: TFunc): LayerGroup[] {
  return [
    {
      title: t("field.map.groupBackdrop"),
      rows: [
        { key: "satellite", label: t("field.map.satellite"), icon: "earth", color: "#4A90E2", note: t("field.map.sourceEsri"), online: true },
        { key: "hillshade", label: t("field.map.hillshade"), icon: "triangle", color: "#8A8A8E", note: t("field.map.sourceEsri"), online: true },
        { key: "roads", label: t("field.map.roads"), icon: "car", color: "#D8D3C6", note: t("field.map.sourceEsri"), online: true },
        { key: "labels", label: t("field.map.labels"), icon: "text", color: "#F5F1E8", note: t("field.map.sourceEsri"), online: true },
        { key: "land", label: t("field.map.land"), icon: "map-outline", color: "#5A6B7C", note: t("field.map.sourcePack") },
      ],
    },
    {
      title: t("field.map.groupGeology"),
      rows: [
        { key: "geology", label: t("field.map.geology"), icon: "map", color: "#C9A227", note: t("field.map.sourceMacrostrat") },
        { key: "geologyLabels", label: t("field.map.geologyLabels"), icon: "pricetag", color: "#C9A227", note: t("field.map.sourceMacrostrat") },
        { key: "faults", label: t("field.map.faults"), icon: "git-branch", color: "#FF4438", note: t("field.map.sourceMacrostrat") },
        { key: "contacts", label: t("field.map.contacts"), icon: "git-compare", color: "#E8E4DA", note: t("field.map.sourceMacrostrat") },
        { key: "lineaments", label: t("field.map.lineaments"), icon: "remove", color: "#B9A6D8", note: t("field.map.sourceMacrostrat") },
        { key: "occurrences", label: t("field.map.occurrences"), icon: "ellipse", color: "#E03A2F", note: t("field.map.sourceMrds") },
      ],
    },
    {
      title: t("field.map.groupTerrain"),
      rows: [
        { key: "terrain", label: t("field.map.terrain"), icon: "trending-up", color: "#8A8A8E", note: t("field.map.sourceDem") },
        { key: "slope", label: t("field.map.slope"), icon: "analytics", color: "#E0A03C", note: t("field.map.sourceDem") },
        { key: "aspect", label: t("field.map.aspect"), icon: "compass", color: "#9FB4C7", note: t("field.map.sourceDem") },
        { key: "drainage", label: t("field.map.drainage"), icon: "water", color: "#4FA8E8", note: t("field.map.sourcePack") },
      ],
    },
    {
      title: t("field.map.groupSession"),
      rows: [
        { key: "track", label: t("field.map.track"), icon: "analytics", color: "#F5C518", note: t("field.map.sourceDevice") },
        { key: "waypoints", label: t("field.map.waypoints"), icon: "location", color: "#3B82F6", note: t("field.map.sourceDevice") },
        { key: "target", label: t("field.map.target"), icon: "navigate", color: "#F5C518" },
        { key: "accuracy", label: t("field.map.accuracy"), icon: "radio-button-on", color: "#3B82F6" },
        { key: "compass", label: t("field.map.compass"), icon: "compass", color: "#3B82F6" },
        { key: "grid", label: t("field.map.grid"), icon: "grid", color: "#8A8A8E" },
      ],
    },
  ];
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  // The map is the screen. Everything else is drawn on top of it, so the ground
  // runs to all four edges rather than being framed by chrome.
  mapArea: { ...StyleSheet.absoluteFillObject, overflow: "hidden" },
  mapWaiting: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md },
  mapWaitingText: { color: colors.textMuted, fontSize: 14 },

  // Its child is laid out normally, so this box has a real height and the pill
  // inside it is actually touchable. Anything absolutely positioned needs its
  // own offsets rather than a wrapper — see MapRail.
  pillWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  compassWrap: { position: "absolute", right: spacing.md, alignItems: "flex-end", gap: spacing.sm },
  zoomWrap: { position: "absolute", right: spacing.md, top: "42%", gap: spacing.sm },
  // Above the collapsed sheet, where a right thumb reaches without shifting grip.
  // `bottom` is set inline from the safe-area inset; see sheetBottom.
  locateWrap: { position: "absolute", right: spacing.md },
  attribution: {
    position: "absolute", right: spacing.md,   // `bottom` inline; see sheetBottom
    color: "rgba(245,241,232,0.55)", fontSize: 9,
  },
});

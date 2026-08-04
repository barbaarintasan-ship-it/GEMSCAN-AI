// Exploration Mode — the field screen for workflow steps 1–8.
//
// MAP-FIRST. The geological map is the interface, not an illustration attached
// to one: it fills the screen for the whole session and the readout sits in a
// sheet over it, because someone walking across ground needs to see the ground.
// The previous layout was a column of cards that happened to contain a map, and
// in the field it read as a wall of text.
//
// This file holds no exploration logic. Every number comes from the orchestrator
// snapshot or from measurements over the knowledge pack; the engines, the
// targeting and the geological reasoning are untouched.
//
// Three rules from the architecture shape it more than anything visual:
//
//   Invariant 2 — no unexplained recommendation. The REASON is in the COLLAPSED
//     sheet beside the distance, not behind a tap: a user with no geological
//     training is being asked to walk somewhere.
//   Invariant 4 — never a bearing from a position you are not standing at.
//   Risk 3 — stale packs. Pack version and age stay visible.
//
// Bilingual throughout. Nothing user-facing is hardcoded, including the
// REASONS, which arrive STRUCTURED from the engine precisely so they can be
// rendered in either language rather than as pre-built English sentences.
import React from "react";
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput,
  useWindowDimensions, View,
} from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius, spacing } from "../../lib/theme";
import { ExplorationProvider, useExploration } from "../../lib/exploration/provider";
import type { TargetReason } from "../../lib/geo/targeting.ts";
import { DEFAULT_TARGETING } from "../../lib/geo/targeting.ts";
import {
  WAYPOINT_TYPES, waypointTypeLabelKey, type Waypoint, type WaypointType,
} from "../../lib/field/waypointTypes";
import { compassPoint as compassPointOf } from "../../../shared/geo-core/geo/spatial.ts";
import { buildScene, sceneCovers, type MapScene } from "../../lib/geo/mapScene";
import {
  fittingRadiusM, elevationAt, NEARBY_FAULT_M, NEARBY_OCCURRENCE_M, type Orientation,
} from "../../lib/geo/orientation";
import { useGeoReadout } from "../../lib/geo/useGeoReadout";
import { classifyDistance, type RegionalTarget } from "../../lib/geo/expedition";
import { gradeFix, type FixQuality } from "../../lib/geo/fixQuality";
import { loadLayers, saveLayers } from "../../lib/geo/layerPrefs";
import {
  ExplorationMap, DEFAULT_LAYERS, type MapHandle, type MapLayers, type MapLive,
} from "../../components/ExplorationMap";
import { Compass, LayerPanel, MapRail, RoundBtn, ScaleBar, TargetPill } from "../../components/MapOverlay";
import { ExplorationSheet, SheetAction, SheetSection, SheetStats } from "../../components/ExplorationSheet";
import { useWalkingTrack } from "../../lib/exploration/useWalkingTrack";
import { useSatelliteTiles } from "../../lib/geo/useSatelliteTiles";
import { ATTRIBUTION } from "../../lib/geo/tileCache";
import { useIsOnline } from "../../lib/network";
import { shareWaypoints, exportableCount } from "../../lib/field/waypointShare";
import type { ExportFormat } from "../../lib/field/waypointExport";
import {
  compassKey, confidenceBandKey, describeClass, distanceBandKey, formatDistance,
  formatDuration, formatElevationDelta, formatFixAge, formatSpeed, formatTravel,
  transportKey, transportShortKey, type TFunc,
} from "../../lib/exploration/format";

/** Half-width of the first view. 2 km is a walkable neighbourhood. */
const INITIAL_RADIUS_M = 2_000;

/**
 * How often the GPS readout re-renders while nothing else changes.
 *
 * A fix does not get less accurate when you look at it — it gets less accurate
 * as it AGES, and "updated 40 s ago" is only true if something redraws it. Five
 * seconds is fine enough to notice a receiver going quiet and coarse enough not
 * to be a per-second re-render of the whole screen.
 */
const FIX_TICK_MS = 5_000;

export default function ExplorationRoute() {
  return (
    <ExplorationProvider>
      <Stack.Screen options={{ headerShown: false }} />
      <ExplorationScreen />
    </ExplorationProvider>
  );
}

function ExplorationScreen() {
  const { t } = useTranslation();
  const { snapshot: s, actions, packs, waypoints, waypointRecords } = useExploration();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const isOnline = useIsOnline();

  const running = s.state !== "idle" && s.state !== "ended";
  const map = React.useRef<MapHandle>(null);

  const [layers, setLayers] = React.useState<MapLayers>(DEFAULT_LAYERS);
  const [layersOpen, setLayersOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [camera, setCamera] = React.useState({ rotationDeg: 0, metresPerPx: 1 });

  // A layer set is a working preference, not a session detail. Loaded once and
  // written back on every change, so the geologist who turns satellite off to
  // read the geology does not have to do it again tomorrow.
  const layersLoaded = React.useRef(false);
  React.useEffect(() => {
    void loadLayers(DEFAULT_LAYERS).then((stored) => {
      setLayers(stored);
      layersLoaded.current = true;
    });
  }, []);
  React.useEffect(() => {
    // Guarded, so the defaults rendered before the read completes are never
    // written back over what the user actually chose.
    if (layersLoaded.current) void saveLayers(layers);
  }, [layers]);

  // The point every readout is about: a looked-up place, else the real fix.
  const at = s.inspecting ?? (s.position ? { lat: s.position.lat, lng: s.position.lng } : null);
  const data = packs.getData();
  const ready = packs.isReady();

  // Orientation and the regional leads come from one movement-gated scan, off
  // the gesture path — see lib/geo/useGeoReadout. Leads start where the local
  // targeting engine stops, so the same feature is never offered twice.
  const readout = useGeoReadout(data, ready, at, DEFAULT_TARGETING.maxDistanceM);
  const orientation = readout.orientation;

  // The scene is rebuilt only when the viewer leaves the prepared ground, never
  // on every fix: a rebuild remounts the map surface, and doing that while
  // someone is dragging it would make the map unusable.
  const [scene, setScene] = React.useState<MapScene | null>(null);
  React.useEffect(() => {
    if (!at || !ready) return;
    if (scene && sceneCovers(scene, at)) return;
    const radius = orientation ? fittingRadiusM(orientation, INITIAL_RADIUS_M) : INITIAL_RADIUS_M;
    setScene(buildScene(data, at, radius));
  }, [at?.lat, at?.lng, ready, data, scene, orientation]); // eslint-disable-line react-hooks/exhaustive-deps

  const track = useWalkingTrack(s.position, s.explorationSessionId);
  const { tiles, downloading } = useSatelliteTiles(
    scene?.bbox ?? null, INITIAL_RADIUS_M, layers.satellite, isOnline,
  );

  // Fix quality is graded on a clock, not on fixes: a receiver that has stopped
  // reporting produces no re-render at all, and that silence is exactly the
  // thing the geologist needs to be told about.
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((v) => v + 1), FIX_TICK_MS);
    return () => clearInterval(id);
  }, [running]);
  const fix: FixQuality = React.useMemo(
    () => gradeFix(s.position ? { accuracyM: s.position.accuracyM, timestamp: s.position.timestamp } : null),
    [s.position, tick],  // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Elevation difference to whatever is being navigated to. Both readings come
  // from the same DEM, and either being absent makes the answer null rather
  // than zero — "no data" and "level ground" are not the same statement.
  const destPoint = s.activeTarget
    ? { lat: s.activeTarget.centre.lat, lng: s.activeTarget.centre.lng }
    : s.destination;
  const elevationDeltaM = React.useMemo(() => {
    if (!ready || !destPoint || !s.position) return null;
    const there = elevationAt(data, destPoint);
    const here = elevationAt(data, { lat: s.position.lat, lng: s.position.lng });
    if (!there || !here) return null;
    return there.elevationM - here.elevationM;
  }, [ready, data, destPoint?.lat, destPoint?.lng, s.position?.lat, s.position?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  const live: MapLive = React.useMemo(() => ({
    position: s.position,
    headingDeg: s.headingDeg,
    // The engine's recommendation if there is one, otherwise the point the user
    // chose to walk to. Both are destinations; only one of them is advice.
    target: s.activeTarget
      ? { lat: s.activeTarget.centre.lat, lng: s.activeTarget.centre.lng }
      : s.destination,
    track: track.points,
    waypoints,
    tiles,
  }), [s.position, s.headingDeg, s.activeTarget, s.destination, track.points, waypoints, tiles]);

  // Arrival is what the whole walk was for, so the sheet opens itself: the
  // geologist has stopped and is about to act.
  React.useEffect(() => {
    if (s.state === "awaitingEvidence") setExpanded(true);
  }, [s.state]);

  // Returned from a submitted sample. The loop continues: fold the new evidence
  // in and re-score, so the next recommendation accounts for what was just
  // found. The session is NOT restarted — it never stopped.
  const { analysed } = useLocalSearchParams<{ analysed?: string }>();
  const foldedIn = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!analysed || foldedIn.current === analysed) return;
    foldedIn.current = analysed;
    void actions.recordEvidence();
  }, [analysed, actions]);

  if (!running) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header online={isOnline} />
        <StartCard onStart={actions.start} />
      </View>
    );
  }

  const sheetExpandedH = Math.min(height * 0.62, height - 200);
  const arrived = s.state === "awaitingEvidence";

  return (
    <View style={styles.screen}>
      <View style={{ paddingTop: insets.top, backgroundColor: colors.bg }}>
        <Header online={isOnline} downloading={downloading} onEnd={actions.stop} />
      </View>

      <View style={styles.mapArea}>
        {scene ? (
          <ExplorationMap
            ref={map}
            scene={scene}
            live={live}
            layers={layers}
            initialRadiusM={INITIAL_RADIUS_M}
            onCamera={setCamera}
          />
        ) : (
          <View style={styles.mapWaiting}>
            <ActivityIndicator color={colors.gold} />
            <Text style={styles.mapWaitingText}>
              {ready ? t("field.status.waitingGps") : t("field.pack.none")}
            </Text>
          </View>
        )}

        <View style={styles.pillWrap} pointerEvents="box-none">
          {/* Tapping the pill opens the sheet — the reasoning behind whatever it
              is saying is always one thumb away from the claim itself. */}
          <GuidancePill
            snapshot={s}
            nearest={readout.regional[0] ?? null}
            onPress={() => setExpanded(true)}
            t={t}
          />
        </View>

        <MapRail
          items={[
            { icon: "layers", label: t("field.map.layers"), active: layersOpen, onPress: () => setLayersOpen((v) => !v) },
            { icon: "locate", label: t("field.map.centre"), onPress: () => map.current?.centre() },
            // Once a destination can be 90 km away, centring on the viewer no
            // longer shows where they are being sent. This pulls back to hold both.
            { icon: "scan", label: t("field.map.frame"), onPress: () => map.current?.frameTarget() },
            { icon: "analytics", label: t("field.map.track"), active: layers.track, onPress: () => setLayers((l) => ({ ...l, track: !l.track })) },
            { icon: "location", label: t("field.map.waypoints"), active: layers.waypoints, onPress: () => setLayers((l) => ({ ...l, waypoints: !l.waypoints })) },
          ]}
        />

        <View style={styles.compassWrap}>
          <Compass rotationDeg={camera.rotationDeg} onPress={() => map.current?.setRotation(0)} />
        </View>

        <View style={styles.zoomWrap}>
          <RoundBtn icon="add" onPress={() => map.current?.zoomBy(1.6)} />
          <RoundBtn icon="remove" onPress={() => map.current?.zoomBy(1 / 1.6)} />
          <RoundBtn
            label={t("field.map.satelliteShort")}
            active={layers.satellite}
            onPress={() => setLayers((l) => ({ ...l, satellite: !l.satellite }))}
          />
        </View>

        <View style={styles.locateWrap}>
          <RoundBtn icon="navigate" onPress={() => map.current?.centre()} size={52} />
        </View>

        <ScaleBar metresPerPx={camera.metresPerPx} />
        {layers.satellite && tiles.length > 0 ? (
          <Text style={styles.attribution}>{ATTRIBUTION}</Text>
        ) : null}

        {layersOpen ? (
          <LayerPanel
            title={t("field.map.layersTitle")}
            layers={layers as unknown as Record<string, boolean>}
            onToggle={(k) => setLayers((l) => ({ ...l, [k]: !l[k as keyof MapLayers] }))}
            onClose={() => setLayersOpen(false)}
            labels={[
              { key: "satellite", label: t("field.map.satellite"), icon: "earth", color: "#4A90E2" },
              { key: "geology", label: t("field.map.geology"), icon: "map", color: "#C9A227" },
              { key: "terrain", label: t("field.map.terrain"), icon: "trending-up", color: "#8A8A8E" },
              { key: "faults", label: t("field.map.faults"), icon: "git-branch", color: "#E5E5E7" },
              { key: "occurrences", label: t("field.map.occurrences"), icon: "ellipse", color: "#E03A2F" },
              { key: "waypoints", label: t("field.map.waypoints"), icon: "location", color: "#3B82F6" },
              { key: "track", label: t("field.map.track"), icon: "analytics", color: "#F5C518" },
              { key: "target", label: t("field.map.target"), icon: "navigate", color: "#F5C518" },
              { key: "accuracy", label: t("field.map.accuracy"), icon: "radio-button-on", color: "#3B82F6" },
              { key: "compass", label: t("field.map.compass"), icon: "compass", color: "#3B82F6" },
              { key: "grid", label: t("field.map.grid"), icon: "grid", color: "#8A8A8E" },
            ]}
          />
        ) : null}
      </View>

      <ExplorationSheet
        expandedHeight={sheetExpandedH}
        expanded={expanded}
        onExpandedChange={setExpanded}
        header={
          <CollapsedHeader
            snapshot={s}
            orientation={orientation}
            nearest={readout.regional[0] ?? null}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
            t={t}
          />
        }
      >
        {arrived ? (
          <ArrivedBlock
            onScan={() => goToCapture()}
            onWaypoint={() => void actions.captureObservation("outcrop")}
            onRecalculate={actions.refresh}
            t={t}
          />
        ) : null}

        <GpsBlock
          fix={fix}
          position={s.position}
          needsCalibration={s.headingNeedsCalibration}
          headingDeg={s.headingDeg}
          t={t}
        />

        <SheetSection title={t("field.sheet.interpretation")}>
          <Text style={styles.body}>{interpretation(s, orientation, t)}</Text>
        </SheetSection>

        <SheetSection title={t("field.sheet.nearbyEvidence")}>
          <EvidenceLines orientation={orientation} unit={unitOf(s.context)} t={t} />
        </SheetSection>

        {s.activeTarget || s.destination ? (
          <SheetSection title={t("field.target.why")}>
            {/* Everything a journey needs, whether it is 400 m or 90 km: how far,
                which way, how long, by what means, and how high. Distance
                classifies the trip; it never cancels it. */}
            <JourneyLines
              distanceM={s.activeTarget ? s.distanceToTargetM ?? s.activeTarget.distanceM : s.destinationDistanceM}
              bearingDeg={s.activeTarget ? s.activeTarget.bearingDeg : s.destinationBearingDeg}
              elevationDeltaM={elevationDeltaM}
              t={t}
            />
            {s.selectedRegional ? (
              <Text style={styles.reason}>
                {"•"} {regionalLabel(s.selectedRegional, t)}
              </Text>
            ) : null}
            {(s.activeTarget?.reasons ?? []).map((r, i) => (
              <Text key={reasonKey(r, i)} style={styles.reason}>{"•"} {renderReason(r, t)}</Text>
            ))}
            {s.activeTarget && s.activeTarget.commodities.length > 0 ? (
              <Text style={styles.faint}>
                {t("field.target.lookingFor", { commodities: s.activeTarget.commodities.join(", ") })}
              </Text>
            ) : null}
            <View style={styles.actionRow}>
              <SheetAction
                icon={<Ionicons name="scan" size={20} color={colors.text} />}
                label={t("field.map.frame")}
                onPress={() => map.current?.frameTarget()}
              />
              <SheetAction
                icon={<Ionicons name="bookmark" size={20} color={colors.text} />}
                label={t("field.target.save")}
                onPress={() => void actions.captureObservation("other")}
              />
              {s.destination ? (
                <SheetAction
                  icon={<Ionicons name="close-circle" size={20} color={colors.text} />}
                  label={t("field.destination.stop")}
                  onPress={actions.clearDestination}
                />
              ) : null}
            </View>
          </SheetSection>
        ) : null}

        {arrived ? (
          <SheetSection title={t("field.evidence.heading")}>
            <Text style={styles.body}>{t("field.evidence.body")}</Text>
            <View style={styles.chips}>
              {WAYPOINT_TYPES.map((type) => (
                <Pressable key={type} style={styles.chip} onPress={() => void actions.captureObservation(type)}>
                  <Text style={styles.chipText}>{t(waypointTypeLabelKey(type))}</Text>
                </Pressable>
              ))}
            </View>
          </SheetSection>
        ) : null}

        <View style={styles.actionRow}>
          <SheetAction
            icon={<Ionicons name="camera" size={20} color={colors.text} />}
            label={t("field.sheet.captureEvidence")}
            onPress={() => goToCapture()}
          />
          <SheetAction
            icon={<Ionicons name="location" size={20} color={colors.text} />}
            label={t("field.sheet.addWaypoint")}
            onPress={() => void actions.captureObservation("outcrop")}
          />
          <SheetAction
            icon={<Ionicons name="refresh" size={20} color={colors.text} />}
            label={t("field.sheet.recalculate")}
            onPress={actions.refresh}
          />
        </View>

        {s.targets.length > 1 ? (
          <SheetSection title={t("field.target.otherOptions")}>
            {s.targets
              .filter((x) => x.cell !== s.activeTarget?.cell)
              .map((x) => (
                <Pressable key={x.cell} style={styles.otherRow} onPress={() => actions.selectTarget(x.cell)}>
                  <Text style={styles.otherTitle}>
                    {t("field.target.headTo", {
                      distance: formatDistance(t, x.distanceM),
                      compass: t(compassKey(x.compass)),
                    })}
                  </Text>
                  <Text style={styles.otherReason} numberOfLines={2}>
                    {x.reasons[0] ? renderReason(x.reasons[0], t) : ""}
                  </Text>
                  <Text style={styles.faint}>{describeClass(t, classifyDistance(x.distanceM))}</Text>
                </Pressable>
              ))}
          </SheetSection>
        ) : null}

        {/* The answer to "nothing to walk to". Everything the pack holds, at any
            distance, classified rather than filtered. */}
        <SheetSection title={t("field.regional.title")}>
          <RegionalBlock
            leads={readout.regional}
            computing={readout.computing}
            selectedId={s.selectedRegional?.id ?? null}
            onNavigate={actions.navigateToRegional}
            onStop={actions.clearDestination}
            t={t}
          />
        </SheetSection>

        <SheetSection title={t("field.track.title")}>
          <TraverseBlock
            track={track}
            evidenceCount={s.evidenceCount}
            waypointCount={waypoints.length}
            targetsInvestigated={s.targetsInvestigated}
            t={t}
          />
        </SheetSection>

        <SheetSection title={t("field.export.title")}>
          <ExportBlock records={waypointRecords} t={t} />
        </SheetSection>

        <SheetSection title={t("field.location.lookupTitle")}>
          <LookupBlock
            inspecting={s.inspecting}
            onLookup={actions.inspectAt}
            onClear={actions.clearInspect}
            onNavigate={actions.navigateTo}
            t={t}
          />
        </SheetSection>

        <PackFooter
          provenance={s.packProvenance}
          problem={s.packProblem}
          online={isOnline}
          walkedM={track.distanceM}
          t={t}
        />
      </ExplorationSheet>
    </View>
  );
}

/**
 * Into the EXISTING enterprise sample capture, not a new workflow.
 *
 * A push, never a replace: the exploration session keeps running underneath, so
 * coming back lands on the live map with the same target, the same track and
 * the same session id. The capture screen is told where it was opened from so
 * it can hand control straight back when the analysis finishes.
 */
function goToCapture(): void {
  // No coordinates are passed: the capture screen takes its OWN fix through the
  // same code every other sample uses. Handing it a position from here would
  // create a second, staler source of truth for where a sample was collected.
  router.push({ pathname: "/(app)/enterprise/new-sample", params: { from: "exploration" } });
}

// ── Header ──────────────────────────────────────────────────────────────────

function Header({
  online, downloading, onEnd,
}: { online: boolean; downloading?: boolean; onEnd?: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={10}>
        <Ionicons name="arrow-back" size={24} color={colors.text} />
      </Pressable>
      <View style={styles.headerText}>
        <Text style={styles.headerTitle}>{t("field.title")}</Text>
        <View style={styles.headerStatus}>
          <View style={[styles.dot, online ? styles.dotOnline : styles.dotOffline]} />
          <Text style={styles.headerSub}>
            {downloading ? t("field.net.downloading") : online ? t("field.net.online") : t("field.net.offline")}
          </Text>
        </View>
      </View>
      {onEnd ? (
        <Pressable onPress={onEnd} hitSlop={10}>
          <Text style={styles.endText}>{t("field.actions.end")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ── Sheet contents ──────────────────────────────────────────────────────────

type Snap = ReturnType<typeof useExploration>["snapshot"];

function GuidancePill({
  snapshot: s, nearest, onPress, t,
}: { snapshot: Snap; nearest: RegionalTarget | null; onPress: () => void; t: TFunc }) {
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
    // A chosen destination now carries its band and transport, because at this
    // point it may be a two-day drive and "1.4 km" and "94 km" cannot read the
    // same way on a pill someone glances at while walking.
    const cls = classifyDistance(s.destinationDistanceM);
    return (
      <TargetPill
        title={t("field.destination.headTo", {
          distance: formatDistance(t, s.destinationDistanceM),
          compass: t(compassKey(compassPointOf(s.destinationBearingDeg))),
        })}
        subtitle={`${t(transportShortKey(cls.transport))} · ${formatTravel(t, cls.travelMinutes)}`}
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
      return (
        <TargetPill
          title={t("field.destination.headTo", {
            distance: formatDistance(t, nearest.distanceM),
            compass: t(compassKey(nearest.compass)),
          })}
          subtitle={`${t(distanceBandKey(nearest.distanceClass.band))} · ${regionalLabel(nearest, t)}`}
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

function CollapsedHeader({
  snapshot: s, orientation, nearest, expanded, onToggle, t,
}: {
  snapshot: Snap; orientation: Orientation | null; nearest: RegionalTarget | null;
  expanded: boolean; onToggle: () => void; t: TFunc;
}) {
  const target = s.activeTarget;
  const suppressed = !!s.inspecting;

  // What the four-up readout is ABOUT, in order of precedence: the engine's
  // recommendation, then a chosen destination, then the nearest thing the pack
  // holds. The last of those is why the row no longer reads "— — — —" over most
  // of the country while the pack sits on a mapped occurrence 90 km away.
  const journey =
    target
      ? { distanceM: s.distanceToTargetM ?? target.distanceM, bearingDeg: target.bearingDeg, compass: target.compass }
      : s.destination && s.destinationDistanceM != null && s.destinationBearingDeg != null
        ? {
            distanceM: s.destinationDistanceM,
            bearingDeg: s.destinationBearingDeg,
            compass: compassPointOf(s.destinationBearingDeg),
          }
        : nearest
          ? { distanceM: nearest.distanceM, bearingDeg: nearest.bearingDeg, compass: nearest.compass }
          : null;

  const cls = journey ? classifyDistance(journey.distanceM) : null;

  return (
    <View>
      <SheetStats
        items={[
          {
            value: suppressed || !journey ? "—" : formatDistance(t, journey.distanceM),
            label: t("field.sheet.distance"),
            icon: <Ionicons name="navigate" size={16} color={colors.gold} />,
          },
          {
            value: suppressed || !journey ? "—" : t("field.sheet.directionValue", {
              compass: t(compassKey(journey.compass)), deg: Math.round(journey.bearingDeg),
            }),
            label: t("field.sheet.direction"),
          },
          // Confidence is the ENGINE's, and only the engine's. A regional lead
          // is a real map record but not an assessment of the ground, so it
          // reports how to get there instead of borrowing a confidence band it
          // was never given.
          target
            ? {
                value: t(confidenceBandKey(target.band)),
                label: t("field.sheet.confidence"),
                tone: target.band === "High" ? ("good" as const) : undefined,
              }
            : {
                value: cls ? t(transportShortKey(cls.transport)) : "—",
                label: t("field.target.transportLabel"),
                tone: "plain" as const,
              },
          target?.reasons[0]
            ? { value: shortReason(target.reasons[0], t), label: t("field.sheet.reason"), tone: "plain" as const }
            : {
                value: cls ? formatTravel(t, cls.travelMinutes) : "—",
                label: t("field.target.travelTime"),
                tone: "plain" as const,
              },
        ]}
      />
      <View style={styles.collapsedBody}>
        <Text style={styles.collapsedText} numberOfLines={expanded ? undefined : 3}>
          {recommendation(s, orientation, nearest, t)}
        </Text>
        <Pressable onPress={onToggle} style={styles.chevron} hitSlop={8}>
          <Ionicons name={expanded ? "chevron-down" : "chevron-up"} size={22} color={colors.text} />
        </Pressable>
      </View>
    </View>
  );
}

function ArrivedBlock({
  onScan, onWaypoint, onRecalculate, t,
}: { onScan: () => void; onWaypoint: () => void; onRecalculate: () => void; t: TFunc }) {
  return (
    <View style={styles.arrived}>
      <View style={styles.arrivedHead}>
        <View style={styles.tick}><Ionicons name="checkmark" size={20} color="#0B0B0C" /></View>
        <View style={styles.arrivedText}>
          <Text style={styles.arrivedTitle}>{t("field.arrived.title")}</Text>
          <Text style={styles.faint}>{t("field.arrived.body")}</Text>
        </View>
      </View>
      <View style={styles.actionRow}>
        {/* The one big action. It opens the sample capture that ALREADY exists;
            it does not start a parallel workflow of its own. */}
        <SheetAction
          icon={<Ionicons name="camera" size={22} color={colors.gold} />}
          label={t("field.arrived.scanArea")}
          tone="gold"
          onPress={onScan}
        />
        <SheetAction
          icon={<Ionicons name="location" size={20} color={colors.text} />}
          label={t("field.sheet.addWaypoint")}
          onPress={onWaypoint}
        />
      </View>
      <Pressable style={styles.wideBtn} onPress={onRecalculate}>
        <Ionicons name="sync" size={18} color={colors.text} />
        <Text style={styles.wideBtnText}>{t("field.arrived.recalculate")}</Text>
      </Pressable>
    </View>
  );
}

/**
 * What the receiver is actually reporting.
 *
 * Never a claim of precision the platform did not make. The band, the age and
 * the warning all come from geo/fixQuality reading the raw fix — nothing here
 * smooths, averages or improves a position, and a fix that has gone quiet says
 * so rather than continuing to draw a confident dot.
 */
function GpsBlock({
  fix, position, needsCalibration, headingDeg, t,
}: {
  fix: FixQuality;
  position: Snap["position"];
  needsCalibration: boolean;
  headingDeg: number | null;
  t: TFunc;
}) {
  const gradeLabel = t("field.gps.grade" + fix.grade[0].toUpperCase() + fix.grade.slice(1));
  const accuracy = fix.accuracyM == null
    ? t("field.gps.accuracyUnknown")
    : t("field.gps.accuracy", { m: Math.round(fix.accuracyM) });

  const warning =
    fix.grade === "none" ? t("field.gps.warnNone")
    : fix.grade === "stale" ? t("field.gps.warnStale", { s: Math.round((fix.ageMs ?? 0) / 1000) })
    : fix.grade === "poor" ? t("field.gps.warnPoor", { m: Math.round(fix.accuracyM ?? 0) })
    : null;

  return (
    <View style={[styles.gpsBox, warning ? styles.gpsBoxWarn : null]}>
      <View style={styles.gpsHead}>
        <Ionicons
          name={fix.warn ? "warning" : "location"}
          size={16}
          color={fix.warn ? colors.gold : "#22C55E"}
        />
        <Text style={styles.gpsGrade}>{gradeLabel}</Text>
        <Text style={styles.faint}>
          {accuracy}
          {fix.ageMs != null ? `  ·  ${formatFixAge(t, fix.ageMs)}` : ""}
        </Text>
      </View>
      {warning ? <Text style={styles.gpsWarn}>{warning}</Text> : null}
      <Text style={styles.faint}>
        {position?.altitudeM != null ? t("field.gps.altitude", { m: Math.round(position.altitudeM) }) : ""}
        {position?.altitudeM != null && headingDeg != null ? "  ·  " : ""}
        {headingDeg != null ? t("field.target.bearing", { deg: Math.round(headingDeg) }) : ""}
      </Text>
      {needsCalibration ? <Text style={styles.gpsWarn}>{t("field.gps.calibrate")}</Text> : null}
    </View>
  );
}

/** Distance, direction, band, transport, travel time and relief — one journey. */
function JourneyLines({
  distanceM, bearingDeg, elevationDeltaM, t,
}: {
  distanceM: number | null;
  bearingDeg: number | null;
  elevationDeltaM: number | null;
  t: TFunc;
}) {
  if (distanceM == null || bearingDeg == null) {
    return <Text style={styles.body}>{t("field.destination.waitingFix")}</Text>;
  }
  const cls = classifyDistance(distanceM);
  return (
    <View style={styles.journey}>
      <Text style={styles.journeyHead}>
        {formatDistance(t, distanceM)}
        {"  "}
        {t(compassKey(compassPointOf(bearingDeg)))}
        {"  "}
        <Text style={styles.faint}>{Math.round(bearingDeg)}°</Text>
      </Text>
      <Text style={styles.reason}>{describeClass(t, cls)}</Text>
      <Text style={styles.faint}>{formatElevationDelta(t, elevationDeltaM)}</Text>
    </View>
  );
}

/**
 * Every mapped feature the pack holds, at any distance, best first.
 *
 * This list is the whole answer to "nothing to walk to". It is never filtered by
 * distance — a 94 km occurrence is a day's drive, which is guidance, and hiding
 * it was the app claiming ignorance it did not have. Each row is a REAL record:
 * a mapped occurrence or a mapped fault, with a measured distance and bearing.
 */
function RegionalBlock({
  leads, computing, selectedId, onNavigate, onStop, t,
}: {
  leads: RegionalTarget[];
  computing: boolean;
  selectedId: string | null;
  onNavigate: (r: RegionalTarget) => void;
  onStop: () => void;
  t: TFunc;
}) {
  if (computing && leads.length === 0) {
    return <Text style={styles.body}>{t("field.regional.computing")}</Text>;
  }
  if (leads.length === 0) {
    // The pack genuinely holds nothing. That is a measurement, not a shrug, and
    // it is the ONE case where there is nothing further to offer.
    return <Text style={styles.body}>{t("field.regional.none")}</Text>;
  }

  return (
    <View>
      <Text style={styles.faint}>{t("field.regional.hint")}</Text>
      {leads.map((r) => {
        const active = r.id === selectedId;
        return (
          <Pressable
            key={r.id}
            style={[styles.leadRow, active && styles.leadRowActive]}
            onPress={() => (active ? onStop() : onNavigate(r))}
          >
            <View style={styles.leadText}>
              <Text style={styles.otherTitle}>{regionalLabel(r, t)}</Text>
              <Text style={styles.otherReason}>
                {formatDistance(t, r.distanceM)}
                {"  "}
                {t(compassKey(r.compass))}
                {"  ·  "}
                {t(distanceBandKey(r.distanceClass.band))}
              </Text>
              <Text style={styles.faint}>
                {t(transportShortKey(r.distanceClass.transport))}
                {"  ·  "}
                {formatTravel(t, r.distanceClass.travelMinutes)}
                {"  ·  "}
                {t("field.regional.priority", { value: Math.round(r.priority * 100) })}
              </Text>
            </View>
            <Ionicons
              name={active ? "close-circle" : "navigate"}
              size={20}
              color={active ? colors.danger : colors.gold}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/** What this traverse has actually covered, from the recorder's own numbers. */
function TraverseBlock({
  track, evidenceCount, waypointCount, targetsInvestigated, t,
}: {
  track: ReturnType<typeof useWalkingTrack>;
  evidenceCount: number;
  waypointCount: number;
  targetsInvestigated: number;
  t: TFunc;
}) {
  const st = track.stats;
  const rows: [string, string][] = [
    [t("field.track.distance"), formatDistance(t, st.distanceM)],
    [t("field.track.duration"), formatDuration(t, st.durationMs)],
    [t("field.track.moving"), formatDuration(t, st.movingMs)],
    [t("field.track.avgSpeed"), formatSpeed(t, track.averageSpeedMps)],
    [t("field.track.maxSpeed"), formatSpeed(t, track.maxSpeedMps)],
    // Relief comes from GPS altitude, which many fixes omit entirely; zero here
    // means "nothing reported", so it is shown as measured rather than dressed up.
    [t("field.track.ascent"), st.ascentM > 0 ? formatDistance(t, st.ascentM) : t("field.track.none")],
    [t("field.track.descent"), st.descentM > 0 ? formatDistance(t, st.descentM) : t("field.track.none")],
    [t("field.track.samples"), String(evidenceCount)],
    [t("field.track.waypoints"), String(waypointCount)],
    [t("field.track.targets"), String(targetsInvestigated)],
  ];

  return (
    <View style={styles.statGrid}>
      {rows.map(([k, v]) => (
        <View key={k} style={styles.statCell}>
          <Text style={styles.statCellValue}>{v}</Text>
          <Text style={styles.faint}>{k}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The notebook, out of the phone.
 *
 * Writes and shares through the OS. Nothing is uploaded and no account is
 * involved: these are the geologist's own observations, and they must come out
 * with no signal.
 */
function ExportBlock({ records, t }: { records: readonly Waypoint[]; t: TFunc }) {
  const [busy, setBusy] = React.useState<ExportFormat | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const count = exportableCount(records);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    setNote(null);
    const r = await shareWaypoints(records, format);
    setBusy(null);
    setNote(
      r.ok
        ? t("field.export.done", { count: r.count, filename: r.filename })
        : r.reason === "empty" ? t("field.export.empty")
        : r.reason === "unavailable" ? t("field.export.unavailable")
        : t("field.export.failed"),
    );
  };

  return (
    <View>
      <Text style={styles.faint}>{t("field.export.hint", { count })}</Text>
      <View style={styles.row}>
        {(["gpx", "csv", "geojson"] as const).map((f) => (
          <Pressable
            key={f}
            style={[styles.btn, count > 0 ? styles.btnGhost : styles.btnDisabled]}
            disabled={count === 0 || busy != null}
            onPress={() => void run(f)}
          >
            {busy === f
              ? <ActivityIndicator color={colors.text} />
              : <Text style={styles.btnGhostText}>{t(`field.export.${f}`)}</Text>}
          </Pressable>
        ))}
      </View>
      {note ? <Text style={styles.faint}>{note}</Text> : null}
    </View>
  );
}

/**
 * The evidence list.
 *
 * Near and far are separate answers. NEARBY is what bears on the ground
 * underfoot; the far block names the nearest mapped feature when nothing is
 * near, which is most of Somalia — suppressing it was the difference between
 * "there is nothing here" and "I have nothing to say".
 */
function EvidenceLines({
  orientation: o, unit, t,
}: { orientation: Orientation | null; unit: string | null; t: TFunc }) {
  if (!o) return <Text style={styles.body}>{t("field.pack.none")}</Text>;

  const rows: string[] = [];
  if (unit) rows.push(t("field.evidence2.unit", { name: unit }));
  if (o.fault && o.fault.distanceM <= NEARBY_FAULT_M) {
    rows.push(t("field.evidence2.faultDir", {
      distance: formatDistance(t, o.fault.distanceM),
      compass: t(compassKey(compassPointOf(o.fault.bearingDeg))),
    }));
  }
  if (o.occurrence && o.occurrence.distanceM <= NEARBY_OCCURRENCE_M) {
    rows.push(t("field.evidence2.occurrenceDir", {
      commodity: o.occurrence.commodity ?? o.occurrence.name ?? t("field.evidence2.unknownCommodity"),
      distance: formatDistance(t, o.occurrence.distanceM),
      compass: t(compassKey(compassPointOf(o.occurrence.bearingDeg))),
    }));
  }
  if (o.elevationM != null) rows.push(t("field.evidence2.elevation", { m: Math.round(o.elevationM) }));

  const far: string[] = [];
  if (o.nothingNearby) {
    if (o.occurrence) {
      far.push(t("field.evidence2.farOccurrence", {
        commodity: o.occurrence.commodity ?? o.occurrence.name ?? t("field.evidence2.unknownCommodity"),
        distance: formatDistance(t, o.occurrence.distanceM),
        compass: t(compassKey(compassPointOf(o.occurrence.bearingDeg))),
      }));
    }
    if (o.fault) {
      far.push(t("field.evidence2.farFault", {
        distance: formatDistance(t, o.fault.distanceM),
        compass: t(compassKey(compassPointOf(o.fault.bearingDeg))),
      }));
    }
  }

  return (
    <View>
      {rows.length === 0 ? <Text style={styles.body}>{t("field.evidence2.none")}</Text> : null}
      {rows.map((r) => <Text key={r} style={styles.reason}>{"•"} {r}</Text>)}
      {far.length > 0 ? (
        <View style={styles.farBlock}>
          <Text style={styles.farTitle}>{t("field.evidence2.farTitle")}</Text>
          {far.map((r) => <Text key={r} style={styles.reason}>{"→"} {r}</Text>)}
          <Text style={styles.faint}>{t("field.evidence2.farHint")}</Text>
        </View>
      ) : null}
    </View>
  );
}

function LookupBlock({
  inspecting, onLookup, onClear, onNavigate, t,
}: {
  inspecting: { lat: number; lng: number } | null;
  onLookup: (lat: number, lng: number) => void;
  onClear: () => void;
  onNavigate: (lat: number, lng: number) => void;
  t: TFunc;
}) {
  const [lat, setLat] = React.useState("");
  const [lng, setLng] = React.useState("");
  // Accept a comma decimal separator too — it is what many keyboards produce.
  const parse = (v: string) => Number(v.trim().replace(",", "."));
  const latN = parse(lat), lngN = parse(lng);
  const valid =
    Number.isFinite(latN) && Number.isFinite(lngN) &&
    latN >= -90 && latN <= 90 && lngN >= -180 && lngN <= 180;

  return (
    <View>
      <Text style={styles.body}>{t("field.location.lookupHint")}</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input} value={lat} onChangeText={setLat}
          placeholder={t("field.location.lat")} placeholderTextColor={colors.textFaint}
          keyboardType="numbers-and-punctuation"
        />
        <TextInput
          style={styles.input} value={lng} onChangeText={setLng}
          placeholder={t("field.location.lng")} placeholderTextColor={colors.textFaint}
          keyboardType="numbers-and-punctuation"
        />
      </View>
      <View style={styles.row}>
        <Pressable
          style={[styles.btn, valid ? styles.btnPrimary : styles.btnDisabled]}
          disabled={!valid} onPress={() => onLookup(latN, lngN)}
        >
          <Text style={valid ? styles.btnPrimaryText : styles.btnGhostText}>
            {t("field.location.lookup")}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.btn, valid ? styles.btnGhost : styles.btnDisabled]}
          disabled={!valid} onPress={() => onNavigate(latN, lngN)}
        >
          <Text style={styles.btnGhostText}>{t("field.location.navigate")}</Text>
        </Pressable>
      </View>
      {inspecting ? (
        <Pressable style={[styles.btn, styles.btnGhost]} onPress={onClear}>
          <Text style={styles.btnGhostText}>{t("field.location.backToMe")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function PackFooter({
  provenance, problem, online, walkedM, t,
}: {
  provenance: { packVersion: string; ageDays: number; stale: boolean } | null;
  problem: string | null; online: boolean; walkedM: number; t: TFunc;
}) {
  return (
    <View style={styles.footer}>
      {/* Risk 3: pack age is always visible, so months-old knowledge is never
          mistaken for current. A refused pack says WHY it was refused. */}
      <Text style={styles.faint}>
        {provenance
          ? t(provenance.stale ? "field.pack.stale" : "field.pack.info", {
              version: provenance.packVersion, days: provenance.ageDays,
            })
          : problem ?? t("field.pack.none")}
      </Text>
      <Text style={styles.faint}>
        {t("field.sheet.walked", { distance: formatDistance(t, walkedM) })}
        {"  ·  "}
        {online ? t("field.net.online") : t("field.net.offline")}
      </Text>
    </View>
  );
}

function StartCard({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation();
  return (
    <ScrollView contentContainerStyle={styles.startWrap}>
      <View style={styles.card}>
        <Text style={styles.h1}>{t("field.start.heading")}</Text>
        <Text style={styles.body}>{t("field.start.body")}</Text>
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onStart}>
          <Text style={styles.btnPrimaryText}>{t("field.start.button")}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

// ── Wording ─────────────────────────────────────────────────────────────────

/**
 * One sentence for the collapsed sheet: what to do now, and why.
 *
 * The one thing it must never do is end the workflow. Every branch below either
 * gives a direction or explains what is being waited for — and where the engine
 * has no recommendation, the nearest MEASURED feature in the pack is offered
 * with the means and time to reach it, rather than the sentence this screen used
 * to finish on: "nothing to walk to here".
 */
function recommendation(
  s: Snap, o: Orientation | null, nearest: RegionalTarget | null, t: TFunc,
): string {
  if (s.suspendedBy) {
    return s.suspendedBy === "no-fix" ? t("field.status.waitingGps")
      : s.suspendedBy === "paused" ? t("field.status.paused")
      : t("field.status.sensorError");
  }
  if (s.inspecting) return t("field.location.lookupHint");
  if (s.state === "awaitingEvidence") return t("field.arrived.body");
  if (s.activeTarget) {
    const first = s.activeTarget.reasons[0];
    return t("field.sheet.walkToward", {
      distance: formatDistance(t, s.distanceToTargetM ?? s.activeTarget.distanceM),
      compass: t(compassKey(s.activeTarget.compass)),
      reason: first ? renderReason(first, t) : "",
    });
  }
  // A chosen destination outranks a suggestion: the user already decided.
  if (s.destination && s.destinationDistanceM != null && s.destinationBearingDeg != null) {
    const cls = classifyDistance(s.destinationDistanceM);
    return t("field.sheet.regionalLead", {
      distance: formatDistance(t, s.destinationDistanceM),
      compass: t(compassKey(compassPointOf(s.destinationBearingDeg))),
      transport: t(transportKey(cls.transport)),
      travel: formatTravel(t, cls.travelMinutes),
    });
  }
  // No target within one leg. Not a dead end — a classification. The pack knows
  // where the nearest mapped ground is; say so, and say how to get to it.
  if (nearest) {
    return t("field.sheet.nothingHereFar", {
      distance: formatDistance(t, nearest.distanceM),
      compass: t(compassKey(nearest.compass)),
      transport: t(transportKey(nearest.distanceClass.transport)),
      travel: formatTravel(t, nearest.distanceClass.travelMinutes),
    });
  }
  // The scan has not finished yet — a pause, not a conclusion.
  if (s.state === "orienting") return t("field.status.orienting");
  // Only now, with the whole pack read and genuinely nothing in it, is silence
  // the honest answer. Unknown stays Unknown.
  if (o?.nothingNearby) return t("field.regional.none");
  return t("field.none.noStrongerBody");
}

/** A short paragraph for the expanded sheet: what this ground is. */
function interpretation(s: Snap, o: Orientation | null, t: TFunc): string {
  const unit = unitOf(s.context);
  const parts: string[] = [];
  parts.push(unit ? t("field.sheet.youAreOn", { unit }) : t("field.sheet.unitUnknown"));
  if (o?.fault && o.fault.distanceM <= NEARBY_FAULT_M) {
    parts.push(t("field.sheet.faultAhead", { distance: formatDistance(t, o.fault.distanceM) }));
  }
  if (s.activeTarget?.reasons[0]) parts.push(renderReason(s.activeTarget.reasons[0], t));
  return parts.join(" ");
}

/** Two or three words for the collapsed "Reason" column. */
function shortReason(r: TargetReason, t: TFunc): string {
  switch (r.kind) {
    case "occurrence": return t("field.short.occurrence", { commodity: r.commodity });
    case "association": return t("field.short.association", { commodity: r.commodity });
    case "community": return t("field.short.community");
    case "observation": return t("field.short.observation");
    case "fault": return t("field.short.fault");
    case "contact": return t("field.short.contact");
    case "intersection": return t("field.short.intersection");
    case "unit": return r.name;
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

function unitOf(ctx: { geology?: { unit?: string } } | null): string | null {
  return ctx?.geology?.unit ?? null;
}

const reasonKey = (r: TargetReason, i: number): string => r.kind + "-" + String(i);

/** What a regional lead IS, in one phrase — never more than the pack recorded. */
function regionalLabel(r: RegionalTarget, t: TFunc): string {
  if (r.reason.kind === "known_occurrence") {
    return r.reason.commodity
      ? t("field.regional.occurrence", { commodity: r.reason.commodity })
      : t("field.regional.occurrenceUnnamed");
  }
  return r.reason.name
    ? t("field.regional.faultNamed", { name: r.reason.name })
    : t("field.regional.fault");
}

/**
 * Renders a structured reason in the active language.
 *
 * The engine reports WHAT it found; this decides how to say it. That split is
 * what lets a Somali geologist read the same reasoning an English one does,
 * instead of a translated shell wrapped around English geology.
 */
function renderReason(r: TargetReason, t: TFunc): string {
  switch (r.kind) {
    case "occurrence":
      return t("field.reason.occurrence", { commodity: r.commodity, distance: formatDistance(t, r.distanceM) });
    case "association":
      return t("field.reason.association", { commodity: r.commodity });
    case "community":
      return t("field.reason.community", { count: r.count });
    case "observation":
      return t("field.reason.observation", {
        label: t(waypointTypeLabelKey(r.label as WaypointType)),
        distance: formatDistance(t, r.distanceM),
      });
    case "fault":
      return t("field.reason.fault", { distance: formatDistance(t, r.distanceM) });
    case "contact":
      return t("field.reason.contact", { distance: formatDistance(t, r.distanceM) });
    case "intersection":
      return t("field.reason.intersection", { distance: formatDistance(t, r.distanceM) });
    case "unit":
      return t("field.reason.unit", { name: r.name });
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  mapArea: { flex: 1, overflow: "hidden" },
  mapWaiting: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md },
  mapWaitingText: { color: colors.textMuted, fontSize: 14 },

  header: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
  },
  headerText: { flex: 1 },
  headerTitle: { color: colors.text, fontSize: 22, fontWeight: "800" },
  headerStatus: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOnline: { backgroundColor: "#22C55E" },
  dotOffline: { backgroundColor: colors.textFaint },
  headerSub: { color: colors.textMuted, fontSize: 13 },
  endText: { color: colors.danger, fontSize: 14, fontWeight: "700" },

  pillWrap: { position: "absolute", top: spacing.md, left: 0, right: 0, alignItems: "center" },
  compassWrap: { position: "absolute", top: spacing.md + 56, right: spacing.md },
  zoomWrap: { position: "absolute", right: spacing.md, top: "38%", gap: spacing.sm },
  locateWrap: { position: "absolute", right: spacing.md, bottom: spacing.lg },
  attribution: {
    position: "absolute", right: spacing.md, bottom: 2,
    color: "rgba(245,241,232,0.55)", fontSize: 9,
  },

  collapsedBody: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    paddingHorizontal: spacing.lg, paddingTop: spacing.md,
    borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.md,
  },
  collapsedText: { flex: 1, color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  chevron: {
    width: 42, height: 42, borderRadius: 21,
    borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center",
  },

  arrived: {
    borderWidth: 1, borderColor: "rgba(34,197,94,0.35)",
    backgroundColor: "rgba(34,197,94,0.08)",
    borderRadius: radius.xl, padding: spacing.md,
    gap: spacing.md, marginBottom: spacing.lg,
  },
  arrivedHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  tick: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: "#22C55E",
    alignItems: "center", justifyContent: "center",
  },
  arrivedText: { flex: 1 },
  arrivedTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },

  actionRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  wideBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    paddingVertical: spacing.md, backgroundColor: colors.bg,
  },
  wideBtnText: { color: colors.text, fontSize: 14, fontWeight: "600" },

  farBlock: {
    marginTop: spacing.md, paddingTop: spacing.md,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  farTitle: {
    color: colors.textFaint, fontSize: 11, fontWeight: "700",
    letterSpacing: 0.6, marginBottom: spacing.xs,
  },

  card: {
    backgroundColor: colors.surface, borderRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.lg, gap: spacing.sm,
  },
  startWrap: { padding: spacing.lg, gap: spacing.md },

  h1: { color: colors.text, fontSize: 26, fontWeight: "800" },
  body: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  faint: { color: colors.textFaint, fontSize: 12 },
  reason: { color: colors.text, fontSize: 14, lineHeight: 21 },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, backgroundColor: colors.bg,
  },
  chipText: { color: colors.text, fontSize: 13 },

  otherRow: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  otherTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  otherReason: { color: colors.textFaint, fontSize: 12 },

  gpsBox: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: spacing.md, gap: 4, marginBottom: spacing.lg, backgroundColor: colors.bg,
  },
  gpsBoxWarn: { borderColor: colors.goldBorder, backgroundColor: colors.goldSoft },
  gpsHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  gpsGrade: { color: colors.text, fontSize: 14, fontWeight: "700" },
  gpsWarn: { color: colors.gold, fontSize: 12, lineHeight: 18 },

  journey: { gap: 2, marginBottom: spacing.sm },
  journeyHead: { color: colors.text, fontSize: 20, fontWeight: "800" },

  leadRow: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  leadRowActive: { backgroundColor: colors.goldSoft, borderRadius: radius.md, paddingHorizontal: spacing.sm },
  leadText: { flex: 1, gap: 1 },

  statGrid: { flexDirection: "row", flexWrap: "wrap" },
  statCell: { width: "33.33%", paddingVertical: spacing.sm, paddingRight: spacing.sm },
  statCellValue: { color: colors.text, fontSize: 15, fontWeight: "700" },

  row: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  input: {
    flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    color: colors.text, backgroundColor: colors.bg, fontSize: 15,
  },
  btn: {
    flex: 1, borderRadius: radius.lg, paddingVertical: spacing.md,
    alignItems: "center", justifyContent: "center",
  },
  btnPrimary: { backgroundColor: colors.gold },
  btnPrimaryText: { color: "#0B0B0C", fontSize: 15, fontWeight: "700" },
  btnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  btnGhostText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  btnDisabled: { borderWidth: 1, borderColor: colors.border, opacity: 0.45 },

  footer: { gap: spacing.xs, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
});

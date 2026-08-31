// The exploration sheet — a SURFACE over the live map.
//
// ARCHITECTURE V2, PRINCIPLE 0.2: the map is the operating system. This file used
// to be the whole screen: it owned the map, the scene, the camera, the tile
// fetcher and the layer set, which meant all of them were born and died with a
// route. It is now one surface among several that the explore layout renders ON
// a map that never unmounts (see components/MapWorkspace.tsx and
// lib/exploration/workspace.tsx).
//
// What is left here is what the SHEET is: the readout, the reasoning, and the
// actions. No map state, no session lifecycle.
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
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import * as ImagePicker from "expo-image-picker";
import { colors, radius, spacing } from "../../../lib/theme";
import { useExpeditionLease } from "../../../lib/exploration/useExpeditionLease";
import { useExploration } from "../../../lib/exploration/provider";
import { cacheSize } from "../../../lib/geo/tileCache";
import { hasCapturedPhotos } from "../../../lib/captureHandoff";
import { DevDiagnostics, type DiagnosticRow } from "../../../components/DevDiagnostics";
import {
  currentPhases, SEVERE_MS, stallReport, type Stall,
} from "../../../lib/diagnostics/jsStall";
import type { ExplorationSnapshot } from "../../../lib/exploration/orchestrator";
import { isDelivering } from "../../../lib/exploration/mission";
import { AIGeologistReport } from "../../../components/AIGeologistReport";
import { AddWaypointForm } from "../../../components/AddWaypointForm";
import { StructuredEvidenceForm } from "../../../components/StructuredEvidenceForm";
import { isEmptyStructuredEvidence } from "../../../lib/field/structuredEvidenceTypes";
import { NearbyEvidence } from "../../../components/NearbyEvidence";
import { NEARBY_RADIUS_M, nearbyWaypoints } from "../../../lib/field/nearbyWaypoints";
import { EvidenceBasis } from "../../../components/EvidenceBasis";
import { CommodityChooser } from "../../../components/CommodityChooser";
import { useMapWorkspace } from "../../../lib/exploration/workspace";
import { takeAnalysedSample } from "../../../lib/exploration/analysisHandoff";
import {
  interpretation, recommendation, reasonKey, regionalLabel, renderReason,
  shortReason, unitOf,
} from "../../../lib/exploration/wording";
import {
  WAYPOINT_TYPES, positionReported, waypointTypeLabelKey, type Waypoint,
} from "../../../lib/field/waypointTypes";
import { compassPoint as compassPointOf } from "../../../../shared/geo-core/geo/spatial.ts";
import { haversineM } from "../../../../shared/geo-core/geo/spatial.ts";
import {
  elevationAt, NEARBY_FAULT_M, NEARBY_OCCURRENCE_M, type Orientation,
} from "../../../lib/geo/orientation";
import { classifyDistance, type DistanceClass, type RegionalTarget } from "../../../lib/geo/expedition";
import { roadFactor } from "../../../lib/geo/roadFactor";
import { formatAccuracyM, type FixQuality } from "../../../lib/geo/fixQuality";
import {
  journeyTo, nearestLineOfKind, terrainAt, unitAt, associatedCommodities,
  type IdentifiedFeature, type Identification,
} from "../../../lib/geo/featureInfo";
import { fieldAdvice, EVIDENCE_NEARBY_M, type Advice } from "../../../lib/geo/fieldAdvice";
import {
  ExplorationSheet, SheetAction, SheetRow, SheetSection, SheetStats,
} from "../../../components/ExplorationSheet";
import { shareWaypoints, exportableCount } from "../../../lib/field/waypointShare";
import type { ExportFormat } from "../../../lib/field/waypointExport";
import type { useWalkingTrack } from "../../../lib/exploration/useWalkingTrack";
import {
  compassKey, confidenceBandKey, describeClass, distanceBandKey, formatAccuracy,
  formatDistance, formatDuration, formatElevationDelta, formatFixAge, formatSpeed,
  formatRoadDistance, formatRoadKm, formatTravelDistance,
  formatTravel, transportShortKey, type TFunc,
} from "../../../lib/exploration/format";

export default function ExplorationSurface() {
  const { t, i18n } = useTranslation();
  // The Add Waypoint form. Opened only from places the geologist went to on
  // purpose — the arrival panel and a tapped point — never from a row their thumb
  // passes over while scrolling.
  const [waypointFormOpen, setWaypointFormOpen] = React.useState(false);
  // The User Geological Evidence form. Same "opened on purpose" rule as the
  // waypoint form — reached from the arrival panel, never mounted open.
  const [evidenceFormOpen, setEvidenceFormOpen] = React.useState(false);

  /**
   * The camera, then the library as a fallback.
   *
   * The same expo-image-picker path the enterprise sample screen uses — a second
   * photo source would mean two sets of permission handling and two ways for a
   * cancel to be misread. The uris are handed straight to `captureObservation`,
   * which copies them into app-owned storage inside `WaypointService.capture`.
   */
  const pickWaypointPhotos = React.useCallback(async (): Promise<string[]> => {
    try {
      // THE LIBRARY, not the camera. FIELD CAMERA already covers photographing
      // what is in front of you; this button says "ADD PHOTO" and opened the same
      // camera, which left no way at all to attach a photograph the phone did not
      // take. A colleague four hundred kilometres away sends three pictures of a
      // quartz vein and there was nowhere to put them.
      //
      // Multiple selection because evidence arrives in sets — an outcrop, a close
      // up of the vein, something for scale — and picking them one at a time is
      // three trips through the same dialogue.
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 1,
      });
      if (r.canceled) return [];
      return (r.assets ?? []).map((a) => a.uri).filter(Boolean);
    } catch {
      // No library, or permission refused. Not an error worth interrupting a field
      // record for — the observation is still worth saving without a photograph.
      return [];
    }
  }, []);
  const {
    snapshot: s, actions, packs, waypoints, waypointRecords, packages, photoUploads,
    structuredEvidence,
  } = useExploration();
  const w = useMapWorkspace();
  // Read for the detached notice only. Never gates anything.
  const lease = useExpeditionLease();
  const insets = useSafeAreaInsets();
  /**
   * Previous field evidence near where the geologist is standing.
   *
   * From the device's own waypoint store and the live fix — no network, and nothing
   * that touches the prospectivity engine. Memoised on the fix so it is not
   * recomputed on every unrelated re-render.
   */
  const nearbyEvidence = React.useMemo(
    () => (s.position
      ? nearbyWaypoints(waypointRecords, { lat: s.position.lat, lng: s.position.lng })
      : []),
    [waypointRecords, s.position?.lat, s.position?.lng],
  );

  const fix = w.fix;

  const orientation = w.readout.orientation;

  // Elevation difference to whatever is being navigated to. Both readings come
  // from the same DEM, and either being absent makes the answer null rather
  // than zero — "no data" and "level ground" are not the same statement.
  const destPoint = s.activeTarget
    ? { lat: s.activeTarget.centre.lat, lng: s.activeTarget.centre.lng }
    : s.destination;
  const elevationDeltaM = React.useMemo(() => {
    if (!w.ready || !destPoint || !s.position) return null;
    const there = elevationAt(w.data, destPoint);
    const here = elevationAt(w.data, { lat: s.position.lat, lng: s.position.lng });
    if (!there || !here) return null;
    return there.elevationM - here.elevationM;
  }, [w.ready, w.data, destPoint?.lat, destPoint?.lng, s.position?.lat, s.position?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Advice is recomputed on the same movement gate as the readout — the answer
  // does not change when you shuffle two metres, and running it per fix would
  // put a pack scan back on the thread the map draws on.
  const advice: Advice[] = React.useMemo(() => {
    const at = w.readout.at;
    if (!w.ready || !at) return [];
    const cell = terrainAt(w.data, at);
    const unit = unitAt(w.data, at);
    const lithology = typeof unit?.attributes?.lith === "string" ? unit.attributes.lith : null;
    const nearestContact = nearestLineOfKind(w.data, at, "contact");
    const evidenceNearby = waypoints.filter(
      (p) => haversineM(at, { lat: p.lat, lng: p.lng }) <= EVIDENCE_NEARBY_M,
    ).length;

    return fieldAdvice({
      terrain: cell
        ? { slopeDeg: cell.slopeDeg, morphology: cell.morphology, drainageDistM: cell.drainageDistM, fromM: cell.fromM }
        : null,
      unit: unit
        ? { name: unit.name, lithology, associated: associatedCommodities(w.data, lithology) }
        : null,
      fault: orientation?.fault ?? null,
      contact: nearestContact,
      occurrence: orientation?.occurrence
        ? {
            distanceM: orientation.occurrence.distanceM,
            bearingDeg: orientation.occurrence.bearingDeg,
            commodity: orientation.occurrence.commodity,
          }
        : null,
      target: s.activeTarget
        ? { distanceM: s.distanceToTargetM ?? s.activeTarget.distanceM, bearingDeg: s.activeTarget.bearingDeg }
        : null,
      evidenceNearby,
    });
  }, [w.ready, w.data, w.readout.at, orientation, s.activeTarget, s.distanceToTargetM, waypoints]);

  // Arrival is what the whole walk was for, so the sheet opens itself: the
  // geologist has stopped and is about to act.
  React.useEffect(() => {
    if (s.state === "awaitingEvidence") w.setExpanded(true);
  }, [s.state]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Returned from a submitted sample. The loop continues: fold the new evidence
   * in and re-score, so the next recommendation accounts for what was just
   * found. The session is NOT restarted — it never stopped.
   *
   * Two channels, because there are two ways back. The capture screen now pops
   * to this live surface and leaves the id in a slot (analysisHandoff); a deep
   * link or the legacy route still arrives as a parameter. Both fold once.
   */
  const foldedIn = React.useRef<string | null>(null);
  const fold = React.useCallback((id: string | null | undefined) => {
    if (!id || foldedIn.current === id) return;
    foldedIn.current = id;
    void actions.recordEvidence();
  }, [actions]);

  useFocusEffect(React.useCallback(() => { fold(takeAnalysedSample()); }, [fold]));

  const { analysed } = useLocalSearchParams<{ analysed?: string }>();
  React.useEffect(() => { fold(analysed); }, [analysed, fold]);

  /**
   * FIELD DIAGNOSTICS — every value read from the live app, never derived here.
   *
   * Enabled until explicitly removed (lib/devIndicator.ts). This is what makes a
   * failure on a hillside answerable on the spot instead of reported as "it
   * broke": whether the GPS or the target is wrong, whether the pack loaded,
   * whether the tile cache works, whether the expedition is alive, whether the
   * workspace restarted, and whether the label projection is still in force.
   */
  const [tileBytes, setTileBytes] = React.useState<number | null>(null);
  React.useEffect(() => { void cacheSize().then(setTileBytes); }, [w.sync.pending]);

  // Read OUTSIDE the memo: a stall recorded after mount must still appear, and a
  // value captured once at mount would report "none" for the rest of the session.
  const stalls = stallReport();
  const worstStall = stalls.stalls.reduce<Stall | null>(
    (worst, x) => (worst == null || x.durationMs > worst.durationMs ? x : worst),
    null,
  );

  const diagnostics: DiagnosticRow[] = React.useMemo(() => {
    // ONE authority for every pack row in this panel.
    //
    // The version row used to read `s.packProvenance`, a snapshot field written
    // only by a completed targeting run, while the SHA row two lines down read
    // the store. In the field that produced a panel asserting both "Pack version:
    // NOT LOADED" and a 64-character SHA256 of the pack it had supposedly not
    // loaded, with the map drawing that pack's geology behind it. The snapshot is
    // now derived from the store too (see orchestrator.getSnapshot), so the two
    // agree — but this panel reads the store outright, because a diagnostics
    // panel that reports anything other than the authority is the bug it exists
    // to catch.
    const manifest = packs.getManifest();
    const provenance = packs.provenance();
    const packState = packs.getStatus().state;
    const unitHere = w.ready && w.readout.at ? unitAt(w.data, w.readout.at) : null;
    const pickedFeature = w.picked?.features[0] ?? null;
    const layersOn = (Object.keys(w.layers) as Array<keyof typeof w.layers>).filter((k) => w.layers[k]);
    const cam = w.camera;

    return [
      // The map host renders this sheet's parent, so its presence IS the answer.
      { label: "Map OS", value: "ACTIVE", good: true },
      { label: "Workspace ID", value: w.workspaceId, good: true },
      { label: "Expedition ID", value: s.explorationSessionId ?? "— none —", warn: !s.explorationSessionId },
      // THE LEASE, VISIBLE.
      //
      // A field test asked "why did no dialog appear?" and the honest answer was
      // that nobody could see whether a lease was open — including me. The whole
      // Milestone 1 gate turns on this one boolean, so it is on the panel.
      {
        label: "Field lease",
        value: lease.isLoading
          ? "reading…"
          : lease.lease
            ? `${lease.lease.state} · open ${Math.round((Date.now() - lease.lease.openedAt) / 60000)} min`
            : "— none open —",
        good: lease.isOpen && !lease.isDetached,
        warn: lease.isDetached,
      },
      {
        label: "Lease collector",
        value: lease.lease?.collectedBy?.email ?? (lease.lease ? "— unattributed —" : "—"),
        warn: !!lease.lease && !lease.lease.collectedBy,
      },
      {
        label: "Auth gate",
        value: lease.isOpen ? "LIFTED (expedition open)" : "enforced",
        good: lease.isOpen,
      },
      // An expedition that disappeared between two builds could not be explained
      // by anything on the device: close() dropped the lease and persisted a
      // null. This row is the record it should always have left behind — a walk
      // may not end anonymously.
      {
        label: "Last expedition end",
        value: lease.lastClosure
          ? `${lease.lastClosure.reason} · ${lease.lastClosure.expeditionId} · ${new Date(lease.lastClosure.closedAt).toLocaleString()} · ${lease.lastClosure.build}`
          : "— none recorded —",
        warn: lease.lastClosure?.reason === "expired",
      },
      { label: "Session state", value: s.state + (s.suspendedBy ? ` (${s.suspendedBy})` : "") },
      { label: "GPS status", value: fixLabel(fix), warn: fix.warn, good: fix.grade === "good" },
      {
        label: "Latitude",
        value: s.position ? s.position.lat.toFixed(6) : "—",
        warn: !s.position,
      },
      { label: "Longitude", value: s.position ? s.position.lng.toFixed(6) : "—", warn: !s.position },
      {
        label: "GPS accuracy",
        // Formatted, not rounded — the stored value keeps every digit the
        // receiver gave. See formatAccuracyM.
        value: formatAccuracyM(s.position?.accuracyM),
        warn: (s.position?.accuracyM ?? 0) > 25,
      },
      { label: "Geological unit", value: unitHere ? unitHere.id : "no mapped unit here" },
      { label: "Target ID", value: s.activeTarget?.cell ?? "— none —" },
      {
        label: "Selected feature",
        value: pickedFeature
          ? pickedFeature.kind + ":" + ("id" in pickedFeature ? pickedFeature.id : "terrain")
          : "— none —",
      },
      {
        // The store's own state is named either way, so "no pack" and "pack the
        // panel could not see" can never again look the same.
        label: "Pack version",
        value: provenance
          ? `${provenance.packVersion} (${provenance.ageDays}d)`
          : `NOT LOADED · store state: ${packState}`,
        warn: !provenance,
        good: !!provenance && !provenance.stale,
      },
      { label: "Pack SHA256", value: manifest?.sha256 ?? "—", warn: !manifest },
      {
        label: "Tile cache",
        value: tileBytes == null
          ? "reading…"
          : `${(tileBytes / 1_048_576).toFixed(1)} MB · ${cam?.tilesPainted ?? 0} painted`,
        warn: tileBytes === 0,
      },
      // The one that answers "have the labels drifted again?". Tiles are
      // EPSG:3857; the canvas is local equirectangular; the strips are the
      // reprojection between them.
      //
      // The span is printed with the count because the count alone cannot answer
      // the question. One strip is CORRECT for any tile under 0.12°, which is z12
      // and closer — so the panel read "1 strips" at every working zoom, and that
      // is exactly what a dead reprojection would read too. Read them together:
      // 0.04° → 1 is right; anything over 0.12° → 1 means it has stopped.
      {
        label: "Projection",
        value: cam && cam.tilesPainted > 0
          ? `tiles EPSG:3857 (Web Mercator) → canvas equirectangular · ` +
            `${cam.tileStrips} ${cam.tileStrips === 1 ? "strip" : "strips"} ` +
            `· widest tile ${cam.tileSpanDeg.toFixed(3)}°`
          : "tiles EPSG:3857 (Web Mercator) → canvas equirectangular · no tiles painted",
        good: !!cam && cam.tilesPainted > 0 &&
          (cam.tileSpanDeg < 0.12 ? cam.tileStrips === 1 : cam.tileStrips > 1),
        warn: !!cam && cam.tilesPainted > 0 &&
          cam.tileSpanDeg >= 0.12 && cam.tileStrips <= 1,
      },
      { label: "Map rotation", value: `${Math.round(cam?.rotationDeg ?? 0)}° up-screen bearing` },
      { label: "Scale", value: cam ? `${cam.metresPerPx.toFixed(2)} m/px` : "—" },
      { label: "Network", value: w.isOnline ? "ONLINE" : "OFFLINE", good: w.isOnline },
      { label: "Layers on", value: `${layersOn.length}/${Object.keys(w.layers).length} · ${layersOn.join(", ")}` },
      // ── The outbox, in full ──────────────────────────────────────────────
      //
      // This used to be one row reading "8 held · 4 failing". The device knew why
      // each of those four had failed — the reason was on disk, in the entry — and
      // the panel showed a number instead. Five states, and the reason, because a
      // failure a geologist cannot see is a failure they cannot act on.
      {
        // The invariant first. Every record is on the device from the moment it
        // exists; nothing here is ever dropped unsent.
        label: "Stored on device",
        value: `${w.sync.stored} record${w.sync.stored === 1 ? "" : "s"}` +
          (w.sync.pending === 0 && w.sync.stored > 0 ? " · all filed" : ""),
        good: w.sync.stored > 0 && w.sync.pending === 0,
      },
      {
        label: "Pending upload",
        value: w.sync.syncing
          ? `filing… (${w.sync.pending} to go)`
          : w.sync.queued === 0
            ? "none waiting"
            : `${w.sync.queued} queued`,
      },
      {
        label: "Retrying",
        value: w.sync.retrying === 0
          ? "none"
          : `${w.sync.retrying} · next attempt ${untilLabel(w.sync.nextRetryAt)}`,
        warn: w.sync.retrying > 0,
      },
      {
        // Named "failed", counted separately from retrying, and never silent
        // about why. `rejected` are the ones the server called permanent — they
        // are out of the queue but their reason is kept deliberately.
        label: "Failed",
        value: w.sync.failing === 0 && w.sync.rejected === 0
          ? "none"
          : [
              w.sync.failing > 0 ? `${w.sync.failing} failing (still retrying)` : null,
              w.sync.rejected > 0 ? `${w.sync.rejected} refused permanently` : null,
            ].filter(Boolean).join(" · "),
        warn: w.sync.failing > 0 || w.sync.rejected > 0,
      },
      ...w.sync.reasons.map((r, i) => ({
        label: i === 0 ? "Reason" : "",
        value: `${r.count}× ${r.permanent ? "PERMANENT · " : ""}${r.reason}`,
        warn: true,
      })),
      {
        label: "Successfully synced",
        value: `${w.sync.synced} filed with the server`,
        good: w.sync.synced > 0,
      },
      {
        label: "Last drain",
        value: w.sync.lastDrainAt == null
          ? "not attempted yet"
          : `${Math.round((Date.now() - w.sync.lastDrainAt) / 1000)} s ago · ` +
            (w.sync.blocked
              ? `BLOCKED: ${w.sync.blocked}${w.sync.blockedReason ? ` — ${w.sync.blockedReason}` : ""}`
              : "completed"),
        warn: !!w.sync.blocked,
        good: w.sync.lastDrainAt != null && !w.sync.blocked,
      },
      {
        label: "Samples held",
        value: w.samples.uploading
          ? `filing ${w.samples.pending}…`
          : `${w.samples.pending} on device · ${w.samples.failed} will retry`,
        warn: w.samples.failed > 0,
        good: w.samples.pending === 0,
      },
      {
        label: "AI analysis",
        value: foldedIn.current
          ? `folded ${foldedIn.current}`
          : `${s.evidenceCount} evidence this session`,
      },
      {
        label: "Camera handoff",
        value: hasCapturedPhotos() ? "photos waiting in slot" : "idle",
        warn: hasCapturedPhotos(),
      },
      {
        label: "Track recording",
        value: s.explorationSessionId
          ? `${w.track.points.length} pts · ${Math.round(w.track.distanceM)} m`
          : "not recording",
        good: w.track.points.length > 0,
      },
      /**
       * THE FROZEN-APP ROWS.
       *
       * The report is "it opens, it still scrolls, and no button responds until I
       * force-close it". Those two facts together are the diagnosis: on Android a
       * ScrollView scrolls on the NATIVE thread and keeps moving whatever
       * JavaScript is doing, while a Pressable cannot fire until JavaScript gets a
       * turn. An overlay would have blocked the drag as well as the tap.
       *
       * lib/diagnostics/jsStall has been measuring this since the report came in.
       * It was never shown anywhere, so the measurement existed and the answer did
       * not. These three rows are that measurement, on the hillside, with no cable.
       */
      {
        label: "JS stalls",
        value: stalls.count === 0
          ? "none"
          : `${stalls.count} · worst ${Math.round(stalls.worstMs)} ms · ${Math.round(stalls.totalMs)} ms total`,
        warn: stalls.worstMs >= SEVERE_MS,
        good: stalls.count === 0,
      },
      {
        label: "Worst stall in",
        // A duration alone says "something took four seconds" and leaves the hunt
        // where it started. The phase stack says WHAT was running.
        value: worstStall ? (worstStall.phases.join(" › ") || "unattributed") : "—",
        warn: worstStall != null && worstStall.durationMs >= SEVERE_MS,
      },
      {
        label: "Running now",
        value: currentPhases().join(" › ") || "idle",
      },
      {
        // Verifiable, because the fix for the three biggest field reports is
        // invisible when it works. If this says HELD and the position still goes
        // stale with the screen on, the cause is somewhere else entirely.
        label: "Screen",
        value: w.running ? "HELD AWAKE while walking" : "normal timeout",
        good: w.running,
      },
    ];
  }, [
    w.workspaceId, w.ready, w.data, w.readout.at, w.picked, w.layers, w.camera, w.isOnline,
    w.sync, w.samples, w.track.points.length, w.track.distanceM, s, fix, packs, tileBytes,
    stalls, worstStall,
  ]);

  if (!w.running) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Header online={w.isOnline} />
        <StartCard onStart={actions.start} />
      </View>
    );
  }

  // The map is the interface, so the sheet is capped well short of the screen:
  // even fully open, the ground the geologist is standing on stays in view.
  const sheetExpandedH = Math.min(w.screenHeight * 0.68, w.screenHeight - 180);
  const arrived = s.state === "awaitingEvidence";

  return (
    <ExplorationSheet
      expandedHeight={sheetExpandedH}
      expanded={w.expanded}
      onExpandedChange={w.setExpanded}
      header={
        <CollapsedHeader
          snapshot={s}
          orientation={orientation}
          nearest={w.readout.regional[0] ?? null}
          expanded={w.expanded}
          onToggle={() => w.setExpanded((v) => !v)}
          t={t}
        />
      }
    >
      {/* FIELD DIAGNOSTICS — first in the sheet on purpose. Enabled until
          explicitly removed; see lib/devIndicator.ts. */}
      <DevDiagnostics title={t("field.diag.title")} rows={diagnostics} />

      {arrived ? (
        <ArrivedBlock
          onScan={() => goToCapture()}
          onWaypoint={() => setWaypointFormOpen(true)}
          onRecalculate={actions.refresh}
          t={t}
        />
      ) : null}
      {/* DETACHED EXPEDITION — never silent.

          The account has been signed out while this walk is open. Recording
          continues and nothing is lost; only filing stops. This has to be said,
          because "signed out" and "token expired" produce the same null session
          and the geologist is entitled to know which happened to them. First in
          the sheet, above everything, because it changes what they should expect
          the app to do. */}
      {lease.isDetached ? (
        <View style={styles.detached}>
          <Ionicons name="person-remove-outline" size={16} color="#F0B429" />
          <Text style={styles.detachedText}>
            Signed out — the expedition is still recording. Everything is saved on
            this device and will be filed when
            {lease.lease?.collectedBy?.email ? " " + lease.lease.collectedBy.email : " that account"}
            {" signs in."}
          </Text>
        </View>
      ) : null}


      {/* What the last tap turned out to be. First in the sheet because it is
          the thing the geologist just asked about. */}
      {w.picked ? (
        <SheetSection title={t("field.identify.title")}>
          <IdentifyBlock
            picked={w.picked}
            from={s.position ? { lat: s.position.lat, lng: s.position.lng } : null}
            fixAccuracyM={s.position?.accuracyM ?? null}
            // Elevation AT THE FEATURE, from the same DEM every other reading
            // uses. Null when no cell is close enough to describe it.
            elevationAtFeature={(p) => (w.ready ? elevationAt(w.data, p)?.elevationM ?? null : null)}
            provenance={s.packProvenance}
            onNavigate={(lat, lng) => { actions.navigateTo(lat, lng); w.setPicked(null); }}
            onCentre={(lat, lng) => w.mapRef.current?.centreOn(lat, lng)}
            onWaypoint={() => setWaypointFormOpen(true)}
            onCapture={() => goToCapture()}
            onClose={() => w.setPicked(null)}
            t={t}
          />
        </SheetSection>
      ) : null}

      {/* RECORDING AN OBSERVATION MUST NOT REQUIRE HAVING ARRIVED.
          The two ways in were the arrival panel and a tap on the map, so evidence
          could only be entered for ground the geologist had reached or could see
          on screen. A colleague sends a coordinate seven hundred kilometres away
          with photographs of a quartz vein and there was no button at all — the
          form existed and nothing could open it.
          Hidden while the arrival panel is up, which already offers this. */}
      {!arrived && s.state !== "idle" && s.state !== "ended" ? (
        <Pressable
          style={styles.addAnywhere}
          onPress={() => setWaypointFormOpen(true)}
          accessibilityRole="button"
        >
          <Ionicons name="location-outline" size={16} color={colors.gold} />
          <Text style={styles.addAnywhereText}>{t("field.sheet.addWaypoint")}</Text>
        </Pressable>
      ) : null}

      <SheetSection title={t("field.advice.title")}>
        <AdviceBlock advice={advice} t={t} />
      </SheetSection>

      <GpsBlock
        fix={w.fix}
        position={s.position}
        needsCalibration={s.headingNeedsCalibration}
        headingDeg={s.headingDeg}
        headingAccuracy={s.headingAccuracy}
        speedMps={w.track.averageSpeedMps}
        t={t}
      />

      <SheetSection title={t("field.sheet.interpretation")}>
        <Text style={styles.body}>{interpretation(s, orientation, t)}</Text>
      </SheetSection>

      {/* THE BASIS OF THE NUMBER, next to the number. Measured: with occurrence
          evidence removed the engine scores AUC 0.53 — a coin toss — because
          nine points in ten have no evidence at all. That was invisible. It is
          not any more: what contributed, what is held back and why, what was
          never loaded, and what has no source. */}
      {/* WHICH COMMODITY, before the basis of the number — because the choice
          changes what counts as evidence, and reading the basis without knowing
          the question it answers is reading half a sentence. The list comes from
          the pack's own profiles, so it can never offer one the engine cannot
          model. */}
      <SheetSection title={t("field.commodity.title")}>
        <CommodityChooser
          pack={packs.getData()}
          selected={s.commodity}
          onSelect={actions.setCommodity}
          t={t}
        />
      </SheetSection>

      {s.coverage ? (
        <SheetSection title={t("field.coverage.title")}>
          <EvidenceBasis coverage={s.coverage} t={t} />
        </SheetSection>
      ) : null}

      <SheetSection title={t("field.sheet.nearbyEvidence")}>
        <EvidenceLines orientation={orientation} unit={unitOf(s.context)} t={t} />
      </SheetSection>

      {s.mission && s.mission.state !== "none" ? (
        <SheetSection title={t("field.mission.title")}>
          <MissionBlock
            mission={s.mission}
            distanceM={s.distanceToTargetM}
            observations={s.evidenceCount}
            onBegin={actions.beginInvestigation}
            onFinish={() => void actions.finishSection()}
            onClose={actions.closeMission}
            t={t}
          />
        </SheetSection>
      ) : null}

      {/* WHAT IS ALREADY RECORDED HERE.
          Placed before the assessment because a geologist who has just walked back
          into ground they worked before needs to know that before anything else —
          and because the panel this replaces used to say "No sample recorded" over
          ground that had one. */}
      <SheetSection title={t("field.nearby.title")}>
        <NearbyEvidence
          near={nearbyEvidence}
          radiusM={NEARBY_RADIUS_M}
          locale={i18n.language}
          t={t}
        />
      </SheetSection>

      {/* THE ASSESSMENT. Shown from the moment a section is finished — the states
          before a report exists are real positions in the workflow, and a
          geologist who has just finished on a mountain needs to be told their
          evidence is safe rather than shown an empty panel. */}
      {s.mission && (isDelivering(s.mission.state) || s.mission.state === "mission_closed") ? (
        <SheetSection title={t("report.title")}>
          <AIGeologistReport
            mission={s.mission}
            findings={
              s.mission.packageId
                ? packages?.get(s.mission.packageId)?.analysis ?? null
                : null
            }
            prospectivityScore={
              s.activeTarget?.reportScore ?? s.activeTarget?.score ??
              s.mission.reportScore ?? s.mission.score
            }
            photosPending={photoUploads?.pendingFor(s.mission.id).length ?? 0}
            analysisError={packages?.get(s.mission.id)?.analysisError ?? null}
            appLanguage={(i18n.language === "so" ? "so" : "en")}
            t={t}
          />
        </SheetSection>
      ) : null}

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

          {/* WHAT THIS TARGET WAS RANKED UNDER.
              Read from the TARGET, never from the current selection. A target
              issued under UNIVERSAL and then held while the user picks GOLD is
              still a universal target, and a screen that read the selection would
              present it as a gold-specific recommendation — a claim the app would
              be making on the engine's behalf. The third case says so outright. */}
          {s.activeTarget ? (
            <Text
              style={
                s.activeTarget.scoredForCommodity !== (s.commodity ?? null)
                  ? styles.scoredStale
                  : styles.faint
              }
            >
              {s.activeTarget.scoredForCommodity !== (s.commodity ?? null)
                ? t("field.target.scoredStale", {
                    commodity: s.commodity
                      ? t(`commodity.${s.commodity}`, { defaultValue: s.commodity })
                      : t("field.commodity.universal"),
                  })
                : s.activeTarget.scoredForCommodity
                  ? t("field.target.scoredFor", {
                      commodity: t(`commodity.${s.activeTarget.scoredForCommodity}`, {
                        defaultValue: s.activeTarget.scoredForCommodity,
                      }),
                    })
                  : t("field.target.scoredUniversal")}
            </Text>
          ) : null}

          {/* THE DESTINATION IS HELD, and the reader is told so.
              A geologist was switched off their target mid-drive, twice, and had no
              way to know whether the app had decided something or gone wrong. The
              app no longer does that — and saying so out loud is what turns a
              silent guarantee into a usable one. */}
          {s.targetCommitment === "committed" ? (
            <Text style={styles.held}>{t("field.target.held")}</Text>
          ) : null}

          {/* CANCEL A HAND-PICKED TARGET. The geologist chose a far target — a
              known occurrence, a fault, a place they are sure of — and the app
              held it. This lets them undo that choice and get the nearest
              suggestion back. Hidden once an investigation is under way, so an
              active section is never discarded by a stray tap. */}
          {s.targetCommitment === "committed" && s.mission?.state !== "field_investigation" ? (
            <Pressable
              onPress={() => actions.cancelChosenTarget()}
              accessibilityRole="button"
              style={styles.cancelRow}
              hitSlop={6}
            >
              <Ionicons name="close-circle-outline" size={16} color={colors.textFaint} />
              <Text style={styles.cancelText}>{t("field.target.cancelChosen")}</Text>
            </Pressable>
          ) : null}

          {/* Better ground, reported and never acted on. Tapping is the only way
              the destination moves. */}
          {s.betterTargetAvailable ? (
            <Pressable
              onPress={() => actions.selectTarget(s.betterTargetAvailable!.cell)}
              accessibilityRole="button"
              style={styles.betterRow}
            >
              <Text style={styles.better}>
                {t("field.target.betterAvailable", {
                  distance: formatDistance(t, s.betterTargetAvailable.distanceM),
                  compass: s.betterTargetAvailable.compass,
                })}
              </Text>
              <Text style={styles.betterAction}>{t("field.target.switchToIt")}</Text>
            </Pressable>
          ) : null}
          <View style={styles.actionRow}>
            <SheetAction
              icon={<Ionicons name="scan" size={20} color={colors.text} />}
              label={t("field.map.frame")}
              onPress={() => w.mapRef.current?.frameTarget()}
            />
            <SheetAction
              icon={<Ionicons name="bookmark" size={20} color={colors.text} />}
              label={t("field.target.save")}
              onPress={() => void actions.captureObservation({ type: "other" })}
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
              <Pressable
                key={type}
                style={styles.chip}
                onPress={() => void actions.captureObservation({ type })}
              >
                <Text style={styles.chipText}>{t(waypointTypeLabelKey(type))}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            style={styles.evidenceFormRow}
            onPress={() => setEvidenceFormOpen(true)}
            accessibilityRole="button"
          >
            <Ionicons name="document-text" size={18} color={colors.gold} />
            <Text style={styles.evidenceFormRowText}>
              {t("field.evidenceForm.openButton")}
            </Text>
            {structuredEvidence && !isEmptyStructuredEvidence(structuredEvidence) ? (
              <Text style={styles.evidenceFormRowCount}>
                {structuredEvidence.assays.length + structuredEvidence.geophysics.length +
                  structuredEvidence.mapping.length + structuredEvidence.remoteSensing.length +
                  structuredEvidence.fieldObservations.length}
              </Text>
            ) : null}
          </Pressable>
        </SheetSection>
      ) : null}

      <View style={styles.actionRow}>
        <SheetAction
          icon={<Ionicons name="camera" size={20} color={colors.text} />}
          label={t("field.sheet.captureEvidence")}
          onPress={() => goToCapture()}
        />
        {/* NO "Add waypoint" HERE.
            Removed on field report: this row sits in the middle of a sheet the
            geologist scrolls with a thumb, and a large icon target in that path
            gets pressed by accident — which writes a waypoint at whatever position
            the phone happened to have. Recording evidence should be a deliberate
            act, so it is reached from the arrival panel and from a tapped point on
            the map, both of which the user opened on purpose. */}
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
                <Text style={styles.faint}>{describeClass(t, classifyDistance(x.distanceM, roadFactor().current()))}</Text>
              </Pressable>
            ))}
        </SheetSection>
      ) : null}

      {/* The answer to "nothing to walk to". Everything the pack holds, at any
          distance, classified rather than filtered. */}
      <SheetSection title={t("field.regional.title")}>
        <RegionalBlock
          leads={w.readout.regional}
          computing={w.readout.computing}
          selectedId={s.selectedRegional?.id ?? null}
          onNavigate={actions.navigateToRegional}
          onMakeTarget={(r) => void actions.selectTargetAt(r.lat, r.lng)}
          onStop={actions.clearDestination}
          t={t}
        />
      </SheetSection>

      <SheetSection title={t("field.track.title")}>
        <TraverseBlock
          track={w.track}
          evidenceCount={s.evidenceCount}
          waypointCount={waypoints.length}
          targetsInvestigated={s.targetsInvestigated}
          t={t}
        />
      </SheetSection>

      {/* What the walk still owes the server. Shown because "nothing collected
          in the field is ever discarded" is a promise the geologist should be
          able to check, not one they have to trust. */}
      <SheetSection title={t("field.sync.title")}>
        <SheetRow
          label={t("field.sync.held")}
          value={w.sync.pending === 0 ? t("field.sync.done") : String(w.sync.pending)}
          muted={w.sync.pending === 0}
        />
        {w.sync.failing > 0 ? (
          <Text style={styles.gpsWarn}>{t("field.sync.failing", { count: w.sync.failing })}</Text>
        ) : null}
        <Text style={styles.faint}>{t("field.sync.note")}</Text>
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
          onMakeTarget={(lat, lng) => void actions.selectTargetAt(lat, lng)}
          t={t}
        />
      </SheetSection>

      <PackFooter
        provenance={s.packProvenance}
        problem={s.packProblem}
        online={w.isOnline}
        walkedM={w.track.distanceM}
        t={t}
      />
      {/* One capture path. The form collects, the orchestrator derives missionId
          and hands the photos to the SAME PhotoUploadQueue Finish Section uses. */}
      <AddWaypointForm
        visible={waypointFormOpen}
        existingWaypoints={waypointRecords}
        now={() => Date.now()}
        onCancel={() => setWaypointFormOpen(false)}
        onPickPhotos={pickWaypointPhotos}
        onSave={(r) => {
          setWaypointFormOpen(false);
          void actions.captureObservation({
            type: r.type,
            notes: r.notes,
            sample: r.sample,
            photoUris: r.photoUris,
            // A coordinate somebody sent REPLACES the receiver's, and says so.
            // Without the origin the package would read as an eyewitness account
            // of ground this phone has never been near.
            ...(r.reportedAt
              ? {
                  origin: "reported" as const,
                  position: positionReported(r.reportedAt.lat, r.reportedAt.lng, Date.now()),
                }
              : {}),
          });
        }}
        t={t}
      />
      {/* Same "hand in, don't reach for" rule as the waypoint form — this writes
          to the StructuredEvidenceStore, and Finish Section reads it back from
          there when it assembles the package. */}
      <StructuredEvidenceForm
        visible={evidenceFormOpen}
        commodity={s.commodity}
        now={() => Date.now()}
        onCancel={() => setEvidenceFormOpen(false)}
        onSave={(r) => {
          setEvidenceFormOpen(false);
          void actions.addStructuredEvidence(r);
        }}
        t={t}
      />
    </ExplorationSheet>
  );
}

/** "in 4 m 10 s", or "now" once the backoff has expired. */
function untilLabel(at: number | null): string {
  if (at == null) return "now";
  const ms = at - Date.now();
  if (ms <= 0) return "now";
  const s = Math.round(ms / 1000);
  return s < 60 ? `in ${s} s` : `in ${Math.floor(s / 60)} m ${s % 60} s`;
}

/** One phrase for the receiver's state, for the diagnostics panel. */
function fixLabel(fix: FixQuality): string {
  const acc = fix.accuracyM == null ? "no accuracy" : formatAccuracyM(fix.accuracyM);
  const age = fix.ageMs == null ? "" : ` · ${Math.round(fix.ageMs / 1000)} s old`;
  return `${fix.grade} · ${acc}${age}`;
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

  const cls = journey ? classifyDistance(journey.distanceM, roadFactor().current()) : null;

  // Null on foot, and null with no journey — so the cell falls back to the
  // straight line and its label changes with it.
  const roadKm = cls && !suppressed && journey
    ? formatRoadKm(t, cls.travelDistanceM, cls.roadFactorApplied)
    : null;

  return (
    <View>
      <SheetStats
        items={[
          {
            // The cell shows ONE number and its label says which one, because the
            // full labelled figure rendered "94 km t…" in a quarter-screen column.
            // Driving, that number is the road distance — it sits beside the
            // travel time, and those two must agree. The straight line is on the
            // pill above the map and in the sentence below.
            value: suppressed || !journey
              ? "—"
              : roadKm ?? formatDistance(t, journey.distanceM),
            label: roadKm ? t("field.sheet.distanceRoad") : t("field.sheet.distance"),
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
/**
 * The mission, from arriving to closing.
 *
 * ARRIVING IS NOT FINISHING, and this block exists to say so. A target is an H3
 * resolution-7 cell — about five square kilometres — so "you have arrived" at its
 * edge means the geologist has reached the ground, not that the work is done. The
 * copy says which, every time, and the only button on offer is the next real step.
 */
function MissionBlock({
  mission, distanceM, observations, onBegin, onFinish, onClose, t,
}: {
  mission: NonNullable<ExplorationSnapshot["mission"]>;
  distanceM: number | null;
  observations: number;
  onBegin: () => void;
  onFinish: () => void;
  onClose: () => void;
  t: TFunc;
}) {
  const st = mission.state;
  return (
    <View style={styles.mission}>
      {st === "arrived_at_target_area" ? (
        <>
          <Text style={styles.missionHead}>{t("field.mission.arrivedTitle")}</Text>
          <Text style={styles.missionBody}>
            {t("field.mission.arrivedBody", { area: "5 km²" })}
          </Text>
          {/* The hotspot, or an honest statement that there is not one. Most areas
              score evenly and inventing a point in the middle would be a
              recommendation with nothing behind it. */}
          <Text style={mission.hotspot ? styles.missionHotspot : styles.missionBody}>
            {mission.hotspot
              ? t("field.mission.hotspot", {
                  distance: formatDistance(t, distanceM ?? 0),
                  compass: "—",
                })
              : t("field.mission.noHotspot")}
          </Text>
          <Pressable onPress={onBegin} style={styles.missionPrimary} accessibilityRole="button">
            <Text style={styles.missionPrimaryText}>{t("field.mission.begin")}</Text>
          </Pressable>
        </>
      ) : null}

      {st === "field_investigation" ? (
        <>
          <Text style={styles.missionHead}>{t("field.mission.investigating", { count: observations })}</Text>
          <Pressable onPress={onFinish} style={styles.missionPrimary} accessibilityRole="button">
            <Text style={styles.missionPrimaryText}>{t("field.mission.finish")}</Text>
          </Pressable>
        </>
      ) : null}

      {st === "section_completed" || st === "waiting_for_upload" ? (
        <>
          <Text style={styles.missionHead}>{t("field.mission.completed")}</Text>
          <Text style={styles.missionBody}>
            {t("field.mission.waitingUpload", { observations, photos: 0 })}
          </Text>
          <Pressable onPress={onClose} style={styles.missionSecondary} accessibilityRole="button">
            <Text style={styles.missionSecondaryText}>{t("field.mission.close")}</Text>
          </Pressable>
        </>
      ) : null}

      {st === "ai_analysis_complete" ? (
        <Text style={styles.missionHead}>{t("field.mission.analysed")}</Text>
      ) : null}

      {st === "mission_closed" ? (
        <Text style={styles.missionBody}>{t("field.mission.closed")}</Text>
      ) : null}

      {/* Why no other target is being offered. Without this the hold reads as the
          app having stopped thinking. */}
      {st !== "mission_closed" ? (
        <Text style={styles.missionLocked}>{t("field.mission.locked")}</Text>
      ) : null}
    </View>
  );
}

function GpsBlock({
  fix, position, needsCalibration, headingDeg, headingAccuracy, speedMps, t,
}: {
  fix: FixQuality;
  position: Snap["position"];
  needsCalibration: boolean;
  headingDeg: number | null;
  /** The platform's own calibration level for the compass. Higher is better. */
  headingAccuracy: number | null;
  /** Pace over MOVING time, from the track recorder. Null before there is any. */
  speedMps: number | null;
  t: TFunc;
}) {
  const gradeLabel = t("field.gps.grade" + fix.grade[0].toUpperCase() + fix.grade.slice(1));
  // The number the receiver reported, at the precision it reported it. See
  // formatAccuracy: ±1.5 m and ±2 m are different statements.
  const accuracy = formatAccuracy(t, fix.accuracyM);

  const warning =
    fix.grade === "none" ? t("field.gps.warnNone")
    : fix.grade === "stale" ? t("field.gps.warnStale", { s: Math.round((fix.ageMs ?? 0) / 1000) })
    : fix.grade === "poor" ? t("field.gps.warnPoor", { m: Math.round(fix.accuracyM ?? 0) })
    : null;

  const heading =
    headingDeg == null
      ? t("field.gps.headingNone")
      : t("field.target.bearing", { deg: Math.round(headingDeg) }) +
        (needsCalibration ? ` · ${t("field.gps.headingCalibrating")}` : "");

  const movement =
    speedMps == null ? t("field.gps.movementUnknown")
    : speedMps < 0.2 ? t("field.gps.stationary")
    : t("field.gps.moving", { speed: formatSpeed(t, speedMps) });

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
      <SheetRow label={t("field.gps.headingLabel")} value={heading} muted={headingDeg == null} />
      <SheetRow label={t("field.gps.movement")} value={movement} muted={speedMps == null} />
      {position?.altitudeM != null ? (
        <SheetRow label={t("field.identify.elevation")} value={t("field.gps.altitude", { m: Math.round(position.altitudeM) })} />
      ) : null}
      {/* The platform's own calibration level, unmodified. A "confident" heading
          from an uncalibrated magnetometer is the one reading a geologist must
          not be given without the caveat attached. */}
      {headingAccuracy != null ? (
        <Text style={styles.faint}>
          {t("field.gps.headingLabel")}: {headingAccuracy}
        </Text>
      ) : null}
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
  const cls = classifyDistance(distanceM, roadFactor().current());
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
/**
 * "~172 km waddo · ", or nothing when no road multiplier was applied.
 *
 * The separator lives inside so a walk renders with no stray dot.
 */
function roadOf(t: TFunc, c: DistanceClass): string {
  const road = formatRoadDistance(t, c.travelDistanceM, c.roadFactorApplied);
  return road ? `${road}  ·  ` : "";
}

function RegionalBlock({
  leads, computing, selectedId, onNavigate, onMakeTarget, onStop, t,
}: {
  leads: RegionalTarget[];
  computing: boolean;
  selectedId: string | null;
  onNavigate: (r: RegionalTarget) => void;
  /**
   * Promote a lead to a real, committed TARGET.
   *
   * `onNavigate` sets a destination — plain navigation, no assessment. A lead the
   * geologist actually wants to work is a target, and until now there was no way to
   * make one out of anything beyond the ranked ring.
   */
  onMakeTarget: (r: RegionalTarget) => void;
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
                {/* The road figure the duration was computed from. This line is
                    assembled here rather than from a template, which is how it
                    slipped past the locale-level check: "177 km · Safar · 8 saac
                    50 daq" quoted a straight line beside a road time. */}
                {roadOf(t, r.distanceClass)}
                {formatTravel(t, r.distanceClass.travelMinutes)}
                {"  ·  "}
                {t("field.regional.priority", { value: Math.round(r.priority * 100) })}
              </Text>
              {/* A lead a geologist wants to WORK is a target, not just a
                  destination. Separate from the row tap, which is navigation, so
                  neither steals the other. */}
              <Pressable
                onPress={() => onMakeTarget(r)}
                accessibilityRole="button"
                hitSlop={8}
                style={styles.leadMakeTarget}
              >
                <Text style={styles.leadMakeTargetText}>{t("field.target.makeTarget")}</Text>
              </Pressable>
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
  inspecting, onLookup, onClear, onNavigate, onMakeTarget, t,
}: {
  inspecting: { lat: number; lng: number } | null;
  onLookup: (lat: number, lng: number) => void;
  onClear: () => void;
  onNavigate: (lat: number, lng: number) => void;
  /** Make this place a real, committed target — any distance. */
  onMakeTarget: (lat: number, lng: number) => void;
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
      {/* THE FREE CHOICE. Any distance, no ring, no score gate.
          Reported from the field: the engine offered a target 1.5 km off and there
          was no way to go anywhere else, because only cells inside kRing(3) could
          be chosen at all. Refusing to route somewhere a geologist has decided to
          go is not the app's decision to make. */}
      <Pressable
        style={[styles.btn, valid ? styles.btnPrimary : styles.btnDisabled]}
        disabled={!valid} onPress={() => onMakeTarget(latN, lngN)}
      >
        <Text style={valid ? styles.btnPrimaryText : styles.btnGhostText}>
          {t("field.target.makeTarget")}
        </Text>
      </Pressable>
      <Text style={styles.faint}>{t("field.target.makeTargetHint")}</Text>
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

/**
 * What the geologist just tapped, answered in full.
 *
 * Everything opens from the map: this is a section of the same sheet, not
 * another screen, so the ground under discussion stays visible while it is being
 * read. Every row is a pack field — where the pack has no value the row says
 * "not recorded" rather than vanishing, because "this unit has no recorded age"
 * and "we did not look" are different things to tell someone.
 */
function IdentifyBlock({
  picked, from, fixAccuracyM, elevationAtFeature, provenance,
  onNavigate, onCentre, onWaypoint, onCapture, onClose, t,
}: {
  picked: Identification;
  from: { lat: number; lng: number } | null;
  /** The accuracy of the viewer's own fix — it bounds the distance below. */
  fixAccuracyM: number | null;
  elevationAtFeature: (p: { lat: number; lng: number }) => number | null;
  provenance: { packVersion: string; ageDays: number; stale: boolean } | null;
  onNavigate: (lat: number, lng: number) => void;
  onCentre: (lat: number, lng: number) => void;
  onWaypoint: () => void;
  onCapture: () => void;
  onClose: () => void;
  t: TFunc;
}) {
  const none = t("field.identify.notRecorded");
  // Where "go here" means: a record's own coordinates when the tap hit one,
  // otherwise the point that was tapped.
  const goTo = React.useMemo(() => {
    const f = picked.features.find(
      (x): x is Extract<IdentifiedFeature, { lat: number; lng: number }> =>
        x.kind === "occurrence" || x.kind === "line",
    );
    return f ? { lat: f.lat, lng: f.lng } : picked.at;
  }, [picked]);

  const journey = journeyTo(from, goTo);

  if (picked.features.length === 0) {
    return (
      <View>
        <Text style={styles.body}>{t("field.identify.nothingHere")}</Text>
        <View style={styles.actionRow}>
          <SheetAction
            icon={<Ionicons name="navigate" size={20} color={colors.text} />}
            label={t("field.identify.navigate")}
            onPress={() => onNavigate(picked.at.lat, picked.at.lng)}
          />
          <SheetAction
            icon={<Ionicons name="close-circle" size={20} color={colors.text} />}
            label={t("field.identify.close")}
            onPress={onClose}
          />
        </View>
      </View>
    );
  }

  return (
    <View>
      {picked.features.map((f) => (
        <View key={featureKey(f)} style={styles.identifyCard}>
          {f.kind === "occurrence" ? (
            <>
              <Text style={styles.identifyTitle}>
                {f.name ?? t("field.identify.occurrence")}
              </Text>
              <Text style={styles.identifyKind}>{t("field.identify.occurrence")}</Text>
              <SheetRow label={t("field.identify.commodity")} value={f.commodity ?? none} muted={!f.commodity} />
              <SheetRow label={t("field.identify.depositType")} value={f.depositType ?? none} muted={!f.depositType} />
              <SheetRow
                label={t("field.identify.hostRocks")}
                value={f.hostRocks && f.hostRocks.length ? f.hostRocks.join(", ") : none}
                muted={!f.hostRocks?.length}
              />
              <SheetRow label={t("field.identify.source")} value={f.source} />
              {f.reference ? <SheetRow label={t("field.identify.reference")} value={f.reference} /> : null}
              {/* A mapped record is not an assessment of the ground. MRDS says
                  something is there; it does not say how likely it is to be worth
                  anything, and borrowing a number here would be inventing one. */}
              <SheetRow label={t("field.sheet.confidence")} value={t("field.identify.confidenceNotAssessed")} muted />
              <Text style={styles.faint}>
                {t("field.identify.offset", { distance: formatDistance(t, f.offsetM) })}
              </Text>
              <Text style={styles.reason}>{t("field.identify.recommendedOccurrence")}</Text>
            </>
          ) : null}

          {f.kind === "unit" ? (
            <>
              <Text style={styles.identifyTitle}>{f.name}</Text>
              <Text style={styles.identifyKind}>{t("field.identify.unit")}</Text>
              <SheetRow label={t("field.identify.type")} value={f.unitKind} />
              <SheetRow
                label={t("field.identify.age")}
                value={ageText(f.interval, f.ageTopMa, f.ageBottomMa, t) ?? none}
                muted={!f.interval && f.ageTopMa == null}
              />
              <SheetRow label={t("field.identify.lithology")} value={f.lithology ?? none} muted={!f.lithology} />
              {f.description ? <SheetRow label={t("field.identify.description")} value={f.description} /> : null}
              <SheetRow label={t("field.identify.source")} value={f.source ?? none} muted={!f.source} />
              {f.associated.length > 0 ? (
                <>
                  <SheetRow
                    label={t("field.identify.associated")}
                    value={f.associated.map((a) => a.commodity).join(", ")}
                  />
                  <Text style={styles.faint}>{t("field.identify.associatedNote")}</Text>
                </>
              ) : null}
              <Text style={styles.reason}>{t("field.identify.recommendedUnit")}</Text>
            </>
          ) : null}

          {f.kind === "line" ? (
            <>
              <Text style={styles.identifyTitle}>{f.name ?? t(lineKindKey(f.lineKind))}</Text>
              <Text style={styles.identifyKind}>{t(lineKindKey(f.lineKind))}</Text>
              <SheetRow label={t("field.identify.source")} value={f.source ?? none} muted={!f.source} />
              <Text style={styles.faint}>
                {t("field.identify.offset", { distance: formatDistance(t, f.offsetM) })}
              </Text>
              <Text style={styles.reason}>
                {f.lineKind === "drainage"
                  ? t("field.identify.recommendedDrainage")
                  : f.lineKind === "contact"
                    ? t("field.identify.recommendedContact")
                    : t("field.identify.recommendedFault")}
              </Text>
            </>
          ) : null}

          {f.kind === "terrain" ? (
            <>
              <Text style={styles.identifyTitle}>{t("field.identify.terrain")}</Text>
              <SheetRow label={t("field.identify.elevation")} value={t("field.gps.altitude", { m: Math.round(f.elevationM) })} />
              <SheetRow label={t("field.identify.slope")} value={t("field.identify.slopeValue", { deg: Math.round(f.slopeDeg) })} />
              <SheetRow
                label={t("field.identify.aspect")}
                value={f.aspectDeg == null ? none : t(compassKey(compassPointOf(f.aspectDeg)))}
                muted={f.aspectDeg == null}
              />
              <SheetRow label={t("field.identify.morphology")} value={t("field.morphology." + f.morphology)} />
              <SheetRow
                label={t("field.identify.drainage")}
                value={f.drainageDistM == null ? none : formatDistance(t, f.drainageDistM)}
                muted={f.drainageDistM == null}
              />
              {/* The DEM cell is a SAMPLE. How far away it is decides how much
                  it says about the ground actually under the finger. */}
              <Text style={styles.faint}>
                {t("field.identify.offset", { distance: formatDistance(t, f.fromM) })}
              </Text>
            </>
          ) : null}
        </View>
      ))}

      {/* WHERE IT IS, in numbers. These are the FEATURE's coordinates — the
          record's own, or the point that was tapped for a polygon — never the
          viewer's. Six decimal places is about a tenth of a metre, which is
          finer than anything in the pack and lets a coordinate be read out over
          a radio without ambiguity. */}
      <View style={styles.identifyCard}>
        <SheetRow label={t("field.identify.latitude")} value={goTo.lat.toFixed(6)} />
        <SheetRow label={t("field.identify.longitude")} value={goTo.lng.toFixed(6)} />
        <SheetRow
          label={t("field.identify.elevation")}
          value={
            elevationAtFeature(goTo) == null
              ? none
              : t("field.gps.altitude", { m: Math.round(elevationAtFeature(goTo)!) })
          }
          muted={elevationAtFeature(goTo) == null}
        />
        {/* Distance and bearing only from a real position — Invariant 4 — and
            the fix's own accuracy beside them, because it is what bounds them. */}
        <SheetRow
          label={t("field.identify.distance")}
          value={journey ? formatDistance(t, journey.distanceM) : t("field.destination.waitingFix")}
          muted={!journey}
        />
        <SheetRow
          label={t("field.identify.bearing")}
          value={
            journey
              ? `${t(compassKey(compassPointOf(journey.bearingDeg)))} ${Math.round(journey.bearingDeg)}°`
              : none
          }
          muted={!journey}
        />
        <SheetRow
          label={t("field.identify.fixAccuracy")}
          value={formatAccuracy(t, fixAccuracyM)}
          muted={fixAccuracyM == null}
        />
        {/* Pack rows carry no per-feature timestamp, so the honest answer to
            "last updated" is the currency of the dataset it came from. */}
        <SheetRow
          label={t("field.identify.lastUpdated")}
          value={
            provenance
              ? t("field.identify.packCurrency", { version: provenance.packVersion, days: provenance.ageDays })
              : none
          }
          muted={!provenance}
        />
      </View>

      {journey ? (
        <Text style={styles.journeyHead}>
          {formatDistance(t, journey.distanceM)}
          {"  "}
          {t(compassKey(compassPointOf(journey.bearingDeg)))}
          {"  "}
          <Text style={styles.faint}>{Math.round(journey.bearingDeg)}°</Text>
        </Text>
      ) : null}
      {journey ? (
        <Text style={styles.reason}>{describeClass(t, classifyDistance(journey.distanceM, roadFactor().current()))}</Text>
      ) : null}

      <View style={styles.actionRow}>
        <SheetAction
          icon={<Ionicons name="navigate" size={20} color={colors.gold} />}
          label={t("field.identify.navigate")}
          tone="gold"
          onPress={() => onNavigate(goTo.lat, goTo.lng)}
        />
        <SheetAction
          icon={<Ionicons name="locate" size={20} color={colors.text} />}
          label={t("field.identify.centre")}
          onPress={() => onCentre(goTo.lat, goTo.lng)}
        />
        <SheetAction
          icon={<Ionicons name="location" size={20} color={colors.text} />}
          label={t("field.identify.waypoint")}
          onPress={onWaypoint}
        />
        <SheetAction
          icon={<Ionicons name="camera" size={20} color={colors.text} />}
          label={t("field.identify.capture")}
          onPress={onCapture}
        />
      </View>
      <Pressable style={styles.wideBtn} onPress={onClose}>
        <Ionicons name="close" size={18} color={colors.text} />
        <Text style={styles.wideBtnText}>{t("field.identify.close")}</Text>
      </Pressable>
    </View>
  );
}

/** The rolling advice list — what is worth doing in the next few hundred metres. */
function AdviceBlock({ advice, t }: { advice: Advice[]; t: TFunc }) {
  if (advice.length === 0) return <Text style={styles.body}>{t("field.advice.none")}</Text>;
  return (
    <View>
      {advice.map((a) => (
        <View key={a.id} style={styles.adviceRow}>
          <Ionicons name={adviceIcon(a.kind)} size={16} color={colors.gold} style={styles.adviceIcon} />
          <View style={styles.adviceText}>
            <Text style={styles.reason}>{renderAdvice(a, t)}</Text>
            {/* Invariant 2: every line names the pack row it came from. */}
            <Text style={styles.faint}>{t(a.basis.key, a.basis.params)}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function renderAdvice(a: Advice, t: TFunc): string {
  const p = a.params;
  const params: Record<string, unknown> = { ...p };
  if (typeof p.distanceM === "number") params.distance = formatDistance(t, p.distanceM);
  if (typeof p.compass === "string") params.compass = t(compassKey(p.compass));
  if (typeof p.slopeDeg === "number") params.slope = p.slopeDeg;
  params.radius = formatDistance(t, EVIDENCE_NEARBY_M);
  return t("field.advice." + a.kind, params);
}

function adviceIcon(kind: Advice["kind"]): keyof typeof Ionicons.glyphMap {
  switch (kind) {
    case "continue_to_target": return "navigate";
    case "inspect_fault": return "git-branch";
    case "inspect_contact": return "git-compare";
    case "drainage_trap": return "water";
    case "steep_outcrop": return "trending-up";
    case "ridge_outcrop": return "triangle";
    case "valley_float": return "trending-down";
    case "host_association": return "layers";
    case "occurrence_ahead": return "ellipse";
    case "capture_evidence": return "camera";
  }
}

const featureKey = (f: IdentifiedFeature): string =>
  f.kind === "terrain" ? "terrain" : f.kind + ":" + f.id;

const lineKindKey = (kind: string): string =>
  kind === "fault" ? "field.identify.fault"
  : kind === "contact" ? "field.identify.contact"
  : kind === "drainage" ? "field.identify.drainageLine"
  : kind === "lineament" ? "field.identify.lineament"
  : "field.identify.line";

/** Macrostrat's interval and its Ma range, whichever of them the pack carries. */
function ageText(
  interval: string | null, top: number | null, bottom: number | null, t: TFunc,
): string | null {
  const range = top != null && bottom != null ? t("field.identify.ageRange", { top, bottom }) : null;
  if (interval && range) return `${interval} · ${range}`;
  return interval ?? range;
}


// The map and its chrome are styled in components/MapWorkspace.tsx — this sheet
// is a surface over them and owns nothing positioned against the screen edges.
const styles = StyleSheet.create({
  addAnywhere: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: spacing.xs, marginBottom: spacing.sm, paddingVertical: spacing.md,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.gold,
  },
  addAnywhereText: { color: colors.gold, fontWeight: "700", fontSize: 14 },
  detached: {
    flexDirection: "row", alignItems: "flex-start", gap: spacing.sm,
    borderWidth: 1, borderColor: "rgba(240,180,41,0.55)",
    backgroundColor: "rgba(240,180,41,0.12)",
    borderRadius: radius.lg, padding: spacing.md,
    marginHorizontal: spacing.lg, marginBottom: spacing.sm,
  },
  detachedText: { fontSize: 13, lineHeight: 18, color: "#F0B429", flex: 1, fontWeight: "600" },
  screen: { flex: 1, backgroundColor: colors.bg },

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

  identifyCard: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.sm, backgroundColor: colors.bg,
  },
  identifyTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  identifyKind: { color: colors.gold, fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginBottom: spacing.xs },

  adviceRow: { flexDirection: "row", gap: spacing.sm, paddingVertical: spacing.xs },
  adviceIcon: { marginTop: 3 },
  adviceText: { flex: 1 },

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
  held: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  leadMakeTarget: {
    alignSelf: "flex-start", marginTop: 4,
    paddingHorizontal: spacing.sm, paddingVertical: 3,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.gold,
  },
  leadMakeTargetText: {
    color: colors.gold, fontSize: 10, fontWeight: "800", letterSpacing: 0.4,
  },
  scoredStale: {
    color: colors.gold, fontSize: 12, lineHeight: 18, marginTop: 4, fontWeight: "600",
  },
  mission: {
    borderWidth: 1, borderColor: colors.gold, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.md, gap: spacing.xs,
    backgroundColor: "rgba(212,175,55,0.07)",
  },
  missionHead: { color: colors.text, fontSize: 14, fontWeight: "700", lineHeight: 20 },
  missionBody: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  missionHotspot: { color: colors.gold, fontSize: 13, fontWeight: "600", lineHeight: 19 },
  missionPrimary: {
    marginTop: spacing.xs, paddingVertical: spacing.sm, borderRadius: radius.md,
    backgroundColor: colors.gold, alignItems: "center",
  },
  missionPrimaryText: { color: "#1A1A1A", fontSize: 13, fontWeight: "800", letterSpacing: 0.5 },
  missionSecondary: {
    marginTop: spacing.xs, paddingVertical: spacing.sm, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, alignItems: "center",
  },
  missionSecondaryText: { color: colors.text, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  missionLocked: { color: colors.textFaint, fontSize: 10, lineHeight: 15, marginTop: 2 },
  betterRow: {
    marginTop: spacing.xs, paddingVertical: spacing.xs, paddingHorizontal: spacing.sm,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.gold,
    backgroundColor: "rgba(212,175,55,0.10)", gap: 2,
  },
  better: { color: colors.text, fontSize: 12, lineHeight: 18 },
  betterAction: { color: colors.gold, fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  cancelRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  cancelText: { color: colors.textFaint, fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  reason: { color: colors.text, fontSize: 14, lineHeight: 21 },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, backgroundColor: colors.bg,
  },
  chipText: { color: colors.text, fontSize: 13 },

  evidenceFormRow: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md,
    borderWidth: 1, borderColor: colors.goldBorder, borderRadius: radius.lg,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, backgroundColor: colors.goldSoft,
  },
  evidenceFormRowText: { color: colors.gold, fontWeight: "700", fontSize: 13.5, flex: 1 },
  evidenceFormRowCount: {
    color: colors.gold, fontWeight: "800", fontSize: 13, minWidth: 20, textAlign: "center",
  },

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

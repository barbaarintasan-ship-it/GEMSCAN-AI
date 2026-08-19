// The map workspace — everything the map is, held above the screens.
//
// ARCHITECTURE V2, PRINCIPLE 0.2: the map is the operating system. No
// navigation may unmount the map, the exploration session, or the GPS watch.
//
// That principle has a concrete consequence, and this module is it. Until now
// the scene, the camera, the layer set, the tile fetcher and the tapped feature
// all lived inside the exploration SCREEN, so every one of them was born and
// died with a route. A site view, an area editor or a discovery sheet would each
// have had to rebuild the map to show itself — which is the definition of
// screens the user feels themselves navigating between.
//
// Everything here therefore lives in the LAYOUT that hosts the map, above the
// router's children. Surfaces come and go; this does not.
//
// It holds no geology of its own. Every number still comes from the pack, the
// orchestrator or the engines — this decides what the map is looking at, never
// what is true.
import React from "react";
import { InteractionManager, useWindowDimensions } from "react-native";
import { useExploration } from "./provider";
import { useWalkingTrack, type WalkingTrack } from "./useWalkingTrack";
import { useAwakeWhileExploring } from "./useAwakeWhileExploring";
import { useExpeditionSync, type ExpeditionSyncState } from "./useExpeditionSync";
import { useSampleSync, type SampleSyncState } from "../samples/store";
import { buildScene, sceneCovers, type MapScene } from "../geo/mapScene";
import { markPhase } from "../diagnostics/jsStall";
import { fittingRadiusM } from "../geo/orientation";
import { gradeFix, type FixQuality } from "../geo/fixQuality";
import { loadLayers, saveLayers } from "../geo/layerPrefs";
import { useGeoReadout, type GeoReadout } from "../geo/useGeoReadout";
import { identifyAt, type Identification } from "../geo/featureInfo";
import { useMapTiles } from "../geo/useMapTiles";
import { DEFAULT_TARGETING } from "../geo/targeting.ts";
import { useIsOnline } from "../network";
import {
  DEFAULT_LAYERS, tileSourcesFor,
  type MapCamera, type MapHandle, type MapLayers, type MapLive, type MapPick,
} from "../../components/ExplorationMap";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";

/** Half-width of the first view. 2 km is a walkable neighbourhood. */
export const INITIAL_RADIUS_M = 2_000;

/**
 * The most ground one scene will ever hold.
 *
 * `buildScene` prepares SCENE_MARGIN times this in each direction, so 500 km
 * here is a 4,000 km box — larger than the pack's whole extent. Past that point
 * a bigger number selects nothing more and only costs time.
 */
export const MAX_SCENE_RADIUS_M = 500_000;

/**
 * The shortest time between two scene rebuilds.
 *
 * A rebuild scans the pack and pushes several hundred kilobytes to the map. It
 * is the right thing to do when the geologist has genuinely gone somewhere; it
 * is never the right thing to do twice in one second, however hard the camera is
 * moving.
 */
export const SCENE_REBUILD_MIN_MS = 1_200;

/** How still the camera must be before the screen re-renders around it. */
const CAMERA_SETTLE_MS = 180;
/** ...and how long that may be put off during a pan that never stops. */
const CAMERA_MAX_STALE_MS = 700;

/**
 * How often the GPS readout re-renders while nothing else changes.
 *
 * A fix does not get less accurate when you look at it — it gets less accurate
 * as it AGES, and "updated 40 s ago" is only true if something redraws it. Five
 * seconds is fine enough to notice a receiver going quiet and coarse enough not
 * to be a per-second re-render of the whole workspace.
 */
const FIX_TICK_MS = 5_000;

const M_PER_DEG = 111_195;
type Box = [number, number, number, number];

/** Is `inner` comfortably inside `outer`? A margin of the box's own size. */
export function bboxWithin(inner: readonly number[], outer: readonly number[]): boolean {
  const padLng = (outer[2] - outer[0]) * 0.08;
  const padLat = (outer[3] - outer[1]) * 0.08;
  return (
    inner[0] >= outer[0] + padLng && inner[2] <= outer[2] - padLng &&
    inner[1] >= outer[1] + padLat && inner[3] <= outer[3] - padLat
  );
}

/** The smallest box holding both. */
export function union(a: readonly number[], b: readonly number[]): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** A square box of `radiusM` about a point. */
export function boxAround(p: { lat: number; lng: number }, radiusM: number): Box {
  const dLat = radiusM / M_PER_DEG;
  const dLng = dLat / Math.max(0.1, Math.cos((p.lat * Math.PI) / 180));
  return [p.lng - dLng, p.lat - dLat, p.lng + dLng, p.lat + dLat];
}

/** Half the diagonal of a geographic box, in metres. */
export function bboxRadiusM(b: readonly number[]): number {
  const lat = (b[1] + b[3]) / 2;
  const dy = (b[3] - b[1]) * M_PER_DEG;
  const dx = (b[2] - b[0]) * M_PER_DEG * Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  return Math.hypot(dx, dy) / 2;
}

export interface MapWorkspace {
  /** The installed pack and whether it is usable. Layer 1, read-only. */
  data: PackData;
  ready: boolean;
  /** The point every readout is about: a looked-up place, else the real fix. */
  at: { lat: number; lng: number } | null;
  /** Movement-gated scan of the pack — orientation plus regional leads. */
  readout: GeoReadout;

  scene: MapScene | null;
  layers: MapLayers;
  setLayers: React.Dispatch<React.SetStateAction<MapLayers>>;
  layersOpen: boolean;
  setLayersOpen: React.Dispatch<React.SetStateAction<boolean>>;
  camera: MapCamera | null;
  onCamera: (c: MapCamera) => void;
  live: MapLive;
  /** True while imagery is being fetched, for the status line. */
  downloading: boolean;
  hasTiles: boolean;

  /** The live map. Held here so any surface can drive it without owning it. */
  // React 19's `useRef<T>(null)` is typed `RefObject<T | null>`, so the context
  // field must admit null too. Every consumer already reads it as `mapRef.current?.…`.
  mapRef: React.RefObject<MapHandle | null>;
  onPick: (p: MapPick) => void;

  /** What the last tap turned out to be — shown by whichever surface is open. */
  picked: Identification | null;
  setPicked: React.Dispatch<React.SetStateAction<Identification | null>>;
  /** The sheet's detent. Shared, because a tap on the map opens it. */
  expanded: boolean;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;

  track: WalkingTrack;
  fix: FixQuality;
  running: boolean;
  isOnline: boolean;
  /** Screen height, so surfaces can size themselves against the map. */
  screenHeight: number;
  /** What the walk still owes the server. Architecture v2 §0.2, Slice 2. */
  sync: ExpeditionSyncState;
  /**
   * Samples this device is holding, and whether they are being filed.
   *
   * Mounted HERE as well as on the collection screen because a traverse is
   * exactly when samples are taken and exactly when a signal is intermittent:
   * the walk should file them as it goes, without the geologist opening a list.
   */
  samples: SampleSyncState;
  /**
   * Identity of THIS mount of the workspace.
   *
   * Minted once per provider. If it changes while a session is running, the map
   * host was torn down and rebuilt — which principle 0.2 forbids — and the
   * diagnostics panel will show it changing. Cheap, and the only direct evidence
   * of a regression that is otherwise invisible.
   */
  workspaceId: string;
}

const Ctx = React.createContext<MapWorkspace | null>(null);

export function MapWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const {
    snapshot: s, packs, waypoints, waypointRecords, photoUploads, packages, actions,
  } = useExploration();
  const isOnline = useIsOnline();
  const { height: screenHeight } = useWindowDimensions();

  const running = s.state !== "idle" && s.state !== "ended";
  // The screen stays on while a walk is running. Without it Android suspends the
  // process, the GPS callbacks stop, arrival is never checked, and the app looks
  // frozen on resume — one cause behind all three field reports.
  useAwakeWhileExploring(running);
  const mapRef = React.useRef<MapHandle>(null);

  // One id per mount of this provider — see the note on workspaceId.
  const workspaceIdRef = React.useRef<string | null>(null);
  workspaceIdRef.current ??= "ws-" + Date.now().toString(36) + "-" +
    Math.floor(Math.random() * 1e4).toString(36);

  const [layers, setLayers] = React.useState<MapLayers>(DEFAULT_LAYERS);
  const [layersOpen, setLayersOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [camera, setCamera] = React.useState<MapCamera | null>(null);
  const [picked, setPicked] = React.useState<Identification | null>(null);

  /**
   * The camera, settled before it becomes React state.
   *
   * The map reports its camera on every frame it draws, and a state update per
   * frame re-renders every surface — sheet, readouts and all — sixty times a
   * second while a finger is dragging. That is what made the controls feel
   * unresponsive: they were fine, the thread they answer on was not.
   *
   * So the update lands when the camera goes STILL, with a ceiling on how long
   * it may be deferred, so the scale bar keeps moving during a long pan without
   * costing a render per frame.
   */
  const cameraRef = React.useRef<MapCamera | null>(null);
  const cameraTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraPushedAt = React.useRef(0);
  // Perf-guard telemetry, [jsStall]-style so it greps alongside it — sourced
  // from the map surface's own frame timing, since this app's memory
  // footprint is not observable from inside the WebView that draws it.
  // Logged on a pressure-level change (the guard reacting) or a genuinely
  // slow frame, never every message — report() already fires up to ten times
  // a second while panning.
  const lastPressureLevel = React.useRef(0);
  const lastPerfLogAt = React.useRef(0);
  const onCamera = React.useCallback((c: MapCamera) => {
    if (c.pressureLevel !== lastPressureLevel.current) {
      lastPressureLevel.current = c.pressureLevel;
      console.warn(
        `[mapPerf] pressureLevel -> ${c.pressureLevel} (drawMs=${c.drawMs} imgMax=${c.imgMax}` +
        ` demStride=${c.demStride} imagesHeld=${c.imagesHeld})`,
      );
    } else if (c.drawMs > 250 && Date.now() - lastPerfLogAt.current > 1000) {
      lastPerfLogAt.current = Date.now();
      console.warn(
        `[mapPerf] slow frame drawMs=${c.drawMs} imgMax=${c.imgMax}` +
        ` demStride=${c.demStride} pressureLevel=${c.pressureLevel} imagesHeld=${c.imagesHeld}`,
      );
    }
    cameraRef.current = c;
    if (cameraTimer.current) clearTimeout(cameraTimer.current);
    const push = () => {
      cameraTimer.current = null;
      cameraPushedAt.current = Date.now();
      setCamera(cameraRef.current);
    };
    if (Date.now() - cameraPushedAt.current > CAMERA_MAX_STALE_MS) { push(); return; }
    cameraTimer.current = setTimeout(push, CAMERA_SETTLE_MS);
  }, []);
  React.useEffect(() => () => {
    if (cameraTimer.current) clearTimeout(cameraTimer.current);
  }, []);

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

  const at = s.inspecting ?? (s.position ? { lat: s.position.lat, lng: s.position.lng } : null);
  const data = packs.getData();
  const ready = packs.isReady();

  // Orientation and the regional leads come from one movement-gated scan, off
  // the gesture path — see lib/geo/useGeoReadout. Leads start where the local
  // targeting engine stops, so the same feature is never offered twice.
  const readout = useGeoReadout(data, ready, at, DEFAULT_TARGETING.maxDistanceM);
  const orientation = readout.orientation;

  /**
   * The ground the map has prepared, which follows the VIEW as well as the
   * viewer.
   *
   * Three things can make the scene insufficient, and all three rebuild it:
   * walking out of it, looking beyond its edge, and learning (once the pack scan
   * finishes) that the nearest real feature is further away than it covers.
   */
  const [scene, setScene] = React.useState<MapScene | null>(null);
  const builtRadius = React.useRef(0);
  const building = React.useRef(false);
  const builtAt = React.useRef(0);
  React.useEffect(() => {
    if (!at || !ready || building.current) return;

    const view = camera?.bbox ?? null;
    const needed = orientation ? fittingRadiusM(orientation, INITIAL_RADIUS_M) : INITIAL_RADIUS_M;

    // Both at once: what is being LOOKED at and where the geologist is STANDING.
    // Choosing one or the other looks equivalent and is not — with the viewer
    // 300 km outside the view, "recentre on the walker" and "recentre on the
    // view" each invalidate the other's box, and the workspace rebuilds the
    // scene for ever. The union can only grow, so it always settles.
    const want = union(view ?? boxAround(at, needed), boxAround(at, needed));
    const centre = { lat: (want[1] + want[3]) / 2, lng: (want[0] + want[2]) / 2 };
    const radius = Math.min(MAX_SCENE_RADIUS_M, Math.max(needed, bboxRadiusM(want)));

    // Zoomed far enough out, the view is wider than any scene can ever be — the
    // pack does not contain another continent. Asking "does the scene cover the
    // view?" there is a question with no yes, and it answered no on every camera
    // frame: a full pack scan and a several-hundred-kilobyte push to the map,
    // eight times a second. At the ceiling, the widest scene there is IS the
    // answer.
    const atCeiling = builtRadius.current >= MAX_SCENE_RADIUS_M - 1;
    const enough =
      scene != null &&
      builtRadius.current >= radius * 0.9 &&
      (atCeiling || (sceneCovers(scene, at) && bboxWithin(want, scene.bbox)));
    if (enough) return;

    // A floor on how often the pack may be re-selected, whatever the camera
    // does. Nothing the geologist can do with two fingers should be able to
    // schedule this faster than it finishes.
    if (Date.now() - builtAt.current < SCENE_REBUILD_MIN_MS) return;

    // Selecting over the whole pack is not free, and it must never land in the
    // middle of a pinch. The scene the geologist can already see stays up until
    // the wider one is ready.
    building.current = true;
    InteractionManager.runAfterInteractions(() => {
      // Scans the pack and pushes several hundred kilobytes to the map. Named so
      // a stall landing here is attributed rather than "unattributed".
      const built = markPhase("map.buildScene");
      const next = buildScene(data, centre, radius);
      built();
      builtRadius.current = radius;
      builtAt.current = Date.now();
      building.current = false;
      setScene(next);
    });
  }, [at?.lat, at?.lng, ready, data, scene, orientation, camera?.bbox]); // eslint-disable-line react-hooks/exhaustive-deps

  const track = useWalkingTrack(s.position, s.explorationSessionId);

  // The backdrop follows the CAMERA, not the session: tile detail tracks screen
  // detail, so zooming in to read a village name fetches a sharper tile instead
  // of enlarging a blurred one. Until the map has reported a viewport there is
  // nothing to fetch for, and the scene's own box is the honest first guess.
  const viewport = React.useMemo(
    () =>
      camera
        ? { bbox: camera.bbox, metresPerPx: camera.metresPerPx }
        : scene
          ? { bbox: scene.bbox, metresPerPx: INITIAL_RADIUS_M / 400 }
          : null,
    [camera, scene],
  );
  const { base: baseTiles, overlay: overlayTiles, downloading } = useMapTiles(
    viewport, tileSourcesFor(layers), isOnline,
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

  const selectedPoint = React.useMemo(() => (picked ? picked.at : null), [picked]);

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
    baseTiles,
    overlayTiles,
    selected: selectedPoint,
  }), [
    s.position, s.headingDeg, s.activeTarget, s.destination, track.points,
    waypoints, baseTiles, overlayTiles, selectedPoint,
  ]);

  /**
   * A tap on the map, answered from the pack.
   *
   * Runs off the gesture path, and only over the pack the map is already
   * drawing: no network, no new screen. The tolerance arrives in METRES from the
   * map, converted there from a fingertip at the zoom the tap was made at.
   */
  const onPick = React.useCallback((p: MapPick) => {
    if (!ready) return;
    InteractionManager.runAfterInteractions(() => {
      setPicked(identifyAt(data, { lat: p.lat, lng: p.lng }, { tapRadiusM: p.radiusM }));
      setExpanded(true);
    });
  }, [ready, data]);

  /**
   * The expedition, filed as it happens.
   *
   * A watcher over the session that already exists: it opens a record when the
   * session starts, queues each observation and the growing traverse, closes the
   * record when the walk ends, and drains the queue when there is a signal.
   * Nothing the geologist collects is discarded any more (Architecture v2 §0.2).
   */
  const samples = useSampleSync();

  const sync = useExpeditionSync({
    sessionId: s.explorationSessionId,
    waypoints: waypointRecords,
    trackPoints: track.points,
    trackStats: track.stats,
    isOnline,
    // The SAME queue a finished section fills. Two instances over one storage key
    // would be two state machines fighting over the same file.
    photoQueue: photoUploads,
    // The same store Finish Section writes to. The assessment is attached to the
    // package it belongs to, so there is one record of a mission, not two.
    packages,
    // Closes the loop on a photograph: the queue knows the key, the observation
    // is what needs to remember it.
    onPhotoUploaded: actions.notePhotoUploaded,
  });

  const value: MapWorkspace = {
    data, ready, at, readout,
    scene, layers, setLayers, layersOpen, setLayersOpen,
    camera, onCamera, live, downloading,
    hasTiles: baseTiles.length > 0 || overlayTiles.length > 0,
    mapRef, onPick,
    picked, setPicked, expanded, setExpanded,
    track, fix, running, isOnline, screenHeight, sync, samples,
    workspaceId: workspaceIdRef.current,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMapWorkspace(): MapWorkspace {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useMapWorkspace must be used within MapWorkspaceProvider");
  return v;
}

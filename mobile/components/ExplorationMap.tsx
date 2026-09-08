// The exploration map — full-screen, interactive, offline-first.
//
// WHY A WEBVIEW CANVAS AND NOT A MAP LIBRARY
// ------------------------------------------
// Every off-the-shelf map component in this ecosystem is a native module built
// around a tile server. This map's whole point is that it keeps working where
// there is no tile server and no network, drawing the geologist's own knowledge
// pack. A 2D canvas in the WebView already present in the app renders polygons,
// lines and points at gesture speed, with no new native dependency and nothing
// to fail when the signal drops.
//
// The page is self-contained: the scene is inlined into the HTML and the script
// is written here. It fetches nothing except map tiles, and those only when the
// app has already downloaded them and passes local file URIs.
//
// WHAT LIVES WHERE
// ----------------
// The HTML is rebuilt only when the SCENE changes — panning off the edge of the
// prepared area. Live state is pushed in through injectJavaScript instead,
// because rebuilding the document on every GPS fix would tear the map out from
// under a moving finger. Each kind of live state has its OWN entry point
// (position, track, pins, tiles) so a new fix injects forty bytes rather than
// re-serialising an hour-long track and sixty tile records with it.
//
// HOW IT STAYS AT SIXTY FRAMES
// ----------------------------
// Four things, and they are the difference between a map you can walk with and
// one you fight:
//
//   1. Geometry is projected to LOCAL METRES ONCE, at load, into typed arrays.
//      Per frame the only work is a rotate-scale-translate over numbers already
//      in the right units.
//   2. Every feature carries its own world-space bounding box and is REJECTED
//      before a single vertex is touched. Off-screen geology costs nothing.
//   3. Vertices are strided to the feature's size ON SCREEN. A unit 40 px wide
//      is drawn with 40 points, not the 400 it was thinned to.
//   4. The trigonometry for the camera rotation is computed once per FRAME, not
//      once per vertex, which is what it was.
import React from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import type { MapScene } from "../lib/geo/mapScene";
import type { CachedTile } from "../lib/geo/tileCache";

export interface MapLayers {
  /** Esri World Imagery, when it has been downloaded. */
  satellite: boolean;
  /** Esri World Hillshade — relief where the pack's DEM grid is too coarse. */
  hillshade: boolean;
  /** Roads and tracks, so a target has a way to reach it. */
  roads: boolean;
  /** Country, region, town and village names. */
  labels: boolean;
  /** Mapped coastline, so unmapped ground and open sea stop looking alike. */
  land: boolean;
  geology: boolean;
  /** Unit names written on the units themselves, at zooms that can hold them. */
  geologyLabels: boolean;
  /** The pack's DEM as shaded cells. Works with no signal at all. */
  terrain: boolean;
  /** Steepness from the same DEM cells. */
  slope: boolean;
  /** Downslope direction from the same DEM cells. */
  aspect: boolean;
  faults: boolean;
  /** Mapped unit boundaries — where one rock meets another. */
  contacts: boolean;
  /** Mapped watercourses. */
  drainage: boolean;
  lineaments: boolean;
  occurrences: boolean;
  waypoints: boolean;
  track: boolean;
  target: boolean;
  /** The ±accuracy disc around the viewer, drawn to scale. */
  accuracy: boolean;
  /** The heading cone — which way the phone is pointing. */
  compass: boolean;
  /** Distance rings around the viewer and a north-aligned metric graticule. */
  grid: boolean;
}

export const DEFAULT_LAYERS: MapLayers = {
  satellite: false,
  hillshade: false,
  roads: false,
  labels: false,
  land: true,
  geology: true,
  geologyLabels: true,
  terrain: false,
  slope: false,
  aspect: false,
  faults: true,
  contacts: true,
  drainage: true,
  lineaments: true,
  occurrences: true,
  waypoints: true,
  track: true,
  target: true,
  accuracy: true,
  compass: true,
  grid: true,
};

/** Which raster sources the current layer set actually needs downloaded. */
export function tileSourcesFor(l: MapLayers): { imagery: boolean; hillshade: boolean; roads: boolean; labels: boolean } {
  return { imagery: l.satellite, hillshade: l.hillshade, roads: l.roads, labels: l.labels };
}

export interface MapLive {
  position: { lat: number; lng: number; accuracyM: number | null } | null;
  /** Device heading, degrees from true north. Drives the direction cone only. */
  headingDeg: number | null;
  target: { lat: number; lng: number } | null;
  /** Breadcrumb of where the geologist has actually walked. */
  track: Array<[number, number]>;
  waypoints: Array<{ lng: number; lat: number; type: string }>;
  /** Painted under the geology. */
  baseTiles: CachedTile[];
  /** Painted over it — roads and place names exist to be read. */
  overlayTiles: CachedTile[];
  /** A tapped feature's location, so the map can mark what the sheet describes. */
  selected: { lat: number; lng: number } | null;
}

export const EMPTY_LIVE: MapLive = {
  position: null, headingDeg: null, target: null,
  track: [], waypoints: [], baseTiles: [], overlayTiles: [], selected: null,
};

export interface MapHandle {
  zoomBy(factor: number): void;
  /** Recentre on the viewer and reset rotation to north-up. */
  centre(): void;
  setRotation(deg: number): void;
  /** Zoom out until both the viewer and the current target are on screen. */
  frameTarget(): void;
  /** Centre on an arbitrary point without changing zoom — used by the sheet. */
  centreOn(lat: number, lng: number): void;
}

/** A camera to return to, when the map is being redrawn after a round trip. */
export interface CameraRestore {
  lat: number;
  lng: number;
  metresPerPx: number;
  rotationDeg: number;
}

/** Reported back so the native overlay can draw the compass and the scale bar. */
export interface MapCamera {
  rotationDeg: number;
  /** Metres per screen pixel — what the scale bar is derived from. */
  metresPerPx: number;
  ringStepM: number | null;
  /**
   * Strips the last frame used to reproject its widest tile, and how many tiles
   * it actually painted. Diagnostics: 1 strip at a walking zoom is correct, 1
   * strip at a regional zoom means the reprojection has stopped working and the
   * place names have drifted again.
   */
  tileStrips: number;
  /** Latitude span of the widest tile painted — what `tileStrips` was decided from. */
  tileSpanDeg: number;
  tilesPainted: number;
  /**
   * The adaptive rendering budgets, for diagnostics — see imgCapFor/demStride
   * in the page script. `pressureLevel` above 0 means the reactive guard has
   * already trimmed the image cache and widened the DEM stride on its own;
   * that is expected under a heavy layer set and not itself a bug report.
   */
  drawMs: number;
  imgMax: number;
  demStride: number;
  pressureLevel: number;
  /** Decoded tile images the page is holding right now — always sent, always typed. */
  imagesHeld: number;
  /** What the screen currently covers. Drives which tiles are worth fetching. */
  bbox: [number, number, number, number];
}

/** A tap on the map, in geographic terms, with the tolerance it was made at. */
export interface MapPick {
  lat: number;
  lng: number;
  /** Fingertip tolerance converted to ground metres at the current zoom. */
  radiusM: number;
}

// ── The page ────────────────────────────────────────────────────────────────

function page(scene: MapScene, layers: MapLayers): string {
  // JSON.stringify is safe to inline as long as nothing can close the script
  // tag early. The scene is numbers and pack-supplied names, but a name is
  // still data from a database, so the one sequence that matters is escaped.
  const json = JSON.stringify(scene).replace(/<\//g, "<\\/");
  const lay = JSON.stringify(layers);

  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html,body{margin:0;padding:0;height:100%;background:#0B0B0C;overflow:hidden;
    -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
  canvas{display:block;width:100%;height:100%;touch-action:none}
</style></head><body><canvas id="c"></canvas><script>
(function(){
"use strict";
var SCENE = ${json};
var LAYERS = ${lay};
var LIVE = {
  position:null, headingDeg:null, target:null, track:[], waypoints:[],
  baseTiles:[], overlayTiles:[], selected:null
};

var cv = document.getElementById("c");
var ctx = cv.getContext("2d", { alpha:false });
var DPR = Math.min(2, window.devicePixelRatio || 1);
var W = 0, H = 0;

function resize(){
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  ctx.setTransform(DPR,0,0,DPR,0,0);
  draw();
}
window.addEventListener("resize", resize);

// ── Projection ────────────────────────────────────────────────────────────
// Local equirectangular metres about the scene centre. Over a map you can walk
// across, the error is far below GPS accuracy, and it keeps north straight.
var M_LAT = 111195;
var C = SCENE.centre;
var KLNG = M_LAT * Math.cos(C.lat * Math.PI / 180);

function wx(lng){ return (lng - C.lng) * KLNG; }
function wy(lat){ return (lat - C.lat) * M_LAT; }
function lngOf(x){ return C.lng + x / KLNG; }
function latOf(y){ return C.lat + y / M_LAT; }

// Camera: centre in world metres, scale in px/m, and ONE rotation convention.
//
// THE CONVENTION, stated once because four places disagreed about it and the
// map rotated the wrong way for its trouble:
//
//   cam.rot is the compass BEARING THAT APPEARS UP THE SCREEN, in radians.
//     0        = north up
//     +π/2     = east up  (the map has been turned so east is at the top)
//
//   Drawing: the rotation matrix below turns the ground counter-clockwise by
//   cam.rot, which is the same statement seen from the other side — if east is
//   up, north has swung anticlockwise to the left edge.
//
//   A BEARING becomes a screen angle as (bearing - cam.rot - PI/2); screen
//   angles run clockwise from the +x axis, so straight up is -PI/2.
//   Every overlay that points somewhere — the heading cone, the aspect ticks —
//   uses exactly that expression. Two of them added cam.rot instead of
//   subtracting it, which is correct only when the map happens to be north-up.
//
//   A two-finger twist moves the GROUND with the fingers, as every map does:
//   fingers clockwise, ground clockwise, which means the bearing at the top of
//   the screen DECREASES. The gesture used to add it, so the map turned the
//   opposite way to the hand.
var cam = { x:0, y:0, scale:0.02, rot:0 };
var MIN_SCALE = 0.00002, MAX_SCALE = 4;

// Per-frame trigonometry. Computed ONCE in beginFrame and read by every
// projection below — it used to be two Math calls per vertex, which on a real
// Macrostrat scene is hundreds of thousands of them per frame.
var CS = 1, SN = 0, HW = 0, HH = 0;
// Split from beginFrame() so the static-layer buffer (see rebuildStaticBuffer)
// can retarget CS/SN/HW/HH at its own, larger W/H while it renders, then put
// them back for the real viewport — without bumping FRAME twice for what is
// still, from the tile cache's point of view, a single visible frame.
function computeTrig(){
  CS = Math.cos(cam.rot); SN = Math.sin(cam.rot);
  HW = W/2; HH = H/2;
}
function beginFrame(){
  FRAME++;
  computeTrig();
}
var P = [0,0];
function toScreen(x, y, out){
  var ex = x - cam.x, ey = y - cam.y;
  out[0] = HW + (ex * CS - ey * SN) * cam.scale;
  out[1] = HH - (ex * SN + ey * CS) * cam.scale;   // north stays up
  return out;
}
function sxy(lng, lat){ return toScreen(wx(lng), wy(lat), P); }
/** Screen point back to world metres — for taps. */
function toWorld(sx, sy, out){
  var rx = (sx - HW) / cam.scale, ry = (HH - sy) / cam.scale;
  out[0] = cam.x + rx * CS + ry * SN;
  out[1] = cam.y - rx * SN + ry * CS;
  return out;
}

// ── Prepared geometry ─────────────────────────────────────────────────────
// Every ring and path is converted to world metres ONCE, into a flat Float64
// array, with the bounding box that lets a frame skip it without looking at a
// single vertex.
function prepRing(ring){
  var n = ring.length;
  var a = new Float64Array(n*2);
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (var i=0;i<n;i++){
    var x = wx(ring[i][0]), y = wy(ring[i][1]);
    a[i*2] = x; a[i*2+1] = y;
    if (x<minx) minx=x; if (x>maxx) maxx=x;
    if (y<miny) miny=y; if (y>maxy) maxy=y;
  }
  return { a:a, n:n, box:[minx,miny,maxx,maxy] };
}
function grow(box, r){
  if (!box) return r.box.slice();
  if (r.box[0]<box[0]) box[0]=r.box[0];
  if (r.box[1]<box[1]) box[1]=r.box[1];
  if (r.box[2]>box[2]) box[2]=r.box[2];
  if (r.box[3]>box[3]) box[3]=r.box[3];
  return box;
}
function prepPolys(list){
  var out = [];
  for (var i=0;i<list.length;i++){
    var g = list[i], rings = [], box = null;
    for (var r=0;r<g.rings.length;r++){
      var pr = prepRing(g.rings[r]);
      if (pr.n < 3) continue;
      rings.push(pr); box = grow(box, pr);
    }
    if (!rings.length) continue;
    out.push({
      id:g.id, name:g.name, color:g.color, rings:rings, box:box,
      edge: darken(g.color, 0.45),
      lx: g.labelAt ? wx(g.labelAt.lng) : 0,
      ly: g.labelAt ? wy(g.labelAt.lat) : 0,
      hasLabel: !!g.labelAt, span: g.labelSpanM || 0
    });
  }
  return out;
}
function prepLines(list){
  var out = [];
  for (var i=0;i<list.length;i++){
    var f = list[i], paths = [], box = null;
    for (var p=0;p<f.paths.length;p++){
      var pr = prepRing(f.paths[p]);
      if (pr.n < 2) continue;
      paths.push(pr); box = grow(box, pr);
    }
    if (!paths.length) continue;
    out.push({ id:f.id, kind:f.kind, name:f.name, paths:paths, box:box });
  }
  return out;
}
function prepPoints(list){
  var out = [];
  for (var i=0;i<list.length;i++){
    var o = list[i];
    out.push({ id:o.id, label:o.label, commodity:o.commodity, x:wx(o.lng), y:wy(o.lat) });
  }
  return out;
}
function prepCells(list){
  var out = [];
  for (var i=0;i<list.length;i++){
    var t = list[i];
    out.push({
      x:wx(t.lng), y:wy(t.lat), shade:t.shade, slope:t.slopeDeg||0,
      aspect:(t.aspectDeg==null?null:t.aspectDeg), morph:t.morphology
    });
  }
  return out;
}

/** A darker edge for a fill colour, so boundaries read without a second hue. */
function darken(hex, k){
  if (typeof hex !== "string" || hex.charAt(0) !== "#" || hex.length < 7) return "rgba(0,0,0,0.55)";
  var r = parseInt(hex.substr(1,2),16), g = parseInt(hex.substr(3,2),16), b = parseInt(hex.substr(5,2),16);
  return "rgb(" + Math.round(r*k) + "," + Math.round(g*k) + "," + Math.round(b*k) + ")";
}

var GEO, LAND, FAULTS, CONTACTS, DRAIN, LINEA, OCC, CELLS;
function prepScene(){
  GEO = prepPolys(SCENE.polygons || []);
  LAND = prepPolys(SCENE.land || []);
  FAULTS = prepLines(SCENE.faults || []);
  CONTACTS = prepLines(SCENE.contacts || []);
  DRAIN = prepLines(SCENE.drainage || []);
  LINEA = prepLines(SCENE.lineaments || []);
  OCC = prepPoints(SCENE.occurrences || []);
  CELLS = prepCells(SCENE.terrain || []);
}
prepScene();
/** H3 res-7 cells are about this far apart; the DEM layers draw them to size. */
var CELL_M = 2400;

// ── Culling ───────────────────────────────────────────────────────────────
// The view, as a world-space box that already accounts for rotation: the
// circumscribed radius of the screen is rotation-invariant, so one comparison
// per feature is enough however the map is twisted.
var VIEW = [0,0,0,0];
function viewBox(){
  var r = Math.hypot(W,H) / 2 / cam.scale;
  VIEW[0] = cam.x - r; VIEW[1] = cam.y - r;
  VIEW[2] = cam.x + r; VIEW[3] = cam.y + r;
}
function visible(box){
  return !(box[2] < VIEW[0] || box[0] > VIEW[2] || box[3] < VIEW[1] || box[1] > VIEW[3]);
}

/**
 * How many vertices this feature deserves at this size on screen.
 *
 * A boundary 30 px wide cannot show 400 points and does not need to try. The
 * endpoints are always drawn, so a stride never opens a closed ring.
 */
function strideFor(ring, n){
  var wpx = (ring.box[2]-ring.box[0]) * cam.scale;
  var hpx = (ring.box[3]-ring.box[1]) * cam.scale;
  var budget = Math.max(12, Math.min(n, (wpx + hpx)));
  return Math.max(1, Math.floor(n / budget));
}

function tracePath(ring, close){
  var a = ring.a, n = ring.n, st = strideFor(ring, n);
  var ex, ey, sx, sy;
  var x0 = a[0] - cam.x, y0 = a[1] - cam.y;
  ctx.moveTo(HW + (x0*CS - y0*SN)*cam.scale, HH - (x0*SN + y0*CS)*cam.scale);
  for (var i=st;i<n;i+=st){
    ex = a[i*2] - cam.x; ey = a[i*2+1] - cam.y;
    sx = HW + (ex*CS - ey*SN)*cam.scale;
    sy = HH - (ex*SN + ey*CS)*cam.scale;
    ctx.lineTo(sx, sy);
  }
  // The last vertex always, or a strided ring closes on the wrong point.
  ex = a[(n-1)*2] - cam.x; ey = a[(n-1)*2+1] - cam.y;
  ctx.lineTo(HW + (ex*CS - ey*SN)*cam.scale, HH - (ex*SN + ey*CS)*cam.scale);
  if (close) ctx.closePath();
}

// ── Tiles ─────────────────────────────────────────────────────────────────
// A bounded image cache. Unbounded, a long traverse across four sources holds
// every tile it ever decoded in memory and the WebView is killed for it.
//
// THE FREEZE THIS FIXES. The cap was 160 while the screen can hold 240 — four
// sources at sixty tiles each. Over the cap, the LRU evicted tiles that were
// being drawn IN THAT FRAME. The next frame re-created them, re-decoded them,
// and every onload called draw() again, which evicted them again. A
// self-sustaining loop: N image decodes per frame, each scheduling another
// frame. It pinned the WebView's render threads, made tilesPainted change on
// every frame so report() posted ten messages a second for ever, and each of
// those re-rendered the whole React tree. Measured on the device: JS thread at
// 100%, 771 MB resident, and no button anywhere in the app would answer.
//
// It only bit when more tiles were on screen than the cache held — zoomed out,
// or with several layers on — which is why it was intermittent.
//
// Two rules now, and the first alone is not enough:
//   1. the cap is larger than any screenful can be, and
//   2. NOTHING drawn in the current frame is ever evicted.
var IMGS = {};
var IMG_ORDER = [];
var IMG_USED = {};
// MEASURED, then corrected. This was 512 as belt-and-braces alongside the
// frame-aware eviction below, and the belt cost 131 MB: each decoded 256x256 tile
// is about 256 KB, and panning filled the cache. On the device the app climbed
// from 431 MB to 536 MB while the map was dragged, and the phone began swapping —
// which is what the intermittent freeze actually was, the second time.
//
// The fix was never the cap. It is rule 2: nothing drawn in the current frame is
// evicted, so the cache cannot saw through its own working set at ANY cap. With
// that in place the real bound is the screenful — four sources at sixty tiles is
// 240 — and this only has to sit a little above it, so a pan can hold the
// outgoing and incoming screens for one frame.
//
// ADAPTIVE CEILING. 288 was still sized for the worst RASTER case alone. A
// THIRD freeze — 50+ SECOND stalls, not the ~300ms kind above — showed up
// with every layer on at once: four raster sources at their old 288 AND
// every geology, contact, fault, drainage and DEM layer drawing over them.
// The tiles in this cache cost nothing extra when vector and DEM layers are
// what changed — they are typed arrays and canvas fills, not decoded Images —
// but they compete for the same device memory and the same frame budget, and
// that combination is what the field report actually was. So the CUSHION
// above the screenful floor shrinks as more non-raster layers stack up; the
// floor — rule 1 above — never does. See imgCapFor().
var IMG_MAX = 288;
// Bumped once per painted frame, so "used this frame" is a number comparison.
var FRAME = 0;

/**
 * How many tile sources the current layer set can actually fill a screen
 * with. The one number imgCapFor() is never allowed to undercut.
 */
function activeTileSources(l){
  var n = 0;
  if (l.satellite) n++;
  if (l.hillshade) n++;
  if (l.roads) n++;
  if (l.labels) n++;
  return n;
}

/**
 * Relative drawing cost of one active layer, for the CUSHION only — never
 * the floor. Weighted by what actually competes for memory and frame time:
 * a filled polygon or a DEM cell over a whole scene costs more than a sparse
 * point layer or a session overlay (track, waypoints, target, accuracy,
 * compass, grid) that is never more than a handful of shapes.
 */
var LAYER_WEIGHT = {
  geology:2, geologyLabels:1, contacts:1, faults:1, drainage:1, lineaments:1,
  occurrences:0.5, terrain:2, slope:2, aspect:2, land:0.5,
};
function nonRasterHeaviness(l){
  var h = 0;
  for (var k in LAYER_WEIGHT) if (l[k]) h += LAYER_WEIGHT[k];
  return h;
}

/**
 * The image cache ceiling for the CURRENT layer set.
 *
 * Not a layer count limit — Field Reliability Contract: a geologist decides
 * which layers matter, this only decides how generously the cache may hold
 * on to tiles while they do. Two terms, added rather than multiplied so
 * neither can push the other below the floor: a screenful of the active
 * raster sources (rule 1, unconditional), plus a cushion that a heavier
 * vector/DEM set is allowed to spend less of.
 */
function imgCapFor(l){
  var floor = Math.max(60, activeTileSources(l) * 60);
  var cushion = Math.max(24, 108 - nonRasterHeaviness(l) * 6);
  return Math.min(288, floor + cushion);
}

/**
 * Reactive pressure guard — the one thing the static budgets above cannot
 * see: how the DEVICE is actually coping. There is no API inside a WebView
 * for this app's own memory footprint, so this reads the only two things
 * drawing itself produces: how long a frame took, and how many tiles are
 * decoded right now. pressureLevel widens the DEM stride (demStride, below)
 * and narrows the image cache (pressureImgMax) a step at a time under a
 * SUSTAINED run of slow frames — a single bad one (a GC pause, a tile
 * decode's onload) must not trip it.
 */
var frameMsHistory = [];
var pressureLevel = 0;
function notePressure(frameMs){
  frameMsHistory.push(frameMs);
  if (frameMsHistory.length > 20) frameMsHistory.shift();
  if (frameMsHistory.length < 6) return;
  var sum = 0;
  for (var i=0;i<frameMsHistory.length;i++) sum += frameMsHistory[i];
  var avg = sum / frameMsHistory.length;
  if (avg > 120 && pressureLevel < 3) pressureLevel++;
  else if (avg < 40 && pressureLevel > 0) pressureLevel--;
}
/** imgCapFor()'s cushion, trimmed further per pressure level — floor untouched. */
function pressureImgMax(baseCap, l){
  var floor = Math.max(60, activeTileSources(l) * 60);
  var cushion = Math.max(0, baseCap - floor);
  return floor + Math.round(cushion * (1 - pressureLevel * 0.25));
}

function tileImg(uri){
  IMG_USED[uri] = FRAME;
  var im = IMGS[uri];
  if (im !== undefined) return im;
  im = new Image();
  im.onload = function(){ draw(); };
  im.onerror = function(){ IMGS[uri] = null; };
  im.src = uri;
  IMGS[uri] = im;
  IMG_ORDER.push(uri);
  if (IMG_ORDER.length > IMG_MAX) evictUnusedImages();
  return im;
}

/**
 * Drop the oldest images that are NOT on screen this frame.
 *
 * If everything in the cache is in use the cache simply stays over its cap for
 * this frame. Holding a few extra tiles for one frame costs memory; evicting a
 * tile that is about to be drawn costs the loop described above.
 */
function evictUnusedImages(){
  var keep = [];
  var target = IMG_ORDER.length - IMG_MAX;
  for (var i=0;i<IMG_ORDER.length;i++){
    var u = IMG_ORDER[i];
    if (target > 0 && IMG_USED[u] !== FRAME){
      delete IMGS[u];
      delete IMG_USED[u];
      target--;
      continue;
    }
    keep.push(u);
  }
  IMG_ORDER = keep;
}

// ── Reprojecting a Web Mercator tile onto an equirectangular canvas ────────
//
// THE BUG THIS FIXES: place names landed in the wrong place. Bosaso showed
// inland when it is a coastal town, and the satellite coastline did not line up
// with the pack's own coastline — while the GPS dot was correct all along.
//
// The cause is that the two are in different projections. This canvas is local
// equirectangular (latitude is linear down the screen, which is what keeps north
// straight and distances honest over ground you can walk). A raster tile is Web
// MERCATOR: latitude is NOT linear across its rows. Drawing the tile as one
// straight stretch between its corner latitudes is therefore wrong everywhere
// except at its edges, and the error grows with how much latitude the tile
// spans — sub-pixel when zoomed in to walk, tens of kilometres at the 100 km
// view where the geologist was looking. Everything printed on the tile moved
// with it: labels, roads, coastlines.
//
// The fix is to stop pretending. Each tile is drawn as a stack of horizontal
// strips, each strip placed at the latitudes Mercator actually gives it. Nothing
// is approximated away; the residual is the strip height, which is why the count
// follows the span. Longitude needs no such treatment — Mercator x IS linear in
// longitude.
function mercY(lat){
  var r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1/Math.cos(r)) / Math.PI) / 2;
}
function latFromMercY(y){
  var n = Math.PI * (1 - 2*y);
  return 180/Math.PI * Math.atan(0.5*(Math.exp(n) - Math.exp(-n)));
}
/** Strips this tile needs. One when the tile is small enough not to bend. */
function stripsFor(t){
  var spanDeg = Math.abs(t.n - t.s);
  if (spanDeg < 0.12) return 1;              // ~z11 and closer: already flat
  return Math.min(24, Math.max(2, Math.ceil(spanDeg * 8)));
}

var tilesPainted = 0;
// The most strips any tile needed this frame. Reported to the app so the
// diagnostics panel can state the projection in force — if labels ever drift
// again, the first question is whether the reprojection is running at all.
var tileStrips = 0;
// The latitude span, in degrees, of the widest tile painted this frame — the
// input stripsFor() decided on.
//
// WHY BOTH NUMBERS ARE REPORTED. A strip count of 1 is the correct answer for
// any tile under 0.12 deg, which is z12 and closer, which is most fieldwork. So
// the panel read "1 strips" at every zoom a geologist ever looked at it, and
// that reading is indistinguishable from a reprojection that never ran at all —
// the exact question the row exists to answer. With the span beside it the
// number is a decision and can be checked: 0.04 deg -> 1 is right, 5 deg -> 1
// would be the bug.
var tileSpanDeg = 0;
function drawTiles(list, count){
  for (var i=0;i<list.length;i++){
    var t = list[i];
    // Cull first: a tile off screen still costs a transform and a blit.
    var bx = wx(t.w), by = wy(t.s), ex = wx(t.e), ey = wy(t.n);
    if (ex < VIEW[0] || bx > VIEW[2] || ey < VIEW[1] || by > VIEW[3]) continue;
    var img = tileImg(t.uri);
    if (!img || !img.complete || !img.naturalWidth) continue;
    if (count) tilesPainted++;

    // HILLSHADE IS NOT A PICTURE OF THE GROUND — it is a grey relief wash on a
    // white sheet, and painting it over imagery at full opacity hides the
    // imagery completely. That is what it did: satellite on, hillshade on, and
    // the map went white. Over imagery it is multiplied in, which is what a
    // shaded-relief overlay is for; with no imagery under it, it stands alone as
    // a terrain map and is drawn as it comes.
    var blend = t.source === "hillshade" && LAYERS.satellite;

    // Reprojected strip by strip — see the note above mercY. Tiles are
    // axis-aligned in geography, so under rotation each strip goes through the
    // same transform as everything else rather than being blitted.
    var strips = stripsFor(t);
    if (strips > tileStrips) tileStrips = strips;
    var spanDeg = Math.abs(t.n - t.s);
    if (spanDeg > tileSpanDeg) tileSpanDeg = spanDeg;
    var yTop = mercY(t.n), yBot = mercY(t.s);
    var sh = 256 / strips;

    for (var k=0;k<strips;k++){
      var lat0 = strips === 1 ? t.n : latFromMercY(yTop + (yBot - yTop) * (k / strips));
      var lat1 = strips === 1 ? t.s : latFromMercY(yTop + (yBot - yTop) * ((k+1) / strips));
      var a = sxy(t.w, lat0), ax=a[0], ay=a[1];
      var b = sxy(t.e, lat0), bxs=b[0], bys=b[1];
      var d = sxy(t.w, lat1), dxs=d[0], dys=d[1];
      ctx.save();
      if (blend){
        ctx.globalAlpha = 0.5;
        // Falls back to a plain 50% wash where the engine has no multiply, which
        // still leaves the imagery legible underneath.
        ctx.globalCompositeOperation = "multiply";
      }
      ctx.transform((bxs-ax)/256,(bys-ay)/256,(dxs-ax)/sh,(dys-ay)/sh,ax,ay);
      // Half a pixel of overlap kills the seam between strips and between tiles.
      ctx.drawImage(img, 0, k*sh, 256, sh, 0, 0, 256.5, sh + 0.5);
      ctx.restore();
    }
  }
}

// ── Layers ────────────────────────────────────────────────────────────────
function drawLand(){
  if (!LAYERS.land || !LAND.length) return;
  ctx.fillStyle = "#17181B";
  for (var i=0;i<LAND.length;i++){
    var g = LAND[i];
    if (!visible(g.box)) continue;
    ctx.beginPath();
    for (var r=0;r<g.rings.length;r++) tracePath(g.rings[r], true);
    ctx.fill("evenodd");
  }
}

function drawGeology(){
  if (!LAYERS.geology) return;
  // Translucent over imagery so the ground stays readable underneath — the
  // geologist needs both the rock unit and what it looks like. That only holds
  // where imagery actually landed; with the layer on and no tiles yet the old
  // rule faded the geology to 42% over bare black, which is the closest this map
  // ever came to showing a blank screen. Nothing to see through, full colour.
  var alpha = tilesPainted > 0 ? 0.45 : 0.88;
  ctx.lineJoin = "round";
  for (var i=0;i<GEO.length;i++){
    var g = GEO[i];
    if (!visible(g.box)) continue;
    // ONE path over every ring, filled even-odd. Filling ring by ring — which is
    // what this did — paints a unit's holes solid, so a lake or an inlier
    // vanished under the unit that surrounds it. That is the "oversized polygon"
    // and the "wrong topology" both at once.
    ctx.beginPath();
    for (var r=0;r<g.rings.length;r++) tracePath(g.rings[r], true);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g.color;
    ctx.fill("evenodd");
    // A darker edge of the unit's own colour: the boundary reads crisply without
    // introducing a second hue that means nothing on a geological map.
    ctx.globalAlpha = Math.min(1, alpha + 0.3);
    ctx.strokeStyle = g.edge;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Square of ground for a DEM cell — drawn at the size the cell describes. */
function cellPath(c, m){
  var h = m/2;
  var p = toScreen(c.x-h, c.y+h, P), ax=p[0], ay=p[1];
  p = toScreen(c.x+h, c.y+h, P); var bx=p[0], by=p[1];
  p = toScreen(c.x+h, c.y-h, P); var cx=p[0], cy=p[1];
  p = toScreen(c.x-h, c.y-h, P); var dx=p[0], dy=p[1];
  ctx.beginPath();
  ctx.moveTo(ax,ay); ctx.lineTo(bx,by); ctx.lineTo(cx,cy); ctx.lineTo(dx,dy);
  ctx.closePath();
}
function cellVisible(c, m){
  return !(c.x + m < VIEW[0] || c.x - m > VIEW[2] || c.y + m < VIEW[1] || c.y - m > VIEW[3]);
}
/**
 * Whether the DEM layers are worth drawing at this zoom.
 *
 * Below a couple of pixels a cell is not shading, it is noise — and there can be
 * a couple of thousand of them in a wide scene, which is four transforms and a
 * fill each, every frame, for a smear. The grid is a SAMPLING grid; drawing it
 * smaller than its samples claims a resolution it does not have.
 */
function cellsWorthDrawing(){ return CELL_M * cam.scale >= 2; }

/**
 * DEM draw budget, shared across terrain/slope/aspect — computed ONCE per
 * frame, not once per layer.
 *
 * The three layers read the SAME CELLS array; there is only ever one copy
 * of the grid in memory. But each drew every cell in it independently, so
 * switching on all three tripled the per-frame cost of one grid with nothing
 * more shown. This throttles DRAWING ONLY — identifyAt() and every other
 * measurement still reads the full grid regardless of what is on screen.
 *
 * Full resolution is kept at the zoom a geologist actually stands at:
 * cellsWorthDrawing() already refuses anything below ~2px of screen size,
 * and this adds nothing below ~6px, where a stride would visibly coarsen
 * ground someone is standing on. The stride bites zoomed OUT — where the
 * grid is denser than the screen can resolve anyway — and when more than one
 * DEM layer is stacking the same cost on top of it. pressureLevel (below)
 * can widen it further under sustained slow frames, on top of either reason.
 */
function demStride(){
  var active = (LAYERS.terrain?1:0) + (LAYERS.slope?1:0) + (LAYERS.aspect?1:0);
  var px = CELL_M * cam.scale;
  var extra = Math.max(0, active - 1) + pressureLevel;
  if (extra === 0 || px >= 6) return 1;           // walking zoom: full detail
  return px >= 3 ? 1 + extra : 1 + extra * 2;
}

function drawTerrain(){
  if (!LAYERS.terrain || !CELLS.length || !cellsWorthDrawing()) return;
  var stride = DEM_STRIDE;
  for (var i=0;i<CELLS.length;i+=stride){
    var t = CELLS[i];
    if (!cellVisible(t, CELL_M)) continue;
    ctx.globalAlpha = 0.10 + t.shade * 0.32;
    ctx.fillStyle = "#FFFFFF";
    cellPath(t, CELL_M); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Green through amber to red. Steepness is the one thing the ramp encodes. */
function slopeColor(deg){
  var k = Math.max(0, Math.min(1, deg/45));
  var r = Math.round(60 + k*195), g = Math.round(190 - k*140), b = Math.round(90 - k*60);
  return "rgb("+r+","+g+","+b+")";
}
function drawSlope(){
  if (!LAYERS.slope || !CELLS.length || !cellsWorthDrawing()) return;
  var stride = DEM_STRIDE;
  for (var i=0;i<CELLS.length;i+=stride){
    var t = CELLS[i];
    if (!cellVisible(t, CELL_M)) continue;
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = slopeColor(t.slope);
    cellPath(t, CELL_M); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawAspect(){
  if (!LAYERS.aspect || !CELLS.length || !cellsWorthDrawing()) return;
  ctx.lineCap = "round";
  var stride = DEM_STRIDE;
  for (var i=0;i<CELLS.length;i+=stride){
    var t = CELLS[i];
    if (t.aspect == null) continue;      // flat ground has no downslope direction
    if (!cellVisible(t, CELL_M)) continue;
    var p = toScreen(t.x, t.y, P), px = p[0], py = p[1];
    var len = Math.min(26, Math.max(8, CELL_M*cam.scale*0.4));
    // Downslope, drawn in the map's frame so a rotated map still reads true.
    var a = (t.aspect * Math.PI/180) - cam.rot - Math.PI/2;
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(px - Math.cos(a)*len/2, py - Math.sin(a)*len/2);
    ctx.lineTo(px + Math.cos(a)*len/2, py + Math.sin(a)*len/2);
    ctx.stroke();
  }
}

/**
 * Lines, cased.
 *
 * A dark casing under a bright stroke is how every printed geological map keeps
 * a fault legible over anything — dark rock, bright imagery, a shaded slope. The
 * previous fault colour was #101014 over a near-black background, which is to
 * say invisible.
 */
function drawLineSet(set, colour, width, dash, minPx){
  if (!set.length) return;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (var i=0;i<set.length;i++){
    var f = set[i];
    if (!visible(f.box)) continue;
    // Skip lines too small on screen to be anything but noise.
    if (minPx && Math.max(f.box[2]-f.box[0], f.box[3]-f.box[1]) * cam.scale < minPx) continue;
    ctx.beginPath();
    for (var p=0;p<f.paths.length;p++) tracePath(f.paths[p], false);
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = width + 2.2;
    ctx.stroke();
    if (dash) ctx.setLineDash(dash);
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawFaults(){ if (LAYERS.faults) drawLineSet(FAULTS, "#FF4438", 2.6, null, 3); }
function drawContacts(){ if (LAYERS.contacts) drawLineSet(CONTACTS, "#E8E4DA", 1.5, [7,5], 6); }
function drawDrainage(){ if (LAYERS.drainage) drawLineSet(DRAIN, "#4FA8E8", 2.0, null, 4); }
function drawLineaments(){ if (LAYERS.lineaments) drawLineSet(LINEA, "#C77DFF", 2.6, [7,4], 2); }

function label(text, x, y, size, colour){
  ctx.font = "600 " + size + "px -apple-system,Roboto,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(6,6,8,0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}

/**
 * Unit names, at zooms that can hold them.
 *
 * A name is written only when the unit is wide enough on screen to carry it and
 * only when no name has already been placed nearby, so labels never stack into
 * an unreadable smear. Density therefore follows zoom without a rule about zoom.
 */
function drawGeologyLabels(){
  if (!LAYERS.geology || !LAYERS.geologyLabels) return;
  var placed = [];
  var size = 12;
  for (var i=0;i<GEO.length;i++){
    var g = GEO[i];
    if (!g.hasLabel || !visible(g.box)) continue;
    if (g.span * cam.scale < 90) continue;    // too small to write across
    var p = toScreen(g.lx, g.ly, P), px = p[0], py = p[1];
    if (px < 40 || px > W-40 || py < 30 || py > H-30) continue;
    var clash = false;
    for (var k=0;k<placed.length;k++){
      if (Math.abs(placed[k][0]-px) < 110 && Math.abs(placed[k][1]-py) < 26) { clash = true; break; }
    }
    if (clash) continue;
    placed.push([px,py]);
    label(g.name, px, py, size, "rgba(255,255,255,0.94)");
    if (placed.length > 8) break;
  }
}

/** Commodity colours, for the few this pack actually carries. */
function occColour(c){
  if (!c) return "#E03A2F";
  var k = String(c).toLowerCase();
  if (k.indexOf("gold") >= 0) return "#F5C518";
  if (k.indexOf("iron") >= 0) return "#C05A2E";
  if (k.indexOf("copper") >= 0) return "#E07A3C";
  if (k.indexOf("urani") >= 0) return "#6ED47A";
  if (k.indexOf("gyp") >= 0 || k.indexOf("lime") >= 0) return "#D8D3C6";
  return "#E03A2F";
}

function drawOccurrences(){
  if (!LAYERS.occurrences) return;
  var labelled = 0;
  for (var i=0;i<OCC.length;i++){
    var o = OCC[i];
    if (o.x < VIEW[0] || o.x > VIEW[2] || o.y < VIEW[1] || o.y > VIEW[3]) continue;
    var p = toScreen(o.x, o.y, P), px = p[0], py = p[1];
    if (px<-20||px>W+20||py<-20||py>H+20) continue;
    var col = occColour(o.commodity);
    // A struck circle — the conventional mineral-occurrence symbol — rather than
    // a dot, so it is not mistaken for a waypoint or a GPS position.
    ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.lineWidth = 3.4;
    ctx.beginPath(); ctx.arc(px,py,7,0,6.2832); ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(px,py,7,0,6.2832); ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(px,py,2.6,0,6.2832); ctx.fill();
    if (cam.scale > 0.05 && labelled < 10 && o.label){
      labelled++;
      label(o.label, px, py + 17, 11, col);
    }
  }
}

function drawTrack(){
  if (!LAYERS.track || LIVE.track.length<2) return;
  ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 6;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  var st = Math.max(1, Math.floor(LIVE.track.length / 600));
  ctx.beginPath();
  for (var i=0;i<LIVE.track.length;i+=st){
    var p = sxy(LIVE.track[i][0], LIVE.track[i][1]);
    if (i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]);
  }
  var last = sxy(LIVE.track[LIVE.track.length-1][0], LIVE.track[LIVE.track.length-1][1]);
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
  ctx.strokeStyle = "#F5C518"; ctx.lineWidth = 3.2;
  ctx.stroke();
}

function drawWaypoints(){
  if (!LAYERS.waypoints) return;
  for (var i=0;i<LIVE.waypoints.length;i++){
    var w = LIVE.waypoints[i];
    var p = sxy(w.lng, w.lat);
    if (p[0]<-24||p[0]>W+24||p[1]<-24||p[1]>H+24) continue;
    // Teardrop pin, so a recorded observation never reads as an occurrence.
    ctx.fillStyle = "#3B82F6"; ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p[0], p[1]-10, 7, Math.PI, 0);
    ctx.lineTo(p[0], p[1]+2);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath(); ctx.arc(p[0], p[1]-10, 2.6, 0, 6.2832); ctx.fill();
  }
}

/** A ring around whatever the sheet is currently describing. */
function drawSelected(){
  if (!LIVE.selected) return;
  var p = sxy(LIVE.selected.lng, LIVE.selected.lat);
  ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(p[0],p[1], 14, 0, 6.2832); ctx.stroke();
  ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(p[0],p[1], 14, 0, 6.2832); ctx.stroke();
  ctx.beginPath(); ctx.arc(p[0],p[1], 22, 0, 6.2832);
  ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.lineWidth = 1.5; ctx.stroke();
}

function drawTarget(){
  if (!LAYERS.target || !LIVE.target) return;
  var p = sxy(LIVE.target.lng, LIVE.target.lat);
  var tx = p[0], ty = p[1];

  if (LIVE.position){
    var q = sxy(LIVE.position.lng, LIVE.position.lat);
    ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 5;
    ctx.setLineDash([10,7]);
    ctx.beginPath(); ctx.moveTo(q[0],q[1]); ctx.lineTo(tx,ty); ctx.stroke();
    ctx.strokeStyle = "#F5C518"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(q[0],q[1]); ctx.lineTo(tx,ty); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(tx,ty,16,0,6.2832); ctx.stroke();
  ctx.strokeStyle = "#F5C518"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(tx,ty,16,0,6.2832); ctx.stroke();
  ctx.beginPath(); ctx.arc(tx,ty,7,0,6.2832); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tx-24,ty); ctx.lineTo(tx-19,ty); ctx.moveTo(tx+19,ty); ctx.lineTo(tx+24,ty);
  ctx.moveTo(tx,ty-24); ctx.lineTo(tx,ty-19); ctx.moveTo(tx,ty+19); ctx.lineTo(tx,ty+24);
  ctx.stroke();
  ctx.fillStyle = "#F5C518";
  ctx.beginPath(); ctx.arc(tx,ty,3.5,0,6.2832); ctx.fill();
}

/**
 * The round distance to step the grid and the range rings by, for this zoom.
 * Snapped to 1/2/5 × a power of ten so every ring is a number a person can use.
 */
function gridStepM(){
  var target = 120 / cam.scale;             // ~120 px in metres
  var pow = Math.pow(10, Math.floor(Math.log(target)/Math.LN10));
  if (target/pow >= 5) return pow*5;
  if (target/pow >= 2) return pow*2;
  return pow;
}
var RING_STEP = null;

// The graticule depends only on the camera and the scene, so it belongs in the
// cached static layer. The range rings below it are centred on LIVE.position —
// they were split OUT of this function so the cached buffer can never freeze a
// stale ring around wherever the viewer stood when the buffer was last built
// (see drawRangeRings and the "static vs dynamic" note above rebuildStaticBuffer).
function drawGridLines(){
  var step = gridStepM();
  RING_STEP = step;
  if (!LAYERS.grid) return;

  // A north-aligned metric graticule, drawn in WORLD metres about the scene
  // centre so the lines stay true north even when the map has been twisted. It
  // is what lets someone read a distance off the map in a direction other than
  // the one they happen to be facing.
  ctx.strokeStyle = "rgba(255,255,255,0.09)"; ctx.lineWidth = 1;
  var half = Math.hypot(W, H) / 2 / cam.scale;
  var x0 = Math.floor((cam.x - half)/step)*step, x1 = cam.x + half;
  var y0 = Math.floor((cam.y - half)/step)*step, y1 = cam.y + half;
  // Bounded: at a silly zoom this could otherwise ask for thousands of lines.
  if ((x1-x0)/step <= 80 && (y1-y0)/step <= 80){
    var a = [0,0], b = [0,0];
    ctx.beginPath();
    for (var gx=x0; gx<=x1; gx+=step){
      toScreen(gx, y0, a); toScreen(gx, y1, b);
      ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]);
    }
    for (var gy=y0; gy<=y1; gy+=step){
      toScreen(x0, gy, a); toScreen(x1, gy, b);
      ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]);
    }
    ctx.stroke();
  }
}

/** Range rings around the viewer: how far away things are, at a glance. */
function drawRangeRings(){
  if (!LAYERS.grid) return;
  if (!LIVE.position) return;
  var step = RING_STEP || gridStepM();
  var p = sxy(LIVE.position.lng, LIVE.position.lat);
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  for (var i=1;i<=3;i++){
    var r = step*i*cam.scale;
    if (r < 22 || r > Math.max(W,H)) continue;
    ctx.beginPath(); ctx.arc(p[0],p[1],r,0,6.2832); ctx.stroke();
  }
}

function drawMe(){
  if (!LIVE.position) return;
  var p = sxy(LIVE.position.lng, LIVE.position.lat);
  var px = p[0], py = p[1];

  // Accuracy is drawn to SCALE. A confident-looking dot over a 100 m fix is a
  // lie the geologist would act on.
  if (LAYERS.accuracy && LIVE.position.accuracyM != null){
    var ar = LIVE.position.accuracyM * cam.scale;
    if (ar > 6){
      ctx.fillStyle = "rgba(59,130,246,0.18)";
      ctx.strokeStyle = "rgba(59,130,246,0.45)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(px,py,ar,0,6.2832); ctx.fill(); ctx.stroke();
    }
  }
  if (LAYERS.compass && LIVE.headingDeg != null){
    // The cone follows the map's rotation, so it points where the phone points.
    var a = (LIVE.headingDeg * Math.PI/180) - cam.rot - Math.PI/2;
    var spread = 0.42;
    var g = ctx.createRadialGradient(px,py,4,px,py,52);
    g.addColorStop(0,"rgba(59,130,246,0.55)");
    g.addColorStop(1,"rgba(59,130,246,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(px,py);
    ctx.arc(px,py,52,a-spread,a+spread); ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = "#2F6BD6";
  ctx.beginPath(); ctx.arc(px,py,12,0,6.2832); ctx.fill();
  ctx.fillStyle = "#3B82F6"; ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(px,py,8,0,6.2832); ctx.fill(); ctx.stroke();
}

var pending = false;
// Recomputed once per frame — see imgCapFor/pressureImgMax and demStride
// above. Cheap (a handful of boolean checks over the current layer set), and
// reading them mid-frame from drawTiles/drawTerrain/drawSlope/drawAspect
// would rebudget while the frame it is meant to bound is already drawing.
var DEM_STRIDE = 1;

// ── The static-layer cache ───────────────────────────────────────────────
//
// THE FREEZE THIS FIXES. Every GPS fix and every compass reading used to run
// the ENTIRE draw() below — geology, 136 faults, 5,960 lineaments, 1,538
// contacts, 16,870 drainage features, terrain, tiles — just to move the small
// "you are here" dot or rotate its direction cone. MEASURED on-device: the map
// sat at 1.5-3 fps completely idle, because GPS alone delivers a fix every
// second, UNCONDITIONALLY (WALKING_PROFILE.timeIntervalMs=1000, distance-gate
// off — see locationService.ts), whether or not the geologist actually moved.
//
// STATIC = drawLand, tiles, drawGeology, drawTerrain, drawSlope, drawDrainage,
// drawContacts, drawLineaments, drawFaults, drawAspect, drawGridLines,
// drawGeologyLabels — everything that depends only on the camera, the layer
// set and the scene/tile data, never on LIVE.position or LIVE.headingDeg.
// These are rendered once into an offscreen canvas (the "static buffer"),
// sized a bit larger than the viewport, and then BLITTED onto the screen with
// a plain translate for every frame that does not actually need them redrawn.
//
// DYNAMIC = drawRangeRings, drawTrack, drawTarget, drawOccurrences,
// drawWaypoints, drawSelected, drawMe — drawn fresh every frame, on top of the
// blitted buffer, at real (not buffer) W/H so their own culling stays correct.
// drawOccurrences is data-static (it never reads LIVE.position/headingDeg
// either) but stays OUT of the buffer on purpose: caching it would blit
// occurrence markers underneath the track/target instead of on top of them,
// the stacking order they have always drawn in. At ~159 viewport-culled
// points it is cheap enough to redraw live without reopening the freeze this
// buffer exists to fix.
//
// The buffer is invalidated — and rebuilt, at full cost, exactly like today —
// whenever anything that actually changes the static picture happens: a pan
// or pinch gesture, a fling, zoom, rotation, __centre/__frame/__restore/__fit,
// a layer toggle, new tiles, or a wider scene. Every one of those already
// calls draw() directly and draw() ALWAYS rebuilds the buffer, so none of
// them needed to change. The ONLY new call path is __setPosition's follow-only
// tick (see drawFollowFrame), which reuses the existing buffer via a cheap
// blit whenever the camera is still within its padded coverage, and falls
// back to a full draw() — same cost as before, never worse — the moment it
// isn't (e.g. real walking drift finally exceeds the padding, or the buffer
// has never been built yet).
var bufCanvas = null, bufCtx = null;
var bufCam = { x:0, y:0, scale:0, rot:0 };
var bufW = 0, bufH = 0;
var bufValid = false;
// Extra world shown beyond each viewport edge, as a fraction of that edge's
// own length. 0.4 gives comfortable headroom for many seconds of walking
// (a few metres of drift is a tiny fraction of a screen at any field zoom)
// while keeping the offscreen canvas well under 2x the screen's pixel count.
var BUF_PAD_FACTOR = 0.4;

function ensureBufCanvas(){
  if (bufCanvas) return;
  bufCanvas = document.createElement("canvas");
  bufCtx = bufCanvas.getContext("2d", { alpha:false });
}

/** True only when the last-built buffer still fully covers the current screen. */
function bufferCoversViewport(){
  if (!bufValid) return false;
  // A blit is a pure translate: valid only when neither scale nor rotation has
  // moved since the buffer was built. Zoom and twist gestures already force a
  // full draw() (see their handlers), so this is normally exact equality, not
  // a near-miss — but compare defensively rather than assume it.
  if (cam.scale !== bufCam.scale || cam.rot !== bufCam.rot) return false;
  toScreen(bufCam.x, bufCam.y, P);
  var offX = P[0] - bufW/2, offY = P[1] - bufH/2;
  return offX <= 0 && offY <= 0 && offX + bufW >= W && offY + bufH >= H;
}

/** Everything that does NOT depend on LIVE.position/headingDeg. */
function drawStaticLayers(){
  ctx.fillStyle = "#07070A"; ctx.fillRect(0,0,W,H);
  drawLand();
  tilesPainted = 0;
  tileStrips = 0;
  tileSpanDeg = 0;
  if (LAYERS.satellite || LAYERS.hillshade) drawTiles(LIVE.baseTiles, true);
  drawGeology();
  drawTerrain();
  drawSlope();
  drawDrainage();
  drawContacts();
  drawLineaments();
  drawFaults();
  drawAspect();
  if (LAYERS.roads || LAYERS.labels) drawTiles(LIVE.overlayTiles, false);
  drawGridLines();
  drawGeologyLabels();
  // drawOccurrences is deliberately NOT here — see draw()/drawDynamicOnly().
}

/** Rebuilds the static buffer around the CURRENT camera, with padding. */
function rebuildStaticBuffer(){
  ensureBufCanvas();
  var padW = W * BUF_PAD_FACTOR, padH = H * BUF_PAD_FACTOR;
  bufW = Math.round(W + 2*padW); bufH = Math.round(H + 2*padH);
  var pw = Math.max(1, Math.round(bufW*DPR)), ph = Math.max(1, Math.round(bufH*DPR));
  if (bufCanvas.width !== pw || bufCanvas.height !== ph){
    bufCanvas.width = pw; bufCanvas.height = ph;
  }
  var saveCtx = ctx, saveW = W, saveH = H;
  ctx = bufCtx; W = bufW; H = bufH;
  ctx.setTransform(DPR,0,0,DPR,0,0);
  computeTrig();
  viewBox();
  drawStaticLayers();
  ctx = saveCtx; W = saveW; H = saveH;
  bufCam.x = cam.x; bufCam.y = cam.y; bufCam.scale = cam.scale; bufCam.rot = cam.rot;
  bufValid = true;
  // Put CS/SN/HW/HH/VIEW back for the real viewport before the caller carries on.
  computeTrig();
  viewBox();
}

/** Paints the (possibly stale-but-still-covering) static buffer onto the real canvas. */
function blitStaticBuffer(){
  toScreen(bufCam.x, bufCam.y, P);
  var offX = P[0] - bufW/2, offY = P[1] - bufH/2;
  ctx.drawImage(bufCanvas, 0, 0, bufCanvas.width, bufCanvas.height, offX, offY, bufW, bufH);
}

function draw(){
  if (pending) return;
  pending = true;
  requestAnimationFrame(function(){
    pending = false;
    var frameStart = (window.performance && performance.now) ? performance.now() : Date.now();
    IMG_MAX = pressureImgMax(imgCapFor(LAYERS), LAYERS);
    DEM_STRIDE = demStride();
    beginFrame();
    viewBox();
    rebuildStaticBuffer();
    ctx.fillStyle = "#07070A"; ctx.fillRect(0,0,W,H);
    blitStaticBuffer();
    drawRangeRings();
    drawTrack();
    drawTarget();
    // Occurrences are static DATA (never read LIVE.position/headingDeg — same
    // test as everything in drawStaticLayers) but are drawn HERE, live, not
    // cached in the buffer: caching would blit them underneath the track/
    // target instead of on top of them, as they have always been stacked.
    // ~159 points, viewport-culled, a handful of arcs each — cheap enough to
    // redraw every frame without reopening the freeze this file exists to fix.
    drawOccurrences();
    drawWaypoints();
    drawSelected();
    drawMe();
    var frameEnd = (window.performance && performance.now) ? performance.now() : Date.now();
    lastDrawMs = frameEnd - frameStart;
    notePressure(lastDrawMs);
    report();
  });
}

/**
 * The cheap path for anything that only touches DYNAMIC state — a GPS fix
 * (position and/or the track it grows), a compass reading, a new target or
 * waypoint set. Blits the cached static buffer instead of redrawing 24k+
 * features, then draws only the handful of things that actually depend on
 * that state. Falls back to a full draw() — never worse than before — the
 * moment the camera has drifted beyond the buffer's padded coverage, e.g.
 * real walking drift finally exceeding it, or the buffer never having been
 * built yet.
 */
var dynamicPending = false;
function drawDynamicOnly(){
  if (pending || dynamicPending) return;   // a full draw() already covers this
  dynamicPending = true;
  requestAnimationFrame(function(){
    dynamicPending = false;
    if (pending) return;   // a full draw() slipped in first; it already covered this frame
    beginFrame();
    viewBox();
    if (!bufferCoversViewport()){
      draw();
      return;
    }
    ctx.fillStyle = "#07070A"; ctx.fillRect(0,0,W,H);
    blitStaticBuffer();
    drawRangeRings();
    drawTrack();
    drawTarget();
    drawOccurrences(); // kept out of the buffer — see the comment in draw()
    drawWaypoints();
    drawSelected();
    drawMe();
    report();
  });
}

// ── Reporting to the app ──────────────────────────────────────────────────
// The camera drives the scale bar, the compass AND which tiles are worth
// fetching, so it must be reported — but a message per frame is a bridge
// crossing per frame. Rounded to what the receivers can actually use, and
// dropped when unchanged, a whole pan produces a handful of messages.
var lastReport = "", lastReportKey = "", postTimer = null, lastPostAt = 0;
/** At most this often while the camera is moving. The last state always lands. */
var REPORT_MS = 100;
/** Set at the end of every frame — see draw(). Reported, never read for layout. */
var lastDrawMs = 0;

function report(){
  var c1 = toWorld(0, 0, [0,0]), c2 = toWorld(W, 0, [0,0]);
  var c3 = toWorld(0, H, [0,0]), c4 = toWorld(W, H, [0,0]);
  var xs = [c1[0],c2[0],c3[0],c4[0]], ys = [c1[1],c2[1],c3[1],c4[1]];
  var rotationDeg = ((cam.rot*180/Math.PI)%360+360)%360;
  var metresPerPx = 1/cam.scale;
  var bbox = [
    lngOf(Math.min.apply(null,xs)), latOf(Math.min.apply(null,ys)),
    lngOf(Math.max.apply(null,xs)), latOf(Math.max.apply(null,ys))
  ].map(function(v){ return Math.round(v*10000)/10000; });
  // The identity a frame is deduped ON. Deliberately narrower than the
  // message actually sent, below — drawMs moves by timing noise even when
  // the camera and every layer are unchanged, and keying the dedupe to it
  // would turn "dropped when unchanged" back into a message every frame,
  // which is the exact bridge-crossing cost this function exists to avoid.
  var key = JSON.stringify({
    rotationDeg:rotationDeg, metresPerPx:metresPerPx, ringStepM:RING_STEP,
    tileStrips:tileStrips, imagesHeld:IMG_ORDER.length,
    tileSpanDeg: Math.round(tileSpanDeg * 1000) / 1000, tilesPainted:tilesPainted,
    bbox:bbox,
  });
  if (key === lastReportKey) return;
  lastReportKey = key;
  var msg = JSON.stringify({
    type:"camera",
    rotationDeg: rotationDeg,
    metresPerPx: metresPerPx,
    ringStepM: RING_STEP,
    tileStrips: tileStrips,
    // How many decoded tile images the page is holding. Reported because it
    // is the memory the map costs, and because a cache that saws through its
    // own working set froze the app once already.
    imagesHeld: IMG_ORDER.length,
    tileSpanDeg: Math.round(tileSpanDeg * 1000) / 1000,
    tilesPainted: tilesPainted,
    // The adaptive budgets — diagnostics only, and excluded from the dedupe
    // key above on purpose. RSS itself is not readable from inside a WebView, so this
    // is the closest honest proxy: how long drawing took, how hard the
    // guards are currently squeezing, and how many tiles are actually held
    // right now (imagesHeld, above).
    drawMs: Math.round(lastDrawMs * 10) / 10,
    imgMax: IMG_MAX,
    demStride: DEM_STRIDE,
    pressureLevel: pressureLevel,
    bbox: bbox,
  });
  lastReport = msg;

  // Rate-limited, with a TRAILING send. A message per drawn frame is a bridge
  // crossing per frame and a React render behind it, which is what made the
  // native controls feel unresponsive during a drag. The trailing timer is what
  // makes this safe: whatever the camera settles on is always delivered, so the
  // scale bar and the tile fetcher never end up describing a view that is gone.
  var now = Date.now();
  if (now - lastPostAt >= REPORT_MS){
    lastPostAt = now;
    post(msg);
    return;
  }
  if (postTimer) return;
  postTimer = setTimeout(function(){
    postTimer = null;
    lastPostAt = Date.now();
    post(lastReport);
  }, REPORT_MS);
}
function post(msg){ if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg); }

// ── Gestures ──────────────────────────────────────────────────────────────
var touches = {};
var gesture = null;
var followMe = true;   // recentres on the viewer until the user drags
var moved = 0;         // pixels travelled in this gesture — a tap moves none
var startedAt = 0;
var vx = 0, vy = 0, lastMoveAt = 0;   // world-metres per ms, for the fling

function pts(){ var a=[]; for (var k in touches) a.push(touches[k]); return a; }

cv.addEventListener("touchstart", function(e){
  glide = 0;
  for (var i=0;i<e.changedTouches.length;i++){
    var t = e.changedTouches[i];
    touches[t.identifier] = { x:t.clientX, y:t.clientY };
  }
  if (Object.keys(touches).length === e.changedTouches.length){
    moved = 0; startedAt = Date.now(); vx = 0; vy = 0;
  }
  gesture = startGesture();
  e.preventDefault();
}, {passive:false});

function startGesture(){
  var a = pts();
  if (a.length === 1) return { kind:"pan", x:a[0].x, y:a[0].y, camx:cam.x, camy:cam.y };
  if (a.length >= 2){
    var dx = a[1].x-a[0].x, dy = a[1].y-a[0].y;
    return {
      kind:"pinch",
      dist: Math.hypot(dx,dy) || 1,
      ang: Math.atan2(dy,dx),
      scale: cam.scale, rot: cam.rot,
      cx: (a[0].x+a[1].x)/2, cy: (a[0].y+a[1].y)/2,
      camx: cam.x, camy: cam.y
    };
  }
  return null;
}

cv.addEventListener("touchmove", function(e){
  for (var i=0;i<e.changedTouches.length;i++){
    var t = e.changedTouches[i];
    if (touches[t.identifier]) { touches[t.identifier].x = t.clientX; touches[t.identifier].y = t.clientY; }
  }
  var a = pts();
  if (!gesture) { e.preventDefault(); return; }

  if (gesture.kind === "pan" && a.length === 1){
    var dx = a[0].x - gesture.x, dy = a[0].y - gesture.y;
    moved = Math.max(moved, Math.hypot(dx,dy));
    if (moved > 6) followMe = false;
    // Undo the rotation so a drag moves the ground the way the finger moves.
    var cs = Math.cos(-cam.rot), sn = Math.sin(-cam.rot);
    var wxm = (-dx/cam.scale), wym = (dy/cam.scale);
    var nx = gesture.camx + (wxm*cs - wym*sn);
    var ny = gesture.camy + (wxm*sn + wym*cs);
    var now = Date.now(), dt = Math.max(8, now - (lastMoveAt || now));
    vx = (nx - cam.x)/dt; vy = (ny - cam.y)/dt;
    lastMoveAt = now;
    cam.x = nx; cam.y = ny;
    draw();
  } else if (gesture.kind === "pinch" && a.length >= 2){
    followMe = false;
    moved = 999;
    var ddx = a[1].x-a[0].x, ddy = a[1].y-a[0].y;
    var dist = Math.hypot(ddx,ddy) || 1;
    var ang = Math.atan2(ddy,ddx);
    // Zoom about the FINGERS, not the screen centre: the ground under the pinch
    // must stay under it, which is the difference between a map that zooms and
    // one that lurches.
    var before = toWorld(gesture.cx, gesture.cy, [0,0]);
    cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, gesture.scale * (dist/gesture.dist)));
    cam.rot = gesture.rot - (ang - gesture.ang);
    beginFrame();
    var after = toWorld(gesture.cx, gesture.cy, [0,0]);
    cam.x += before[0] - after[0];
    cam.y += before[1] - after[1];
    draw();
  }
  e.preventDefault();
}, {passive:false});

/**
 * Momentum.
 *
 * A map that stops dead under the finger feels like a document; every field map
 * worth using carries the pan on and decays it. Cheap: one rAF loop that ends
 * as soon as the movement is under half a pixel a frame.
 */
var glide = 0;
function fling(){
  if (!glide) return;
  cam.x += vx * 16; cam.y += vy * 16;
  vx *= 0.94; vy *= 0.94;
  if (Math.hypot(vx, vy) * 16 * cam.scale < 0.4){ glide = 0; draw(); return; }
  draw();
  requestAnimationFrame(fling);
}

function endTouch(e){
  var wasTap = Object.keys(touches).length === e.changedTouches.length &&
               moved < 8 && (Date.now() - startedAt) < 400;
  var pt = e.changedTouches[0];
  for (var i=0;i<e.changedTouches.length;i++) delete touches[e.changedTouches[i].identifier];
  var none = Object.keys(touches).length === 0;

  if (wasTap && pt && e.type === "touchend"){
    beginFrame();
    var w = toWorld(pt.clientX, pt.clientY, [0,0]);
    post(JSON.stringify({
      type:"pick",
      lng: lngOf(w[0]), lat: latOf(w[1]),
      // A fingertip is about 22 px whatever the zoom; in metres that is only
      // meaningful once converted at the scale the tap was made at.
      radiusM: 22 / cam.scale
    }));
  } else if (none && gesture && gesture.kind === "pan" && Math.hypot(vx,vy)*16*cam.scale > 1.2 &&
             (Date.now() - lastMoveAt) < 90){
    glide = 1;
    requestAnimationFrame(fling);
  }
  gesture = startGesture();
  e.preventDefault();
}
cv.addEventListener("touchend", endTouch, {passive:false});
cv.addEventListener("touchcancel", endTouch, {passive:false});

// ── Commands from the app ─────────────────────────────────────────────────
function follow(){
  if (followMe && LIVE.position){
    cam.x = wx(LIVE.position.lng); cam.y = wy(LIVE.position.lat);
  }
}
// A GPS fix and a compass reading arrive through this SAME call (see the React
// effect that invokes it). Neither one ever needs the static layer (geology,
// faults, lineaments, contacts, terrain, tiles) redrawn — see drawDynamicOnly
// and the static-layer cache above draw() — so both go through it. The
// heading-specific throttle below is layered ON TOP of that cache, not a
// substitute for it: HeadingService already gates compass emission to ≤2 Hz /
// ≥3° (headingService.ts), and this absorbs the 3-7° wobble that survives
// that filter (ordinary hand tremor) so it doesn't even cost a blit + marker
// redraw, without perceptibly delaying a real turn.
var lastPosKey = null;
var lastHeadingDrawDeg = null;
var lastHeadingDrawAt = 0;
var HEADING_REDRAW_MIN_DEG = 8;
var HEADING_REDRAW_MIN_MS = 350;
window.__setPosition = function(p, heading){
  var posKey = p ? (p.lat + "," + p.lng + "," + p.accuracyM) : null;
  var posChanged = posKey !== lastPosKey;
  lastPosKey = posKey;
  LIVE.position = p; LIVE.headingDeg = heading;
  follow();
  if (posChanged || heading == null || lastHeadingDrawDeg == null){
    lastHeadingDrawDeg = heading; lastHeadingDrawAt = Date.now();
    drawDynamicOnly();
    return;
  }
  var deltaDeg = Math.abs(((heading - lastHeadingDrawDeg + 540) % 360) - 180);
  var sinceLastMs = Date.now() - lastHeadingDrawAt;
  if (deltaDeg < HEADING_REDRAW_MIN_DEG && sinceLastMs < HEADING_REDRAW_MIN_MS) return;
  lastHeadingDrawDeg = heading; lastHeadingDrawAt = Date.now();
  drawDynamicOnly();
};
// Track/pins are DYNAMIC data too (see the static-layer cache above draw()) —
// a growing track or a new target must never force the static buffer to
// rebuild, so these go through the same cheap path as position/heading.
window.__setTrack = function(points){ LIVE.track = points; drawDynamicOnly(); };
window.__addTrack = function(points){
  for (var i=0;i<points.length;i++) LIVE.track.push(points[i]);
  drawDynamicOnly();
};
window.__setPins = function(target, waypoints, selected){
  LIVE.target = target; LIVE.waypoints = waypoints; LIVE.selected = selected;
  drawDynamicOnly();
};
window.__setTiles = function(base, overlay){
  LIVE.baseTiles = base; LIVE.overlayTiles = overlay;
  draw();
};
/**
 * Swap in more ground WITHOUT losing the camera.
 *
 * The scene used to be baked into the document, so widening it meant rebuilding
 * the page — which threw the map back to its opening view and could not be done
 * while anyone was looking at it. So it was never widened, and a session that
 * opened on a 2 km window kept that window however far the geologist zoomed out:
 * mapped occurrences 95 km away were not hidden by a layer switch, they were
 * never in the scene at all.
 *
 * Now the scene is data like everything else. The projection origin moves with
 * it, so the camera is converted to geography through the OLD origin and back
 * through the new one — the ground under the screen does not shift by a pixel.
 */
window.__setScene = function(next){
  var lat = latOf(cam.y), lng = lngOf(cam.x);
  SCENE = next;
  C = SCENE.centre;
  KLNG = M_LAT * Math.cos(C.lat * Math.PI / 180);
  prepScene();
  cam.x = wx(lng); cam.y = wy(lat);
  draw();
};
window.__setLayers = function(next){ LAYERS = next; draw(); };
window.__zoom = function(f){
  cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cam.scale*f));
  draw();
};
window.__centre = function(){
  followMe = true;
  cam.rot = 0;
  if (LIVE.position){ cam.x = wx(LIVE.position.lng); cam.y = wy(LIVE.position.lat); }
  draw();
};
window.__centreOn = function(lat, lng){
  followMe = false;
  cam.x = wx(lng); cam.y = wy(lat);
  draw();
};
window.__setRotation = function(deg){ cam.rot = deg*Math.PI/180; draw(); };
/**
 * Put the camera back exactly where it was.
 *
 * The canvas is destroyed when the geologist leaves the map route and rebuilt
 * when they return. The SESSION never stopped (the providers live above the
 * router), so re-fitting to the opening 2 km view would be the one thing that
 * still lost their place. This restores the view they left, over the scene that
 * was never discarded.
 */
window.__restore = function(lat, lng, metresPerPx, bearingDeg){
  followMe = false;
  cam.x = wx(lng); cam.y = wy(lat);
  if (metresPerPx > 0) cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, 1/metresPerPx));
  cam.rot = (bearingDeg || 0) * Math.PI / 180;
  draw();
};
window.__fit = function(metres){
  cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (Math.min(W,H)*0.42)/metres));
  draw();
};
/**
 * Frame the viewer AND the target together.
 *
 * Once a destination can be 90 km away, "centre on me" is no longer enough to
 * see where you are being sent — the crosshair sits off the edge of a map zoomed
 * for walking, and the guidance line points into nothing. This pulls back far
 * enough to hold both, which is the only way a regional target is legible at all.
 */
window.__frame = function(){
  if (!LIVE.position || !LIVE.target) return;
  var ax = wx(LIVE.position.lng), ay = wy(LIVE.position.lat);
  var bx = wx(LIVE.target.lng), by = wy(LIVE.target.lat);
  cam.x = (ax+bx)/2; cam.y = (ay+by)/2;
  cam.rot = 0;
  var span = Math.max(Math.abs(bx-ax), Math.abs(by-ay), 200);
  cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (Math.min(W,H)*0.78)/span));
  followMe = false;  // holding the frame is the whole point; do not snap back
  draw();
};

resize();
})();
</script></body></html>`;
}

// ── The component ───────────────────────────────────────────────────────────

export const ExplorationMap = React.forwardRef<MapHandle, {
  scene: MapScene;
  live: MapLive;
  layers: MapLayers;
  /** Metres the initial view should span from the centre outward. */
  initialRadiusM?: number;
  onCamera?: (c: MapCamera) => void;
  /** A tap on the map, for the caller to identify against the pack. */
  onPick?: (p: MapPick) => void;
  /**
   * Where the camera was when this map was last drawn.
   *
   * Present when the geologist is coming BACK to the map — read once, on mount,
   * instead of the opening fit.
   */
  restore?: CameraRestore | null;
}>(function ExplorationMap({ scene, live, layers, initialRadiusM, onCamera, onPick, restore }, ref) {
  const web = React.useRef<WebView>(null);
  const [ready, setReady] = React.useState(false);

  // The document is built ONCE, from the scene the session opened with. Widening
  // the scene is a message, not a reload: rebuilding the page would reset the
  // camera, which is why the scene used to be frozen at whatever the first GPS
  // fix justified — and why anything outside that window was invisible.
  const opening = React.useRef(scene);
  const html = React.useMemo(() => page(opening.current, layers), []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = React.useCallback((js: string) => {
    web.current?.injectJavaScript(js + " true;");
  }, []);

  React.useImperativeHandle(ref, () => ({
    zoomBy: (f) => run(`window.__zoom(${f});`),
    centre: () => run("window.__centre();"),
    setRotation: (d) => run(`window.__setRotation(${d});`),
    frameTarget: () => run("window.__frame();"),
    centreOn: (lat, lng) => run(`window.__centreOn(${lat},${lng});`),
  }), [run]);

  // Live state is pushed in PIECES. A GPS fix arrives every second or two; a
  // track can be thousands of points and the tile list sixty records, and
  // re-serialising all of it per fix was the single largest recurring cost on
  // the bridge. Each of these fires only when its own input changed.
  React.useEffect(() => {
    if (!ready) return;
    run(`window.__setPosition(${JSON.stringify(live.position)},${JSON.stringify(live.headingDeg)});`);
  }, [ready, live.position, live.headingDeg, run]);

  // The track only ever grows, so only the growth is sent. A shorter array
  // means a new session or a reset, and that replaces the lot.
  const sentTrack = React.useRef(0);
  React.useEffect(() => {
    if (!ready) return;
    const n = live.track.length;
    if (n < sentTrack.current) {
      run(`window.__setTrack(${JSON.stringify(live.track)});`);
    } else if (n > sentTrack.current) {
      run(`window.__addTrack(${JSON.stringify(live.track.slice(sentTrack.current))});`);
    }
    sentTrack.current = n;
  }, [ready, live.track, run]);

  React.useEffect(() => {
    if (!ready) return;
    run(`window.__setPins(${JSON.stringify(live.target)},${JSON.stringify(live.waypoints)},${JSON.stringify(live.selected)});`);
  }, [ready, live.target, live.waypoints, live.selected, run]);

  React.useEffect(() => {
    if (!ready) return;
    run(`window.__setTiles(${JSON.stringify(live.baseTiles)},${JSON.stringify(live.overlayTiles)});`);
  }, [ready, live.baseTiles, live.overlayTiles, run]);

  React.useEffect(() => {
    if (!ready) return;
    run(`window.__setLayers(${JSON.stringify(layers)});`);
  }, [ready, layers, run]);

  // Read ONCE, on mount: a camera the user has since moved must not be yanked
  // back by a re-render.
  const restoreOnMount = React.useRef(restore ?? null);
  React.useEffect(() => {
    if (!ready) return;
    const r = restoreOnMount.current;
    if (r) {
      run(`window.__restore(${r.lat},${r.lng},${r.metresPerPx},${r.rotationDeg});`);
      return;
    }
    if (initialRadiusM) run(`window.__fit(${initialRadiusM});`);
  }, [ready, initialRadiusM, run]);

  // More ground, pushed in as it is prepared. Same escaping rule as the inlined
  // scene: pack names are database strings and must not be able to close a tag.
  const sentScene = React.useRef(opening.current);
  React.useEffect(() => {
    if (!ready || scene === sentScene.current) return;
    sentScene.current = scene;
    run(`window.__setScene(${JSON.stringify(scene).replace(/<\//g, "<\\/")});`);
  }, [ready, scene, run]);

  return (
    <View style={styles.fill}>
      <WebView
        ref={web}
        style={styles.fill}
        source={{ html }}
        // The page needs its own script; it has no other reason to run code and
        // loads nothing remote — map tiles arrive as local file URIs that the
        // app downloaded and verified.
        javaScriptEnabled
        domStorageEnabled={false}
        originWhitelist={["*"]}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        scrollEnabled={false}
        overScrollMode="never"
        bounces={false}
        androidLayerType="hardware"
        onLoadEnd={() => setReady(true)}
        onMessage={(e) => {
          try {
            const m = JSON.parse(e.nativeEvent.data);
            if (m.type === "camera") onCamera?.(m);
            else if (m.type === "pick") onPick?.(m);
          } catch {
            // A malformed message is not worth interrupting a field session for.
          }
        }}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#0B0B0C" },
});

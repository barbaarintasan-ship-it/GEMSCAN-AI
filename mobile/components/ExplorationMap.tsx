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
// is written here. It fetches nothing except satellite tiles, and those only
// when the app has already downloaded them and passes local file URIs.
//
// WHAT LIVES WHERE
// ----------------
// The HTML is rebuilt only when the SCENE changes — panning off the edge of the
// prepared area. Live state (position, heading, target, track) is pushed in
// through injectJavaScript instead, because rebuilding the document on every
// GPS fix would tear the map out from under a moving finger.
import React from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import type { MapScene } from "../lib/geo/mapScene";

export interface MapLayers {
  satellite: boolean;
  geology: boolean;
  terrain: boolean;
  faults: boolean;
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
  satellite: true,
  geology: true,
  terrain: true,
  faults: true,
  occurrences: true,
  waypoints: true,
  track: true,
  target: true,
  accuracy: true,
  compass: true,
  grid: true,
};

export interface MapLive {
  position: { lat: number; lng: number; accuracyM: number | null } | null;
  /** Device heading, degrees from true north. Drives the direction cone only. */
  headingDeg: number | null;
  target: { lat: number; lng: number } | null;
  /** Breadcrumb of where the geologist has actually walked. */
  track: Array<[number, number]>;
  waypoints: Array<{ lng: number; lat: number; type: string }>;
  /** Satellite tiles already on disk, as local URIs with their geographic box. */
  tiles: Array<{ uri: string; w: number; s: number; e: number; n: number }>;
}

export const EMPTY_LIVE: MapLive = {
  position: null, headingDeg: null, target: null,
  track: [], waypoints: [], tiles: [],
};

export interface MapHandle {
  zoomBy(factor: number): void;
  /** Recentre on the viewer and reset rotation to north-up. */
  centre(): void;
  setRotation(deg: number): void;
  /** Zoom out until both the viewer and the current target are on screen. */
  frameTarget(): void;
}

/** Reported back so the native overlay can draw the compass and the scale bar. */
export interface MapCamera {
  rotationDeg: number;
  /** Metres per screen pixel — what the scale bar is derived from. */
  metresPerPx: number;
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
var LIVE = { position:null, headingDeg:null, target:null, track:[], waypoints:[], tiles:[] };

var cv = document.getElementById("c");
var ctx = cv.getContext("2d");
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

// Camera: centre in world metres, scale in px/m, rotation clockwise in radians.
var cam = { x:0, y:0, scale:0.02, rot:0 };
var MIN_SCALE = 0.00002, MAX_SCALE = 2;

function toScreen(x, y, out){
  var ex = x - cam.x, ey = y - cam.y;
  var cs = Math.cos(cam.rot), sn = Math.sin(cam.rot);
  var rx = ex * cs - ey * sn;
  var ry = ex * sn + ey * cs;
  out[0] = W/2 + rx * cam.scale;
  out[1] = H/2 - ry * cam.scale;   // screen y grows downward; north stays up
  return out;
}
var P = [0,0];
function sxy(lng, lat){ return toScreen(wx(lng), wy(lat), P); }

// ── Drawing ───────────────────────────────────────────────────────────────
function ringPath(ring){
  ctx.beginPath();
  for (var i=0;i<ring.length;i++){
    var p = sxy(ring[i][0], ring[i][1]);
    if (i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]);
  }
}

// How many tiles actually PAINTED on the last frame. Not how many were handed
// in: a tile still decoding, or one that failed to load, covers no ground. The
// geology layer reads this to decide how opaque to be, so imagery that never
// arrived can never leave the geologist looking at a washed-out black rectangle.
var tilesPainted = 0;

function drawTiles(){
  tilesPainted = 0;
  if (!LAYERS.satellite) return;
  for (var i=0;i<LIVE.tiles.length;i++){
    var t = LIVE.tiles[i];
    var img = tileImg(t.uri);
    if (!img || !img.complete || !img.naturalWidth) continue;
    tilesPainted++;
    // Tiles are axis-aligned in geography, so under rotation they must be drawn
    // through the same transform as everything else rather than blitted.
    var a = sxy(t.w, t.n), ax=a[0], ay=a[1];
    var b = sxy(t.e, t.n), bx=b[0], by=b[1];
    var d = sxy(t.w, t.s), dx=d[0], dy=d[1];
    ctx.save();
    ctx.transform((bx-ax)/256,(by-ay)/256,(dx-ax)/256,(dy-ay)/256,ax,ay);
    ctx.drawImage(img,0,0,256,256);
    ctx.restore();
  }
}
var IMGS = {};
function tileImg(uri){
  var im = IMGS[uri];
  if (im) return im;
  im = new Image();
  im.onload = function(){ draw(); };
  im.onerror = function(){ IMGS[uri] = null; };
  im.src = uri;
  IMGS[uri] = im;
  return im;
}

function drawGeology(){
  if (!LAYERS.geology) return;
  // Translucent over satellite so the imagery stays readable underneath — the
  // geologist needs both the rock unit and the ground it sits on. But that only
  // holds where imagery actually landed; with the layer on and no tiles yet the
  // old rule faded the geology to 42% over bare black, which is the closest this
  // map ever came to showing a blank screen. Nothing to see through, full colour.
  var alpha = tilesPainted > 0 ? 0.42 : 0.85;
  for (var i=0;i<SCENE.polygons.length;i++){
    var g = SCENE.polygons[i];
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g.color;
    for (var r=0;r<g.rings.length;r++){ ringPath(g.rings[r]); ctx.closePath(); ctx.fill(); }
    ctx.globalAlpha = Math.min(1, alpha + 0.25);
    ctx.strokeStyle = g.color; ctx.lineWidth = 1;
    for (var r2=0;r2<g.rings.length;r2++){ ringPath(g.rings[r2]); ctx.closePath(); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
}

function drawTerrain(){
  if (!LAYERS.terrain || !SCENE.terrain.length) return;
  for (var i=0;i<SCENE.terrain.length;i++){
    var t = SCENE.terrain[i];
    var p = sxy(t.lng, t.lat);
    if (p[0]<-40||p[0]>W+40||p[1]<-40||p[1]>H+40) continue;
    ctx.globalAlpha = 0.10 + t.shade * 0.30;
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath(); ctx.arc(p[0],p[1], 9, 0, 6.2832); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawFaults(){
  if (!LAYERS.faults) return;
  ctx.strokeStyle = "#101014";
  ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.setLineDash([9,6]);
  for (var i=0;i<SCENE.faults.length;i++){
    var f = SCENE.faults[i];
    for (var j=0;j<f.paths.length;j++){
      var path = f.paths[j];
      if (path.length<2) continue;
      ctx.beginPath();
      for (var k=0;k<path.length;k++){
        var p = sxy(path[k][0], path[k][1]);
        if (k===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]);
      }
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

function drawOccurrences(){
  if (!LAYERS.occurrences) return;
  for (var i=0;i<SCENE.occurrences.length;i++){
    var o = SCENE.occurrences[i];
    var p = sxy(o.lng, o.lat);
    if (p[0]<-20||p[0]>W+20||p[1]<-20||p[1]>H+20) continue;
    ctx.fillStyle = "#E03A2F";
    ctx.strokeStyle = "rgba(0,0,0,0.65)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p[0],p[1],7,0,6.2832); ctx.fill(); ctx.stroke();
  }
}

function drawTrack(){
  if (!LAYERS.track || LIVE.track.length<2) return;
  ctx.strokeStyle = "#F5C518"; ctx.lineWidth = 4;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  for (var i=0;i<LIVE.track.length;i++){
    var p = sxy(LIVE.track[i][0], LIVE.track[i][1]);
    if (i===0) ctx.moveTo(p[0],p[1]); else ctx.lineTo(p[0],p[1]);
  }
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

function drawTarget(){
  if (!LAYERS.target || !LIVE.target) return;
  var p = sxy(LIVE.target.lng, LIVE.target.lat);
  var tx = p[0], ty = p[1];

  if (LIVE.position){
    var q = sxy(LIVE.position.lng, LIVE.position.lat);
    ctx.strokeStyle = "#F5C518"; ctx.lineWidth = 3; ctx.setLineDash([10,7]);
    ctx.beginPath(); ctx.moveTo(q[0],q[1]); ctx.lineTo(tx,ty); ctx.stroke();
    ctx.setLineDash([]);
  }
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

function drawGrid(){
  var step = gridStepM();
  window.__ringStep = step;
  if (!LAYERS.grid) return;

  // A north-aligned metric graticule, drawn in WORLD metres about the scene
  // centre so the lines stay true north even when the map has been twisted. It
  // is what lets someone read a distance off the map in a direction other than
  // the one they happen to be facing.
  ctx.strokeStyle = "rgba(255,255,255,0.09)"; ctx.lineWidth = 1;
  // Corners of the screen in world metres, so the grid covers a rotated view.
  var half = Math.hypot(W, H) / 2 / cam.scale;
  var x0 = Math.floor((cam.x - half)/step)*step, x1 = cam.x + half;
  var y0 = Math.floor((cam.y - half)/step)*step, y1 = cam.y + half;
  // Bounded: at a silly zoom this could otherwise ask for thousands of lines.
  if ((x1-x0)/step <= 80 && (y1-y0)/step <= 80){
    var a = [0,0], b = [0,0];
    for (var gx=x0; gx<=x1; gx+=step){
      toScreen(gx, y0, a); toScreen(gx, y1, b);
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke();
    }
    for (var gy=y0; gy<=y1; gy+=step){
      toScreen(x0, gy, a); toScreen(x1, gy, b);
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke();
    }
  }

  // Range rings around the viewer: how far away things are, at a glance.
  if (!LIVE.position) return;
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
    var a = (LIVE.headingDeg * Math.PI/180) + cam.rot - Math.PI/2;
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
function draw(){
  if (pending) return;
  pending = true;
  requestAnimationFrame(function(){
    pending = false;
    ctx.fillStyle = "#0B0B0C"; ctx.fillRect(0,0,W,H);
    drawTiles();
    drawGeology();
    drawTerrain();
    drawFaults();
    drawOccurrences();
    drawGrid();
    drawTrack();
    drawTarget();
    drawWaypoints();
    drawMe();
    report();
  });
}

var lastReport = "";
function report(){
  var msg = JSON.stringify({
    type:"camera",
    rotationDeg: ((-cam.rot*180/Math.PI)%360+360)%360,
    metresPerPx: 1/cam.scale,
    ringStepM: window.__ringStep || null
  });
  if (msg === lastReport) return;
  lastReport = msg;
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
}

// ── Gestures ──────────────────────────────────────────────────────────────
var touches = {};
var gesture = null;
var followMe = true;   // recentres on the viewer until the user drags

function pts(){ var a=[]; for (var k in touches) a.push(touches[k]); return a; }

cv.addEventListener("touchstart", function(e){
  for (var i=0;i<e.changedTouches.length;i++){
    var t = e.changedTouches[i];
    touches[t.identifier] = { x:t.clientX, y:t.clientY };
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
    followMe = false;
    var dx = a[0].x - gesture.x, dy = a[0].y - gesture.y;
    // Undo the rotation so a drag moves the ground the way the finger moves.
    var cs = Math.cos(-cam.rot), sn = Math.sin(-cam.rot);
    var wxm = (-dx/cam.scale), wym = (dy/cam.scale);
    cam.x = gesture.camx + (wxm*cs - wym*sn);
    cam.y = gesture.camy + (wxm*sn + wym*cs);
    draw();
  } else if (gesture.kind === "pinch" && a.length >= 2){
    followMe = false;
    var ddx = a[1].x-a[0].x, ddy = a[1].y-a[0].y;
    var dist = Math.hypot(ddx,ddy) || 1;
    var ang = Math.atan2(ddy,ddx);
    cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, gesture.scale * (dist/gesture.dist)));
    cam.rot = gesture.rot + (ang - gesture.ang);
    draw();
  }
  e.preventDefault();
}, {passive:false});

function endTouch(e){
  for (var i=0;i<e.changedTouches.length;i++) delete touches[e.changedTouches[i].identifier];
  gesture = startGesture();
  e.preventDefault();
}
cv.addEventListener("touchend", endTouch, {passive:false});
cv.addEventListener("touchcancel", endTouch, {passive:false});

// ── Commands from the app ─────────────────────────────────────────────────
window.__setLive = function(next){
  LIVE = next;
  if (followMe && LIVE.position){
    cam.x = wx(LIVE.position.lng); cam.y = wy(LIVE.position.lat);
  }
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
window.__setRotation = function(deg){ cam.rot = -deg*Math.PI/180; draw(); };
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
  onCamera?: (c: MapCamera & { ringStepM: number | null }) => void;
}>(function ExplorationMap({ scene, live, layers, initialRadiusM, onCamera }, ref) {
  const web = React.useRef<WebView>(null);
  const [ready, setReady] = React.useState(false);

  // The document is keyed on the scene so a rebuild remounts cleanly rather
  // than leaving a stale scene behind a fresh script.
  const html = React.useMemo(() => page(scene, layers), [scene]);

  const run = React.useCallback((js: string) => {
    web.current?.injectJavaScript(js + " true;");
  }, []);

  React.useImperativeHandle(ref, () => ({
    zoomBy: (f) => run(`window.__zoom(${f});`),
    centre: () => run("window.__centre();"),
    setRotation: (d) => run(`window.__setRotation(${d});`),
    frameTarget: () => run("window.__frame();"),
  }), [run]);

  React.useEffect(() => {
    if (!ready) return;
    run(`window.__setLive(${JSON.stringify(live)});`);
  }, [ready, live, run]);

  React.useEffect(() => {
    if (!ready) return;
    run(`window.__setLayers(${JSON.stringify(layers)});`);
  }, [ready, layers, run]);

  React.useEffect(() => {
    if (!ready || !initialRadiusM) return;
    run(`window.__fit(${initialRadiusM});`);
  }, [ready, initialRadiusM, run]);

  return (
    <View style={styles.fill}>
      <WebView
        ref={web}
        style={styles.fill}
        source={{ html }}
        // The page needs its own script; it has no other reason to run code and
        // loads nothing remote — satellite tiles arrive as local file URIs that
        // the app downloaded and verified.
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

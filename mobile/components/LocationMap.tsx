// Keyless in-app map (Leaflet + OpenStreetMap tiles) rendered inside a WebView.
//
// We deliberately avoid react-native-maps here because it needs a Google Maps
// API key on Android. Leaflet + OSM tiles need no key and no billing. The only
// requirement is a network connection for the tiles, which the app already has
// when scanning.
//
// Coordinates shown are the exact GPS capture location stored by the scan
// pipeline in scans.capture_location.
import React, { useMemo } from "react";
import { View, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";

export type MapMarker = {
  lat: number;
  lng: number;
  title?: string;
  /** Optional scan id — tapping the marker posts this back to the host. */
  id?: string;
};

type Props = {
  markers: MapMarker[];
  height?: number;
  /** When true, fills available space (flex:1) instead of using a fixed height. */
  fill?: boolean;
  /** Fixed zoom for a single point; ignored when multiple markers (auto-fit). */
  zoom?: number;
  interactive?: boolean;
  /** Called with a marker id when its popup "open" link is tapped. */
  onMarkerPress?: (id: string) => void;
};

function buildHtml(markers: MapMarker[], zoom: number, interactive: boolean): string {
  const pts = JSON.stringify(markers);
  const drag = interactive ? "true" : "false";
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html,body,#map{margin:0;height:100%;width:100%;background:#0B0B0C}
  .leaflet-popup-content{font-family:sans-serif;font-size:13px}
  .gs-open{display:inline-block;margin-top:6px;color:#C9A227;font-weight:700;text-decoration:none}
</style></head><body>
<div id="map"></div>
<script>
  var pts = ${pts};
  var map = L.map('map', { zoomControl: ${drag}, dragging: ${drag}, scrollWheelZoom: ${drag}, doubleClickZoom: ${drag}, tap: ${drag} });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  var group = [];
  pts.forEach(function(p){
    var m = L.marker([p.lat, p.lng]).addTo(map);
    var html = (p.title ? '<b>'+p.title+'</b>' : 'Goobta la helay');
    if (p.id) { html += '<br/><a class="gs-open" href="#" onclick="openScan(\\''+p.id+'\\');return false;">Fur natiijada &rsaquo;</a>'; }
    m.bindPopup(html);
    group.push(m);
  });
  if (pts.length === 1) {
    map.setView([pts[0].lat, pts[0].lng], ${zoom});
  } else if (pts.length > 1) {
    map.fitBounds(L.featureGroup(group).getBounds().pad(0.25));
  } else {
    map.setView([0, 0], 2);
  }
  function openScan(id){
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(id);
  }
</script></body></html>`;
}

export default function LocationMap({
  markers,
  height = 180,
  fill = false,
  zoom = 16,
  interactive = false,
  onMarkerPress,
}: Props) {
  const html = useMemo(() => buildHtml(markers, zoom, interactive), [markers, zoom, interactive]);

  return (
    <View style={[styles.wrap, fill ? styles.fill : { height }]}>
      <WebView
        originWhitelist={["*"]}
        source={{ html }}
        style={styles.web}
        scrollEnabled={false}
        javaScriptEnabled
        domStorageEnabled
        onMessage={(e) => onMarkerPress?.(e.nativeEvent.data)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 14, overflow: "hidden", backgroundColor: "#0B0B0C" },
  fill: { flex: 1 },
  web: { flex: 1, backgroundColor: "#0B0B0C" },
});

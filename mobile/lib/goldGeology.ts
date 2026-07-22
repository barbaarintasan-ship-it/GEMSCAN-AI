// Regional geology context for Gold Prospect Evaluation (v2).
//
// Turns the scan's GPS location into an HONEST, source-backed regional-geology
// statement — never speculation. It uses a small, CURATED, coarse subset of
// PUBLIC-DOMAIN geological data (USGS Africa mineral-industries GIS 2021; USGS
// non-fuel mineral evaluations of Somalia; UN 1970 & UNDP 1975 geochemical
// surveys of northern Somalia) encoded as province polygons + a few documented
// occurrence areas. Everything is PROVINCE / REGION scale — it never claims a
// specific point contains gold.
//
// Pure + offline: NO AI, NO network, NO new tables/APIs. Deterministic (tested
// in goldGeology.test.ts).

type Ring = [number, number][]; // [lng, lat] pairs (GeoJSON order)

type GeoProvince = {
  id: string;
  nameEn: string;
  nameSo: string;
  favorable: boolean; // documented gold-mineralized province?
  ring: Ring;
  source: string;
};

type GeoOccurrence = {
  id: string;
  nameEn: string;
  commodity: string;
  lat: number;
  lng: number;
  approx: boolean; // coordinates are a coarse regional marker
  source: string;
};

const USGS = "USGS Africa mineral-industries GIS (2021) & non-fuel mineral evaluation of Somalia";
const UN_UNDP = "UN (1970) mineral survey & UNDP (1975) geochemical survey, northern Somalia";

// Coarse province polygons. Deliberately regional (province-scale) and honest —
// they mark broad areas the literature associates with gold, not precise
// deposits.
const PROVINCES: GeoProvince[] = [
  {
    id: "north_basement",
    nameEn: "Northern Somali Crystalline Basement",
    nameSo: "Basement-ka Crystalline ee Waqooyiga Soomaaliya",
    favorable: true,
    // Coast-parallel band over the northern mountains (Golis / Cal Madow /
    // Sanaag / Bari), where the Proterozoic basement and greenstone belts crop
    // out — the province with reported volcanogenic gold-rich occurrences.
    ring: [
      [43.0, 9.6],
      [45.0, 9.4],
      [47.5, 9.8],
      [49.5, 10.4],
      [51.3, 10.7],
      [51.3, 11.9],
      [49.0, 11.7],
      [46.5, 11.3],
      [44.0, 11.2],
      [42.9, 11.0],
      [43.0, 9.6],
    ],
    source: USGS,
  },
  {
    id: "bur_massif",
    nameEn: "Bur (Buur) Massif Basement",
    nameSo: "Basement-ka Buur Massif",
    favorable: false, // crystalline basement, but limited documented gold
    ring: [
      [43.3, 2.7],
      [44.2, 2.7],
      [44.2, 3.6],
      [43.3, 3.6],
      [43.3, 2.7],
    ],
    source: USGS,
  },
];

// A few documented occurrence AREAS (coarse regional markers, approximate).
const OCCURRENCES: GeoOccurrence[] = [
  { id: "golis_gold", nameEn: "Golis Mountains gold (alluvial nuggets)", commodity: "gold", lat: 10.6, lng: 47.0, approx: true, source: USGS },
  { id: "bari_basement", nameEn: "Bari basement metallic anomalies", commodity: "base metals / gold indicators", lat: 10.9, lng: 49.6, approx: true, source: UN_UNDP },
];

// Ray-casting point-in-polygon. `ring` is [lng, lat] pairs.
function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Documented occurrences within this radius count as "reported in the region".
const NEARBY_KM = 150;

export type GeologyContext = {
  favorable: boolean;
  provinceName: string | null;
  documentedNearby: boolean;
  line: string; // the honest regional statement for the report
  source: string;
};

type Translate = (en: string, so: string) => string;

export function regionalGeologyContext(lat: number, lng: number, L: Translate, so: boolean): GeologyContext {
  const province = PROVINCES.find((p) => pointInRing(lng, lat, p.ring)) ?? null;
  const nearby = OCCURRENCES.find((o) => haversineKm(lat, lng, o.lat, o.lng) <= NEARBY_KM) ?? null;
  const favorable = !!province?.favorable;
  const provinceName = province ? (so ? province.nameSo : province.nameEn) : null;

  let line: string;
  let source: string;
  if (favorable) {
    line = L(
      `The specimen was found within a geological province (${provinceName}) where greenstone-belt / quartz-hosted gold mineralization has previously been reported.`,
      `Shayga waxaa laga helay gobol juqraafi (${provinceName}) oo horay looga soo sheegay macdanaynta dahabka ee greenstone-belt / quartz-hosted.`,
    );
    if (nearby) {
      line +=
        " " +
        L("Documented mineral occurrences are recorded in this broader region.", "Macdano la diiwaangeliyay ayaa lagu diiwaangeliyay gobolkan ballaaran.");
    }
    source = nearby ? `${province!.source}; ${nearby.source}` : province!.source;
  } else if (province) {
    line = L(
      `The specimen is within the ${provinceName}, a crystalline basement area with limited documented gold formations.`,
      `Shaygu wuxuu ku dhex jiraa ${provinceName}, oo ah aag basement crystalline ah oo leh macdano dahab oo xaddidan oo la diiwaangeliyay.`,
    );
    source = province.source;
  } else if (nearby) {
    line = L(
      "Documented mineral occurrences have been reported in this broader region, though no formal gold province is mapped at this point.",
      "Macdano la diiwaangeliyay ayaa laga soo sheegay gobolkan ballaaran, in kastoo aan gobol dahab rasmi ah lagu sawirin meeshan.",
    );
    source = nearby.source;
  } else {
    line = L(
      "No major documented gold-bearing formations are known in this region.",
      "Ma jiraan macdano dahab oo waaweyn oo la diiwaangeliyay oo gobolkan laga yaqaan.",
    );
    source = USGS;
  }

  return { favorable, provinceName, documentedNearby: !!nearby, line, source };
}

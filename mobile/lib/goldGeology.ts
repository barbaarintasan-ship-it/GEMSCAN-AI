// Regional geology knowledge base for Gold Prospect Evaluation.
//
// Turns a location (GPS first, or a manually-typed country as a fallback) into
// an HONEST, source-backed regional-geology statement — never speculation and
// never a claim that a specific point contains, or lacks, gold.
//
// This is a CURATED, coarse, OFFLINE subset of public-domain geological
// knowledge (USGS mineral-resource data and national geological surveys). It is
// deliberately province / country scale. It reuses the existing offline data
// and is structured so additional curated datasets can be appended to
// `PROVINCES` / `COUNTRIES` in future WITHOUT redesigning the resolver.
//
// Pure + offline: NO AI, NO network, NO new tables/APIs. Deterministic (tested
// in goldGeology.test.ts).

type Ring = [number, number][]; // [lng, lat] pairs (GeoJSON order)

// Coarse axis-aligned box → ring. Keeps the dataset compact and readable; the
// polygons are intentionally province-scale, not precise deposit outlines.
function box(west: number, south: number, east: number, north: number): Ring {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

type GeoProvince = {
  id: string;
  country: string; // ISO-ish label, for grouping / future filtering
  name: string; // proper noun (same in both languages)
  favorable: boolean; // documented major gold province?
  setting: string; // short geological phrase, e.g. "Archean greenstone belt"
  ring: Ring;
  source: string;
};

const USGS = "Public-domain geological literature (USGS mineral-resource data & national geological surveys)";
const UN_UNDP = "UN (1970) mineral survey & UNDP (1975) geochemical survey, northern Somalia";

// ── Curated global gold-province dataset (coarse, offline) ─────────────────
// Extension point: append new curated provinces here; the resolver needs no
// change. Boxes are west, south, east, north (degrees).
const PROVINCES: GeoProvince[] = [
  // ── Africa ──────────────────────────────────────────────────────────────
  { id: "so_north_basement", country: "Somalia", name: "Northern Somali Crystalline Basement", favorable: true, setting: "Proterozoic basement & greenstone belts", ring: box(43.0, 9.4, 51.3, 11.9), source: `${USGS}; ${UN_UNDP}` },
  { id: "so_bur", country: "Somalia", name: "Bur (Buur) Massif Basement", favorable: false, setting: "crystalline basement", ring: box(43.3, 2.7, 44.2, 3.6), source: USGS },
  { id: "et_adola", country: "Ethiopia", name: "Adola–Kibre Mengist Belt", favorable: true, setting: "Neoproterozoic greenstone belt", ring: box(38.5, 5.0, 39.6, 6.5), source: USGS },
  { id: "et_west", country: "Ethiopia", name: "Western Ethiopia (Asosa–Benishangul) Belt", favorable: true, setting: "Neoproterozoic greenstone belt", ring: box(34.0, 8.5, 35.5, 10.5), source: USGS },
  { id: "ke_migori", country: "Kenya", name: "Migori–Lake Victoria Greenstone Belt", favorable: true, setting: "Archean greenstone belt", ring: box(34.0, -1.2, 35.2, 0.6), source: USGS },
  { id: "tz_lakevictoria", country: "Tanzania", name: "Lake Victoria Goldfield", favorable: true, setting: "Archean greenstone belt (Tanzania Craton)", ring: box(31.0, -4.2, 34.5, -1.5), source: USGS },
  { id: "ug_busia", country: "Uganda", name: "Busia–Kakamega Belt (SE Uganda)", favorable: true, setting: "Archean greenstone belt", ring: box(33.4, -0.2, 34.6, 1.2), source: USGS },
  { id: "za_witwatersrand", country: "South Africa", name: "Witwatersrand Basin", favorable: true, setting: "Archean gold-bearing conglomerate reefs", ring: box(26.0, -27.6, 29.6, -26.0), source: USGS },
  { id: "za_barberton", country: "South Africa", name: "Barberton Greenstone Belt", favorable: true, setting: "Archean greenstone belt", ring: box(30.5, -26.1, 31.6, -25.4), source: USGS },
  { id: "na_damara", country: "Namibia", name: "Damara Belt", favorable: true, setting: "Pan-African orogenic gold", ring: box(15.0, -22.6, 17.6, -20.4), source: USGS },
  { id: "bw_tati", country: "Botswana", name: "Tati (Francistown) Greenstone Belt", favorable: true, setting: "Archean greenstone belt", ring: box(27.0, -21.6, 28.1, -20.7), source: USGS },
  { id: "gh_ashanti", country: "Ghana", name: "Ashanti (Birimian) Belt", favorable: true, setting: "Paleoproterozoic Birimian greenstone belt", ring: box(-3.0, 5.0, -0.9, 7.6), source: USGS },
  { id: "ml_birimian", country: "Mali", name: "Kéniéba–Sikasso Birimian Belts", favorable: true, setting: "Paleoproterozoic Birimian greenstone belt", ring: box(-12.2, 11.8, -7.5, 14.6), source: USGS },
  { id: "bf_birimian", country: "Burkina Faso", name: "Burkina Faso Birimian Belts", favorable: true, setting: "Paleoproterozoic Birimian greenstone belt", ring: box(-3.6, 10.4, 0.6, 13.6), source: USGS },
  { id: "cd_kilomoto", country: "DR Congo", name: "Kilo–Moto Belt (Ituri)", favorable: true, setting: "Archean greenstone belt", ring: box(28.4, 0.9, 31.1, 3.6), source: USGS },
  { id: "zm_basement", country: "Zambia", name: "Eastern Zambia Basement", favorable: false, setting: "metamorphic basement, limited documented gold", ring: box(27.0, -14.6, 33.7, -11.9), source: USGS },
  { id: "zw_craton", country: "Zimbabwe", name: "Zimbabwe Craton Greenstone Belts", favorable: true, setting: "Archean greenstone belt", ring: box(28.4, -20.6, 31.6, -17.4), source: USGS },
  { id: "mz_manica", country: "Mozambique", name: "Manica Greenstone Belt", favorable: true, setting: "Archean greenstone belt", ring: box(32.4, -19.6, 33.6, -18.4), source: USGS },
  { id: "mg_central", country: "Madagascar", name: "Central Madagascar Goldfields", favorable: true, setting: "Precambrian basement shear-zone gold", ring: box(45.5, -22.0, 48.6, -18.0), source: USGS },

  // ── Oceania / Americas ────────────────────────────────────────────────────
  { id: "au_yilgarn", country: "Australia", name: "Yilgarn Craton (Kalgoorlie)", favorable: true, setting: "Archean greenstone belt", ring: box(117.0, -32.2, 123.0, -27.0), source: USGS },
  { id: "au_pilbara", country: "Australia", name: "Pilbara Craton", favorable: true, setting: "Archean greenstone / conglomerate gold", ring: box(117.0, -23.2, 121.2, -20.4), source: USGS },
  { id: "ca_abitibi", country: "Canada", name: "Abitibi Greenstone Belt", favorable: true, setting: "Archean greenstone belt", ring: box(-82.0, 47.4, -75.8, 49.6), source: USGS },
  { id: "us_nevada", country: "United States", name: "Nevada Gold Trends (Carlin / Battle Mountain)", favorable: true, setting: "Carlin-type sediment-hosted gold", ring: box(-118.2, 39.4, -114.8, 41.6), source: USGS },
  { id: "us_california", country: "United States", name: "California Mother Lode", favorable: true, setting: "orogenic quartz-vein gold", ring: box(-121.6, 37.0, -120.0, 39.2), source: USGS },
  { id: "br_ferrifero", country: "Brazil", name: "Quadrilátero Ferrífero / Carajás", favorable: true, setting: "Archean–Proterozoic greenstone & iron formation gold", ring: box(-44.6, -20.7, -42.9, -19.5), source: USGS },
  { id: "cl_maricunga", country: "Chile", name: "Maricunga / El Indio Andean Belt", favorable: true, setting: "Andean high-sulfidation epithermal gold", ring: box(-70.6, -29.6, -68.9, -26.4), source: USGS },
  { id: "pe_north", country: "Peru", name: "Northern Peru Gold Belt (Yanacocha)", favorable: true, setting: "Andean epithermal & porphyry gold", ring: box(-79.2, -8.2, -76.8, -5.8), source: USGS },
  { id: "mx_sierramadre", country: "Mexico", name: "Sierra Madre Occidental Belt", favorable: true, setting: "epithermal gold–silver", ring: box(-109.2, 22.8, -104.8, 28.2), source: USGS },

  // ── Asia ─────────────────────────────────────────────────────────────────
  { id: "in_dharwar", country: "India", name: "Kolar & Hutti Belts (Dharwar Craton)", favorable: true, setting: "Archean greenstone belt", ring: box(76.0, 12.4, 78.6, 16.9), source: USGS },
  { id: "pk_chagai", country: "Pakistan", name: "Chagai (Reko Diq) Belt", favorable: true, setting: "porphyry copper–gold", ring: box(61.5, 28.4, 67.2, 30.6), source: USGS },
  { id: "af_badakhshan", country: "Afghanistan", name: "Badakhshan Gold Region", favorable: true, setting: "orogenic & placer gold", ring: box(69.4, 35.9, 71.6, 38.1), source: USGS },
  { id: "cn_jiaodong", country: "China", name: "Jiaodong Peninsula (Shandong)", favorable: true, setting: "mesozonal orogenic gold", ring: box(119.4, 36.4, 122.1, 38.1), source: USGS },
  { id: "mn_southgobi", country: "Mongolia", name: "South Gobi (Oyu Tolgoi) Belt", favorable: true, setting: "porphyry copper–gold", ring: box(104.8, 42.4, 108.2, 44.1), source: USGS },
  { id: "kz_eastkalba", country: "Kazakhstan", name: "Kalba–Narym Belt (East Kazakhstan)", favorable: true, setting: "orogenic gold", ring: box(78.0, 47.9, 84.2, 51.1), source: USGS },
  { id: "ru_lena", country: "Russia", name: "Lena Goldfield (Bodaibo)", favorable: true, setting: "orogenic gold", ring: box(112.0, 56.9, 116.2, 59.1), source: USGS },
  { id: "ru_kolyma", country: "Russia", name: "Kolyma Goldfield (Magadan)", favorable: true, setting: "orogenic & placer gold", ring: box(148.0, 60.9, 155.2, 64.1), source: USGS },
];

// ── Country-level fallback (used when only a typed country is available) ───
// Extension point: append countries here; matching is case-insensitive over
// `names` (include common aliases).
type GeoCountry = {
  names: string[]; // lowercased country names / aliases
  display: string;
  favorable: boolean;
  setting: string; // short phrase describing the national gold geology
  source: string;
};

const COUNTRIES: GeoCountry[] = [
  { names: ["somalia", "soomaaliya"], display: "Somalia", favorable: true, setting: "Proterozoic basement and greenstone belts in the northern mountains", source: `${USGS}; ${UN_UNDP}` },
  { names: ["ethiopia", "itoobiya"], display: "Ethiopia", favorable: true, setting: "Neoproterozoic greenstone belts (Adola and Western Ethiopia)", source: USGS },
  { names: ["kenya", "kiiniya"], display: "Kenya", favorable: true, setting: "the Migori–Lake Victoria Archean greenstone belt", source: USGS },
  { names: ["tanzania"], display: "Tanzania", favorable: true, setting: "the Lake Victoria Goldfield on the Archean Tanzania Craton", source: USGS },
  { names: ["uganda"], display: "Uganda", favorable: true, setting: "the Busia–Kakamega greenstone belt", source: USGS },
  { names: ["south africa", "rsa", "za"], display: "South Africa", favorable: true, setting: "the Witwatersrand Basin and Barberton greenstone belt", source: USGS },
  { names: ["namibia"], display: "Namibia", favorable: true, setting: "the Pan-African Damara Belt", source: USGS },
  { names: ["botswana"], display: "Botswana", favorable: true, setting: "the Tati and Francistown greenstone belts", source: USGS },
  { names: ["ghana"], display: "Ghana", favorable: true, setting: "the Ashanti Birimian greenstone belt, one of Africa's most productive gold regions", source: USGS },
  { names: ["mali"], display: "Mali", favorable: true, setting: "the Birimian greenstone belts of the Kéniéba and Sikasso regions", source: USGS },
  { names: ["burkina faso", "burkina"], display: "Burkina Faso", favorable: true, setting: "the Paleoproterozoic Birimian greenstone belts", source: USGS },
  { names: ["dr congo", "drc", "democratic republic of the congo", "congo-kinshasa"], display: "DR Congo", favorable: true, setting: "the Kilo–Moto greenstone belt in the northeast", source: USGS },
  { names: ["zambia"], display: "Zambia", favorable: false, setting: "metamorphic basement with limited documented gold (the Copperbelt is primarily copper)", source: USGS },
  { names: ["zimbabwe"], display: "Zimbabwe", favorable: true, setting: "the Zimbabwe Craton Archean greenstone belts", source: USGS },
  { names: ["mozambique"], display: "Mozambique", favorable: true, setting: "the Manica greenstone belt", source: USGS },
  { names: ["madagascar"], display: "Madagascar", favorable: true, setting: "Precambrian basement shear-zone goldfields", source: USGS },
  { names: ["australia"], display: "Australia", favorable: true, setting: "the Yilgarn and Pilbara Archean cratons", source: USGS },
  { names: ["canada"], display: "Canada", favorable: true, setting: "the Abitibi greenstone belt and other Precambrian shields", source: USGS },
  { names: ["united states", "usa", "us", "u.s.", "u.s.a."], display: "United States", favorable: true, setting: "the Nevada gold trends and the California Mother Lode", source: USGS },
  { names: ["brazil", "brasil"], display: "Brazil", favorable: true, setting: "the Quadrilátero Ferrífero and Carajás provinces", source: USGS },
  { names: ["chile"], display: "Chile", favorable: true, setting: "the Andean Maricunga and El Indio epithermal belts", source: USGS },
  { names: ["peru", "perú"], display: "Peru", favorable: true, setting: "the northern Peru Andean gold belt", source: USGS },
  { names: ["mexico", "méxico"], display: "Mexico", favorable: true, setting: "the Sierra Madre Occidental epithermal belt", source: USGS },
  { names: ["india"], display: "India", favorable: true, setting: "the Kolar and Hutti greenstone belts of the Dharwar Craton", source: USGS },
  { names: ["pakistan"], display: "Pakistan", favorable: true, setting: "the Chagai porphyry copper–gold belt", source: USGS },
  { names: ["afghanistan"], display: "Afghanistan", favorable: true, setting: "the Badakhshan orogenic and placer gold region", source: USGS },
  { names: ["china"], display: "China", favorable: true, setting: "the Jiaodong orogenic gold province", source: USGS },
  { names: ["mongolia"], display: "Mongolia", favorable: true, setting: "the South Gobi porphyry copper–gold belt", source: USGS },
  { names: ["kazakhstan"], display: "Kazakhstan", favorable: true, setting: "the Kalba–Narym orogenic gold belt", source: USGS },
  { names: ["russia", "russian federation"], display: "Russia", favorable: true, setting: "the Lena and Kolyma orogenic goldfields", source: USGS },
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

export type GeologyContext = {
  favorable: boolean;
  provinceName: string | null;
  documentedNearby: boolean;
  line: string; // the honest regional statement for the report
  source: string;
  resolvedBy: "gps" | "manual";
  locationLabel: string | null; // human-readable place, when known
};

type Translate = (en: string, so: string) => string;

// ── GPS resolver (primary) ─────────────────────────────────────────────────
export function regionalGeologyContext(lat: number, lng: number, L: Translate, _so: boolean): GeologyContext {
  const province = PROVINCES.find((p) => pointInRing(lng, lat, p.ring)) ?? null;
  return buildContext(province, "gps", null, L);
}

// ── Manual (typed country) resolver (fallback) ─────────────────────────────
export function geologyByPlace(
  place: { country?: string; region?: string; district?: string },
  L: Translate,
  _so: boolean,
): GeologyContext | null {
  const country = (place.country ?? "").trim().toLowerCase();
  if (!country) return null;
  // Exact match on any alias, or a substring match only for longer names (so
  // short aliases like "us"/"za" never false-match inside another word).
  const match =
    COUNTRIES.find((c) => c.names.some((n) => country === n || (n.length >= 5 && country.includes(n)))) ?? null;
  const label = [place.district, place.region, place.country].map((s) => (s ?? "").trim()).filter(Boolean).join(", ") || null;

  if (!match) {
    // Typed a country we don't have curated data for — honest, never negative.
    return {
      favorable: false,
      provinceName: null,
      documentedNearby: false,
      resolvedBy: "manual",
      locationLabel: label,
      line: L(
        "No geological reference data is currently available for this region in the offline knowledge base. This does not indicate the absence of gold — it reflects the limits of the bundled dataset.",
        "Xog juqraafi oo tixraac ah oo gobolkan kuma jirto knowledge base-ka offline-ka ah hadda. Tani MA muujinayso maqnaanshaha dahabka — waxay ka tarjumaysaa xaddidaadda xogta la keydiyay.",
      ),
      source: USGS,
    };
  }

  const favorable = match.favorable;
  const line = favorable
    ? L(
        `Based on the location you entered (${match.display}), the country hosts ${match.setting}.`,
        `Iyada oo lagu saleeyay goobta aad gelisay (${match.display}), wadanku wuxuu leeyahay ${match.setting}.`,
      )
    : L(
        `Based on the location you entered (${match.display}), documented gold-favorable formations are ${match.setting}.`,
        `Iyada oo lagu saleeyay goobta aad gelisay (${match.display}), qaababka dahab-saaxiibka ah waa ${match.setting}.`,
      );

  return {
    favorable,
    provinceName: match.display,
    documentedNearby: favorable,
    resolvedBy: "manual",
    locationLabel: label,
    line,
    source: match.source,
  };
}

function buildContext(
  province: GeoProvince | null,
  resolvedBy: "gps" | "manual",
  locationLabel: string | null,
  L: Translate,
): GeologyContext {
  if (province && province.favorable) {
    return {
      favorable: true,
      provinceName: province.name,
      documentedNearby: true,
      resolvedBy,
      locationLabel,
      line: L(
        `The specimen was found within ${province.name}, a region with documented gold mineralization (${province.setting}).`,
        `Shayga waxaa laga helay ${province.name}, gobol leh macdanayn dahab oo la diiwaangeliyay (${province.setting}).`,
      ),
      source: province.source,
    };
  }
  if (province) {
    return {
      favorable: false,
      provinceName: province.name,
      documentedNearby: false,
      resolvedBy,
      locationLabel,
      line: L(
        `The specimen is within ${province.name} (${province.setting}); documented gold occurrences in this specific area are limited.`,
        `Shaygu wuxuu ku dhex jiraa ${province.name} (${province.setting}); macdano dahab oo la diiwaangeliyay oo aaggan gaarka ah waa xaddidan yihiin.`,
      ),
      source: province.source,
    };
  }
  // No province matched — professional, never implies "no gold".
  return {
    favorable: false,
    provinceName: null,
    documentedNearby: false,
    resolvedBy,
    locationLabel,
    line: L(
      "No geological reference data is currently available for this location in the offline knowledge base. This does not indicate the absence of gold — it reflects the limits of the bundled dataset.",
      "Xog juqraafi oo tixraac ah oo goobtan kuma jirto knowledge base-ka offline-ka ah hadda. Tani MA muujinayso maqnaanshaha dahabka — waxay ka tarjumaysaa xaddidaadda xogta la keydiyay.",
    ),
    source: USGS,
  };
}

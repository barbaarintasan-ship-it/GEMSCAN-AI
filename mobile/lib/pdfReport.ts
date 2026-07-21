// Professional PDF report generation (Pro / "Gem Collector" tier only).
//
// This module is UI-agnostic: it takes a plain `PdfReportData` snapshot of a
// finished scan and produces a clean, print-ready PDF using expo-print, then
// hands it to the OS share sheet (WhatsApp, Email, Messages, Save to Files =
// "download") via expo-sharing. Entitlement is NOT checked here — the caller
// (results screen) gates this behind `features.pdfReports`, and scan access is
// already RLS-scoped server-side.
//
// Images are embedded as base64 data URIs (not left as remote signed URLs) so
// the specimen photo always renders in the exported PDF, even offline or after
// the signed URL expires mid-render.
//
// VISUAL DESIGN NOTE (laboratory-report redesign): only buildReportHtml's
// markup/CSS changed here — `PdfReportData` and every field it reads are
// unchanged, and generateAndSharePdf's download/share/print behavior is
// unchanged. This file has zero knowledge of scans/subscriptions/credits/AI
// providers; it only ever renders whatever data.ts already hands it.
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system";
import type { ExplanationStyle, ExpertExplanationDTO } from "./scanUpload";
import { priceUnitLabel, type PriceUnit } from "./valuation";

export type PdfReportImage = { uri: string; caption?: string };

export type PdfHallmark = {
  matchedLabel?: string | null; // e.g. "gold · 750 · London Assay Office · UK"
  marks?: string[]; // transcribed stamps, e.g. ["925", "18K"]
  note?: string | null;
};

export type PdfValuation = {
  unit?: PriceUnit;
  purity?: string | null;
  minUsd?: number | null;
  maxUsd?: number | null;
  typicalUsd?: number | null;
  note?: string | null;
  lowConfidence?: boolean;
};

export type PdfReportData = {
  scanId?: string | null;
  createdAt: string; // ISO timestamp
  bestMatch: string;
  confidencePct: number; // 0-100
  confidenceBand: "low" | "medium" | "high";
  reasoning?: string | null; // AI analysis / notes (legacy fallback)
  alternatives: { label: string; confidencePct: number; band?: string | null }[];
  valuation?: PdfValuation | null;
  hallmark?: PdfHallmark | null;
  images: PdfReportImage[]; // remote (signed) or local file:// URIs
  // Dual Explanation Modes: which style to render, plus whichever of the two
  // write-ups are available. `explanationStyle` picks which one is shown;
  // when the one it names is missing, the report falls back to whichever it
  // has, then to `reasoning`.
  explanationStyle?: ExplanationStyle | null;
  simpleExplanation?: string | null;
  expertExplanation?: ExpertExplanationDTO | null;
};

type Lang = "en" | "so";

// Status/band colors — used for the confidence badge, the confidence bar
// fill, and any other colored status indicator in the report.
const BAND_COLOR: Record<string, string> = {
  high: "#1E7A46",
  medium: "#B8860B",
  low: "#8A8F98",
};
const BAND_BG: Record<string, string> = {
  high: "#E6F4EC",
  medium: "#FBF1DC",
  low: "#EFE9D8",
};

// Grouped expert fields for the laboratory-style sections below — this is a
// PRESENTATION regrouping only. Every key here is the exact same
// ExpertExplanationDTO field the old flat "Gemological Analysis" table read;
// none are new, none are dropped, none are computed differently.
const PHYSICAL_FIELDS: { key: keyof ExpertExplanationDTO; en: string; so: string }[] = [
  { key: "mineralSpecies", en: "Mineral species", so: "Nooca macdanta" },
  { key: "variety", en: "Variety", so: "Nooca gaarka ah" },
  { key: "crystalSystem", en: "Crystal system", so: "Nidaamka kiristaalka" },
  { key: "chemicalComposition", en: "Chemical composition", so: "Dhismaha kiimikada" },
  { key: "mohsHardness", en: "Mohs hardness", so: "Adkaanta Mohs" },
  { key: "specificGravity", en: "Specific gravity", so: "Miisaanka gaarka ah" },
  { key: "refractiveIndex", en: "Refractive index", so: "Tirada dib-u-jiitanka" },
  { key: "cleavage", en: "Cleavage", so: "Kala-goynta" },
  { key: "fracture", en: "Fracture", so: "Jabka" },
  { key: "luster", en: "Luster", so: "Dhalaalka" },
  { key: "transparency", en: "Transparency", so: "Dhaafsanaanta" },
];
const ANALYSIS_FIELDS: { key: keyof ExpertExplanationDTO; en: string; so: string }[] = [
  { key: "diagnosticCharacteristics", en: "Diagnostic characteristics", so: "Astaamaha lagu aqoonsado" },
  { key: "geologicalOrigin", en: "Geological origin", so: "Asalka juqraafiga" },
  { key: "commonTreatments", en: "Common treatments", so: "Daaweynta caadiga ah" },
  { key: "syntheticIndicators", en: "Synthetic indicators", so: "Calaamadaha macmalka ah" },
  { key: "commonImitations", en: "Common imitations", so: "Ku-daydka caadiga ah" },
];
const MARKET_FIELDS: { key: keyof ExpertExplanationDTO; en: string; so: string }[] = [
  { key: "marketDemand", en: "Market demand", so: "Baahida suuqa" },
  { key: "wholesaleEstimate", en: "Wholesale estimate", so: "Qiyaasta jumlada" },
  { key: "retailEstimate", en: "Retail estimate", so: "Qiyaasta tafaariiqda" },
];
const RECOMMENDATION_FIELDS: { key: keyof ExpertExplanationDTO; en: string; so: string }[] = [
  { key: "confidenceReasoning", en: "Confidence reasoning", so: "Sababta kalsoonida" },
  { key: "investmentConsiderations", en: "Investment considerations", so: "Tixgelinta maalgashiga" },
];

// ── helpers ──────────────────────────────────────────────────────────────
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function guessMime(uri: string): string {
  const path = uri.split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".heic") || path.endsWith(".heif")) return "image/heic";
  return "image/jpeg";
}

// Convert any image URI (remote signed URL or local file) into a data: URI so
// it is embedded directly in the PDF and never depends on the network at
// render time. Returns null on failure so the report can drop that image.
async function toDataUri(uri: string): Promise<string | null> {
  try {
    if (!uri) return null;
    if (uri.startsWith("data:")) return uri;

    let localUri = uri;
    if (/^https?:\/\//i.test(uri)) {
      const target =
        (FileSystem.cacheDirectory ?? "") +
        `gemscan-pdf-img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const dl = await FileSystem.downloadAsync(uri, target);
      localUri = dl.uri;
    }
    const base64 = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return `data:${guessMime(uri)};base64,${base64}`;
  } catch {
    return null;
  }
}

function money(n: number): string {
  return `USD ${Math.round(n).toLocaleString("en-US")}`;
}

// Renders a `{ key, en, so }` field group as a kv table, skipping any field
// the data doesn't have — never fabricates a value. Returns "" if nothing in
// the group is present, so callers can skip the whole section.
function fieldGroupRows(
  fields: { key: keyof ExpertExplanationDTO; en: string; so: string }[],
  expert: ExpertExplanationDTO,
  t: (en: string, so: string) => string,
): string {
  return fields
    .filter(({ key }) => expert[key])
    .map(({ key, en, so }) => `<tr><th>${t(en, so)}</th><td>${esc(expert[key])}</td></tr>`)
    .join("");
}

// Small decorative gem mark for the masthead — an inline SVG rather than an
// emoji so it renders consistently (color, weight) across the different
// print engines each platform's share sheet ultimately uses.
const GEM_MARK_SVG = `<svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">
  <polygon points="17,1 30,11 17,33 4,11" fill="#1B2A4A"/>
  <polygon points="17,1 30,11 17,15 4,11" fill="#8C99AE"/>
  <polygon points="4,11 17,15 17,33" fill="#2C4270"/>
  <polygon points="30,11 17,15 17,33" fill="#1B2A4A"/>
  <polygon points="10,6 24,6 30,11 4,11" fill="#C7CCD1"/>
</svg>`;

// Decorative QR-shaped placeholder (NOT a real, scannable code — there is no
// verification URL/service behind it yet). Deliberately labeled as such in
// the markup so nobody mistakes it for a working verification link.
const QR_PLACEHOLDER_SVG = `<svg width="60" height="60" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
  <rect width="60" height="60" fill="#FFFFFF"/>
  <rect x="2" y="2" width="16" height="16" fill="none" stroke="#1B2A4A" stroke-width="3"/>
  <rect x="7" y="7" width="6" height="6" fill="#1B2A4A"/>
  <rect x="42" y="2" width="16" height="16" fill="none" stroke="#1B2A4A" stroke-width="3"/>
  <rect x="47" y="7" width="6" height="6" fill="#1B2A4A"/>
  <rect x="2" y="42" width="16" height="16" fill="none" stroke="#1B2A4A" stroke-width="3"/>
  <rect x="7" y="47" width="6" height="6" fill="#1B2A4A"/>
  <rect x="24" y="2" width="4" height="4" fill="#1B2A4A"/>
  <rect x="32" y="6" width="4" height="4" fill="#1B2A4A"/>
  <rect x="24" y="24" width="4" height="4" fill="#1B2A4A"/>
  <rect x="32" y="24" width="4" height="4" fill="#1B2A4A"/>
  <rect x="24" y="32" width="4" height="4" fill="#1B2A4A"/>
  <rect x="40" y="32" width="4" height="4" fill="#1B2A4A"/>
  <rect x="48" y="40" width="4" height="4" fill="#1B2A4A"/>
  <rect x="24" y="48" width="4" height="4" fill="#1B2A4A"/>
  <rect x="32" y="48" width="4" height="4" fill="#1B2A4A"/>
  <rect x="40" y="48" width="4" height="4" fill="#1B2A4A"/>
</svg>`;

// Round company seal, styled like a stamped authenticity/notary mark —
// placed near the disclaimer, not the header, so it reads as "this report
// was issued by us" rather than "this is an official certificate" (the
// disclaimer directly below it already says it explicitly is not one). The
// circular-text arcs use opposite sweep directions deliberately: the top arc
// sweeps clockwise (text reads upright left-to-right over the top) while the
// bottom arc sweeps counter-clockwise (text reads upright left-to-right
// under the bottom) — using the same sweep for both would render the bottom
// text upside-down and mirrored.
const SEAL_SVG = `<svg width="150" height="150" viewBox="0 0 150 150" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <path id="sealTopArc" d="M 20,75 A 55,55 0 1 1 130,75" fill="none"/>
    <path id="sealBottomArc" d="M 20,75 A 55,55 0 1 0 130,75" fill="none"/>
  </defs>
  <circle cx="75" cy="75" r="70" fill="none" stroke="#1E50A2" stroke-width="1.5" opacity="0.85"/>
  <circle cx="75" cy="75" r="62" fill="none" stroke="#1E50A2" stroke-width="2.5"/>
  <circle cx="75" cy="75" r="44" fill="none" stroke="#1E50A2" stroke-width="1"/>
  <text font-size="8.2" fill="#1E50A2" font-family="Georgia, serif" font-weight="700" letter-spacing="2.2">
    <textPath href="#sealTopArc" startOffset="50%" text-anchor="middle">GEMSCAN LAB COMPANY</textPath>
  </text>
  <text font-size="6.5" fill="#1E50A2" font-family="Georgia, serif" font-weight="600" letter-spacing="0.8">
    <textPath href="#sealBottomArc" startOffset="50%" text-anchor="middle">GEM IDENTIFICATION LAB</textPath>
  </text>
  <g transform="translate(75,75)">
    <polygon points="0,-18 15,-10 0,20 -15,-10" fill="none" stroke="#1E50A2" stroke-width="1.5"/>
    <polygon points="0,-18 15,-10 -15,-10" fill="none" stroke="#1E50A2" stroke-width="1"/>
  </g>
  <circle cx="46" cy="75" r="1.6" fill="#1E50A2"/>
  <circle cx="104" cy="75" r="1.6" fill="#1E50A2"/>
</svg>`;

// ── HTML builder (pure) ──────────────────────────────────────────────────
// `data.images` are expected to already be data: URIs here.
export function buildReportHtml(data: PdfReportData, lang: Lang): string {
  const t = (en: string, so: string) => (lang === "so" ? so : en);
  const band = data.confidenceBand;
  const bandColor = BAND_COLOR[band] ?? BAND_COLOR.low;
  const bandBg = BAND_BG[band] ?? BAND_BG.low;
  const bandWord =
    lang === "so"
      ? { high: "SARE", medium: "DHEXE", low: "HOOSE" }[band]
      : { high: "HIGH", medium: "MEDIUM", low: "LOW" }[band];
  const confidencePct = Math.max(0, Math.min(100, Math.round(data.confidencePct)));

  const issued = data.createdAt ? new Date(data.createdAt) : null;
  const issuedStr = issued ? issued.toLocaleDateString(lang === "so" ? "so-SO" : "en-GB") : "—";
  const verifiedStr = new Date().toLocaleDateString(lang === "so" ? "so-SO" : "en-GB");
  const reportId = (data.scanId ?? "").slice(0, 8).toUpperCase() || "N/A";
  const languageLabel = lang === "so" ? "Soomaali" : "English";

  // ── Specimen photo(s) — larger, framed, moved below the report-identity
  // block (see layout order at the bottom of this function).
  const imgs = (data.images ?? []).filter((i) => i.uri && i.uri.startsWith("data:"));
  const photoHtml = imgs.length
    ? `<section class="block photo-block">
         <div class="section-head"><span class="section-icon">📷</span><h2>${t("Specimen Photograph", "Sawirka Shayga")}</h2></div>
         <div class="photo-frame ${imgs.length === 1 ? "photo-frame--single" : ""}">
           ${imgs
             .map(
               (im) =>
                 `<figure><img src="${im.uri}" alt="specimen"/>${
                   im.caption ? `<figcaption>${esc(im.caption)}</figcaption>` : ""
                 }</figure>`,
             )
             .join("")}
         </div>
       </section>`
    : "";

  // ── Primary Identification + Confidence ──────────────────────────────
  const primaryIdHtml = `
    <section class="block">
      <div class="section-head"><span class="section-icon">🔎</span><h2>${t("Primary Identification", "Aqoonsiga Ugu Horreeya")}</h2></div>
      <div class="id-card">
        <div class="id-label">${t("Best Match", "Aqoonsiga ugu fiican")}</div>
        <h1 class="id-title">${esc(data.bestMatch)}</h1>
        <span class="badge" style="background:${bandBg};color:${bandColor};border-color:${bandColor}">
          ${bandWord} ${t("CONFIDENCE", "KALSOONI")}
        </span>
      </div>
    </section>
    <section class="block">
      <div class="section-head"><span class="section-icon">📊</span><h2>${t("Confidence", "Kalsooni")}</h2></div>
      <div class="conf-row">
        <div class="conf-bar-track"><div class="conf-bar-fill" style="width:${confidencePct}%;background:${bandColor}"></div></div>
        <div class="conf-pct" style="color:${bandColor}">${confidencePct}%</div>
      </div>
    </section>`;

  // ── Executive Summary — synthesized ONLY from fields already in `data`
  // (bestMatch/band/confidencePct), never new AI-generated text.
  const executiveSummaryHtml = `
    <section class="block">
      <div class="section-head"><span class="section-icon">📋</span><h2>${t("Executive Summary", "Soo Koobid Guud")}</h2></div>
      <p class="exec-summary">
        ${t(
          `This specimen was identified as <strong>${esc(data.bestMatch)}</strong> with ${bandWord.toLowerCase()} confidence (${confidencePct}%), based on advanced photographic analysis.`,
          `Shayga waxaa loo aqoonsaday <strong>${esc(data.bestMatch)}</strong> oo leh kalsooni ${bandWord.toLowerCase()} ah (${confidencePct}%), oo ku salaysan falanqaynta sawirrada ee horumarsan.`,
        )}
      </p>
    </section>`;

  // ── Physical Characteristics / AI Expert Analysis / Recommended Next
  // Tests / Professional Recommendations — all read from the SAME
  // expertExplanation object the old flat table used; just regrouped.
  const wantExpert = data.explanationStyle === "expert";
  const expert = data.expertExplanation ?? null;

  let physicalHtml = "";
  let analysisHtml = "";
  let nextTestsHtml = "";
  let recommendationsHtml = "";

  if (expert) {
    const physicalRows = fieldGroupRows(PHYSICAL_FIELDS, expert, t);
    if (physicalRows) {
      physicalHtml = `<section class="block">
          <div class="section-head"><span class="section-icon">🔬</span><h2>${t("Physical Characteristics", "Sifooyinka Jireed")}</h2></div>
          <table class="kv">${physicalRows}</table>
        </section>`;
    }

    const analysisRows = fieldGroupRows(ANALYSIS_FIELDS, expert, t);
    // Simple-mode reports show simpleExplanation as free text here instead of
    // the structured expert breakdown, matching the old fallback behavior.
    if (analysisRows || (!wantExpert && data.simpleExplanation)) {
      analysisHtml = `<section class="block">
          <div class="section-head"><span class="section-icon">🧪</span><h2>${t("Expert Analysis", "Falanqaynta Khibradda")}</h2></div>
          ${!wantExpert && data.simpleExplanation ? `<p class="body-text">${esc(data.simpleExplanation)}</p>` : ""}
          ${analysisRows ? `<table class="kv">${analysisRows}</table>` : ""}
        </section>`;
    }

    if (expert.recommendedLabTests) {
      nextTestsHtml = `<section class="block">
          <div class="section-head"><span class="section-icon">🧫</span><h2>${t("Recommended Next Tests", "Baaritaannada Xiga ee la Talinayo")}</h2></div>
          <p class="body-text">${esc(expert.recommendedLabTests)}</p>
        </section>`;
    }

    const recRows = fieldGroupRows(RECOMMENDATION_FIELDS, expert, t);
    if (recRows) {
      recommendationsHtml = `<section class="block">
          <div class="section-head"><span class="section-icon">✅</span><h2>${t("Professional Recommendations", "Talooyinka Xirfadeed")}</h2></div>
          <table class="kv">${recRows}</table>
        </section>`;
    }
  } else if (data.simpleExplanation) {
    analysisHtml = `<section class="block">
        <div class="section-head"><span class="section-icon">🧪</span><h2>${t("Expert Analysis", "Falanqaynta Khibradda")}</h2></div>
        <p class="body-text">${esc(data.simpleExplanation)}</p>
       </section>`;
  } else if (data.reasoning) {
    analysisHtml = `<section class="block">
         <div class="section-head"><span class="section-icon">🧪</span><h2>${t("Expert Analysis", "Falanqaynta Khibradda")}</h2></div>
         <p class="body-text">${esc(data.reasoning)}</p>
       </section>`;
  }

  // ── Alternative Identifications ──────────────────────────────────────
  const altsHtml = data.alternatives.length
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">🔁</span><h2>${t("Alternative Identifications", "Aqoonsiyo Kale oo Suurtagal ah")}</h2></div>
         <table class="alts">
           <thead><tr>
             <th>#</th>
             <th>${t("Possible identification", "Aqoonsi suurtagal ah")}</th>
             <th class="num">${t("Confidence", "Kalsooni")}</th>
           </tr></thead>
           <tbody>
             ${data.alternatives
               .map(
                 (a, i) =>
                   `<tr><td>${i + 2}</td><td>${esc(a.label)}</td><td class="num">${Math.round(
                     a.confidencePct,
                   )}%</td></tr>`,
               )
               .join("")}
           </tbody>
         </table>
       </section>`
    : "";

  // ── Estimated Market Value (numeric valuation + any qualitative market
  // fields the expert breakdown has) ───────────────────────────────────
  let valueHtml = "";
  const v = data.valuation;
  const marketRows = expert ? fieldGroupRows(MARKET_FIELDS, expert, t) : "";
  if (v && !v.lowConfidence && v.minUsd != null && v.maxUsd != null) {
    const unitLbl = priceUnitLabel(v.unit ?? "specimen", v.purity ?? null, lang === "so");
    const rangeLine = `<div class="value-figure">${money(v.minUsd)} – ${money(v.maxUsd)} <span class="value-unit">${esc(unitLbl)}</span></div>`;
    const typicalLine =
      v.typicalUsd != null
        ? `<div class="value-sub">${t("Typical", "Caadi ahaan")}: ~ ${money(v.typicalUsd)} ${esc(unitLbl)}</div>`
        : "";
    valueHtml = `<section class="block">
        <div class="section-head"><span class="section-icon">💰</span><h2>${t("Estimated Market Price", "Qiimaha Suuqa (Qiyaas)")}</h2></div>
        <div class="value-card">
          ${rangeLine}
          ${typicalLine}
          ${v.note ? `<div class="value-note">${esc(v.note)}</div>` : ""}
          ${marketRows ? `<table class="kv value-kv">${marketRows}</table>` : ""}
          <div class="estimate-tag">${t(
            "Estimated from photographs only. Final value depends on the actual weight, size, clarity, treatment, origin, condition, laboratory verification, and current market prices.",
            "Waxaa lagu qiyaasay sawirro kaliya. Qiimaha kama dambaysta ah wuxuu ku xidhan yahay culayska dhabta ah, cabbirka, saafinnimada, daaweynta, asalka, xaaladda, xaqiijinta shaybaarka, iyo qiimayaasha suuqa ee hadda.",
          )}</div>
        </div>
      </section>`;
  } else {
    valueHtml = `<section class="block">
        <div class="section-head"><span class="section-icon">💰</span><h2>${t("Estimated Market Value", "Qiimaha Suuqa (Qiyaas)")}</h2></div>
        <p class="muted">${t(
          "More photographs or laboratory testing are required for an accurate valuation.",
          "Sawirro dheeraad ah ama baaritaan shaybaar ayaa loo baahan yahay qiimayn sax ah.",
        )}</p>
        ${marketRows ? `<table class="kv">${marketRows}</table>` : ""}
      </section>`;
  }

  // ── Hallmark (only if detected) ──────────────────────────────────────
  let hallmarkHtml = "";
  const h = data.hallmark;
  const hasHallmark = h && ((h.marks && h.marks.length) || h.matchedLabel);
  if (hasHallmark) {
    hallmarkHtml = `<section class="block">
        <div class="section-head"><span class="section-icon">🏷️</span><h2>${t("Hallmark Information", "Macluumaadka Hallmark-ka")}</h2></div>
        <table class="kv">
          ${
            h!.marks && h!.marks.length
              ? `<tr><th>${t("Marks read", "Calaamadaha la akhriyay")}</th><td>${h!.marks
                  .map((m) => `<span class="chip">${esc(m)}</span>`)
                  .join(" ")}</td></tr>`
              : ""
          }
          ${
            h!.matchedLabel
              ? `<tr><th>${t("Reference match", "Isbarbardhig tixraac")}</th><td>${esc(
                  h!.matchedLabel,
                )}</td></tr>`
              : ""
          }
          ${h!.note ? `<tr><th>${t("Note", "Fiiro")}</th><td>${esc(h!.note)}</td></tr>` : ""}
        </table>
      </section>`;
  }

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GemScan Lab ${t("Identification Report", "Warbixinta Aqoonsiga")}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 26mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1B2430; font-size: 12.5px; line-height: 1.6; background: #FAF8F2;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .doc { max-width: 800px; margin: 0 auto; padding: 4px; }

  /* ── Masthead — report identity, first thing on the page ─────────── */
  header.masthead {
    display: flex; justify-content: space-between; align-items: flex-start;
    background: #0F1E3A; color: #fff; border-radius: 14px;
    padding: 22px 26px; margin-bottom: 20px;
  }
  .brand-row { display: flex; align-items: center; gap: 12px; }
  .brand-mark { flex: none; width: 40px; height: 40px; }
  .brand-mark svg { width: 100%; height: 100%; }
  .brand-text .brand-name { font-size: 21px; font-weight: 800; letter-spacing: .3px; }
  .brand-text .brand-company { font-size: 10.5px; color: #C7CCD1; letter-spacing: .6px; text-transform: uppercase; margin-top: 2px; }
  .brand-text .brand-tagline { font-size: 11px; color: #9AA5B8; margin-top: 6px; }

  .id-meta { text-align: right; display: flex; align-items: flex-start; gap: 14px; }
  .id-meta-list { font-size: 10.5px; color: #C7CCD1; line-height: 1.9; }
  .id-meta-list b { color: #fff; }
  .qr-box { flex: none; text-align: center; }
  .qr-box .qr-caption { font-size: 8px; color: #8C99AE; margin-top: 4px; max-width: 62px; }

  section.block { margin: 0 0 18px; page-break-inside: avoid; }
  .section-head { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #E1D9C4; padding-bottom: 6px; margin-bottom: 10px; }
  .section-icon { font-size: 14px; line-height: 1; }
  section.block h2 {
    font-size: 12.5px; text-transform: uppercase; letter-spacing: .6px; color: #4A5568;
    margin: 0; font-weight: 700;
  }
  .body-text { margin: 0 0 8px; color: #333; }
  .muted { color: #8A8F98; }

  /* ── Executive Summary ────────────────────────────────────────────── */
  .exec-summary { background: #F1ECDF; border-left: 3px solid #1B2A4A; border-radius: 8px; padding: 14px 16px; margin: 0; color: #222; }

  /* ── Photo (moved lower, larger, framed) ──────────────────────────── */
  .photo-frame { display: flex; flex-wrap: wrap; gap: 12px; }
  .photo-frame figure {
    margin: 0; width: calc(50% - 6px); background: #F1ECDF; border: 1px solid #E1D9C4;
    border-radius: 12px; padding: 8px;
  }
  .photo-frame--single figure { width: 100%; }
  .photo-frame img { width: 100%; height: 320px; object-fit: cover; border-radius: 8px; display: block; }
  .photo-frame--single img { height: 380px; }
  .photo-frame figcaption { font-size: 10px; color: #8A8F98; margin-top: 6px; text-align: center; }

  /* ── Primary Identification ───────────────────────────────────────── */
  .id-card { background: #F1ECDF; border-radius: 10px; padding: 16px 18px; }
  .id-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; color: #8A8F98; }
  .id-title { font-size: 25px; margin: 3px 0 10px; color: #0F1E3A; }
  .badge {
    display: inline-block; font-weight: 800; font-size: 10.5px;
    padding: 5px 13px; border-radius: 999px; letter-spacing: .4px; border: 1px solid;
  }

  /* ── Confidence bar ────────────────────────────────────────────────── */
  .conf-row { display: flex; align-items: center; gap: 12px; }
  .conf-bar-track { flex: 1; height: 10px; background: #E7E0CF; border-radius: 999px; overflow: hidden; }
  .conf-bar-fill { height: 100%; border-radius: 999px; }
  .conf-pct { font-size: 15px; font-weight: 800; width: 48px; text-align: right; }

  /* ── Tables ────────────────────────────────────────────────────────── */
  table { width: 100%; border-collapse: collapse; }
  table.alts th, table.alts td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #EFE9D8; font-size: 12px; }
  table.alts thead th { color: #8A8F98; font-size: 10.5px; text-transform: uppercase; letter-spacing: .4px; border-bottom: 1px solid #E1D9C4; }
  table.alts .num { text-align: right; font-weight: 700; color: #1B2A4A; }
  table.kv th { text-align: left; width: 38%; vertical-align: top; padding: 6px 8px; color: #666; font-weight: 600; font-size: 11.5px; }
  table.kv td { padding: 6px 8px; font-size: 12px; }
  table.value-kv { margin-top: 10px; }
  .chip { display: inline-block; background: #EFE9D8; border: 1px solid #C7CCD1; color: #1B2A4A;
          border-radius: 6px; padding: 2px 8px; font-weight: 700; font-family: monospace; }

  /* ── Market value ──────────────────────────────────────────────────── */
  .value-card { background: #F1ECDF; border: 1px solid #E1D9C4; border-radius: 12px; padding: 16px; }
  .value-figure { font-size: 23px; font-weight: 800; color: #0F1E3A; }
  .value-unit { font-size: 13px; font-weight: 700; color: #B8860B; }
  .value-sub { font-size: 12.5px; color: #444; margin-top: 2px; }
  .value-note { font-size: 12px; color: #555; margin-top: 6px; }
  .estimate-tag {
    display: inline-block; margin-top: 10px; background: #FBF1DC; color: #7A5C00;
    border: 1px solid #E6CF85; border-radius: 6px; padding: 4px 10px; font-size: 10.5px; font-weight: 700;
  }

  /* ── Footer (repeats on every printed page via position:fixed — the
       underlying print engines here don't support CSS Paged Media page-
       counter boxes, so "Page X of Y" numbering isn't included; see the
       written summary). ───────────────────────────────────────────────── */
  footer.doc-footer {
    position: fixed; bottom: 0; left: 0; right: 0;
    border-top: 1px solid #E1D9C4; padding: 10px 16px 0;
    font-size: 9.5px; color: #8A8F98; display: flex; justify-content: space-between;
  }
  footer.doc-footer .f-left b { color: #1B2A4A; }
  footer.doc-footer .f-right { text-align: right; }

  .disclaimer-block {
    margin-top: 20px; border-top: 1px solid #E1D9C4; padding-top: 12px;
    font-size: 10.5px; color: #6b7280; line-height: 1.7;
  }
  .disclaimer-block strong { color: #1B2A4A; }

  .seal-row { display: flex; justify-content: center; margin-top: 10px; page-break-inside: avoid; }
  .seal-mark { width: 122px; height: 122px; transform: rotate(-8deg); opacity: 0.95; }
  .seal-mark svg { width: 100%; height: 100%; }
  .signature-block { margin-top: 2px; text-align: center; page-break-inside: avoid; }
  .signature-name { font-family: 'Segoe Script', 'Bradley Hand', 'Snell Roundhand', cursive; font-size: 27px; font-style: italic; color: #1E50A2; line-height: 1.1; }
  .signature-line { width: 170px; height: 1px; background: #1E50A2; opacity: 0.55; margin: 3px auto; }
  .signature-label { font-size: 10px; color: #555; letter-spacing: 0.4px; }
</style>
</head>
<body>
  <div class="doc">
    <header class="masthead">
      <div class="brand-row">
        <div class="brand-mark">${GEM_MARK_SVG}</div>
        <div class="brand-text">
          <div class="brand-name">GemScan Lab Company</div>
          <div class="brand-company">${t("Professional Gem Identification Report", "Warbixin Aqoonsi Dhagxaan oo Khibrad leh")}</div>
        </div>
      </div>
      <div class="id-meta">
        <div class="id-meta-list">
          <div>${t("Report No.", "Lambarka Warbixinta")}: <b>${esc(reportId)}</b></div>
          <div>${t("Issue Date", "Taariikhda Bixinta")}: <b>${esc(issuedStr)}</b></div>
          <div>${t("Verification Date", "Taariikhda Xaqiijinta")}: <b>${esc(verifiedStr)}</b></div>
          <div>${t("Language", "Luqadda")}: <b>${esc(languageLabel)}</b></div>
        </div>
        <div class="qr-box">
          ${QR_PLACEHOLDER_SVG}
          <div class="qr-caption">${t("Verification QR — coming soon", "QR Xaqiijin — dhawaan")}</div>
        </div>
      </div>
    </header>

    ${executiveSummaryHtml}

    ${photoHtml}

    ${primaryIdHtml}

    ${physicalHtml}

    ${altsHtml}

    ${analysisHtml}

    ${valueHtml}

    ${hallmarkHtml}

    ${nextTestsHtml}

    ${recommendationsHtml}

    <div class="seal-row">
      <div class="seal-mark">${SEAL_SVG}</div>
    </div>
    <div class="signature-block">
      <div class="signature-name">Aw-Musse</div>
      <div class="signature-line"></div>
      <div class="signature-label">${t("Authorized signature", "Saxiixa la ogolaaday")}</div>
    </div>

    <div class="disclaimer-block">
      <strong>${t("Disclaimer", "Ogeysiis")}:</strong>
      ${t(
        "This report was generated by the GemScan Lab Company digital laboratory system, from photographs provided by the user. This report provides a professional laboratory-based assessment — it is NOT an official laboratory certificate and does not constitute absolute certainty. For legal certification, insurance, or commercial transactions, independent laboratory confirmation is recommended.",
        "Warbixintan waxaa soo saaray nidaamka shaybaarka dhijitaalka ah ee GemScan Lab Company, iyada oo lagu saleeyay sawirro uu bixiyay isticmaaluhu. Warbixintani waxay bixisaa qiimayn shaybaar oo xirfadeed ah — MAAHA shahaado shaybaar rasmi ah, mana tilmaamayso hubaal buuxa. Waxyaabaha lagu sameynayo shahaadayn sharci, caymis, ama macaamil ganacsi, waxaa lagula talinayaa xaqiijin shaybaar madax-banaan.",
      )}
    </div>

    <footer class="doc-footer">
      <div class="f-left">
        <b>GemScan Lab Company</b> — ${t("Gem Identification Laboratory", "Shaybaar Aqoonsi Dhagxaan")}<br/>
        gemscan.ai &nbsp;·&nbsp; support@gemscan.ai
      </div>
      <div class="f-right">
        ${t("Report ID", "Aqoonsiga Warbixinta")}: ${esc(reportId)}
      </div>
    </footer>
  </div>
</body>
</html>`;
}

// ── generate + share ─────────────────────────────────────────────────────
// Embeds images, renders the PDF, gives it a friendly filename (so "Save to
// Files" reads as a real download), and opens the native share sheet.
export async function generateAndSharePdf(
  data: PdfReportData,
  lang: Lang,
): Promise<{ uri: string } | null> {
  // Embed every image as a data URI (drop any that fail to load).
  const embedded = await Promise.all(
    (data.images ?? []).map(async (im) => ({
      uri: (await toDataUri(im.uri)) ?? "",
      caption: im.caption,
    })),
  );
  const html = buildReportHtml(
    { ...data, images: embedded.filter((i) => i.uri) },
    lang,
  );

  const { uri } = await Print.printToFileAsync({ html, base64: false });

  // Rename to a human-friendly filename for the share/save target.
  const safeName =
    "GemScan-Report-" +
    (data.bestMatch || "scan").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) +
    ".pdf";
  let shareUri = uri;
  try {
    const dest = (FileSystem.cacheDirectory ?? "") + safeName;
    await FileSystem.copyAsync({ from: uri, to: dest });
    shareUri = dest;
  } catch {
    /* keep the original temp uri if the rename fails */
  }

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(shareUri, {
      mimeType: "application/pdf",
      UTI: "com.adobe.pdf",
      dialogTitle:
        lang === "so" ? "La wadaag warbixinta GemScan" : "Share your GemScan report",
    });
  }
  return { uri: shareUri };
}

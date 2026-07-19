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
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system";
import type { ExplanationStyle, ExpertExplanationDTO } from "./scanUpload";

export type PdfReportImage = { uri: string; caption?: string };

export type PdfHallmark = {
  matchedLabel?: string | null; // e.g. "gold · 750 · London Assay Office · UK"
  marks?: string[]; // transcribed stamps, e.g. ["925", "18K"]
  note?: string | null;
};

export type PdfValuation = {
  minUsd?: number | null;
  typicalUsd?: number | null;
  premiumUsd?: number | null;
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

const BAND_COLOR: Record<string, string> = {
  high: "#2E7D32",
  medium: "#C9A227",
  low: "#8A8A8E",
};

// Labeled technical fields for the Expert report table, in display order —
// mirrors app/(app)/scan/results.tsx's EXPERT_FIELD_ORDER.
const EXPERT_FIELDS: { key: keyof ExpertExplanationDTO; en: string; so: string }[] = [
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
  { key: "diagnosticCharacteristics", en: "Diagnostic characteristics", so: "Astaamaha lagu aqoonsado" },
  { key: "geologicalOrigin", en: "Geological origin", so: "Asalka juqraafiga" },
  { key: "commonTreatments", en: "Common treatments", so: "Daaweynta caadiga ah" },
  { key: "syntheticIndicators", en: "Synthetic indicators", so: "Calaamadaha macmalka ah" },
  { key: "commonImitations", en: "Common imitations", so: "Ku-daydka caadiga ah" },
  { key: "confidenceReasoning", en: "Confidence reasoning", so: "Sababta kalsoonida" },
  { key: "recommendedLabTests", en: "Recommended lab tests", so: "Baaritaannada shaybaarka la talinayo" },
  { key: "marketDemand", en: "Market demand", so: "Baahida suuqa" },
  { key: "wholesaleEstimate", en: "Wholesale estimate", so: "Qiyaasta jumlada" },
  { key: "retailEstimate", en: "Retail estimate", so: "Qiyaasta tafaariiqda" },
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

// ── HTML builder (pure) ──────────────────────────────────────────────────
// `data.images` are expected to already be data: URIs here.
export function buildReportHtml(data: PdfReportData, lang: Lang): string {
  const t = (en: string, so: string) => (lang === "so" ? so : en);
  const band = data.confidenceBand;
  const bandColor = BAND_COLOR[band] ?? "#8A8A8E";
  const bandWord =
    lang === "so"
      ? { high: "SARE", medium: "DHEXE", low: "HOOSE" }[band]
      : band.toUpperCase();

  const when = data.createdAt ? new Date(data.createdAt) : null;
  const whenStr = when ? when.toLocaleString(lang === "so" ? "so-SO" : "en-GB") : "";
  const reportId = (data.scanId ?? "").slice(0, 8).toUpperCase();

  // Images
  const imgs = (data.images ?? []).filter((i) => i.uri && i.uri.startsWith("data:"));
  const imagesHtml = imgs.length
    ? `<div class="images">${imgs
        .map(
          (im) =>
            `<figure><img src="${im.uri}" alt="specimen"/>${
              im.caption ? `<figcaption>${esc(im.caption)}</figcaption>` : ""
            }</figure>`,
        )
        .join("")}</div>`
    : "";

  // Alternatives
  const altsHtml = data.alternatives.length
    ? `<section class="block">
         <h2>${t("Alternative Matches", "Ikhtiyaarro Kale")}</h2>
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

  // Market value
  let valueHtml = "";
  const v = data.valuation;
  if (v && !v.lowConfidence && (v.minUsd != null || v.typicalUsd != null)) {
    const rangeLine =
      v.minUsd != null && v.premiumUsd != null
        ? `<div class="value-figure">${money(v.minUsd)} – ${money(v.premiumUsd)}</div>`
        : v.typicalUsd != null
          ? `<div class="value-figure">~ ${money(v.typicalUsd)}</div>`
          : "";
    const typicalLine =
      v.minUsd != null && v.premiumUsd != null && v.typicalUsd != null
        ? `<div class="value-sub">${t("Typical value", "Qiimaha caadiga")}: ~ ${money(v.typicalUsd)}</div>`
        : "";
    valueHtml = `<section class="block">
        <h2>${t("Estimated Market Value", "Qiimaha Suuqa (Qiyaas)")}</h2>
        <div class="value-card">
          ${rangeLine}
          ${typicalLine}
          ${v.note ? `<div class="value-note">${esc(v.note)}</div>` : ""}
          <div class="estimate-tag">${t(
            "ESTIMATE ONLY — based on photographs, not an official appraisal",
            "QIYAAS KALIYA — ku saleysan sawirro, maaha qiimayn rasmi ah",
          )}</div>
        </div>
      </section>`;
  } else {
    valueHtml = `<section class="block">
        <h2>${t("Estimated Market Value", "Qiimaha Suuqa (Qiyaas)")}</h2>
        <p class="muted">${t(
          "More photographs or laboratory testing are required for an accurate valuation.",
          "Sawirro dheeraad ah ama baaritaan shaybaar ayaa loo baahan yahay qiimayn sax ah.",
        )}</p>
      </section>`;
  }

  // Hallmark (only if detected)
  let hallmarkHtml = "";
  const h = data.hallmark;
  const hasHallmark = h && ((h.marks && h.marks.length) || h.matchedLabel);
  if (hasHallmark) {
    hallmarkHtml = `<section class="block">
        <h2>${t("Hallmark Information", "Macluumaadka Hallmark-ka")}</h2>
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

  // AI analysis / notes — Dual Explanation Modes: render whichever style was
  // requested, falling back to the other if it's the only one available, and
  // finally to the legacy free-text `reasoning` for pre-feature scans.
  const wantExpert = data.explanationStyle === "expert";
  let notesHtml = "";
  if (wantExpert && data.expertExplanation) {
    const rows = EXPERT_FIELDS.filter(({ key }) => data.expertExplanation![key])
      .map(({ key, en, so }) => `<tr><th>${t(en, so)}</th><td>${esc(data.expertExplanation![key])}</td></tr>`)
      .join("");
    notesHtml = `<section class="block">
        <h2>${t("Gemological Analysis", "Falanqaynta Dhagaxa")}</h2>
        <table class="kv">${rows}</table>
      </section>`;
  } else if (data.simpleExplanation) {
    notesHtml = `<section class="block">
        <h2>${t("AI Analysis & Notes", "Falanqaynta AI & Fiirooyin")}</h2>
        <p>${esc(data.simpleExplanation)}</p>
       </section>`;
  } else if (data.expertExplanation) {
    const rows = EXPERT_FIELDS.filter(({ key }) => data.expertExplanation![key])
      .map(({ key, en, so }) => `<tr><th>${t(en, so)}</th><td>${esc(data.expertExplanation![key])}</td></tr>`)
      .join("");
    notesHtml = `<section class="block">
        <h2>${t("Gemological Analysis", "Falanqaynta Dhagaxa")}</h2>
        <table class="kv">${rows}</table>
      </section>`;
  } else if (data.reasoning) {
    notesHtml = `<section class="block">
         <h2>${t("AI Analysis & Notes", "Falanqaynta AI & Fiirooyin")}</h2>
         <p>${esc(data.reasoning)}</p>
       </section>`;
  }

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GemScan ${t("Identification Report", "Warbixinta Aqoonsiga")}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1c1c1e; font-size: 12.5px; line-height: 1.55; background: #fff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .doc { max-width: 800px; margin: 0 auto; padding: 8px; }

  header.masthead {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 3px solid #C9A227; padding-bottom: 12px; margin-bottom: 18px;
  }
  .brand { font-size: 22px; font-weight: 800; color: #0B0B0C; }
  .brand .gem { color: #C9A227; }
  .brand-sub { font-size: 11px; color: #6b571a; letter-spacing: .4px; text-transform: uppercase; margin-top: 2px; }
  .meta { text-align: right; font-size: 11px; color: #666; line-height: 1.7; }
  .meta b { color: #1c1c1e; }

  .hero { margin: 4px 0 16px; }
  .hero .id-label { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: #8A8A8E; }
  .hero h1 { font-size: 26px; margin: 2px 0 8px; color: #0B0B0C; }
  .band {
    display: inline-block; color: #fff; font-weight: 800; font-size: 11px;
    padding: 5px 12px; border-radius: 999px; letter-spacing: .4px;
  }

  .images { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0 4px; }
  .images figure { margin: 0; width: calc(50% - 5px); }
  .images img {
    width: 100%; height: 220px; object-fit: cover; border-radius: 10px;
    border: 1px solid #e5e0d2; background: #f3f0e8;
  }
  .images figcaption { font-size: 10px; color: #888; margin-top: 3px; text-align: center; }
  .images figure:only-child img { height: 300px; }

  section.block { margin: 16px 0; page-break-inside: avoid; }
  section.block h2 {
    font-size: 13px; text-transform: uppercase; letter-spacing: .5px; color: #6b571a;
    border-bottom: 1px solid #eadfc4; padding-bottom: 5px; margin: 0 0 8px;
  }
  section.block p { margin: 0; }
  .muted { color: #888; }

  table { width: 100%; border-collapse: collapse; }
  table.alts th, table.alts td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #eee; font-size: 12px; }
  table.alts thead th { color: #8A8A8E; font-size: 10.5px; text-transform: uppercase; letter-spacing: .4px; border-bottom: 1px solid #e5e0d2; }
  table.alts .num { text-align: right; font-weight: 700; color: #6b571a; }
  table.kv th { text-align: left; width: 38%; vertical-align: top; padding: 6px 8px; color: #666; font-weight: 600; }
  table.kv td { padding: 6px 8px; }
  .chip { display: inline-block; background: #f6f1e3; border: 1px solid #d8ca9c; color: #6b571a;
          border-radius: 6px; padding: 2px 8px; font-weight: 700; font-family: monospace; }

  .value-card { background: #fbfaf6; border: 1px solid #eadfc4; border-radius: 12px; padding: 14px; }
  .value-figure { font-size: 22px; font-weight: 800; color: #9a7d1f; }
  .value-sub { font-size: 12.5px; color: #444; margin-top: 2px; }
  .value-note { font-size: 12px; color: #555; margin-top: 6px; }
  .estimate-tag {
    display: inline-block; margin-top: 10px; background: #fff3d6; color: #7a5c00;
    border: 1px solid #e6cf85; border-radius: 6px; padding: 4px 10px; font-size: 10.5px; font-weight: 700;
  }

  footer.disclaimer {
    margin-top: 24px; border-top: 1px solid #e5e0d2; padding-top: 12px;
    font-size: 10.5px; color: #8a8a8e; line-height: 1.6;
  }
  footer.disclaimer strong { color: #6b571a; }
</style>
</head>
<body>
  <div class="doc">
    <header class="masthead">
      <div>
        <div class="brand"><span class="gem">💎 Gem</span>Scan</div>
        <div class="brand-sub">${t("Identification Report", "Warbixinta Aqoonsiga")}</div>
      </div>
      <div class="meta">
        ${reportId ? `<div>${t("Report", "Warbixin")} #<b>${esc(reportId)}</b></div>` : ""}
        ${whenStr ? `<div>${t("Scanned", "La baaray")}: <b>${esc(whenStr)}</b></div>` : ""}
        <div>${t("Generated", "La sameeyay")}: <b>${esc(
          new Date().toLocaleString(lang === "so" ? "so-SO" : "en-GB"),
        )}</b></div>
      </div>
    </header>

    <div class="hero">
      <div class="id-label">${t("Best Match", "Aqoonsiga ugu fiican")}</div>
      <h1>${esc(data.bestMatch)}</h1>
      <span class="band" style="background:${bandColor}">${bandWord} ${t(
        "CONFIDENCE",
        "KALSOONI",
      )} · ${Math.round(data.confidencePct)}%</span>
    </div>

    ${imagesHtml}

    ${notesHtml}

    ${altsHtml}

    ${valueHtml}

    ${hallmarkHtml}

    <footer class="disclaimer">
      <strong>${t("Disclaimer", "Ogeysiis")}:</strong>
      ${t(
        "This report is generated by GemScan's AI identification system from photographs provided by the user. It is NOT an official laboratory certificate and NOT a professional appraisal. Identifications and values shown are estimates and may be inaccurate. For high-value items, always seek a certified gemologist or accredited laboratory before buying, selling, insuring, or modifying the item.",
        "Warbixintan waxaa soo saaray nidaamka aqoonsiga AI ee GemScan iyada oo lagu saleeyay sawirro uu bixiyay isticmaaluhu. MAAHA shahaado shaybaar rasmi ah, MAANA ahan qiimayn xirfadeed. Aqoonsiga iyo qiimayaasha la muujiyay waa qiyaas, wayna khaldami karaan. Waxyaabaha qiimaha weyn leh, mar walba la tasho khabiir dhagxaan oo shahaado leh ama shaybaar aqoonsan ka hor iibsashada, iibinta, caymiska, ama wax ka beddelka.",
      )}
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

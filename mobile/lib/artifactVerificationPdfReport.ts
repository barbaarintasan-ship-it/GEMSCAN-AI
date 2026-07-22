// PDF export for the $10 Artifact Verification Report result — a dedicated
// builder, mirroring lib/goldVerificationPdfReport.ts. Deliberately duplicates
// the small helpers/visual language rather than importing, matching how the
// other verification PDF builders each keep zero shared dependency.
//
// Only ever called after a report has actually unlocked (verdict present) —
// never gates/checks entitlement itself.
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system";
import type { ArtifactVerificationVerdict } from "./artifactVerification";

type Lang = "en" | "so";

export type ArtifactVerificationPdfData = {
  scanId?: string | null;
  verificationId: string;
  generatedAt: string; // ISO timestamp — when the verdict was produced
  photoUri?: string | null; // remote (signed) or local file:// URI
  verdict: ArtifactVerificationVerdict;
  recommendationLabel: string; // already-localized label (verify-artifact.tsx's RECOMMENDATION_LABELS)
};

const BAND_COLOR: Record<string, string> = { high: "#1E7A46", medium: "#B8860B", low: "#8A8F98" };
const BAND_BG: Record<string, string> = { high: "#E6F4EC", medium: "#FBF1DC", low: "#EFE9D8" };

const EVIDENCE_BANDS: { min: number; en: string; so: string; color: string }[] = [
  { min: 95, en: "Exceptional evidence", so: "Caddayn aad u fiican", color: "#1E7A46" },
  { min: 85, en: "Strong evidence", so: "Caddayn xoog leh", color: "#1E7A46" },
  { min: 70, en: "Moderate evidence", so: "Caddayn dhexdhexaad ah", color: "#B8860B" },
  { min: 50, en: "Limited evidence", so: "Caddayn xaddidan", color: "#B8860B" },
  { min: 0, en: "Insufficient evidence", so: "Caddayn aan ku filnayn", color: "#8A8F98" },
];
function evidenceBand(score: number) {
  return EVIDENCE_BANDS.find((b) => score >= b.min) ?? EVIDENCE_BANDS[EVIDENCE_BANDS.length - 1];
}

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

async function toDataUri(uri: string | null | undefined): Promise<string | null> {
  try {
    if (!uri) return null;
    if (uri.startsWith("data:")) return uri;
    let localUri = uri;
    if (/^https?:\/\//i.test(uri)) {
      const target =
        (FileSystem.cacheDirectory ?? "") +
        `gemscan-artifact-pdf-img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const dl = await FileSystem.downloadAsync(uri, target);
      localUri = dl.uri;
    }
    const base64 = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
    return `data:${guessMime(uri)};base64,${base64}`;
  } catch {
    return null;
  }
}

const GEM_MARK_SVG = `<svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">
  <polygon points="17,1 30,11 17,33 4,11" fill="#1B2A4A"/>
  <polygon points="17,1 30,11 17,15 4,11" fill="#8C99AE"/>
  <polygon points="4,11 17,15 17,33" fill="#2C4270"/>
  <polygon points="30,11 17,15 17,33" fill="#1B2A4A"/>
  <polygon points="10,6 24,6 30,11 4,11" fill="#C7CCD1"/>
</svg>`;

// Round company seal — placed near the disclaimer (not the header) so it reads
// as "issued by us" rather than "official certificate"; opposite arc sweep
// directions so the bottom text renders upright.
const SEAL_SVG = `<svg width="150" height="150" viewBox="0 0 150 150" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <path id="sealTopArc" d="M 20,75 A 55,55 0 1 1 130,75" fill="none"/>
    <path id="sealBottomArc" d="M 20,75 A 55,55 0 1 0 130,75" fill="none"/>
  </defs>
  <circle cx="75" cy="75" r="70" fill="none" stroke="#C9A227" stroke-width="1.5" opacity="0.85"/>
  <circle cx="75" cy="75" r="62" fill="none" stroke="#C9A227" stroke-width="2.5"/>
  <circle cx="75" cy="75" r="44" fill="none" stroke="#C9A227" stroke-width="1"/>
  <text font-size="8.2" fill="#C9A227" font-family="Georgia, serif" font-weight="700" letter-spacing="2.2">
    <textPath href="#sealTopArc" startOffset="50%" text-anchor="middle">LUULSCAN LAB COMPANY</textPath>
  </text>
  <text font-size="6.5" fill="#C9A227" font-family="Georgia, serif" font-weight="600" letter-spacing="0.8">
    <textPath href="#sealBottomArc" startOffset="50%" text-anchor="middle">GEM IDENTIFICATION LAB</textPath>
  </text>
  <g transform="translate(75,75)">
    <polygon points="0,-18 15,-10 0,20 -15,-10" fill="none" stroke="#C9A227" stroke-width="1.5"/>
    <polygon points="0,-18 15,-10 -15,-10" fill="none" stroke="#C9A227" stroke-width="1"/>
  </g>
  <circle cx="46" cy="75" r="1.6" fill="#C9A227"/>
  <circle cx="104" cy="75" r="1.6" fill="#C9A227"/>
</svg>`;

export function buildArtifactVerificationReportHtml(data: ArtifactVerificationPdfData, lang: Lang): string {
  const t = (en: string, so: string) => (lang === "so" ? so : en);
  const v = data.verdict;
  const band = v.confidence >= 0.72 ? "high" : v.confidence >= 0.45 ? "medium" : "low";
  const bandColor = BAND_COLOR[band];
  const bandBg = BAND_BG[band];
  const bandWord =
    lang === "so" ? { high: "SARE", medium: "DHEXE", low: "HOOSE" }[band] : { high: "HIGH", medium: "MEDIUM", low: "LOW" }[band];
  const confidencePct = Math.round(v.confidence * 100);
  const eBand = evidenceBand(v.evidenceScore);

  const generated = new Date(data.generatedAt);
  const generatedStr = generated.toLocaleDateString(lang === "so" ? "so-SO" : "en-GB");
  const verifiedStr = new Date().toLocaleDateString(lang === "so" ? "so-SO" : "en-GB");
  const reportId = (data.verificationId ?? "").slice(0, 8).toUpperCase() || "N/A";
  const languageLabel = lang === "so" ? "Soomaali" : "English";

  const photoHtml =
    data.photoUri && data.photoUri.startsWith("data:")
      ? `<section class="block">
           <div class="section-head"><span class="section-icon">📷</span><h2>${t("Object Photograph", "Sawirka Shayga")}</h2></div>
           <div class="photo-frame photo-frame--single"><figure><img src="${data.photoUri}" alt="artifact"/></figure></div>
         </section>`
      : "";

  const evidenceCard = `
    <section class="block">
      <div class="section-head"><span class="section-icon">📊</span><h2>${t("Evidence Score", "Dhibcaha Caddaynta")}</h2></div>
      <div class="value-card">
        <div class="value-figure" style="color:${eBand.color}">${v.evidenceScore} / 100</div>
        <div class="value-sub" style="color:${eBand.color}">${t(eBand.en, eBand.so)}</div>
        <div class="value-note">${t(
          "Not identification confidence — this reflects how strong and thorough the collected evidence is (find context, photos, and how consistent they are with each other).",
          "Maaha kalsoonida aqoonsiga — waxay muujinaysaa intay u xoog badan tahay caddaynta la ururiyay (xaalka la helay, sawirrada, iyo sida ay isu waafaqsan yihiin).",
        )}</div>
      </div>
    </section>`;

  const primaryIdHtml = `
    <section class="block">
      <div class="section-head"><span class="section-icon">🔎</span><h2>${t("Possible Identification", "Aqoonsiga Suurtagalka ah")}</h2></div>
      <div class="id-card">
        <h1 class="id-title">${esc(v.finalIdentification)}</h1>
        <span class="badge" style="background:${bandBg};color:${bandColor};border-color:${bandColor}">${bandWord} ${t("IDENTIFICATION CONFIDENCE", "KALSOONIDA AQOONSIGA")}</span>
        ${v.probability ? `<div class="value-sub" style="margin-top:8px">${esc(v.probability)}</div>` : ""}
      </div>
    </section>
    <section class="block">
      <div class="section-head"><span class="section-icon">📈</span><h2>${t("Identification Confidence", "Kalsoonida Aqoonsiga")}</h2></div>
      <div class="conf-row">
        <div class="conf-bar-track"><div class="conf-bar-fill" style="width:${confidencePct}%;background:${bandColor}"></div></div>
        <div class="conf-pct" style="color:${bandColor}">${confidencePct}%</div>
      </div>
    </section>`;

  const eraCultureHtml =
    v.estimatedEra || v.estimatedCulture
      ? `<section class="block">
           <div class="section-head"><span class="section-icon">🏺</span><h2>${t("Likely Era & Culture", "Xilliga & Dhaqanka Suurtagalka")}</h2></div>
           <table class="kv">
             ${v.estimatedEra ? `<tr><th>${t("Era", "Xilliga")}</th><td>${esc(v.estimatedEra)}</td></tr>` : ""}
             ${v.estimatedCulture ? `<tr><th>${t("Culture", "Dhaqanka")}</th><td>${esc(v.estimatedCulture)}</td></tr>` : ""}
           </table>
         </section>`
      : "";

  const inscriptionHtml = v.inscriptionReading
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">✍️</span><h2>${t("Inscription Reading", "Akhrinta Qoraalka")}</h2></div>
         <p class="body-text">${esc(v.inscriptionReading)}</p>
       </section>`
    : "";

  const executiveSummaryHtml = v.reasoning
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">📋</span><h2>${t("Executive Summary", "Soo Koobid Guud")}</h2></div>
         <p class="exec-summary">${esc(v.reasoning)}</p>
       </section>`
    : "";

  const recommendationHtml = `<div class="recommendation-pill">${esc(data.recommendationLabel)}</div>`;

  const supportingHtml = v.supportingEvidence.length
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">✅</span><h2>${t("Evidence Supporting This Identification", "Caddaynta Taageerta Aqoonsigan")}</h2></div>
         <ul class="bullet-list">${v.supportingEvidence.map((e) => `<li>✓ ${esc(e)}</li>`).join("")}</ul>
       </section>`
    : "";

  const conflictingHtml = `
    <section class="block">
      <div class="section-head"><span class="section-icon">⚠️</span><h2>${t("Evidence Against This Identification", "Caddaynta Ka Soo Horjeedda Aqoonsigan")}</h2></div>
      ${
        v.conflictingEvidence.length
          ? `<ul class="bullet-list bullet-list--warn">${v.conflictingEvidence.map((e) => `<li>⚠ ${esc(e)}</li>`).join("")}</ul>`
          : `<p class="body-text muted">${t("No significant conflicting evidence was identified.", "Ma jirto caddayn muhiim ah oo ka soo horjeedda oo la helay.")}</p>`
      }
    </section>`;

  const altsHtml = v.mostLikelyAlternatives.length
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">🔁</span><h2>${t("Most Likely Alternatives", "Ikhtiyaarrada Ugu Suurtagalsan")}</h2></div>
         <table class="kv">${v.mostLikelyAlternatives
           .map((a) => `<tr><th>${esc(a.label)}</th><td>${esc(a.note ?? "")}</td></tr>`)
           .join("")}</table>
       </section>`
    : "";

  const nextStepsHtml = v.recommendedNextSteps.length
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">➡️</span><h2>${t("Recommended Next Steps", "Tallaabooyinka Xiga ee la Talinayo")}</h2></div>
         <ul class="bullet-list">${v.recommendedNextSteps.map((s) => `<li>• ${esc(s)}</li>`).join("")}</ul>
       </section>`
    : "";

  const valueHtml = v.estimatedMarketValue
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">💰</span><h2>${t("Estimated Value", "Qiimaha (Qiyaas)")}</h2></div>
         <p class="body-text">${esc(v.estimatedMarketValue)}</p>
         <div class="estimate-tag">${t("QUALITATIVE ESTIMATE ONLY — not a professional appraisal", "QIYAAS GUUD KALIYA — maaha qiimayn xirfadeed")}</div>
       </section>`
    : "";

  // Heritage/legal notice — always rendered, prominently, regardless of verdict.
  const heritageHtml = `
    <section class="block heritage-block">
      <div class="section-head"><span class="section-icon">🏛️</span><h2>${t("Heritage & Legal Notice", "Ogeysiis Hidaha & Sharci")}</h2></div>
      <p class="body-text">${esc(v.heritageLegalNote)}</p>
    </section>`;

  const professionalHtml = v.professionalExaminationRecommended
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">🎓</span><h2>${t("Professional Examination Recommended", "Baaritaan Xirfadeed ayaa lagula talinayaa")}</h2></div>
         <p class="body-text">${esc(
           v.professionalExaminationNote ||
             t(
               "This is not a substitute for hands-on examination by a museum or archaeologist.",
               "Tani maaha beddel baaritaan gacan oo matxaf ama cilmi-baare qadiimi ah sameeyo.",
             ),
         )}</p>
       </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LuulScan Lab ${t("Artifact Verification Report", "Warbixinta Xaqiijinta Aathaarta")}</title>
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
  header.masthead {
    display: flex; justify-content: space-between; align-items: flex-start;
    background: #0F1E3A; color: #fff; border-radius: 14px; padding: 22px 26px; margin-bottom: 20px;
  }
  .brand-row { display: flex; align-items: center; gap: 12px; }
  .brand-mark { flex: none; width: 40px; height: 40px; }
  .brand-mark svg { width: 100%; height: 100%; }
  .brand-text .brand-name { font-size: 21px; font-weight: 800; letter-spacing: .3px; }
  .brand-text .brand-company { font-size: 10.5px; color: #C7CCD1; letter-spacing: .6px; text-transform: uppercase; margin-top: 2px; }
  .id-meta { text-align: right; font-size: 10.5px; color: #C7CCD1; line-height: 1.9; }
  .id-meta b { color: #fff; }
  section.block { margin: 0 0 18px; page-break-inside: avoid; }
  .section-head { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #E1D9C4; padding-bottom: 6px; margin-bottom: 10px; }
  .section-icon { font-size: 14px; line-height: 1; }
  section.block h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .6px; color: #4A5568; margin: 0; font-weight: 700; }
  .body-text { margin: 0 0 8px; color: #333; }
  .muted { color: #8A8F98; }
  .exec-summary { background: #F1ECDF; border-left: 3px solid #1B2A4A; border-radius: 8px; padding: 14px 16px; margin: 0; color: #222; }
  .heritage-block { background: #FBF1DC; border: 1px solid #E6CF85; border-radius: 10px; padding: 12px 14px; }
  .heritage-block h2 { color: #7A5C00; }
  .heritage-block .body-text { color: #5c4600; margin: 0; }
  .photo-frame { display: flex; }
  .photo-frame figure { margin: 0; width: 100%; background: #F1ECDF; border: 1px solid #E1D9C4; border-radius: 12px; padding: 8px; }
  .photo-frame img { width: 100%; height: 380px; object-fit: cover; border-radius: 8px; display: block; }
  .id-card { background: #F1ECDF; border-radius: 10px; padding: 16px 18px; }
  .id-title { font-size: 23px; margin: 0 0 10px; color: #0F1E3A; }
  .badge { display: inline-block; font-weight: 800; font-size: 10.5px; padding: 5px 13px; border-radius: 999px; letter-spacing: .4px; border: 1px solid; }
  .conf-row { display: flex; align-items: center; gap: 12px; }
  .conf-bar-track { flex: 1; height: 10px; background: #E7E0CF; border-radius: 999px; overflow: hidden; }
  .conf-bar-fill { height: 100%; border-radius: 999px; }
  .conf-pct { font-size: 15px; font-weight: 800; width: 48px; text-align: right; }
  .recommendation-pill {
    display: inline-block; background: #FBF1DC; border: 1px solid #E6CF85; color: #7A5C00;
    border-radius: 999px; padding: 8px 20px; font-weight: 800; font-size: 13px; margin: 0 0 18px;
  }
  table.kv { width: 100%; border-collapse: collapse; }
  table.kv th { text-align: left; width: 30%; vertical-align: top; padding: 6px 8px; color: #666; font-weight: 600; font-size: 11.5px; }
  table.kv td { padding: 6px 8px; font-size: 12px; }
  .bullet-list { list-style: none; padding: 0; margin: 0; color: #333; font-size: 12.5px; line-height: 1.8; }
  .bullet-list--warn li { color: #8a3b1a; }
  .value-card { background: #F1ECDF; border: 1px solid #E1D9C4; border-radius: 12px; padding: 16px; }
  .value-figure { font-size: 23px; font-weight: 800; }
  .value-sub { font-size: 12.5px; font-weight: 700; margin-top: 2px; }
  .value-note { font-size: 12px; color: #555; margin-top: 8px; }
  .estimate-tag { display: inline-block; margin-top: 10px; background: #FBF1DC; color: #7A5C00; border: 1px solid #E6CF85; border-radius: 6px; padding: 4px 10px; font-size: 10.5px; font-weight: 700; }
  footer.doc-footer {
    position: fixed; bottom: 0; left: 0; right: 0; border-top: 1px solid #E1D9C4; padding: 10px 16px 0;
    font-size: 9.5px; color: #8A8F98; display: flex; justify-content: space-between;
  }
  footer.doc-footer b { color: #1B2A4A; }
  .disclaimer-block { margin-top: 20px; border-top: 1px solid #E1D9C4; padding-top: 12px; font-size: 10.5px; color: #6b7280; line-height: 1.7; }
  .disclaimer-block strong { color: #1B2A4A; }
  .seal-row { display: flex; justify-content: flex-end; margin-top: 8px; page-break-inside: avoid; }
  .seal-mark { width: 92px; height: 92px; transform: rotate(-8deg); opacity: 0.92; }
  .seal-mark svg { width: 100%; height: 100%; }
</style>
</head>
<body>
  <div class="doc">
    <header class="masthead">
      <div class="brand-row">
        <div class="brand-mark">${GEM_MARK_SVG}</div>
        <div class="brand-text">
          <div class="brand-name">LuulScan Lab Company</div>
          <div class="brand-company">${t("Artifact Verification Report", "Warbixinta Xaqiijinta Aathaarta")}</div>
        </div>
      </div>
      <div class="id-meta">
        <div>${t("Report No.", "Lambarka Warbixinta")}: <b>${esc(reportId)}</b></div>
        <div>${t("Issue Date", "Taariikhda Bixinta")}: <b>${esc(generatedStr)}</b></div>
        <div>${t("Verification Date", "Taariikhda Xaqiijinta")}: <b>${esc(verifiedStr)}</b></div>
        <div>${t("Language", "Luqadda")}: <b>${esc(languageLabel)}</b></div>
      </div>
    </header>

    ${executiveSummaryHtml}
    ${photoHtml}
    ${primaryIdHtml}
    ${evidenceCard}
    ${recommendationHtml}
    ${eraCultureHtml}
    ${inscriptionHtml}
    ${supportingHtml}
    ${conflictingHtml}
    ${altsHtml}
    ${nextStepsHtml}
    ${valueHtml}
    ${heritageHtml}
    ${professionalHtml}

    <div class="seal-row">
      <div class="seal-mark">${SEAL_SVG}</div>
    </div>

    <div class="disclaimer-block">
      <strong>${t("Disclaimer", "Ogeysiis")}:</strong>
      ${t(
        "This report was generated by the LuulScan Lab Company digital laboratory system, combining your original scan with the additional questionnaire and photos you provided. Photo-based analysis cannot confirm authenticity, precise age, or origin, and cannot establish legal provenance. This report is NOT an official certificate and does not authorize sale, export, or removal of any object. Cultural heritage laws in many countries — including Somalia — restrict dealing in antiquities. For any genuine-looking find, consult a museum, a university archaeology department, or the national heritage authority.",
        "Warbixintan waxaa soo saaray nidaamka shaybaarka dhijitaalka ah ee LuulScan Lab Company, isagoo isku darayay baaritaankaagii hore iyo su'aalaha iyo sawirrada aad bixisay. Falanqaynta sawirku ma xaqiijin karto runnimada, da'da saxda ah, ama asalka, mana caddayn karto sharci-ahaanshaha lahaanshaha. Warbixintani MAAHA shahaado rasmi ah, mana ogolaanayso iibin, dhoofin, ama qaadista shay kasta. Sharciyada hidaha dhaqameed ee dalal badan — oo ay ku jirto Soomaaliya — waxay xaddidaan ka-ganacsiga aathaarta. Wax kasta oo u eg mid dhab ah, la tasho matxaf, waaxda cilmi-baarista qadiimiga ah ee jaamacad, ama hay'adda hidaha qaranka.",
      )}
    </div>

    <footer class="doc-footer">
      <div><b>LuulScan Lab Company</b> — ${t("Heritage & Antiquities Identification", "Aqoonsiga Hidaha & Aathaarta")}<br/>gemscan.ai &nbsp;·&nbsp; support@gemscan.ai</div>
      <div>${t("Report ID", "Aqoonsiga Warbixinta")}: ${esc(reportId)}</div>
    </footer>
  </div>
</body>
</html>`;
}

export async function generateAndShareArtifactVerificationPdf(
  data: ArtifactVerificationPdfData,
  lang: Lang,
): Promise<void> {
  const photoDataUri = await toDataUri(data.photoUri);
  const html = buildArtifactVerificationReportHtml({ ...data, photoUri: photoDataUri }, lang);
  const { uri } = await Print.printToFileAsync({ html, base64: false });

  const safeName =
    "LuulScan-Artifact-Verification-Report-" +
    (data.verdict.finalIdentification || "report").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) +
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
      dialogTitle: lang === "so" ? "La wadaag warbixinta xaqiijinta aathaarta" : "Share your artifact verification report",
    });
  }
}

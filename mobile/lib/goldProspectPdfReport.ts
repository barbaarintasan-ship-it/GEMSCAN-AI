// Professional PDF report for Gold Prospect Evaluation.
//
// Mirrors the LuulScan Lab identification report (lib/pdfReport.ts) in look and
// quality, but renders the RULE-BASED gold prospect assessment. It is
// UI-agnostic: it takes a plain snapshot and produces a print-ready PDF via
// expo-print, then hands it to the OS share sheet (WhatsApp / Email / Save to
// Files = "download") via expo-sharing.
//
// This module has ZERO knowledge of scans / subscriptions / credits / AI. It
// makes NO AI calls and NO network calls — it only renders data the screen
// already computed locally from the existing scan result + questionnaire.
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system";

export type GoldProspectPdfData = {
  scanId?: string | null;
  createdAt: string; // ISO timestamp of the underlying scan
  hostRock: string;
  hostConfidencePct: number;
  environment: string;
  score: number; // 0-100
  categoryLabel: string; // already localized
  economicLabel: string; // already localized
  categoryColor: string; // hex
  evidenceFor: string[];
  evidenceAgainst: string[];
  nextSteps: string[];
  regionalGeology?: { line: string; source: string; favorable: boolean } | null;
  location?: { lat: number; lng: number; label?: string | null } | null;
};

type Lang = "en" | "so";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Shared masthead gem mark (same as the identification report, for one brand).
const GEM_MARK_SVG = `<svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">
  <polygon points="17,1 30,11 17,33 4,11" fill="#1B2A4A"/>
  <polygon points="17,1 30,11 17,15 4,11" fill="#8C99AE"/>
  <polygon points="4,11 17,15 17,33" fill="#2C4270"/>
  <polygon points="30,11 17,15 17,33" fill="#1B2A4A"/>
  <polygon points="10,6 24,6 30,11 4,11" fill="#C7CCD1"/>
</svg>`;

// Round company seal (identical to the identification report's).
const SEAL_SVG = `<svg width="150" height="150" viewBox="0 0 150 150" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <path id="gpSealTopArc" d="M 20,75 A 55,55 0 1 1 130,75" fill="none"/>
    <path id="gpSealBottomArc" d="M 20,75 A 55,55 0 1 0 130,75" fill="none"/>
  </defs>
  <circle cx="75" cy="75" r="70" fill="none" stroke="#1E50A2" stroke-width="1.5" opacity="0.85"/>
  <circle cx="75" cy="75" r="62" fill="none" stroke="#1E50A2" stroke-width="2.5"/>
  <circle cx="75" cy="75" r="44" fill="none" stroke="#1E50A2" stroke-width="1"/>
  <text font-size="8.2" fill="#1E50A2" font-family="Georgia, serif" font-weight="700" letter-spacing="2.2">
    <textPath href="#gpSealTopArc" startOffset="50%" text-anchor="middle">LUULSCAN LAB COMPANY</textPath>
  </text>
  <text font-size="6.5" fill="#1E50A2" font-family="Georgia, serif" font-weight="600" letter-spacing="0.8">
    <textPath href="#gpSealBottomArc" startOffset="50%" text-anchor="middle">GEOLOGICAL PROSPECT LAB</textPath>
  </text>
  <g transform="translate(75,75)">
    <polygon points="0,-18 15,-10 0,20 -15,-10" fill="none" stroke="#1E50A2" stroke-width="1.5"/>
    <polygon points="0,-18 15,-10 -15,-10" fill="none" stroke="#1E50A2" stroke-width="1"/>
  </g>
  <circle cx="46" cy="75" r="1.6" fill="#1E50A2"/>
  <circle cx="104" cy="75" r="1.6" fill="#1E50A2"/>
</svg>`;

// Simple map/location pin schematic (offline — no map tiles are fetched).
const PIN_SVG = `<svg width="34" height="34" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2C7.9 2 4.5 5.4 4.5 9.5c0 5.3 6.4 11.5 7.5 12.5 1.1-1 7.5-7.2 7.5-12.5C19.5 5.4 16.1 2 12 2z" fill="#0F1E3A"/>
  <circle cx="12" cy="9.5" r="3" fill="#fff"/>
</svg>`;

function listBlock(items: string[]): string {
  return items.map((s) => `<li>${esc(s)}</li>`).join("");
}

// ── HTML builder (pure) ────────────────────────────────────────────────────
export function buildGoldProspectHtml(data: GoldProspectPdfData, lang: Lang): string {
  const t = (en: string, so: string) => (lang === "so" ? so : en);
  const score = Math.max(0, Math.min(100, Math.round(data.score)));
  const color = data.categoryColor || "#B8860B";

  const issued = data.createdAt ? new Date(data.createdAt) : new Date();
  const issuedStr = issued.toLocaleDateString(lang === "so" ? "so-SO" : "en-GB");
  const generatedStr = new Date().toLocaleDateString(lang === "so" ? "so-SO" : "en-GB");
  const base = (data.scanId ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase() || "N/A";
  const reportId = base;
  const prospectId = `GP-${base}`;
  const languageLabel = lang === "so" ? "Soomaali" : "English";

  const evidenceForHtml = data.evidenceFor.length
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">➕</span><h2>${t("Evidence Supporting Gold Potential", "Caddaynta Taageeraysa")}</h2></div>
         <ul class="ev ev-for">${listBlock(data.evidenceFor)}</ul>
       </section>`
    : "";

  const evidenceAgainstHtml = data.evidenceAgainst.length
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">➖</span><h2>${t("Evidence Against Gold Potential", "Caddaynta Ka Soo Horjeedda")}</h2></div>
         <ul class="ev ev-against">${listBlock(data.evidenceAgainst)}</ul>
       </section>`
    : "";

  const geo = data.regionalGeology;
  const geoHtml = geo
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">🗺️</span><h2>${t("Regional Geology", "Geology-ga Gobolka")}</h2></div>
         <p class="body-text">${esc(geo.line)}</p>
         <div class="src">${t("Source", "Isha")}: ${esc(geo.source)}</div>
       </section>`
    : "";

  const loc = data.location;
  const mapHtml = loc
    ? `<section class="block">
         <div class="section-head"><span class="section-icon">📍</span><h2>${t("Specimen Location", "Goobta Shayga")}</h2></div>
         <div class="loc-card">
           <div class="loc-pin">${PIN_SVG}</div>
           <div class="loc-meta">
             ${loc.label ? `<div class="loc-place">${esc(loc.label)}</div>` : ""}
             <div class="loc-coords">${t("Coordinates", "Isudhexgalka")}: ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}</div>
             <div class="loc-note">${t("Location does not estimate underground gold.", "Goobtu ma qiyaaso dahab dhulka hoostiisa ah.")}</div>
           </div>
         </div>
       </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LuulScan Lab ${t("Gold Prospect Report", "Warbixinta Rajada Dahabka")}</title>
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
    background: #0F1E3A; color: #fff; border-radius: 14px; padding: 22px 26px; margin-bottom: 16px;
  }
  .brand-row { display: flex; align-items: center; gap: 12px; }
  .brand-mark { flex: none; width: 40px; height: 40px; }
  .brand-mark svg { width: 100%; height: 100%; }
  .brand-name { font-size: 21px; font-weight: 800; letter-spacing: .3px; }
  .brand-company { font-size: 10.5px; color: #C7CCD1; letter-spacing: .6px; text-transform: uppercase; margin-top: 2px; }
  .id-meta-list { font-size: 10.5px; color: #C7CCD1; line-height: 1.9; text-align: right; }
  .id-meta-list b { color: #fff; }

  .cover { background: #F1ECDF; border-left: 3px solid #1B2A4A; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
  .cover h1 { margin: 0 0 4px; font-size: 18px; color: #0F1E3A; }
  .cover p { margin: 0; color: #444; font-size: 12px; }

  section.block { margin: 0 0 16px; page-break-inside: avoid; }
  .section-head { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #E1D9C4; padding-bottom: 6px; margin-bottom: 10px; }
  .section-icon { font-size: 14px; line-height: 1; }
  section.block h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .6px; color: #4A5568; margin: 0; font-weight: 700; }
  .body-text { margin: 0 0 6px; color: #333; }
  .src { font-size: 10px; color: #8A8F98; margin-top: 4px; }

  .host-card { background: #F1ECDF; border-radius: 10px; padding: 14px 16px; }
  .host-name { font-size: 22px; font-weight: 800; color: #0F1E3A; margin: 0 0 2px; }
  .host-kv { font-size: 11.5px; color: #666; }
  .host-kv b { color: #1B2A4A; }
  .host-env { font-size: 12px; color: #444; margin-top: 6px; }

  .score-card { background: #F1ECDF; border: 1px solid #E1D9C4; border-radius: 12px; padding: 16px; }
  .score-top { display: flex; align-items: baseline; gap: 8px; }
  .score-num { font-size: 40px; font-weight: 900; line-height: 1; }
  .score-max { font-size: 15px; color: #8A8F98; font-weight: 700; }
  .score-pill { margin-left: auto; color: #fff; border-radius: 999px; padding: 4px 12px; font-size: 11px; font-weight: 800; }
  .score-track { height: 12px; background: #E7E0CF; border-radius: 999px; overflow: hidden; margin-top: 10px; }
  .score-fill { height: 100%; border-radius: 999px; }
  .score-note { font-size: 10.5px; color: #7A5C00; background: #FBF1DC; border: 1px solid #E6CF85; border-radius: 6px; padding: 4px 10px; display: inline-block; margin-top: 10px; font-weight: 700; }
  .econ { font-size: 16px; font-weight: 800; margin: 0; }

  ul.ev { margin: 0; padding-left: 4px; list-style: none; }
  ul.ev li { position: relative; padding: 3px 0 3px 20px; font-size: 12px; color: #333; }
  ul.ev li::before { position: absolute; left: 0; top: 3px; font-weight: 800; }
  ul.ev-for li::before { content: "✓"; color: #1E7A46; }
  ul.ev-against li::before { content: "–"; color: #B5502E; }
  ol.steps { margin: 0; padding-left: 20px; }
  ol.steps li { font-size: 12px; color: #333; padding: 2px 0; }

  .loc-card { display: flex; align-items: center; gap: 14px; background: #F1ECDF; border-radius: 10px; padding: 14px 16px; }
  .loc-pin { flex: none; }
  .loc-place { font-weight: 700; color: #0F1E3A; font-size: 13px; }
  .loc-coords { font-size: 12px; color: #444; font-family: monospace; }
  .loc-note { font-size: 10px; color: #8A8F98; margin-top: 3px; }

  .seal-row { display: flex; justify-content: center; margin-top: 12px; page-break-inside: avoid; }
  .seal-mark { width: 122px; height: 122px; transform: rotate(-8deg); opacity: 0.95; }
  .seal-mark svg { width: 100%; height: 100%; }
  .signature-block { margin-top: 2px; text-align: center; page-break-inside: avoid; }
  .signature-name { font-family: 'Segoe Script', 'Bradley Hand', 'Snell Roundhand', cursive; font-size: 27px; font-style: italic; color: #1E50A2; line-height: 1.1; }
  .signature-line { width: 170px; height: 1px; background: #1E50A2; opacity: 0.55; margin: 3px auto; }
  .signature-label { font-size: 10px; color: #555; letter-spacing: 0.4px; }

  .disclaimer-block { margin-top: 18px; border-top: 1px solid #E1D9C4; padding-top: 12px; font-size: 10.5px; color: #6b7280; line-height: 1.7; }
  .disclaimer-block strong { color: #1B2A4A; }
  footer.doc-footer {
    position: fixed; bottom: 0; left: 0; right: 0; border-top: 1px solid #E1D9C4; padding: 10px 16px 0;
    font-size: 9.5px; color: #8A8F98; display: flex; justify-content: space-between;
  }
  footer.doc-footer .f-left b { color: #1B2A4A; }
</style>
</head>
<body>
  <div class="doc">
    <header class="masthead">
      <div class="brand-row">
        <div class="brand-mark">${GEM_MARK_SVG}</div>
        <div>
          <div class="brand-name">LuulScan Lab Company</div>
          <div class="brand-company">${t("Geological Prospect Assessment", "Qiimaynta Rajada Juqraafi")}</div>
        </div>
      </div>
      <div class="id-meta-list">
        <div>${t("Report No.", "Lambarka Warbixinta")}: <b>${esc(reportId)}</b></div>
        <div>${t("Prospect Eval. ID", "ID Qiimaynta")}: <b>${esc(prospectId)}</b></div>
        <div>${t("Issue Date", "Taariikhda Bixinta")}: <b>${esc(issuedStr)}</b></div>
        <div>${t("Language", "Luqadda")}: <b>${esc(languageLabel)}</b></div>
      </div>
    </header>

    <div class="cover">
      <h1>${t("Gold Prospect Evaluation Report", "Warbixinta Qiimaynta Rajada Dahabka")}</h1>
      <p>${t(
        "A geological exploration-potential assessment based on the identified host rock, regional geology and established geological rules. It does NOT confirm that gold is present.",
        "Qiimayn suurtagalnimo-sahamineed juqraafi oo ku salaysan dhagaxa martida la aqoonsaday, geology-ga gobolka iyo qawaaniinta juqraafi ee la aasaasay. MA xaqiijiso in dahab jiro.",
      )}</p>
    </div>

    <section class="block">
      <div class="section-head"><span class="section-icon">🪨</span><h2>${t("Detected Host Rock", "Dhagaxa Martida ee la Helay")}</h2></div>
      <div class="host-card">
        <p class="host-name">${esc(data.hostRock)}</p>
        <div class="host-kv">${t("Identification confidence", "Kalsoonida aqoonsiga")}: <b>${Math.round(data.hostConfidencePct)}%</b></div>
        <div class="host-env">${esc(data.environment)}</div>
      </div>
    </section>

    <section class="block">
      <div class="section-head"><span class="section-icon">📊</span><h2>${t("Gold Prospect Score", "Dhibcaha Rajada Dahabka")}</h2></div>
      <div class="score-card">
        <div class="score-top">
          <span class="score-num" style="color:${color}">${score}</span>
          <span class="score-max">/100</span>
          <span class="score-pill" style="background:${color}">${esc(data.categoryLabel)}</span>
        </div>
        <div class="score-track"><div class="score-fill" style="width:${score}%;background:${color}"></div></div>
        <div class="score-note">${t(
          "Exploration score only — it does not confirm gold is present.",
          "Dhibco sahamin oo keliya — ma xaqiijiso in dahab jiro.",
        )}</div>
      </div>
    </section>

    <section class="block">
      <div class="section-head"><span class="section-icon">💰</span><h2>${t("Economic Potential", "Suurtagalnimada Dhaqaale")}</h2></div>
      <p class="econ" style="color:${color}">${esc(data.economicLabel)}</p>
    </section>

    ${evidenceForHtml}
    ${evidenceAgainstHtml}
    ${geoHtml}
    ${mapHtml}

    <section class="block">
      <div class="section-head"><span class="section-icon">🧭</span><h2>${t("Recommended Next Steps", "Tallaabooyinka Xiga ee La Talinayo")}</h2></div>
      <ol class="steps">${listBlock(data.nextSteps)}</ol>
    </section>

    <div class="seal-row"><div class="seal-mark">${SEAL_SVG}</div></div>
    <div class="signature-block">
      <div class="signature-name">Aw-Musse</div>
      <div class="signature-line"></div>
      <div class="signature-label">${t("Authorized signature", "Saxiixa la ogolaaday")}</div>
    </div>

    <div class="disclaimer-block">
      <strong>${t("Disclaimer", "Ogeysiis")}:</strong>
      ${t(
        "This is a Geological Prospect Assessment produced by the LuulScan Lab Company system. It is a geological interpretation based on mineral identification, regional geology and established geological rules — NOT a laboratory assay and NOT confirmation that gold exists. Only field sampling, drilling and accredited laboratory analysis can determine whether an economic gold deposit is present.",
        "Tani waa Qiimayn Rajo Juqraafi oo uu soo saaray nidaamka LuulScan Lab Company. Waa fasiraad juqraafi oo ku salaysan aqoonsiga macdanta, geology-ga gobolka iyo qawaaniinta juqraafi ee la aasaasay — MAAHA baaritaan shaybaar, MANA xaqiijinayso in dahab jiro. Kaliya muunad-qaadis goob, qodid iyo falanqayn shaybaar oo la aqoonsan yahay ayaa go'aamin kara in kayd dahab oo dhaqaale ah jiro.",
      )}
    </div>

    <footer class="doc-footer">
      <div class="f-left">
        <b>LuulScan Lab Company</b> — ${t("Geological Prospect Laboratory", "Shaybaar Rajo Juqraafi")}<br/>
        ${t("Generated by LuulScan Lab Company", "Waxaa soo saaray LuulScan Lab Company")} &nbsp;·&nbsp; ${esc(generatedStr)}
      </div>
      <div class="f-right">${t("Report ID", "Aqoonsiga Warbixinta")}: ${esc(reportId)}</div>
    </footer>
  </div>
</body>
</html>`;
}

// ── generate + share (download) ────────────────────────────────────────────
export async function generateAndShareGoldProspectPdf(
  data: GoldProspectPdfData,
  lang: Lang,
): Promise<{ uri: string } | null> {
  const html = buildGoldProspectHtml(data, lang);
  const { uri } = await Print.printToFileAsync({ html, base64: false });

  const safeName =
    "LuulScan-Gold-Prospect-" +
    (data.hostRock || "report").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) +
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
      dialogTitle: lang === "so" ? "La wadaag warbixinta rajada dahabka" : "Share your Gold Prospect report",
    });
  }
  return { uri: shareUri };
}

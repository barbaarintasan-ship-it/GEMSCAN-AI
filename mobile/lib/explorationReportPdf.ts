// The field report, as a document somebody can be sent.
//
// WHY THIS EXISTS. An exploration report lived on one phone, inside one screen, in
// a scroll view. The person who supplied the evidence — the colleague in Borama who
// sent the coordinate and the photographs — had no way to read the assessment their
// own rock produced. A workflow that collects from a second person and reports to
// nobody but the first is only half a workflow.
//
// NOTHING IS INTERPRETED HERE. Every sentence comes from `renderReport`, which is
// the same renderer the screen uses: the codes the model returned, translated. This
// file lays them out and nothing more. If the PDF and the screen ever disagree, one
// of them has started writing geology, and it is not allowed to be this one.
//
// The mechanics — expo-print to HTML, expo-sharing to the sheet — are the pattern
// `batchReport.ts` and `artifactVerificationPdfReport.ts` already use. Deliberately
// not a new one.
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system";
import {
  renderReport, type ReportLanguage, type RenderedReport,
} from "../../shared/geo-core/gie/renderReport";
import type { MissionFindings } from "../../shared/geo-core/gie/missionFindings";
import type { EvidencePackage } from "./exploration/evidencePackage";
import { localStamp } from "./exploration/format";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** HTML-escape. Field notes are free text and will contain an ampersand eventually. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A photograph as a data URI, or null.
 *
 * Null is a normal answer, not a failure: the local copy may have been cleared, and
 * a report missing one picture is worth far more than no report at all.
 */
async function toDataUri(uri: string): Promise<string | null> {
  try {
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
    return `data:image/jpeg;base64,${b64}`;
  } catch {
    return null;
  }
}

/**
 * How many observations were somebody else's.
 *
 * Printed on the document, because the reader is often the person who supplied
 * them and the distinction is the whole basis on which the assessment should be
 * read. See `EvidenceOrigin`.
 */
export function reportedCount(pkg: EvidencePackage): number {
  return pkg.observations.filter((o) => o.origin === "reported").length;
}

export function buildExplorationReportHtml(
  pkg: EvidencePackage,
  rendered: RenderedReport,
  photos: Array<{ src: string; caption: string }>,
  t: Translate,
): string {
  const reported = reportedCount(pkg);
  const sections = rendered.sections
    .map((s) => `
      <section>
        <h2>${esc(s.title)}</h2>
        ${s.lines.map((l) => `<p>${esc(l)}</p>`).join("")}
      </section>`)
    .join("");

  const plates = photos.length === 0 ? "" : `
    <section>
      <h2>${esc(t("report.section.visual"))}</h2>
      <div class="plates">
        ${photos.map((p, i) => `
          <figure>
            <img src="${p.src}" />
            <figcaption>${i + 1}. ${esc(p.caption)}</figcaption>
          </figure>`).join("")}
      </div>
    </section>`;

  return `<!doctype html><html><head><meta charset="utf-8" />
<style>
  @page { margin: 18mm 14mm; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
         color: #14171a; font-size: 11pt; line-height: 1.5; }
  h1 { font-size: 17pt; margin: 0 0 2mm; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: .08em;
       color: #8a6d1f; margin: 7mm 0 2mm; border-bottom: .4pt solid #d8d2c2;
       padding-bottom: 1.5mm; }
  p { margin: 0 0 2mm; }
  .sub { color: #5a6169; font-size: 9.5pt; margin: 0 0 5mm; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  td { padding: 1.4mm 0; vertical-align: top; }
  td.k { color: #5a6169; width: 38%; }
  .flag { margin: 4mm 0 0; padding: 3mm; background: #fdf6e3;
          border-left: 2.5pt solid #b8860b; font-size: 10pt; }
  .plates { display: flex; flex-wrap: wrap; gap: 5mm; }
  figure { margin: 0; width: 46%; }
  img { width: 100%; border: .4pt solid #d8d2c2; }
  figcaption { font-size: 8.5pt; color: #5a6169; margin-top: 1mm; }
  footer { margin-top: 9mm; padding-top: 2mm; border-top: .4pt solid #d8d2c2;
           font-size: 8.5pt; color: #7a828a; }
</style></head><body>
  <h1>${esc(t("reports.oneTitle"))}</h1>
  <p class="sub">${esc(pkg.targetCell)} · ${esc(localStamp(pkg.completedAt))}</p>

  <section>
    <h2>${esc(t("report.section.overview"))}</h2>
    <table>
      <tr><td class="k">${esc(t("reports.field.position"))}</td><td>${
        pkg.targetCentre.lat.toFixed(5)}, ${pkg.targetCentre.lng.toFixed(5)}</td></tr>
      <tr><td class="k">${esc(t("reports.field.commodity"))}</td><td>${
        esc(pkg.commodity ? t(`commodity.${pkg.commodity}`) : t("reports.universal"))}</td></tr>
      <tr><td class="k">${esc(t("reports.field.mission"))}</td><td>${esc(pkg.missionId)}</td></tr>
      <tr><td class="k">${esc(t("reports.field.collected"))}</td><td>${
        esc(t("reports.collectedSummary", {
          obs: pkg.observations.length,
          photos: pkg.observations.reduce((s, o) => s + o.photos.length, 0),
          track: pkg.track.length,
        }))}</td></tr>
    </table>
    ${reported > 0 ? `<p class="flag">${esc(t("report.reportedFlag", { n: reported }))}</p>` : ""}
  </section>

  ${sections}
  ${plates}

  <footer>${esc(t("report.pdfFooter"))}</footer>
</body></html>`;
}

/**
 * Render this package's assessment and hand it to the share sheet.
 *
 * Returns false when there is nothing to render — a package still awaiting its
 * assessment has no report, and producing an empty document would be worse than
 * the button doing nothing visible.
 */
export async function shareExplorationReportPdf(
  pkg: EvidencePackage,
  t: Translate,
  language: ReportLanguage,
): Promise<boolean> {
  if (!pkg.analysis) return false;

  const rendered = renderReport(
    pkg.analysis as MissionFindings, t, language,
    { prospectivityScore: pkg.prospectivityScore },
  );

  const plates: Array<{ src: string; caption: string }> = [];
  for (const obs of pkg.observations) {
    for (const photo of obs.photos) {
      const src = await toDataUri(photo.uri);
      if (src) {
        plates.push({
          src,
          caption: obs.notes.trim() || t(`field.waypointType.${obs.type}`),
        });
      }
    }
  }

  const html = buildExplorationReportHtml(pkg, rendered, plates, t);
  const { uri } = await Print.printToFileAsync({ html, base64: false });

  // A readable filename, because this arrives in somebody else's messages app and
  // "share.pdf" tells them nothing about which ground it describes.
  const name = `LuulScan-Field-Report-${pkg.targetCell}-${
    localStamp(pkg.completedAt, false)}.pdf`;
  let shareUri = uri;
  try {
    const dest = (FileSystem.cacheDirectory ?? "") + name;
    await FileSystem.copyAsync({ from: uri, to: dest });
    shareUri = dest;
  } catch {
    /* keep the original temp uri if the copy fails */
  }

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(shareUri, {
      mimeType: "application/pdf",
      UTI: "com.adobe.pdf",
      dialogTitle: t("reports.sharePdf"),
    });
  }
  return true;
}

// Batch Scan summary PDF (Pro / "Gem Collector" only — entitlement gate lives
// in the results screen, exactly like the single-scan PDF in pdfReport.ts).
//
// This is a SEPARATE, additive module — it does not modify pdfReport.ts or
// the single-scan report. It reuses the exact same underlying PDF system
// (expo-print + expo-sharing) to render a compact table (one row per batch
// item) instead of one full report per item.
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system";
import type { BatchItemResult } from "./batchTypes";

type Lang = "en" | "so";

const BAND_COLOR: Record<string, string> = {
  high: "#2E7D32",
  medium: "#C9A227",
  low: "#8A8A8E",
};

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

// Batch item photos are local device uris at generation time, but handle a
// remote uri too (harmless, and keeps this module self-contained).
async function toDataUri(uri: string): Promise<string | null> {
  try {
    if (!uri) return null;
    if (uri.startsWith("data:")) return uri;
    let localUri = uri;
    if (/^https?:\/\//i.test(uri)) {
      const target =
        (FileSystem.cacheDirectory ?? "") +
        `gemscan-batch-img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

function statusLabel(status: BatchItemResult["status"], lang: Lang): string {
  if (lang === "so") {
    return status === "completed" ? "Dhammaystiran" : status === "failed" ? "Fashilmay" : "La booday";
  }
  return status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Skipped";
}

function buildBatchSummaryHtml(items: BatchItemResult[], photos: (string | null)[], lang: Lang): string {
  const t = (en: string, so: string) => (lang === "so" ? so : en);
  const completed = items.filter((i) => i.status === "completed").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const skipped = items.filter((i) => i.status === "skipped").length;
  const generated = new Date().toLocaleString(lang === "so" ? "so-SO" : "en-GB");

  const rows = items
    .map((item, i) => {
      const photo = photos[i];
      const statusColor =
        item.status === "completed" ? "#2E7D32" : item.status === "failed" ? "#B3261E" : "#8A8A8E";
      const bandColor = item.band ? BAND_COLOR[item.band] : "#8A8A8E";
      return `<tr>
        <td class="thumb-cell">${photo ? `<img src="${photo}" class="thumb"/>` : ""}</td>
        <td>${esc(item.label ?? "—")}</td>
        <td class="num">${
          item.confidencePct != null
            ? `<span class="band-dot" style="background:${bandColor}"></span>${item.confidencePct}%`
            : "—"
        }</td>
        <td class="num">${esc(item.valueLabel ?? "—")}</td>
        <td>${item.scanType === "deep" ? t("Deep", "Qoto dheer") : t("Standard", "Caadi")}</td>
        <td><span class="status-pill" style="color:${statusColor};border-color:${statusColor}">${esc(
          statusLabel(item.status, lang),
        )}</span></td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GemScan ${t("Batch Scan Summary", "Soo Koobid Batch Scan")}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1c1c1e; font-size: 11.5px; background: #fff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .doc { max-width: 800px; margin: 0 auto; }
  header.masthead {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 3px solid #C9A227; padding-bottom: 10px; margin-bottom: 14px;
  }
  .brand { font-size: 20px; font-weight: 800; color: #0B0B0C; }
  .brand .gem { color: #C9A227; }
  .brand-sub { font-size: 10.5px; color: #6b571a; letter-spacing: .4px; text-transform: uppercase; margin-top: 2px; }
  .meta { text-align: right; font-size: 10.5px; color: #666; line-height: 1.6; }
  .meta b { color: #1c1c1e; }
  .stats { display: flex; gap: 18px; margin: 10px 0 16px; }
  .stat { background: #fbfaf6; border: 1px solid #eadfc4; border-radius: 10px; padding: 8px 14px; }
  .stat b { display: block; font-size: 18px; color: #9a7d1f; }
  .stat span { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .3px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .4px; color: #8A8A8E;
       border-bottom: 1px solid #e5e0d2; padding: 6px 6px; }
  td { padding: 6px; border-bottom: 1px solid #eee; vertical-align: middle; font-size: 11.5px; }
  td.num { text-align: right; }
  .thumb-cell { width: 46px; }
  .thumb { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; background: #f3f0e8; }
  .band-dot { display: inline-block; width: 7px; height: 7px; border-radius: 999px; margin-right: 5px; }
  .status-pill { border: 1px solid; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 700; }
  footer.disclaimer { margin-top: 18px; border-top: 1px solid #e5e0d2; padding-top: 10px; font-size: 10px; color: #8a8a8e; line-height: 1.5; }
</style>
</head>
<body>
  <div class="doc">
    <header class="masthead">
      <div>
        <div class="brand"><span class="gem">💎 Gem</span>Scan</div>
        <div class="brand-sub">${t("Batch Scan Summary", "Soo Koobid Batch Scan")}</div>
      </div>
      <div class="meta">
        <div>${t("Items", "Shayada")}: <b>${items.length}</b></div>
        <div>${t("Generated", "La sameeyay")}: <b>${esc(generated)}</b></div>
      </div>
    </header>

    <div class="stats">
      <div class="stat"><b>${completed}</b><span>${t("Completed", "Dhammaystiran")}</span></div>
      <div class="stat"><b>${failed}</b><span>${t("Failed", "Fashilmay")}</span></div>
      <div class="stat"><b>${skipped}</b><span>${t("Skipped", "La booday")}</span></div>
    </div>

    <table>
      <thead>
        <tr>
          <th></th>
          <th>${t("Object", "Shayga")}</th>
          <th class="num">${t("Confidence", "Kalsooni")}</th>
          <th class="num">${t("Est. value", "Qiimaha qiyaas")}</th>
          <th>${t("Scan type", "Nooca")}</th>
          <th>${t("Status", "Xaalad")}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <footer class="disclaimer">
      ${t(
        "Identifications and values are AI estimates based on photographs — not an official appraisal. See each item's full result in the app for details.",
        "Aqoonsiga iyo qiimaha waa qiyaas AI ku saleysan sawirro — maaha qiimayn rasmi ah. Faahfaahin dheeraad ah eeg natiijada buuxa ee app-ka.",
      )}
    </footer>
  </div>
</body>
</html>`;
}

/**
 * Generates a compact batch-summary PDF (one row per item) and opens the
 * native share sheet. Entitlement (Pro/pdfReports) is enforced by the caller.
 */
export async function generateBatchSummaryPdf(items: BatchItemResult[], lang: Lang): Promise<void> {
  const photos = await Promise.all(items.map((i) => toDataUri(i.imageUri)));
  const html = buildBatchSummaryHtml(items, photos, lang);
  const { uri } = await Print.printToFileAsync({ html, base64: false });

  const safeName = `GemScan-Batch-Summary-${Date.now()}.pdf`;
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
      dialogTitle: lang === "so" ? "La wadaag soo koobidda Batch Scan" : "Share your Batch Scan summary",
    });
  }
}

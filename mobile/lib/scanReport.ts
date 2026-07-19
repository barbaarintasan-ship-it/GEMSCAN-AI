// Build a professional PDF report for ANY saved scan, straight from the
// database — so the same report is available from Scan History / My Collection,
// not only immediately after a scan. Always reflects the latest saved scan
// data (it re-reads every field at generation time).
//
// Entitlement (Pro / "Gem Collector" only) is enforced by the caller and,
// authoritatively, server-side (RLS + tier features). This helper does not
// gate — it just assembles and hands off to the shared generator.
import { supabase } from "./supabase";
import { estimateValue } from "./valuation";
import { generateAndSharePdf, type PdfReportData } from "./pdfReport";

type Lang = "en" | "so";

/**
 * Loads a saved scan's latest data, assembles the report, and opens the native
 * share sheet (WhatsApp / Email / Messages / Save to Files = download).
 * Returns false when the scan has no usable, sufficient-confidence result
 * (nothing meaningful to put in a report).
 */
export async function generatePdfForScan(scanId: string, lang: Lang): Promise<boolean> {
  const [{ data: scanData }, { data: candidateData }] = await Promise.all([
    supabase.from("scans").select("final_result, created_at").eq("id", scanId).maybeSingle(),
    supabase
      .from("scan_candidates")
      .select("rank, label, weighted_confidence, confidence_band")
      .eq("scan_id", scanId)
      .order("rank", { ascending: true }),
  ]);

  const fr = (scanData as { final_result?: any } | null)?.final_result;
  if (!fr || fr.insufficientConfidence || !fr.bestMatch) return false;

  // Photo, hallmark data, and market valuation are all independent of each
  // other — nothing downstream renders until the whole report is assembled,
  // so run all three concurrently instead of one after another.
  const [photoUrl, hallmark, valuation] = await Promise.all([
    // First specimen photo (private bucket → signed URL).
    (async (): Promise<string | null> => {
      const { data: img } = await supabase
        .from("scan_images")
        .select("original_storage_path")
        .eq("scan_id", scanId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      const path = (img as { original_storage_path?: string } | null)?.original_storage_path;
      if (!path) return null;
      const { data: signed } = await supabase.storage.from("scan-images").createSignedUrl(path, 3600);
      return signed?.signedUrl ?? null;
    })(),
    // Hallmark (only when the OCR provider transcribed a mark).
    (async (): Promise<PdfReportData["hallmark"]> => {
      const { data: hm } = await supabase
        .from("scan_ai_responses")
        .select("candidate_label, reasoning, raw_response")
        .eq("scan_id", scanId)
        .eq("provider", "hallmark_ocr")
        .limit(1)
        .maybeSingle();
      if (!hm) return null;
      const raw = (hm as { raw_response?: { marks?: unknown } }).raw_response;
      const marks = Array.isArray(raw?.marks) ? (raw!.marks as string[]) : [];
      const matchedLabel = (hm as { candidate_label?: string | null }).candidate_label ?? null;
      if (marks.length === 0 && !matchedLabel) return null;
      return { marks, matchedLabel, note: (hm as { reasoning?: string | null }).reasoning ?? null };
    })(),
    // Live market valuation — the same additive estimate the results screen
    // shows (it is derived, not stored, so we recompute it for an up-to-date
    // figure).
    estimateValue(fr.bestMatch, fr.confidenceScore, lang).catch(() => null),
  ]);

  const alts = ((candidateData as { rank: number; label: string; weighted_confidence: number; confidence_band: string }[]) ?? []).filter(
    (c) => c.rank > 1,
  );

  const data: PdfReportData = {
    scanId,
    createdAt: (scanData as { created_at: string }).created_at,
    bestMatch: fr.bestMatch,
    confidencePct: Math.round(fr.confidenceScore * 100),
    confidenceBand: fr.confidenceBand,
    reasoning: fr.reasoning ?? null,
    explanationStyle: fr.explanationStyle ?? null,
    simpleExplanation: fr.simpleExplanation ?? null,
    expertExplanation: fr.expertExplanation ?? null,
    alternatives: alts.map((c) => ({
      label: c.label,
      confidencePct: Math.round(c.weighted_confidence * 100),
      band: c.confidence_band,
    })),
    valuation: valuation
      ? {
          minUsd: valuation.minUsd,
          typicalUsd: valuation.typicalUsd,
          premiumUsd: valuation.premiumUsd,
          note: valuation.qualityNote,
          lowConfidence: valuation.lowConfidence,
        }
      : null,
    hallmark,
    images: photoUrl ? [{ uri: photoUrl, caption: lang === "so" ? "Sawirka shayga" : "Specimen photo" }] : [],
  };

  await generateAndSharePdf(data, lang);
  return true;
}

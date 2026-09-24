// Phase 17 — "Find Gold" plain-language layer.
//
// PURE UI TRANSLATION, nothing more: takes the SAME deterministic score/band
// /reasons Phase 10/11 already computed and persisted, and restates them in
// everyday words for a field worker with no geology background. Computes
// nothing new, decides nothing new — every fact surfaced here already
// exists verbatim in mission_assignment.reasons or exploration_area. The
// full technical view (target-report) stays one tap away for anyone who
// wants H3 cells, coverage roles and evidence weights.
import type { TeamTargetReason } from "./missions";

export type SimpleLevel = "good" | "maybe" | "low" | "unknown";

/** Same three bands bandFor() already produces — just a friendlier label. */
export function bandToSimpleLevel(band: string | null | undefined): SimpleLevel {
  if (band === "High") return "good";
  if (band === "Moderate") return "maybe";
  if (band === "Low") return "low";
  return "unknown";
}

export const LEVEL_EMOJI: Record<SimpleLevel, string> = {
  good: "\u{1F7E2}", maybe: "\u{1F7E1}", low: "\u{1F534}", unknown: "⚪",
};

export function levelLabel(level: SimpleLevel, so: boolean): string {
  switch (level) {
    case "good": return so ? "Fursad wanaagsan" : "Good chance";
    case "maybe": return so ? "Fursad dhexdhexaad ah" : "Worth a look";
    case "low": return so ? "Fursad yar" : "Low chance";
    default: return so ? "Wali lama hubin" : "Not checked yet";
  }
}

/** One reason object → one plain sentence, or null when this kind has no
 *  everyday translation yet (caller should skip it, never show "undefined"). */
export function reasonToPlain(reason: TeamTargetReason, so: boolean): string | null {
  const kind = reason?.kind as string | undefined;
  switch (kind) {
    case "occurrence": {
      const commodity = String(reason.commodity ?? (so ? "macdan" : "a mineral"));
      return so ? `Waxaa horey loo helay ${commodity} meel u dhow` : `${commodity} has been found nearby before`;
    }
    case "association":
      return so
        ? "Dhagaxyada halkan waxay xiriir la leeyihiin macdanta la doonayo"
        : "The rock here is chemically linked to what we're looking for";
    case "community":
      return so ? "Dad kale ayaa halkan wax ka helay" : "Other people have reported finding something here";
    case "fault":
    case "contact":
    case "intersection":
      return so
        ? "Qaabka dhagaxa halkan waa nooca macdanta lagu helo badanaa"
        : "The rock structure here is the shape minerals often collect in";
    case "unit": {
      const name = reason.name ? String(reason.name) : "";
      return so
        ? `Nooca dhagaxa halkan${name ? ` (${name})` : ""} ayaa yaqaan inuu macdan sido`
        : `This rock type${name ? ` (${name})` : ""} is known to carry minerals`;
    }
    case "observation": {
      const label = String(reason.label ?? "");
      return so ? `La arkay calaamad: ${label}` : `A sign was observed: ${label}`;
    }
    default:
      return null;
  }
}

/** The first reason with a plain translation, or null if none translate. */
export function topReasonSentence(reasons: TeamTargetReason[] | null | undefined, so: boolean): string | null {
  if (!reasons || reasons.length === 0) return null;
  for (const r of reasons) {
    const s = reasonToPlain(r, so);
    if (s) return s;
  }
  return null;
}

/** Every reason with a plain translation, in order, deduplicated. */
export function allReasonSentences(reasons: TeamTargetReason[] | null | undefined, so: boolean): string[] {
  if (!reasons || reasons.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of reasons) {
    const s = reasonToPlain(r, so);
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// Client for the estimate-value Edge Function (additive market valuation).
// Returns null when the estimate is unavailable so the results screen can simply
// omit the valuation section.
import { supabase } from "./supabase";

const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;

export type Rarity = "common" | "uncommon" | "rare" | "very_rare";

// Weight can't be measured from a photo, so value is always expressed as a
// price RANGE per the correct market unit — never a single total.
export type PriceUnit = "gram" | "carat" | "specimen";

export type Valuation = {
  unit: PriceUnit;
  purity: string | null; // e.g. "22K" for gold; null otherwise
  minUsd: number | null; // per-unit low
  maxUsd: number | null; // per-unit high
  typicalUsd: number | null; // per-unit typical/midpoint (optional)
  rarity: Rarity;
  collectible: boolean;
  qualityNote: string;
  lowConfidence: boolean;
};

// Localized unit label: "per gram (22K)" / "per carat" / "per specimen".
export function priceUnitLabel(unit: PriceUnit, purity: string | null, so: boolean): string {
  const base =
    unit === "gram"
      ? so
        ? "halkii garaam"
        : "per gram"
      : unit === "carat"
        ? so
          ? "halkii karaat"
          : "per carat"
        : so
          ? "halkii xabbo"
          : "per specimen";
  return purity ? `${base} (${purity})` : base;
}

// The single canonical range string ("USD 72–76 per gram (22K)") reused by the
// results card, share text/card, batch list and reports. Returns null when
// there is nothing confident to show.
export function formatValuationRange(v: Valuation, so: boolean): string | null {
  if (v.lowConfidence || v.minUsd == null || v.maxUsd == null) return null;
  return `USD ${Math.round(v.minUsd)}–${Math.round(v.maxUsd)} ${priceUnitLabel(v.unit, v.purity, so)}`;
}

export async function estimateValue(
  label: string,
  confidence?: number,
  lang?: "en" | "so",
): Promise<Valuation | null> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return null;

    const res = await fetch(`${FUNCTIONS_URL}/estimate-value`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label, confidence, lang: lang ?? "en" }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.available !== true) return null;

    return {
      unit: (["gram", "carat", "specimen"] as const).includes(body.unit) ? body.unit : "specimen",
      purity: body.purity != null && String(body.purity).trim() !== "" ? String(body.purity).trim() : null,
      minUsd: body.minUsd ?? null,
      // Back-compat: an older deployed function returns premiumUsd, not maxUsd.
      maxUsd: body.maxUsd ?? body.premiumUsd ?? null,
      typicalUsd: body.typicalUsd ?? null,
      rarity: (["common", "uncommon", "rare", "very_rare"] as const).includes(body.rarity)
        ? body.rarity
        : "common",
      collectible: body.collectible === true,
      qualityNote: String(body.qualityNote ?? ""),
      lowConfidence: body.lowConfidence === true,
    };
  } catch {
    return null;
  }
}

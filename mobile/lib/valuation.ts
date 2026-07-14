// Client for the estimate-value Edge Function (additive market valuation).
// Returns null when the estimate is unavailable so the results screen can simply
// omit the valuation section.
import { supabase } from "./supabase";

const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;

export type Rarity = "common" | "uncommon" | "rare" | "very_rare";

export type Valuation = {
  minUsd: number | null;
  typicalUsd: number | null;
  premiumUsd: number | null;
  rarity: Rarity;
  collectible: boolean;
  qualityNote: string;
  lowConfidence: boolean;
};

export async function estimateValue(label: string, confidence?: number): Promise<Valuation | null> {
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
      body: JSON.stringify({ label, confidence }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.available !== true) return null;

    return {
      minUsd: body.minUsd ?? null,
      typicalUsd: body.typicalUsd ?? null,
      premiumUsd: body.premiumUsd ?? null,
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

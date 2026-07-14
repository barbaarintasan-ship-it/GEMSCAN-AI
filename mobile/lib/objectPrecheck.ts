// STAGE 1 · LEVEL 2 client — cheap Gemini category pre-check.
//
// Downsizes the frame to ≤512px, sends it to the precheck-object Edge Function
// (Gemini only), and returns whether the object is a supported specimen. This
// runs BEFORE the full ensemble so unsupported objects (person/food/clutter/…)
// are rejected on a single cheap call — OpenAI and Claude are never touched.
//
// FAILS OPEN: any auth/network/parse problem resolves to supported=true so a
// pre-check glitch never blocks a legitimate scan. Only a confident
// NOT_SUPPORTED verdict from Gemini rejects.
import * as FileSystem from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";
import { supabase } from "./supabase";

const FUNCTIONS_URL = process.env.EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL!;
const PRECHECK_MAX_WIDTH = 512;

export type SupportedCategory =
  | "gemstone"
  | "mineral"
  | "rock"
  | "gold"
  | "silver"
  | "jewelry"
  | "coin"
  | "artifact"
  | "unknown";

export type PrecheckResult = {
  supported: boolean;
  category: SupportedCategory;
  available: boolean; // did the cloud pre-check actually run?
};

const KNOWN: SupportedCategory[] = [
  "gemstone", "mineral", "rock", "gold", "silver", "jewelry", "coin", "artifact",
];

function normalizeCategory(raw: string | null | undefined): SupportedCategory {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (s.includes("artifact") || s.includes("historical")) return "artifact";
  return (KNOWN.find((k) => s.includes(k)) as SupportedCategory) ?? "unknown";
}

export async function precheckObject(uri: string): Promise<PrecheckResult> {
  const failOpen: PrecheckResult = { supported: true, category: "unknown", available: false };
  try {
    const resized = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: PRECHECK_MAX_WIDTH } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
    );
    const imageBase64 = await FileSystem.readAsStringAsync(resized.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return failOpen;

    const res = await fetch(`${FUNCTIONS_URL}/precheck-object`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ imageBase64, mimeType: "image/jpeg" }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) return failOpen;

    // Only a definitive supported===false rejects; anything else fails open.
    const supported = body.supported !== false;
    return {
      supported,
      category: supported ? normalizeCategory(body.category) : "unknown",
      available: true,
    };
  } catch {
    return failOpen;
  }
}

// English / Somali display label for the detected category.
export function categoryLabel(category: SupportedCategory, lang: "en" | "so"): string {
  const map: Record<SupportedCategory, [string, string]> = {
    gemstone: ["Gemstone", "Dhagax qaali ah"],
    mineral: ["Mineral", "Macdan"],
    rock: ["Rock", "Dhagax"],
    gold: ["Gold", "Dahab"],
    silver: ["Silver", "Qalin/Silfar"],
    jewelry: ["Jewelry", "Dahabbir"],
    coin: ["Coin", "Qadaadiic"],
    artifact: ["Historical artifact", "Shay taariikhi ah"],
    unknown: ["Object", "Shay"],
  };
  const entry = map[category];
  return lang === "so" ? entry[1] : entry[0];
}

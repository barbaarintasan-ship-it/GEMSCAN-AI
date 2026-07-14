// Expert-contact + valuation configuration.
//
// The phone number, WhatsApp number and high-value threshold are read from
// environment variables (set in eas.json → env, prefixed EXPO_PUBLIC_ so they
// are inlined at build time). They are intentionally NOT hardcoded in source so
// they can be changed without touching the app code.
export const EXPERT_PHONE = process.env.EXPO_PUBLIC_EXPERT_PHONE ?? "";
// Digits only, for wa.me deep links (no "+", spaces or dashes).
export const EXPERT_WHATSAPP = (process.env.EXPO_PUBLIC_EXPERT_WHATSAPP ?? "").replace(/[^0-9]/g, "");
export const HIGH_VALUE_THRESHOLD_USD = Number(
  process.env.EXPO_PUBLIC_HIGH_VALUE_THRESHOLD_USD ?? "200",
);

export const hasExpertContact = (): boolean => EXPERT_PHONE.length > 0 || EXPERT_WHATSAPP.length > 0;

// Pre-filled WhatsApp message the user sends to request an expert review.
export function expertMessage(bestMatch: string | null, lang: "en" | "so"): string {
  if (lang === "so") {
    return (
      `Salaan,\n\n` +
      `GemScan AI wuxuu qiyaasay inaan heli karo shay qiimo leh` +
      (bestMatch ? ` (${bestMatch})` : "") +
      `.\n\nWaxaan jeclaan lahaa dib-u-eegis khibrad leh. Waxaan ku lifaaqi doonaa natiijada scan-ka iyo sawirrada.`
    );
  }
  return (
    `Hello,\n\n` +
    `GemScan AI believes I may have found a valuable object` +
    (bestMatch ? ` (${bestMatch})` : "") +
    `.\n\nI would like a professional review. I will attach my scan results and photographs.`
  );
}

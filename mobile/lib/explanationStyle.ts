// Dual Explanation Modes — the user's remembered "Simple" vs "Expert" scan
// result preference. Mirrors the local-first, server-mirrored persistence
// pattern in lib/i18n.ts (LANGUAGE_STORAGE_KEY / setAppLanguage): the choice
// is stored in AsyncStorage so it survives restarts even offline, and is
// best-effort mirrored to profiles.explanation_style so the website/other
// devices stay in sync.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import type { ExplanationStyle } from "./scanUpload";

export const EXPLANATION_STYLE_STORAGE_KEY = "gemscan.explanationStyle";

// Null means "never chosen yet" — the caller should show the
// ExplanationStyleChooser sheet in that case, per the "Choose Explanation
// Style" flow.
export async function getStoredExplanationStyle(): Promise<ExplanationStyle | null> {
  const stored = await AsyncStorage.getItem(EXPLANATION_STYLE_STORAGE_KEY);
  return stored === "simple" || stored === "expert" ? stored : null;
}

export async function setExplanationStyle(style: ExplanationStyle): Promise<void> {
  await AsyncStorage.setItem(EXPLANATION_STYLE_STORAGE_KEY, style);
  // Mirror to the user's profile so the website and app agree. Best-effort:
  // a failure here (offline, no row yet) must not block the local switch.
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("profiles").update({ explanation_style: style }).eq("id", user.id);
    }
  } catch {
    // ignored — local persistence above is the source of truth on-device.
  }
}

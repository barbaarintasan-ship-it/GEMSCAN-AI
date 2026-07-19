// App internationalization (English + Somali).
//
// The app ships with two locales — English ("en") and Somali ("so") — matching
// the `profiles.locale` check constraint in migration 0001. The active language
// is persisted locally in AsyncStorage so the choice survives restarts even
// offline, and is best-effort mirrored to profiles.locale (see setAppLanguage)
// so the website stays in sync. English is the default on first launch
// (deliberately not device-locale-detected); Somali is always available as a
// manual choice via the in-app language switcher (see settings.tsx).
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import en from "../locales/en.json";
import so from "../locales/so.json";

export const LANGUAGE_STORAGE_KEY = "gemscan.language";
export type AppLanguage = "en" | "so";

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    so: { translation: so },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  // React Native's JS runtime may lack Intl.PluralRules; the v3 JSON format
  // avoids depending on it. The app has no plural keys today, but this keeps
  // i18next from throwing if any are added later.
  compatibilityJSON: "v3",
});

// Restore the persisted choice asynchronously. Until this resolves the app
// renders in the device language; react-i18next re-renders subscribers when
// the language changes, so this is a seamless late correction rather than a
// flash of the wrong copy in practice.
AsyncStorage.getItem(LANGUAGE_STORAGE_KEY).then((stored) => {
  if ((stored === "en" || stored === "so") && i18n.language !== stored) {
    i18n.changeLanguage(stored);
  }
});

export async function setAppLanguage(lang: AppLanguage): Promise<void> {
  await i18n.changeLanguage(lang);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  // Mirror to the user's profile so the website and app agree. Best-effort:
  // a failure here (offline, no row yet) must not block the local switch.
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("profiles").update({ locale: lang }).eq("id", user.id);
    }
  } catch {
    // ignored — local persistence above is the source of truth on-device.
  }
}

export default i18n;

// Error tracking + crash reporting, wired through @sentry/react-native.
//
// This is intentionally a safe no-op until EXPO_PUBLIC_SENTRY_DSN is set: no
// real Sentry project exists yet (same situation as Supabase — see
// INFRASTRUCTURE-COMPLETION-REPORT.md), so every function here degrades to
// doing nothing rather than throwing, and nothing else in the app needs to
// know whether monitoring is actually active.
//
// Native crash capture works via standard React Native autolinking (this
// package ships a react-native.config.js) without needing the Sentry Expo
// config plugin. The config plugin (source map upload, sentry.properties)
// is NOT wired in — it requires a real Sentry org/project/auth token and a
// `expo prebuild` re-run, since android/ and ios/ are committed directly
// rather than generated per-build. That remains a pending step until a real
// Sentry project exists.
import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

export function initMonitoring(): void {
  if (!dsn) {
    return;
  }
  Sentry.init({
    dsn,
    environment: __DEV__ ? "development" : "production",
    release: Constants.expoConfig?.version,
    tracesSampleRate: 0.2,
  });
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!dsn) {
    if (__DEV__) {
      console.error(err);
    }
    return;
  }
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

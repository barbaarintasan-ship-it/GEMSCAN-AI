import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAuth } from "../../lib/auth";
import { useExpeditionLease } from "../../lib/exploration/useExpeditionLease";
import LoadingScreen from "../../components/LoadingScreen";

// A native Stack (rather than a bare Slot) so every in-app screen gets a real
// header with a back arrow, and — importantly — so the Android hardware back
// button / edge-swipe gesture pops screens correctly instead of dropping the
// user straight out of the app. The scan flow keeps its own nested stack, so
// this parent hides its header for that route to avoid a double header bar.
export default function AppLayout() {
  const { session, isLoading } = useAuth();
  const lease = useExpeditionLease();

  // BOTH answers, or neither. Deciding on auth alone while the lease is still
  // being read from storage flashes the login screen over a running expedition.
  if (isLoading || lease.isLoading) return <LoadingScreen />;

  /**
   * THE GATE, NARROWED TO WHAT IT IS ACTUALLY FOR.
   *
   * This was `if (!session) → login`, unconditionally. On 07–08/08/2026 that
   * ejected a geologist from a fourteen-hour expedition in the Karkaar mountains:
   * the token expired after about an hour, the refresh failed because there was
   * no network, `onAuthStateChange` propagated a null session, and this line sent
   * them to a screen that cannot be satisfied without a network. Everything they
   * were actually doing — local map, local pack, local GPS, local storage —
   * needed no identity whatsoever.
   *
   * So the gate now asks a second question: is a field session open? If it is,
   * the app stays. Signing in remains required to REACH the app and to upload;
   * it is no longer required to keep working once you are out there.
   *
   * Scope is deliberately narrow (Milestone 1): with no lease open, behaviour is
   * byte-for-byte what it was, so nothing outside Expedition Mode can regress.
   * The screens that genuinely need an identity guard themselves — see
   * history.tsx and collection-map.tsx.
   */
  if (!session && !lease.isOpen) return <Redirect href="/(auth)/login" />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: "#0B0B0C" },
        headerTintColor: "#F5F1E8",
        headerTitleStyle: { color: "#F5F1E8", fontWeight: "700" },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: "#0B0B0C" },
      }}
    >
      <Stack.Screen name="index" options={{ title: "LuulScan" }} />
      <Stack.Screen name="history" options={{ title: "My Collection" }} />
      <Stack.Screen name="collection-map" options={{ title: "Map" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="edit-profile" options={{ title: "Edit Profile" }} />
      <Stack.Screen name="account" options={{ title: "Account" }} />
      <Stack.Screen name="scan" options={{ headerShown: false }} />
      {/* Enterprise owner beta (Sprint 4.2) — hidden entry point, gated to the
          owner allowlist on the client and enforced by requireEnterprise server-side. */}
      {/* The map workspace. Headerless: it draws its own bar over the ground
          (Architecture v2 §0.2 — the map is the operating system). `exploration`
          is the old path, kept as a redirect for installed builds and deep links. */}
      <Stack.Screen name="explore" options={{ headerShown: false }} />
      <Stack.Screen name="exploration" options={{ headerShown: false }} />
      {/* The Enterprise Field Work dashboard, and the two surfaces under it.
          All own their headers: these read as one workspace, not as a stack of
          system-chromed pages. */}
      <Stack.Screen name="enterprise/index" options={{ headerShown: false }} />
      {/* Exploration Reports own their headers — a report is read full-bleed, and
          the list has a back arrow of its own so it matches the map surfaces. */}
      <Stack.Screen name="enterprise/reports" options={{ headerShown: false }} />
      <Stack.Screen name="enterprise/report/[missionId]" options={{ headerShown: false }} />
      <Stack.Screen name="enterprise/samples" options={{ title: "My Samples" }} />
      <Stack.Screen name="enterprise/new-sample" options={{ title: "New Sample" }} />
      <Stack.Screen name="enterprise/sample/[id]" options={{ title: "Sample" }} />
      {/* A sample still held on the device — readable with no signal. */}
      <Stack.Screen name="enterprise/local-sample/[localId]" options={{ title: "Held on device" }} />
      {/* Self-serve team management — draws its own header (matches the other
          enterprise/ surfaces), reached from Settings. */}
      <Stack.Screen name="enterprise/team" options={{ headerShown: false }} />
    </Stack>
  );
}

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../lib/auth";
import { captureException, initMonitoring } from "../lib/monitoring";
// TEMPORARY: global crash-diagnostics for the "Preparing photos" investigation.
// Chained handler (observe + delegate) — remove with lib/scanDiag.ts once done.
import { installCrashDiagnostics } from "../lib/scanDiag";
// Watching the JS thread for the "opens frozen — scrolls but no button responds"
// report. Scrolling is native and continues while JavaScript is blocked; a tap
// cannot. Logging only; see lib/diagnostics/jsStall.ts.
import { markPhase, startStallWatch } from "../lib/diagnostics/jsStall";
// TEMPORARY: outbox.persist() ~52s freeze investigation — fresh-key write
// probe + backup of the outbox/package/sample store keys. Fire-and-forget,
// non-blocking, non-destructive. Remove with lib/diagnostics/storageProbe.ts
// once the investigation concludes.
import { runStorageDiagnostic } from "../lib/diagnostics/storageProbe";
import UpdateGate from "../components/UpdateGate";
import "../lib/i18n";
import { DEV_INDICATOR_ENABLED } from "../lib/devIndicator";
import { ExplorationProvider } from "../lib/exploration/provider";
import { MapWorkspaceProvider } from "../lib/exploration/workspace";

const queryClient = new QueryClient();

initMonitoring();
installCrashDiagnostics();
// Started at module scope, before the first component mounts, so a stall during
// the very first render is measured rather than missed.
startStallWatch();
// Fire-and-forget: never blocks boot, never throws past its own try/catch.
void runStorageDiagnostic();
const bootPhase = markPhase("app.boot");
// Ended on the next macrotask: by then the initial synchronous render has run,
// and anything still blocking belongs to whatever started it, not to boot.
// ENDED ON THE FIRST COMMIT, not on the next tick.
//
// `setTimeout(bootPhase, 0)` closed the phase before any startup work had
// happened, so `app.boot` covered nothing and every real cold-start stall was
// reported as "no phase declared". A four-second block measured on a real device
// arrived with no attribution at all — the one phase that should have caught it
// had already closed itself.
//
// The honest boundary is "the app is on screen": module evaluation, the provider
// graph, i18n and the first render all fall inside it, and the effect below fires
// after the first commit. See `useEffect` in RootLayout.

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; detail: string | null }
> {
  state: { hasError: boolean; detail: string | null } = { hasError: false, detail: null };

  static getDerivedStateFromError(error: unknown) {
    // The MESSAGE is kept, not just the fact of failure. "Something went wrong"
    // told a field tester nothing and told us nothing either: a screen that
    // crashed on a phone in Bosaso had to be guessed at from here. In a
    // field-testing build the boundary shows what actually threw.
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, detail: message.slice(0, 400) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    captureException(error, { componentStack: info.componentStack });
    // Keep the top of the component stack: it names the screen that failed,
    // which is the difference between "the app broke" and "explore/index broke".
    const frames = (info.componentStack ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(" <- ");
    if (frames) this.setState((s) => ({ ...s, detail: [s.detail, frames].filter(Boolean).join("\n\n") }));
  }

  render() {
    if (this.state.hasError) {
      // A branded, recoverable fallback rather than a blank screen, so an
      // unexpected error never looks like the app simply died.
      return (
        <View style={styles.fallback}>
          <Text style={styles.fallbackLogo}>💎 LuulScan</Text>
          <Text style={styles.fallbackTitle}>Something went wrong</Text>
          <Text style={styles.fallbackBody}>
            Wax baa qaldamay. Fadlan isku day mar kale.{"\n"}Please try again.
          </Text>
          <Pressable style={styles.fallbackButton} onPress={() => this.setState({ hasError: false, detail: null })}>
            <Text style={styles.fallbackButtonText}>Try again · Isku day mar kale</Text>
          </Pressable>
          {/* Field-testing build: the actual error, so a failure in the field is
              diagnosable on the spot instead of reported as "it broke". Gated on
              the same flag as the rest of the diagnostics. */}
          {DEV_INDICATOR_ENABLED && this.state.detail ? (
            <Text selectable style={styles.fallbackDetail}>{this.state.detail}</Text>
          ) : null}
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  fallbackDetail: {
    color: "#E0A03C",
    fontSize: 11,
    fontFamily: "monospace",
    marginTop: 24,
    textAlign: "left",
  },
  fallback: {
    flex: 1,
    backgroundColor: "#0B0B0C",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 12,
  },
  fallbackLogo: { fontSize: 26, fontWeight: "800", color: "#C9A227" },
  fallbackTitle: { fontSize: 18, fontWeight: "700", color: "#F5F1E8", marginTop: 4 },
  fallbackBody: { fontSize: 14, color: "#C9C9CC", textAlign: "center", lineHeight: 20 },
  fallbackButton: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 28,
    marginTop: 8,
  },
  fallbackButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
});

export default function RootLayout() {
  // Closes `app.boot` when the first frame is committed — see the note above.
  React.useEffect(() => bootPhase(), []);
  // The animated boot logo plays once per cold start, layered on top of the app
  // while it mounts underneath. When it finishes it unmounts itself.

  return (
    <RootErrorBoundary>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <StatusBar style="light" />
            {/*
              THE FIELD SESSION LIVES HERE — above the router, for the life of the
              app process.

              Architecture v2 §0.2 says no navigation may unmount the map, the
              session or the GPS watch. Mounting these in the explore ROUTE
              satisfied that only while the geologist stayed on the route: the
              back arrow popped it, React unmounted the provider, and the
              provider's teardown called orchestrator.destroy() — ending the
              expedition, stopping the watch and discarding the traverse, because
              somebody wanted to check their collection for ten seconds.

              Above the router, leaving the map is just leaving the map. The
              session keeps running, the track keeps recording, the expedition
              stays open and the outbox keeps filing, until the app itself is
              closed. Returning restores the same camera over the same scene.
            */}
            <ExplorationProvider>
              <MapWorkspaceProvider>
                <Slot />
                <UpdateGate />
              </MapWorkspaceProvider>
            </ExplorationProvider>
          </AuthProvider>
        </QueryClientProvider>
        {/* THE ANIMATED SPLASH IS GONE, and this is why.

            It mounted a WebView and handed it a full HTML document with animated
            SVG — on the cold-start path, on the same thread that was building the
            provider graph and the router. Measured on an SM-A165F:

              [jsStall] UNRESPONSIVE 4002 ms  during: app.splash

            Four seconds of dead JavaScript on every launch. Scrolling kept
            working, because Android scrolls natively; nothing else did, because a
            Pressable cannot fire until JavaScript gets a turn. That is exactly the
            report — "it opens, it scrolls, no button responds until I force-close
            it" — and it took four rounds of instrumentation to name it.

            The app already has a real splash: `expo.splash` in app.json, drawn by
            Android before any JavaScript runs at all. It costs nothing because it
            is not JavaScript.

            components/AnimatedSplash.tsx is KEPT, unmounted. The artwork is worth
            having and the way back is react-native-svg — native, animatable, and
            not a browser. Re-mounting the WebView version would reintroduce the
            four seconds exactly as measured. */}
      </SafeAreaProvider>
    </RootErrorBoundary>
  );
}

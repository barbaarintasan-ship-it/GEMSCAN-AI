import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Slot } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../lib/auth";
import { captureException, initMonitoring } from "../lib/monitoring";
import "../lib/i18n";

const queryClient = new QueryClient();

initMonitoring();

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    captureException(error, { componentStack: info.componentStack });
  }

  render() {
    if (this.state.hasError) {
      // A branded, recoverable fallback rather than a blank screen, so an
      // unexpected error never looks like the app simply died.
      return (
        <View style={styles.fallback}>
          <Text style={styles.fallbackLogo}>💎 GemScan</Text>
          <Text style={styles.fallbackTitle}>Something went wrong</Text>
          <Text style={styles.fallbackBody}>
            Wax baa qaldamay. Fadlan isku day mar kale.{"\n"}Please try again.
          </Text>
          <Pressable style={styles.fallbackButton} onPress={() => this.setState({ hasError: false })}>
            <Text style={styles.fallbackButtonText}>Try again · Isku day mar kale</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
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
  return (
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Slot />
        </AuthProvider>
      </QueryClientProvider>
    </RootErrorBoundary>
  );
}

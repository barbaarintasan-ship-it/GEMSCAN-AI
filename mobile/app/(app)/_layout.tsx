import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAuth } from "../../lib/auth";
import LoadingScreen from "../../components/LoadingScreen";

// A native Stack (rather than a bare Slot) so every in-app screen gets a real
// header with a back arrow, and — importantly — so the Android hardware back
// button / edge-swipe gesture pops screens correctly instead of dropping the
// user straight out of the app. The scan flow keeps its own nested stack, so
// this parent hides its header for that route to avoid a double header bar.
export default function AppLayout() {
  const { session, isLoading } = useAuth();

  if (isLoading) return <LoadingScreen />;
  if (!session) return <Redirect href="/(auth)/login" />;

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
      <Stack.Screen name="index" options={{ title: "GemScan" }} />
      <Stack.Screen name="history" options={{ title: "My Collection" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="account" options={{ title: "Account" }} />
      <Stack.Screen name="scan" options={{ headerShown: false }} />
    </Stack>
  );
}

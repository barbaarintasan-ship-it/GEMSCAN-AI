import { Stack } from "expo-router";

export default function ScanLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: "#0B0B0C" },
        headerTintColor: "#F5F1E8",
        headerTitleStyle: { color: "#F5F1E8" },
        contentStyle: { backgroundColor: "#0B0B0C" },
      }}
    >
      <Stack.Screen name="live" options={{ title: "Live Scan", headerShown: false }} />
      <Stack.Screen name="upload" options={{ title: "Upload Images" }} />
      <Stack.Screen name="capture" options={{ title: "Manual Capture" }} />
      <Stack.Screen name="results" options={{ title: "Scan Result" }} />
      <Stack.Screen name="batch" options={{ title: "Batch Scan" }} />
      <Stack.Screen name="batch-results" options={{ title: "Batch Results" }} />
      <Stack.Screen name="verify" options={{ title: "High-Value Gem Verification" }} />
      <Stack.Screen name="gold-prospect" options={{ title: "Gold Prospect Evaluation" }} />
    </Stack>
  );
}

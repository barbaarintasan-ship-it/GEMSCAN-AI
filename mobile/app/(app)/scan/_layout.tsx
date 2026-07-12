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
      <Stack.Screen name="capture" options={{ title: "New Scan" }} />
      <Stack.Screen name="results" options={{ title: "Scan Result" }} />
    </Stack>
  );
}

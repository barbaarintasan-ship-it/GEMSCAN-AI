import React from "react";
import { View, Image, ActivityIndicator, StyleSheet } from "react-native";

// Branded loading screen shown while the auth session is being restored, so the
// GemScan AI logo stays on screen during the transition from the native splash
// into the app instead of a blank dark frame.
export default function LoadingScreen() {
  return (
    <View style={styles.container}>
      <Image
        source={require("../assets/splash.png")}
        style={styles.logo}
        resizeMode="contain"
      />
      <ActivityIndicator color="#C9A227" style={styles.spinner} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B0B0C",
    alignItems: "center",
    justifyContent: "center",
  },
  logo: { width: 180, height: 180 },
  spinner: { marginTop: 24 },
});

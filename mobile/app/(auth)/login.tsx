import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { router } from "expo-router";
import { useAuth } from "../../lib/auth";

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const onSubmit = async () => {
    setError(null);
    setIsSubmitting(true);
    const { error: signInError } = await signIn(email, password);
    setIsSubmitting(false);
    if (signInError) {
      setError(signInError);
      return;
    }
    router.replace("/(app)");
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>GemScan AI</Text>
      <Text style={styles.subtitle}>Log in to your account</Text>

      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor="#8A8A8E"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor="#8A8A8E"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.button} onPress={onSubmit} disabled={isSubmitting}>
        <Text style={styles.buttonText}>{isSubmitting ? "Logging in…" : "Log in"}</Text>
      </Pressable>

      <Pressable onPress={() => router.push("/(auth)/register")}>
        <Text style={styles.link}>Don't have an account? Sign up</Text>
      </Pressable>

      {/*
        Note: there is intentionally no "Upgrade" or "Subscribe" button on
        this screen or anywhere in the auth flow. Subscriptions are only
        ever purchased on the website — see /05-Monetization-Legal-Payments.md.
      */}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#0B0B0C", gap: 12 },
  title: { fontSize: 28, fontWeight: "700", color: "#F5F1E8", textAlign: "center" },
  subtitle: { fontSize: 14, color: "#8A8A8E", textAlign: "center", marginBottom: 16 },
  input: {
    backgroundColor: "#1A1A1D",
    color: "#F5F1E8",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  button: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: { color: "#0B0B0C", fontWeight: "700" },
  link: { color: "#C9A227", textAlign: "center", marginTop: 16 },
  error: { color: "#E5484D", textAlign: "center" },
});

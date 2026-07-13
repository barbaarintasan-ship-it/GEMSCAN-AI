import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { router } from "expo-router";
import { useAuth } from "../../lib/auth";

export default function RegisterScreen() {
  const { signUp } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    if (!email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setIsSubmitting(true);
    const { error: signUpError, needsEmailConfirmation } = await signUp(email, password);
    setIsSubmitting(false);
    if (signUpError) {
      setError(signUpError);
      return;
    }
    if (needsEmailConfirmation) {
      // Account was created but the project requires email verification. Tell the
      // user to confirm instead of navigating into the app (which would bounce
      // straight back here because there is no session yet).
      setConfirmationEmail(email);
      return;
    }
    // New accounts default to the free tier (see the signup DB trigger in
    // supabase/migrations/0001_init_auth_subscriptions.sql). Upgrading is a
    // website-only action — this screen never offers to sell anything.
    router.replace("/(app)");
  };

  if (confirmationEmail) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Check your email</Text>
        <Text style={styles.subtitle}>
          We sent a confirmation link to {confirmationEmail}. Tap it to activate your
          account, then come back and log in.
        </Text>
        <Pressable style={styles.button} onPress={() => router.replace("/(auth)/login")}>
          <Text style={styles.buttonText}>Go to login</Text>
        </Pressable>
        <Pressable onPress={() => setConfirmationEmail(null)}>
          <Text style={styles.link}>Use a different email</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Create your account</Text>
      <Text style={styles.subtitle}>
        Free accounts get 5 scans/day. Upgrade anytime on gemscan.ai.
      </Text>

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
        placeholder="Password (min. 8 characters)"
        placeholderTextColor="#8A8A8E"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.button} onPress={onSubmit} disabled={isSubmitting}>
        <Text style={styles.buttonText}>{isSubmitting ? "Creating account…" : "Sign up"}</Text>
      </Pressable>

      <Pressable onPress={() => router.push("/(auth)/login")}>
        <Text style={styles.link}>Already have an account? Log in</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#0B0B0C", gap: 12 },
  title: { fontSize: 24, fontWeight: "700", color: "#F5F1E8", textAlign: "center" },
  subtitle: { fontSize: 13, color: "#8A8A8E", textAlign: "center", marginBottom: 16 },
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

import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { router } from "expo-router";
import { useAuth } from "../../lib/auth";

export default function RegisterScreen() {
  const { signUp } = useAuth();
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [country, setCountry] = useState("");
  const [city, setCity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);

    // Validate every field before touching the network. Order matters: report
    // the first problem top-to-bottom so the message lines up with the form.
    if (phone.trim().replace(/[^0-9]/g, "").length < 7) {
      setError("Please enter a valid phone number.");
      return;
    }
    if (!email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The two passwords do not match.");
      return;
    }
    if (country.trim().length === 0) {
      setError("Please enter your country.");
      return;
    }
    if (city.trim().length === 0) {
      setError("Please enter your city.");
      return;
    }

    setIsSubmitting(true);
    const { error: signUpError, needsEmailConfirmation } = await signUp(email, password, {
      phone,
      country,
      city,
    });
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
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Create your account</Text>
        <Text style={styles.subtitle}>
          Free accounts get 5 scans/day. Upgrade anytime on our website.
        </Text>

        <Text style={styles.label}>Phone number</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. +252 61 234 5678"
          placeholderTextColor="#8A8A8E"
          keyboardType="phone-pad"
          autoComplete="tel"
          value={phone}
          onChangeText={setPhone}
        />

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          placeholder="you@example.com"
          placeholderTextColor="#8A8A8E"
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          placeholder="Password (min. 8 characters)"
          placeholderTextColor="#8A8A8E"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        <Text style={styles.label}>Confirm password</Text>
        <TextInput
          style={styles.input}
          placeholder="Re-enter your password"
          placeholderTextColor="#8A8A8E"
          secureTextEntry
          value={confirmPassword}
          onChangeText={setConfirmPassword}
        />

        <Text style={styles.label}>Country</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Somalia"
          placeholderTextColor="#8A8A8E"
          autoCapitalize="words"
          autoComplete="country"
          value={country}
          onChangeText={setCountry}
        />

        <Text style={styles.label}>City</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Mogadishu"
          placeholderTextColor="#8A8A8E"
          autoCapitalize="words"
          value={city}
          onChangeText={setCity}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={styles.button} onPress={onSubmit} disabled={isSubmitting}>
          <Text style={styles.buttonText}>{isSubmitting ? "Creating account…" : "Sign up"}</Text>
        </Pressable>

        <Pressable onPress={() => router.push("/(auth)/login")}>
          <Text style={styles.link}>Already have an account? Log in</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#0B0B0C" },
  container: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 8, backgroundColor: "#0B0B0C" },
  title: { fontSize: 24, fontWeight: "700", color: "#F5F1E8", textAlign: "center" },
  subtitle: { fontSize: 13, color: "#8A8A8E", textAlign: "center", marginBottom: 12 },
  label: { fontSize: 12, color: "#C9C9CC", marginTop: 6, marginBottom: 2 },
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
    marginTop: 16,
  },
  buttonText: { color: "#0B0B0C", fontWeight: "700" },
  link: { color: "#C9A227", textAlign: "center", marginTop: 16 },
  error: { color: "#E5484D", textAlign: "center", marginTop: 8 },
});

import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { setAppLanguage } from "../../lib/i18n";

export default function LoginScreen() {
  const { signIn } = useAuth();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";
  const L = (en: string, soText: string) => (so ? soText : en);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const onSubmit = async () => {
    setError(null);
    setIsSubmitting(true);
    const { error: signInError } = await signIn(email.trim(), password);
    setIsSubmitting(false);
    if (signInError) {
      setError(signInError);
      return;
    }
    router.replace("/(app)");
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.container}>
      <Pressable
        style={[styles.langPill, { top: insets.top + 12 }]}
        onPress={() => setAppLanguage(so ? "en" : "so")}
        accessibilityLabel="Change language"
      >
        <Ionicons name="language-outline" size={15} color="#0B0B0C" />
        <Text style={styles.langText}>{so ? "SO" : "EN"}</Text>
      </Pressable>

      <Text style={styles.title}>💎 GemScan</Text>
      <Text style={styles.subtitle}>{L("Log in to your account", "Gal akoonkaaga")}</Text>

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
        placeholder={L("Password", "Furaha sirta")}
        placeholderTextColor="#8A8A8E"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.button} onPress={onSubmit} disabled={isSubmitting}>
        <Text style={styles.buttonText}>
          {isSubmitting ? L("Logging in…", "Waa la galayaa…") : L("Log in", "Gal")}
        </Text>
      </Pressable>

      <Pressable onPress={() => router.push("/(auth)/register")}>
        <Text style={styles.link}>{L("Don't have an account? Sign up", "Akoon ma lihid? Is-diiwaangeli")}</Text>
      </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#0B0B0C" },
  container: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#0B0B0C", gap: 12 },
  langPill: {
    position: "absolute",
    top: 48,
    right: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  langText: { color: "#0B0B0C", fontWeight: "800", fontSize: 12 },
  title: { fontSize: 28, fontWeight: "800", color: "#C9A227", textAlign: "center" },
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

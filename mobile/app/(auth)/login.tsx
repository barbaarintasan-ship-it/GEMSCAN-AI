import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { setAppLanguage } from "../../lib/i18n";
import { Button } from "../../components/ui/Button";
import { colors, spacing, radius, type as typo } from "../../lib/theme";

export default function LoginScreen() {
  const { signIn, resetPassword } = useAuth();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";
  const L = (en: string, soText: string) => (so ? soText : en);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const onSubmit = async () => {
    setError(null);
    setResetMsg(null);
    setIsSubmitting(true);
    const { error: signInError } = await signIn(email.trim(), password);
    setIsSubmitting(false);
    if (signInError) {
      setError(signInError);
      return;
    }
    router.replace("/(app)");
  };

  // Forgot password: emails a reset link to the address in the email field.
  const onForgotPassword = async () => {
    setError(null);
    setResetMsg(null);
    const em = email.trim();
    if (!em) {
      setError(L("Enter your email above first, then tap 'Forgot password'.", "Marka hore geli iimaylkaaga kore, ka dibna riix 'Furaha ma xasuusto'."));
      return;
    }
    setResetting(true);
    const { error: resetError } = await resetPassword(em);
    setResetting(false);
    if (resetError) {
      setError(resetError);
      return;
    }
    setResetMsg(
      L(
        `We've emailed a password reset link to ${em}. Check your inbox (and spam).`,
        `Waxaan iimayl ugu dirnay xiriirka dib-u-dejinta furaha ${em}. Fiiri iimaylkaaga (iyo spam-ka).`,
      ),
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Fixed above the ScrollView (not inside it) so it stays put on screen
          even when the form scrolls to keep fields clear of the keyboard. */}
      <Pressable
        style={[styles.langPill, { top: insets.top + 12 }]}
        onPress={() => setAppLanguage(so ? "en" : "so")}
        accessibilityLabel="Change language"
      >
        <Ionicons name="language-outline" size={15} color="#0B0B0C" />
        <Text style={styles.langText}>{so ? "SO" : "EN"}</Text>
      </Pressable>

      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: 24 + insets.top }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>💎 LuulScan</Text>
        <Text style={styles.subtitle}>{L("Log in to your account", "Gal akoonkaaga")}</Text>

        <View style={styles.inputRow}>
          <Ionicons name="mail-outline" size={18} color={colors.textFaint} />
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
        </View>
        <View style={styles.inputRow}>
          <Ionicons name="lock-closed-outline" size={18} color={colors.textFaint} />
          <TextInput
            style={styles.input}
            placeholder={L("Password", "Furaha sirta")}
            placeholderTextColor={colors.textFaint}
            secureTextEntry
            autoComplete="password"
            value={password}
            onChangeText={setPassword}
          />
        </View>

        {error && <Text style={styles.error}>{error}</Text>}
        {resetMsg && <Text style={styles.success}>{resetMsg}</Text>}

        <Button
          title={isSubmitting ? L("Logging in…", "Waa la galayaa…") : L("Log in", "Gal")}
          onPress={onSubmit}
          loading={isSubmitting}
          style={styles.submitButton}
        />

        <Pressable onPress={onForgotPassword} hitSlop={8} disabled={resetting}>
          <Text style={styles.linkMuted}>
            {resetting
              ? L("Sending reset link…", "Waa la dirayaa xiriirka…")
              : L("Forgot password?", "Furaha ma xasuusto?")}
          </Text>
        </Pressable>

        <Pressable onPress={() => router.push("/(auth)/register")} hitSlop={8}>
          <Text style={styles.link}>{L("Don't have an account? Sign up", "Akoon ma lihid? Is-diiwaangeli")}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, justifyContent: "center", padding: spacing.xxl, backgroundColor: colors.bg, gap: spacing.md },
  langPill: {
    position: "absolute",
    top: 48,
    right: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: colors.gold,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  langText: { color: "#0B0B0C", fontWeight: "800", fontSize: 12 },
  title: { fontSize: 28, fontWeight: "800", color: colors.gold, textAlign: "center" },
  subtitle: { ...typo.body, textAlign: "center", marginBottom: spacing.sm },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
  },
  input: { flex: 1, color: colors.text, paddingVertical: 14, fontSize: 15 },
  submitButton: { marginTop: spacing.sm },
  link: { color: colors.gold, textAlign: "center", marginTop: spacing.lg },
  linkMuted: { color: colors.textFaint, textAlign: "center", marginTop: spacing.md, fontSize: 14 },
  error: { color: colors.dangerStrong, textAlign: "center" },
  success: { color: "#2EE66E", textAlign: "center", fontSize: 13, lineHeight: 19 },
});

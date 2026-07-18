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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { EXTERNAL_PURCHASES_ENABLED } from "../../lib/appLinks";
import { Button } from "../../components/ui/Button";
import { colors, spacing, radius, type as typo } from "../../lib/theme";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function RegisterScreen() {
  const { signUp } = useAuth();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const L = (en: string, so: string) => (i18n.language === "so" ? so : en);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [country, setCountry] = useState("");
  const [city, setCity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);

    if (fullName.trim().split(/\s+/).filter(Boolean).length < 3) {
      setError(L("Please enter your full name (three names).", "Fadlan geli magacaaga oo saddexan."));
      return;
    }
    if (phone.trim().replace(/[^0-9]/g, "").length < 7) {
      setError(L("Please enter a valid phone number.", "Fadlan geli lambar taleefan oo sax ah."));
      return;
    }
    if (!EMAIL_RE.test(email.trim())) {
      setError(L("Please enter a valid email address.", "Fadlan geli email sax ah."));
      return;
    }
    if (email.trim().toLowerCase() !== confirmEmail.trim().toLowerCase()) {
      setError(L("The two email addresses do not match.", "Labada email isku mid ma aha."));
      return;
    }
    if (password.length < 8) {
      setError(L("Password must be at least 8 characters.", "Furaha sirtu waa inuu ugu yaraan 8 xaraf noqdaa."));
      return;
    }
    if (password !== confirmPassword) {
      setError(L("The two passwords do not match.", "Labada fure isku mid ma aha."));
      return;
    }
    if (country.trim().length === 0) {
      setError(L("Please enter your country.", "Fadlan geli wadankaaga."));
      return;
    }
    if (city.trim().length === 0) {
      setError(L("Please enter your city.", "Fadlan geli magaaladaada."));
      return;
    }

    setIsSubmitting(true);
    const { error: signUpError, needsEmailConfirmation } = await signUp(email.trim(), password, {
      fullName,
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
      setConfirmationEmail(email.trim());
      return;
    }
    router.replace("/(app)");
  };

  if (confirmationEmail) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{L("Check your email", "Fiiri email-kaaga")}</Text>
        <Text style={styles.subtitle}>
          {L(
            `We sent a confirmation link to ${confirmationEmail}. Tap it to activate your account, then come back and log in.`,
            `Waxaan u dirnay xiriiriye xaqiijin ${confirmationEmail}. Riix si aad akoonka u firfircooneyso, ka dibna ku noqo oo gal.`,
          )}
        </Text>
        <Button title={L("Go to login", "Aad galitaanka")} onPress={() => router.replace("/(auth)/login")} style={styles.submitButton} />
        <Pressable onPress={() => setConfirmationEmail(null)} hitSlop={8}>
          <Text style={styles.link}>{L("Use a different email", "Isticmaal email kale")}</Text>
        </Pressable>
      </View>
    );
  }

  const field = (
    label: string,
    icon: keyof typeof Ionicons.glyphMap,
    value: string,
    onChange: (v: string) => void,
    opts: Partial<React.ComponentProps<typeof TextInput>> = {},
  ) => (
    <>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputRow}>
        <Ionicons name={icon} size={17} color={colors.textFaint} />
        <TextInput
          style={styles.input}
          placeholderTextColor={colors.textFaint}
          value={value}
          onChangeText={onChange}
          {...opts}
        />
      </View>
    </>
  );

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingTop: 24 + insets.top, paddingBottom: 24 + insets.bottom },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>{L("Create your account", "Samee akoonkaaga")}</Text>
        <Text style={styles.subtitle}>
          {EXTERNAL_PURCHASES_ENABLED
            ? L(
                "Free accounts get 3 scans a day. Upgrade any time on our website.",
                "Akoonnada bilaashka ah waxay helaan 3 baaris maalintii. Waqti kasta ka cusboonaysii website-kayaga.",
              )
            : L(
                "Free accounts get 3 scans a day.",
                "Akoonnada bilaashka ah waxay helaan 3 baaris maalintii.",
              )}
        </Text>

        {field(L("Full name (three names)", "Magaca oo saddexan"), "person-outline", fullName, setFullName, {
          placeholder: L("e.g. Cabdi Xasan Cali", "tusaale: Cabdi Xasan Cali"),
          autoCapitalize: "words",
          autoComplete: "name",
        })}
        {field(L("Phone number", "Lambarka taleefanka"), "call-outline", phone, setPhone, {
          placeholder: "+252 61 234 5678",
          keyboardType: "phone-pad",
          autoComplete: "tel",
        })}
        {field(L("Email", "Email-ka"), "mail-outline", email, setEmail, {
          placeholder: "you@example.com",
          autoCapitalize: "none",
          autoComplete: "email",
          keyboardType: "email-address",
        })}
        {field(L("Confirm email", "Xaqiiji email-ka"), "mail-outline", confirmEmail, setConfirmEmail, {
          placeholder: L("Re-enter your email", "Dib u geli email-kaaga"),
          autoCapitalize: "none",
          keyboardType: "email-address",
        })}
        {field(L("Password", "Furaha sirta"), "lock-closed-outline", password, setPassword, {
          placeholder: L("At least 8 characters", "Ugu yaraan 8 xaraf"),
          secureTextEntry: true,
        })}
        {field(L("Confirm password", "Xaqiiji furaha"), "lock-closed-outline", confirmPassword, setConfirmPassword, {
          placeholder: L("Re-enter your password", "Dib u geli furahaaga"),
          secureTextEntry: true,
        })}
        {field(L("Country", "Wadanka"), "globe-outline", country, setCountry, {
          placeholder: L("e.g. Somalia", "tusaale: Soomaaliya"),
          autoCapitalize: "words",
          autoComplete: "country",
        })}
        {field(L("City", "Magaalada"), "location-outline", city, setCity, {
          placeholder: L("e.g. Mogadishu", "tusaale: Muqdisho"),
          autoCapitalize: "words",
        })}

        {error && <Text style={styles.error}>{error}</Text>}

        <Button
          title={isSubmitting ? L("Creating account…", "Akoonka waa la abuurayaa…") : L("Sign up", "Is-diiwaangeli")}
          onPress={onSubmit}
          loading={isSubmitting}
          style={styles.submitButton}
        />

        <Pressable onPress={() => router.push("/(auth)/login")} hitSlop={8}>
          <Text style={styles.link}>{L("Already have an account? Log in", "Ma horeba akoon baa kuu jira? Gal")}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, justifyContent: "center", padding: spacing.xxl, gap: spacing.sm, backgroundColor: colors.bg },
  title: { fontSize: 24, fontWeight: "700", color: colors.text, textAlign: "center" },
  subtitle: { ...typo.bodySmall, textAlign: "center", marginBottom: spacing.md },
  label: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, marginBottom: 2 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
  },
  input: { flex: 1, color: colors.text, paddingVertical: 14, fontSize: 15 },
  submitButton: { marginTop: spacing.lg },
  link: { color: colors.gold, textAlign: "center", marginTop: spacing.lg },
  error: { color: colors.dangerStrong, textAlign: "center", marginTop: spacing.sm },
});

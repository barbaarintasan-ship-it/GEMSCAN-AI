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
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { EXTERNAL_PURCHASES_ENABLED } from "../../lib/appLinks";

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
        <Pressable style={styles.button} onPress={() => router.replace("/(auth)/login")}>
          <Text style={styles.buttonText}>{L("Go to login", "Aad galitaanka")}</Text>
        </Pressable>
        <Pressable onPress={() => setConfirmationEmail(null)}>
          <Text style={styles.link}>{L("Use a different email", "Isticmaal email kale")}</Text>
        </Pressable>
      </View>
    );
  }

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: Partial<React.ComponentProps<typeof TextInput>> = {},
  ) => (
    <>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor="#8A8A8E"
        value={value}
        onChangeText={onChange}
        {...opts}
      />
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

        {field(L("Full name (three names)", "Magaca oo saddexan"), fullName, setFullName, {
          placeholder: L("e.g. Cabdi Xasan Cali", "tusaale: Cabdi Xasan Cali"),
          autoCapitalize: "words",
          autoComplete: "name",
        })}
        {field(L("Phone number", "Lambarka taleefanka"), phone, setPhone, {
          placeholder: "+252 61 234 5678",
          keyboardType: "phone-pad",
          autoComplete: "tel",
        })}
        {field(L("Email", "Email-ka"), email, setEmail, {
          placeholder: "you@example.com",
          autoCapitalize: "none",
          autoComplete: "email",
          keyboardType: "email-address",
        })}
        {field(L("Confirm email", "Xaqiiji email-ka"), confirmEmail, setConfirmEmail, {
          placeholder: L("Re-enter your email", "Dib u geli email-kaaga"),
          autoCapitalize: "none",
          keyboardType: "email-address",
        })}
        {field(L("Password", "Furaha sirta"), password, setPassword, {
          placeholder: L("At least 8 characters", "Ugu yaraan 8 xaraf"),
          secureTextEntry: true,
        })}
        {field(L("Confirm password", "Xaqiiji furaha"), confirmPassword, setConfirmPassword, {
          placeholder: L("Re-enter your password", "Dib u geli furahaaga"),
          secureTextEntry: true,
        })}
        {field(L("Country", "Wadanka"), country, setCountry, {
          placeholder: L("e.g. Somalia", "tusaale: Soomaaliya"),
          autoCapitalize: "words",
          autoComplete: "country",
        })}
        {field(L("City", "Magaalada"), city, setCity, {
          placeholder: L("e.g. Mogadishu", "tusaale: Muqdisho"),
          autoCapitalize: "words",
        })}

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={styles.button} onPress={onSubmit} disabled={isSubmitting}>
          <Text style={styles.buttonText}>
            {isSubmitting ? L("Creating account…", "Akoonka waa la abuurayaa…") : L("Sign up", "Is-diiwaangeli")}
          </Text>
        </Pressable>

        <Pressable onPress={() => router.push("/(auth)/login")}>
          <Text style={styles.link}>{L("Already have an account? Log in", "Ma horeba akoon baa kuu jira? Gal")}</Text>
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

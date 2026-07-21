// Edit Profile — lets the signed-in user change their name, phone, country and
// city whenever they want. Email is shown read-only (it is immutable server-
// side). Fields are stored in auth user_metadata (see lib/auth updateProfile);
// display_name is also mirrored into the profiles table.
import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { Button } from "../../components/ui/Button";
import { colors, spacing, radius, type as typo } from "../../lib/theme";

function metaString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export default function EditProfileScreen() {
  const { session, updateProfile } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const L = (en: string, soText: string) => (so ? soText : en);

  const meta = session?.user?.user_metadata ?? {};
  const [fullName, setFullName] = useState(metaString(meta.display_name));
  const [phone, setPhone] = useState(metaString(meta.phone));
  const [country, setCountry] = useState(metaString(meta.country));
  const [city, setCity] = useState(metaString(meta.city));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSave() {
    setError(null);
    if (fullName.trim().length === 0) {
      setError(L("Please enter your name.", "Fadlan geli magacaaga."));
      return;
    }
    setSaving(true);
    const { error: saveError } = await updateProfile({ fullName, phone, country, city });
    setSaving(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    Alert.alert(
      L("Profile updated", "Profile-ka waa la cusboonaysiiyay"),
      L("Your details have been saved.", "Xogtaada waa la kaydiyay."),
    );
    router.back();
  }

  const field = (
    label: string,
    icon: keyof typeof Ionicons.glyphMap,
    value: string,
    onChangeText: (t: string) => void,
    props: Partial<React.ComponentProps<typeof TextInput>> = {},
  ) => (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.inputRow}>
        <Ionicons name={icon} size={18} color={colors.textFaint} />
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholderTextColor={colors.textFaint}
          {...props}
        />
      </View>
    </View>
  );

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: 32 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>{L("Edit Profile", "Wax ka beddel Profile-ka")}</Text>

        {/* Email — read-only (immutable). */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>{L("Email", "Iimaylka")}</Text>
          <View style={[styles.inputRow, styles.inputDisabled]}>
            <Ionicons name="mail-outline" size={18} color={colors.textFaint} />
            <Text style={styles.disabledText} numberOfLines={1}>
              {session?.user.email ?? "—"}
            </Text>
          </View>
        </View>

        {field(L("Full name", "Magaca oo dhan"), "person-outline", fullName, setFullName, {
          placeholder: L("Your name", "Magacaaga"),
        })}
        {field(L("Phone", "Taleefan"), "call-outline", phone, setPhone, {
          placeholder: "+252…",
          keyboardType: "phone-pad",
        })}
        {field(L("Country", "Wadanka"), "flag-outline", country, setCountry, {
          placeholder: L("Country", "Wadanka"),
        })}
        {field(L("City", "Magaalada"), "location-outline", city, setCity, {
          placeholder: L("City", "Magaalada"),
        })}

        {error && <Text style={styles.error}>{error}</Text>}

        <Button
          title={saving ? L("Saving…", "Waa la kaydinayaa…") : L("Save changes", "Kaydi isbeddellada")}
          onPress={onSave}
          loading={saving}
          style={styles.saveButton}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { padding: spacing.xxl, gap: spacing.md },
  title: { ...typo.heading, marginBottom: spacing.xs },
  fieldGroup: { gap: 6 },
  fieldLabel: { ...typo.label, marginTop: 0, marginBottom: 0 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
  },
  inputDisabled: { opacity: 0.6 },
  input: { flex: 1, color: colors.text, paddingVertical: 14, fontSize: 15 },
  disabledText: { flex: 1, color: colors.textFaint, paddingVertical: 14, fontSize: 15 },
  error: { color: colors.dangerStrong, textAlign: "center" },
  saveButton: { marginTop: spacing.sm },
});

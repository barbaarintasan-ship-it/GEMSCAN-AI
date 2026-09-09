// Manage Team — self-serve add/remove of Enterprise org teammates.
//
// Reachable from Settings for any user who belongs to an active org (any
// role can view the roster; only owner/admin can add or remove — enforced
// server-side by the RPCs in lib/enterprise/team.ts, mirrored here only to
// decide what UI to show).
import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing, radius } from "../../../lib/theme";
import {
  fetchMyOrganizations,
  fetchOrgMembers,
  addOrgMemberByEmail,
  removeOrgMember,
  type MyOrganization,
  type OrgMember,
} from "../../../lib/enterprise/team";

export default function ManageTeamScreen() {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [loading, setLoading] = useState(true);
  const [org, setOrg] = useState<MyOrganization | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const orgs = await fetchMyOrganizations();
      const mine = orgs[0] ?? null;
      setOrg(mine);
      if (mine) {
        const roster = await fetchOrgMembers(mine.organization_id);
        setMembers(roster);
      } else {
        setMembers([]);
      }
    } catch {
      setOrg(null);
      setMembers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const canManage = org?.my_role === "owner" || org?.my_role === "admin";
  const atSeatLimit = org?.max_seats != null && org.seats_used >= org.max_seats;

  async function handleAdd() {
    if (!org || !emailInput.trim()) return;
    setAdding(true);
    try {
      await addOrgMemberByEmail(org.organization_id, emailInput.trim());
      setEmailInput("");
      await load();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      let text = so ? "Ma awoodin in aan daro xubinta." : "Could not add this teammate.";
      if (msg.includes("no_account")) {
        text = so
          ? "Qofkan wax akoon GEMSCAN ah kuma haysto. Waa inuu hore u isticmaalaa app-ka, ka dibna dib u isku day."
          : "This person doesn't have a GEMSCAN account yet. Ask them to sign up in the app first, then try again.";
      } else if (msg.includes("seat_limit_reached")) {
        text = so
          ? "Qorshahaagu wuxuu gaadhay xadka xubnaha ee la iibsaday."
          : "Your plan has reached its purchased seat limit.";
      }
      Alert.alert(so ? "Khalad" : "Error", text);
    } finally {
      setAdding(false);
    }
  }

  function handleRemove(member: OrgMember) {
    if (!org) return;
    Alert.alert(
      so ? "Ka saar xubinta?" : "Remove teammate?",
      member.email,
      [
        { text: so ? "Jooji" : "Cancel", style: "cancel" },
        {
          text: so ? "Ka saar" : "Remove",
          style: "destructive",
          onPress: async () => {
            setRemovingId(member.user_id);
            try {
              await removeOrgMember(org.organization_id, member.user_id);
              await load();
            } catch (err) {
              Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
            } finally {
              setRemovingId(null);
            }
          },
        },
      ],
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{so ? "Maamul Kooxda" : "Manage Team"}</Text>
      </View>

      {loading ? (
        <View style={styles.centerFill}>
          <ActivityIndicator color={colors.gold} />
        </View>
      ) : !org ? (
        <View style={styles.centerFill}>
          <Ionicons name="people-outline" size={36} color={colors.textFaint} />
          <Text style={styles.emptyText}>
            {so
              ? "Akoonkaagu kuma jiro shirkad Enterprise ah."
              : "Your account isn't part of an Enterprise organization."}
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.orgCard}>
            <Text style={styles.orgName}>{org.name}</Text>
            <Text style={styles.orgMeta}>
              {so ? "Xubno" : "Seats"}: {org.seats_used}
              {org.max_seats != null ? ` / ${org.max_seats}` : ` (${so ? "aan xaddidnayn" : "unlimited"})`}
            </Text>
          </View>

          <View style={styles.card}>
            {members.map((m, idx) => (
              <View key={m.user_id}>
                {idx > 0 && <View style={styles.divider} />}
                <View style={styles.memberRow}>
                  <View style={styles.memberInfo}>
                    <Text style={styles.memberEmail} numberOfLines={1}>{m.email}</Text>
                    <Text style={styles.memberRole}>{m.role}</Text>
                  </View>
                  {canManage && m.role !== "owner" && (
                    <Pressable
                      onPress={() => handleRemove(m)}
                      disabled={removingId === m.user_id}
                      hitSlop={8}
                    >
                      {removingId === m.user_id ? (
                        <ActivityIndicator size="small" color={colors.dangerStrong} />
                      ) : (
                        <Ionicons name="close-circle-outline" size={22} color={colors.dangerStrong} />
                      )}
                    </Pressable>
                  )}
                </View>
              </View>
            ))}
          </View>

          {canManage && (
            <>
              <Text style={styles.sectionLabel}>
                {so ? "Ku dar xubin cusub" : "Add a teammate"}
              </Text>
              {atSeatLimit ? (
                <Text style={styles.limitNote}>
                  {so
                    ? `Qorshahaagu wuxuu gaadhay xadka ${org.max_seats} xubnood. Sare u qaad qorshaha si aad u darto dad badan.`
                    : `Your plan is limited to ${org.max_seats} seat(s). Upgrade your plan to add more people.`}
                </Text>
              ) : (
                <View style={styles.addRow}>
                  <TextInput
                    style={styles.input}
                    placeholder={so ? "email@tusaale.com" : "teammate@email.com"}
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    value={emailInput}
                    onChangeText={setEmailInput}
                  />
                  <Pressable
                    style={[styles.addButton, (!emailInput.trim() || adding) && styles.addButtonDisabled]}
                    onPress={handleAdd}
                    disabled={!emailInput.trim() || adding}
                  >
                    {adding ? (
                      <ActivityIndicator size="small" color="#0B0B0C" />
                    ) : (
                      <Text style={styles.addButtonText}>{so ? "Dar" : "Add"}</Text>
                    )}
                  </Pressable>
                </View>
              )}
              <Text style={styles.footnote}>
                {so
                  ? "Qofka aad rabto inaad darto waa inuu hore u sameeyaa akoon GEMSCAN ah isla email-kan."
                  : "The person you add must already have a GEMSCAN account under that email."}
              </Text>
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.xl },
  emptyText: { color: colors.textMuted, fontSize: 13, textAlign: "center" },
  body: { padding: spacing.md, gap: spacing.md, paddingBottom: 40 },
  orgCard: {
    borderWidth: 1, borderColor: colors.goldBorder, borderRadius: radius.lg,
    padding: spacing.md, gap: 4,
  },
  orgName: { color: colors.text, fontSize: 16, fontWeight: "800" },
  orgMeta: { color: colors.gold, fontSize: 13, fontWeight: "600" },
  card: { backgroundColor: "#1A1A1D", borderRadius: 14, paddingHorizontal: 16 },
  divider: { height: 1, backgroundColor: "#2A2A2C" },
  memberRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14, gap: spacing.sm,
  },
  memberInfo: { flex: 1, gap: 2 },
  memberEmail: { color: colors.text, fontSize: 14, fontWeight: "600" },
  memberRole: { color: colors.textFaint, fontSize: 12, textTransform: "capitalize" },
  sectionLabel: { color: colors.gold, fontSize: 11, fontWeight: "800", letterSpacing: 0.6, marginTop: spacing.xs },
  addRow: { flexDirection: "row", gap: spacing.sm },
  input: {
    flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: 10, color: colors.text, fontSize: 14,
  },
  addButton: {
    backgroundColor: colors.gold, borderRadius: radius.md, paddingHorizontal: spacing.lg,
    alignItems: "center", justifyContent: "center",
  },
  addButtonDisabled: { opacity: 0.5 },
  addButtonText: { color: "#0B0B0C", fontWeight: "800", fontSize: 14 },
  limitNote: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  footnote: { color: colors.textFaint, fontSize: 11, lineHeight: 16 },
});

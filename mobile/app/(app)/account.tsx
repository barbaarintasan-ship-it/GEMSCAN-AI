// Account / subscription status screen.
//
// This screen displays entitlement (read from verify-subscription) and, if
// the user wants to change plans, links out to the website. It never
// contains a purchase flow, price list with a "Buy" button, or any payment
// SDK — that would violate the payment-separation decision.
import React, { useState } from "react";
import { View, Text, Pressable, Linking, Alert, StyleSheet, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../lib/auth";
import { useSubscriptionStatus } from "../../lib/subscription";
import { PAYMENT_URL, EXTERNAL_PURCHASES_ENABLED } from "../../lib/appLinks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { colors, spacing, type as typo } from "../../lib/theme";

export default function AccountScreen() {
  const { session, signOut, deleteAccount } = useAuth();
  const { data, isLoading, refetch, isRefetching } = useSubscriptionStatus();
  const insets = useSafeAreaInsets();
  const [deleting, setDeleting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const confirmDelete = () => {
    Alert.alert(
      "Delete account?",
      "This permanently deletes your GemScan account and all your scans and data. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            const { error } = await deleteAccount();
            setDeleting(false);
            if (error) Alert.alert("Could not delete account", error);
            // On success the session clears and the app routes back to login.
          },
        },
      ],
    );
  };

  async function handleLogout() {
    setSigningOut(true);
    await signOut();
  }

  return (
    <View style={[styles.container, { paddingBottom: 24 + insets.bottom }]}>
      <Text style={styles.heading}>Account</Text>
      <Text style={styles.email}>{session?.user.email}</Text>

      <Card accent style={styles.card}>
        <View style={styles.cardHeader}>
          <Ionicons name="diamond" size={16} color={colors.gold} />
          <Text style={styles.cardLabel}>Subscription</Text>
        </View>
        <Text style={styles.cardValue}>{isLoading ? "Loading…" : (data?.tier ?? "free")}</Text>
        {data?.currentPeriodEnd && (
          <Text style={styles.cardSubtext}>Renews/expires: {data.currentPeriodEnd}</Text>
        )}
        {EXTERNAL_PURCHASES_ENABLED && (
          <Text style={styles.cardSubtext}>
            Subscriptions are managed exclusively on the GemScan website. If you just upgraded
            and don't see it reflected here, tap refresh below.
          </Text>
        )}
      </Card>

      <Button
        title={isRefetching ? "Refreshing…" : "Refresh subscription status"}
        variant="secondary"
        icon={<Ionicons name="refresh-outline" size={16} color={colors.text} />}
        onPress={() => refetch()}
        disabled={isRefetching}
        style={styles.actionSpacing}
      />

      {EXTERNAL_PURCHASES_ENABLED && (
        <Button
          title="Manage subscription on website"
          variant="primary"
          icon={<Ionicons name="open-outline" size={16} color="#0B0B0C" />}
          onPress={() => Linking.openURL(PAYMENT_URL)}
          style={styles.actionSpacing}
        />
      )}

      <Pressable style={styles.signOutButton} onPress={handleLogout} disabled={signingOut}>
        {signingOut ? (
          <ActivityIndicator color={colors.text} />
        ) : (
          <Text style={styles.signOutText}>Log out</Text>
        )}
      </Pressable>

      <Button
        title={deleting ? "Deleting…" : "Delete account"}
        variant="danger"
        loading={deleting}
        onPress={confirmDelete}
        style={styles.actionSpacing}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.xxl, backgroundColor: colors.bg, gap: spacing.md },
  heading: { ...typo.heading },
  email: { ...typo.caption, marginBottom: spacing.sm },
  card: { gap: spacing.xs },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  cardLabel: { ...typo.label, marginTop: 0, marginBottom: 0 },
  cardValue: { fontSize: 20, color: colors.gold, fontWeight: "700", textTransform: "capitalize" },
  cardSubtext: { ...typo.caption },
  actionSpacing: { marginTop: spacing.xs },
  signOutButton: { marginTop: spacing.xxl, alignItems: "center", paddingVertical: spacing.sm },
  signOutText: { color: colors.text, fontSize: 15 },
});

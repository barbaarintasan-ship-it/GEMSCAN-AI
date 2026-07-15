// Account / subscription status screen.
//
// This screen displays entitlement (read from verify-subscription) and, if
// the user wants to change plans, links out to the website. It never
// contains a purchase flow, price list with a "Buy" button, or any payment
// SDK — that would violate the payment-separation decision.
import React, { useState } from "react";
import { View, Text, Pressable, Linking, Alert, StyleSheet } from "react-native";
import { useAuth } from "../../lib/auth";
import { useSubscriptionStatus } from "../../lib/subscription";
import { PAYMENT_URL, EXTERNAL_PURCHASES_ENABLED } from "../../lib/appLinks";

export default function AccountScreen() {
  const { session, signOut, deleteAccount } = useAuth();
  const { data, isLoading, refetch, isRefetching } = useSubscriptionStatus();
  const [deleting, setDeleting] = useState(false);

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

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Account</Text>
      <Text style={styles.email}>{session?.user.email}</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Subscription</Text>
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
      </View>

      <Pressable
        style={styles.secondaryButton}
        onPress={() => refetch()}
        disabled={isRefetching}
      >
        <Text style={styles.secondaryButtonText}>
          {isRefetching ? "Refreshing…" : "Refresh subscription status"}
        </Text>
      </Pressable>

      {EXTERNAL_PURCHASES_ENABLED && (
        <Pressable style={styles.button} onPress={() => Linking.openURL(PAYMENT_URL)}>
          <Text style={styles.buttonText}>Manage subscription on website</Text>
        </Pressable>
      )}

      <Pressable style={styles.signOutButton} onPress={signOut}>
        <Text style={styles.signOutText}>Log out</Text>
      </Pressable>

      <Pressable style={styles.deleteButton} onPress={confirmDelete} disabled={deleting}>
        <Text style={styles.deleteText}>{deleting ? "Deleting…" : "Delete account"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, backgroundColor: "#0B0B0C", gap: 12 },
  heading: { fontSize: 22, fontWeight: "700", color: "#F5F1E8" },
  email: { fontSize: 13, color: "#8A8A8E", marginBottom: 8 },
  card: {
    backgroundColor: "#1A1A1D",
    borderRadius: 16,
    padding: 16,
    gap: 6,
  },
  cardLabel: { fontSize: 12, color: "#8A8A8E", textTransform: "uppercase" },
  cardValue: { fontSize: 20, color: "#C9A227", fontWeight: "700", textTransform: "capitalize" },
  cardSubtext: { fontSize: 12, color: "#8A8A8E" },
  button: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: { color: "#0B0B0C", fontWeight: "700" },
  secondaryButton: {
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#3A3A3D",
  },
  secondaryButtonText: { color: "#F5F1E8" },
  signOutButton: { marginTop: 24, alignItems: "center" },
  signOutText: { color: "#F5F1E8" },
  deleteButton: {
    marginTop: 8,
    alignItems: "center",
    paddingVertical: 12,
  },
  deleteText: { color: "#E5484D", fontWeight: "600" },
});

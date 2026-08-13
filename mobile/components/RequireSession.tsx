// Identity as a CAPABILITY, declared by the screens that need it.
//
// The auth check used to sit at the root of the (app) tree, which meant every
// screen inherited it whether it needed identity or not — and the field screens
// do not. Lifting that gate for an open expedition (see (app)/_layout) leaves a
// state that could not exist before: inside the app, with no session. Two screens
// read `session.user.id` directly and would throw in it.
//
// So identity is asked for HERE, by the two screens that genuinely need it. That
// is the inversion the architecture calls for, applied at the smallest scale that
// closes the hole: the field path stays open, and a screen that cannot work
// without an account says so instead of crashing.
//
// NOT a redirect to login. In this state the geologist is mid-expedition with no
// signal, so a login screen is a dead end — the same trap, one screen deeper.
// There is no previous behaviour being changed here: with no session, none of
// these screens was reachable at all before.
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../lib/auth";
import { colors, radius, spacing, type as t } from "../lib/theme";

export function RequireSession({
  children,
  what,
}: {
  children: React.ReactNode;
  /** What the screen shows, named the way the geologist would name it. */
  what: string;
}) {
  const { session } = useAuth();
  if (session) return <>{children}</>;

  return (
    <View style={styles.wrap}>
      <Ionicons name="cloud-offline-outline" size={30} color={colors.gold} />
      <Text style={styles.title}>Sign in to see {what}</Text>
      <Text style={styles.body}>
        {what} is kept on the server, so it needs an account and a connection.
        {"\n\n"}
        Nothing you have collected is affected — it is on this device and will be
        filed when you sign in.
      </Text>
      <Pressable style={styles.btn} onPress={() => router.back()}>
        <Text style={styles.btnText}>Back</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center",
    gap: spacing.md, padding: spacing.xl,
  },
  title: { ...t.title, color: colors.text, textAlign: "center" },
  body: { ...t.body, color: colors.textMuted, textAlign: "center", maxWidth: 320 },
  btn: {
    backgroundColor: colors.gold, borderRadius: radius.lg,
    paddingVertical: spacing.md, paddingHorizontal: spacing.xl, marginTop: spacing.sm,
  },
  btnText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
});

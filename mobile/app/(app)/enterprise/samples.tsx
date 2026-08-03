// Enterprise › My Samples (Sprint 4.2 owner beta).
// Lists the signed-in owner's submitted field samples (GET /enterprise-samples,
// RLS-scoped server-side). Tapping a row opens its detail; the FAB starts a new
// sample. Deliberately minimal — no admin, org, mission or verification UI.
import React, { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl, ActivityIndicator, Alert } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, type as t } from "../../../lib/theme";
import { deleteSample, listSamples, type SampleListRow } from "../../../lib/enterpriseSamples";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";

export default function MySamplesScreen() {
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<SampleListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      setRows(await listSamples());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load samples.");
    } finally {
      isRefresh ? setRefreshing(false) : setLoading(false);
    }
  }, []);

  // Reload on focus so a freshly submitted sample shows up when we pop back.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const confirmDelete = useCallback((item: { id: string; name: string | null }) => {
    const label = item.name || `Sample ${item.id.slice(0, 8)}`;
    Alert.alert(
      "Delete sample?",
      `"${label}" and its photos will be removed. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            // Removed from the list immediately. The server call is what makes
            // it true, so a failure puts it back rather than leaving the list
            // disagreeing with the database.
            setRows((cur) => cur.filter((x) => x.id !== item.id));
            try {
              await deleteSample(item.id);
            } catch (e) {
              Alert.alert("Delete failed", e instanceof Error ? e.message : "Unknown error");
              void load();
            }
          },
        },
      ],
    );
  }, [load]);

  return (
    <View style={styles.container}>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.gold} /></View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={rows.length === 0 ? styles.emptyWrap : styles.listPad}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.gold} />}
          ListHeaderComponent={
            error ? (
              <Pressable style={styles.errorBox} onPress={() => load()}>
                <Text style={styles.errorText}>{error}</Text>
                <Text style={styles.errorRetry}>Tap to retry</Text>
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            !error ? (
              <EmptyState
                icon="cube-outline"
                title="No samples yet"
                hint="Submit your first field sample to start building your collection."
              />
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => router.push(`/(app)/enterprise/sample/${item.id}`)}
              // Long-press to delete, rather than a button on every row: the
              // list is for opening samples, and a delete control sitting under
              // the thumb of someone scrolling with muddy hands is a mistake
              // waiting to happen. The confirmation names the sample.
              onLongPress={() => confirmDelete(item)}
              delayLongPress={500}
            >
              <View style={styles.rowIcon}><Ionicons name="cube-outline" size={20} color={colors.gold} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{item.name || `Sample ${item.id.slice(0, 8)}`}</Text>
                <Text style={styles.rowMeta}>{new Date(item.collected_at).toLocaleString()}</Text>
              </View>
              <View style={styles.statusPill}>
                <Text style={styles.statusText}>{item.status}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </Pressable>
          )}
        />
      )}

      {/* Bottom action bar — solid background + safe-area padding so the button
          always sits clearly ABOVE the phone's system navigation bar (previously
          it was drawn under the translucent nav bar and looked washed out). */}
      {/* Math.max fallback: some Android builds report insets.bottom = 0 (no edge-to-edge),
          so a fixed floor keeps the button clearly ABOVE the system nav bar regardless. */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 44) + spacing.sm }]}>
        <Button
          title="New Sample"
          variant="primary"
          icon={<Ionicons name="add" size={20} color="#0B0B0C" />}
          onPress={() => router.push("/(app)/enterprise/new-sample")}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  listPad: { padding: spacing.lg, paddingBottom: 140 },
  emptyWrap: { flexGrow: 1, justifyContent: "center", padding: spacing.lg },
  row: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    backgroundColor: colors.surfaceAlt, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm,
  },
  rowIcon: {
    width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.goldSoft,
    alignItems: "center", justifyContent: "center",
  },
  rowTitle: { ...t.subheading },
  rowMeta: { ...t.caption, marginTop: 2 },
  statusPill: { backgroundColor: colors.surfaceSunken, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { ...t.caption, color: colors.textMuted, textTransform: "capitalize" },
  footer: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: colors.border,
    paddingHorizontal: spacing.lg, paddingTop: spacing.md,
  },
  errorBox: { backgroundColor: "rgba(228,104,93,0.12)", borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  errorText: { ...t.body, color: colors.danger },
  errorRetry: { ...t.caption, color: colors.danger, marginTop: 4 },
});

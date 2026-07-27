// Enterprise › My Samples (Sprint 4.2 owner beta).
// Lists the signed-in owner's submitted field samples (GET /enterprise-samples,
// RLS-scoped server-side). Tapping a row opens its detail; the FAB starts a new
// sample. Deliberately minimal — no admin, org, mission or verification UI.
import React, { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl, ActivityIndicator } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, type as t } from "../../../lib/theme";
import { listSamples, type SampleListRow } from "../../../lib/enterpriseSamples";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";

export default function MySamplesScreen() {
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
            <Pressable style={styles.row} onPress={() => router.push(`/(app)/enterprise/sample/${item.id}`)}>
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

      <View style={styles.fabWrap}>
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
  listPad: { padding: spacing.lg, paddingBottom: 96 },
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
  fabWrap: { position: "absolute", left: spacing.lg, right: spacing.lg, bottom: spacing.xl },
  errorBox: { backgroundColor: "rgba(228,104,93,0.12)", borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  errorText: { ...t.body, color: colors.danger },
  errorRetry: { ...t.caption, color: colors.danger, marginTop: 4 },
});

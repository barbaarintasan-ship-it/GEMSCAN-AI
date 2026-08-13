// Enterprise › My Samples (Sprint 4.2 owner beta).
// Lists the signed-in owner's submitted field samples (GET /enterprise-samples,
// RLS-scoped server-side). Tapping a row opens its detail; the FAB starts a new
// sample. Deliberately minimal — no admin, org, mission or verification UI.
import React, { useCallback, useState } from "react";
import { View, Text, TextInput, FlatList, Pressable, StyleSheet, RefreshControl, ActivityIndicator, Alert } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, type as t } from "../../../lib/theme";
import { deleteSample, listSamples, reanalyzeSample } from "../../../lib/enterpriseSamples";
import { statusView, retryableRows } from "../../../lib/samples/sampleStatus";
import { localSamples, useSampleSync } from "../../../lib/samples/store";
import {
  loadCollection, searchCollection, type CollectionRow,
} from "../../../lib/samples/offlineSampleList";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";

/**
 * OFFLINE FIRST.
 *
 * This screen used to be a network read: no signal, no collection — an empty list
 * with an error over samples the geologist had taken with their own hands an hour
 * earlier. The device holds every one of them.
 *
 * So the collection is assembled from what is here (samples this device created,
 * still being filed or already filed) and the last server list, cached. A failed
 * read is no longer an error; it is a reason to show what we already know, and to
 * say when it was last refreshed.
 */
/** The cache lives in AsyncStorage, read the same way every other store reads it. */
function storageAdapter() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage").default;
  return {
    getItem: (k: string) => AsyncStorage.getItem(k) as Promise<string | null>,
    setItem: (k: string, v: string) => AsyncStorage.setItem(k, v) as Promise<void>,
  };
}

export default function MySamplesScreen() {
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<CollectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  // Files whatever the device is still holding, whenever it can.
  const sync = useSampleSync();

  const load = useCallback(async (isRefresh = false) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      const store = localSamples();
      // PERSONAL ONLY. This screen is a collection of specimens, not a record of
      // field missions — those live under Exploration Reports, and mixing them
      // was what let a rock picked up at home be given a prospectivity reading.
      const result = await loadCollection(store, storageAdapter(), {
        list: () => listSamples("personal"),
      });
      setRows(result.rows);
      setOffline(result.fromCache);
      setFetchedAt(result.fetchedAt);
    } finally {
      isRefresh ? setRefreshing(false) : setLoading(false);
    }
  }, []);

  // Re-read whenever the local store changes — a sample filed in the background
  // should stop saying "held on device" without the geologist pulling to refresh.
  React.useEffect(() => localSamples().subscribe(() => { void load(true); }), [load]);

  const visible = React.useMemo(() => searchCollection(rows, query), [rows, query]);

  // Analyses that are not running any more. Computed over the WHOLE collection,
  // not the filtered view: a search for "Dool" must not change how many are
  // broken.
  const stalled = React.useMemo(() => retryableRows(rows), [rows]);
  const [retrying, setRetrying] = useState(false);

  const onRetryStalled = useCallback(async () => {
    setRetrying(true);
    let ok = 0;
    const failures: string[] = [];
    // Sequential and independent — one refusal must not stop the rest, and a
    // burst of parallel analyses is how the whole batch gets rate-limited.
    for (const row of stalled) {
      try {
        await reanalyzeSample(row.id);
        ok++;
      } catch (e) {
        failures.push(e instanceof Error ? e.message : "unknown error");
      }
    }
    setRetrying(false);
    await load(true);
    Alert.alert(
      ok > 0 ? "Re-analysis started" : "Could not restart",
      [
        ok > 0 ? `${ok} sample${ok === 1 ? "" : "s"} queued. Pull to refresh in a minute.` : null,
        // Reported, not swallowed: if the server is refusing, the reason is the
        // only useful thing on the screen.
        failures.length > 0 ? `${failures.length} refused — ${failures[0]}` : null,
      ].filter(Boolean).join("\n\n"),
    );
  }, [stalled, load]);

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
          data={visible}
          keyExtractor={(r) => r.id}
          contentContainerStyle={visible.length === 0 ? styles.emptyWrap : styles.listPad}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.gold} />}
          ListHeaderComponent={
            <>
              <TextInput
                style={styles.search}
                value={query}
                onChangeText={setQuery}
                placeholder="Search samples"
                placeholderTextColor={colors.textFaint}
              />
              {/* State, not failure. Offline is a condition to report, not an
                  error to apologise for — the collection is right here. */}
              {offline ? (
                <View style={styles.notice}>
                  <Ionicons name="cloud-offline-outline" size={14} color={colors.gold} />
                  <Text style={styles.noticeText}>
                    Offline — showing what this device holds
                    {fetchedAt ? ` · server list from ${new Date(fetchedAt).toLocaleString()}` : ""}
                  </Text>
                </View>
              ) : null}
              {sync.pending > 0 ? (
                <View style={styles.notice}>
                  <Ionicons
                    name={sync.uploading ? "cloud-upload-outline" : "time-outline"}
                    size={14}
                    color={colors.gold}
                  />
                  <Text style={styles.noticeText}>
                    {sync.uploading
                      ? `Filing ${sync.pending} sample${sync.pending === 1 ? "" : "s"}…`
                      : `${sync.pending} sample${sync.pending === 1 ? "" : "s"} held on this device`}
                    {sync.failed > 0 ? ` · ${sync.failed} will retry` : ""}
                  </Text>
                </View>
              ) : null}

              {/* Analyses that are not running any more.
                  Nine samples stranded overnight meant nine trips into nine
                  detail screens to press nine buttons. One tap restarts them
                  all — and it is a TAP, not automatic: re-analysis costs an
                  inference each, and the app does not spend that unasked. */}
              {stalled.length > 0 ? (
                <Pressable
                  style={[styles.notice, styles.noticeAlert]}
                  disabled={retrying}
                  onPress={onRetryStalled}
                >
                  {retrying
                    ? <ActivityIndicator size="small" color="#F0B429" />
                    : <Ionicons name="refresh-circle-outline" size={16} color="#F0B429" />}
                  <Text style={[styles.noticeText, styles.noticeTextAlert]}>
                    {retrying
                      ? `Restarting ${stalled.length}…`
                      : `${stalled.length} analys${stalled.length === 1 ? "is has" : "es have"} stalled · tap to restart`}
                  </Text>
                </Pressable>
              ) : null}
            </>
          }
          ListEmptyComponent={
            <EmptyState
              icon="cube-outline"
              title={query ? "No matches" : "No samples yet"}
              hint={query
                ? "Nothing in the collection matches that."
                : "Submit your first field sample to start building your collection."}
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => {
                // A sample the server has never seen has no server page — opening
                // one would 404. It has a LOCAL page instead, which reads with no
                // signal at all: the photographs, the fix and the observations as
                // the device holds them.
                if (item.local && item.local.state !== "uploaded") {
                  router.push(`/(app)/enterprise/local-sample/${item.localId}`);
                } else {
                  router.push(`/(app)/enterprise/sample/${item.id}`);
                }
              }}
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
              {/* The raw column used to be printed here, which is why the field
                  read "Ai_processing" nine times over — and why a run that had
                  died a day earlier was indistinguishable from one in flight.
                  Same vocabulary as the detail screen now (lib/samples/sampleStatus). */}
              {(() => {
                const local = item.local && item.local.state !== "uploaded";
                const view = local ? null : statusView(item);
                return (
                  <View style={[
                    styles.statusPill,
                    local && styles.statusPillLocal,
                    view?.attention && styles.statusPillAttention,
                  ]}>
                    <Text style={[styles.statusText, view?.attention && styles.statusTextAttention]}>
                      {local
                        ? (item.local!.state === "failed" ? "will retry" : "on device")
                        : view!.label}
                    </Text>
                  </View>
                );
              })()}
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
  search: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    color: colors.text, marginBottom: spacing.sm,
  },
  notice: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: colors.goldSoft, borderWidth: 1, borderColor: colors.goldBorder,
    borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.sm,
  },
  noticeText: { ...t.caption, color: colors.gold, flex: 1 },
  // A stalled analysis is a fault, not a state — it reads differently on purpose.
  noticeAlert: { borderColor: "rgba(240,180,41,0.55)", backgroundColor: "rgba(240,180,41,0.12)" },
  noticeTextAlert: { color: "#F0B429", fontWeight: "700" },
  statusPillLocal: { backgroundColor: colors.goldSoft },
  statusPillAttention: { backgroundColor: "rgba(240,180,41,0.14)" },
  statusTextAttention: { color: "#F0B429", fontWeight: "700" },
  errorBox: { backgroundColor: "rgba(228,104,93,0.12)", borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  errorText: { ...t.body, color: colors.danger },
  errorRetry: { ...t.caption, color: colors.danger, marginTop: 4 },
});

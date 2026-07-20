// My Collection / Scan History.
//
// Lists the signed-in user's past scans (RLS-scoped) newest-first with a
// thumbnail of the first uploaded image, the AI best match, confidence and
// date. Tapping a row opens the existing results screen, which re-reads the
// scan from the database — so history is a pure read view over data the scan
// pipeline already wrote; it changes nothing about that pipeline.
import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  Image,
  Pressable,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Alert,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { useSubscriptionStatus } from "../../lib/subscription";
import { generatePdfForScan } from "../../lib/scanReport";
import { deleteScan } from "../../lib/scanUpload";
import {
  readCachedJson,
  writeCachedJson,
  cacheImageFile,
  localImageUriIfCached,
  pruneImageFiles,
  deleteCachedImage,
  formatCacheAge,
} from "../../lib/offlineCache";
import { useIsOnline } from "../../lib/network";
import { ConfidenceBadge } from "../../components/ui/ConfidenceBadge";
import { EmptyState } from "../../components/ui/EmptyState";
import { OfflineBanner } from "../../components/ui/OfflineBanner";
import { colors, spacing, radius } from "../../lib/theme";

type ScanFinalResult = {
  bestMatch: string | null;
  confidenceScore: number;
  confidenceBand: "low" | "medium" | "high";
  insufficientConfidence: boolean;
} | null;

type HistoryItem = {
  id: string;
  status: string;
  final_result: ScanFinalResult;
  created_at: string;
  location: { lat: number; lng: number } | null;
  thumbnailUrl: string | null;
};

// Offline cache shape — the same fields as HistoryItem, but the thumbnail is
// a local file:// uri (persisted to disk) rather than an expiring 1-hour
// signed URL, so it still renders with no network connection.
type CachedHistoryItem = {
  id: string;
  status: string;
  final_result: ScanFinalResult;
  created_at: string;
  location: { lat: number; lng: number } | null;
  thumbnailLocalUri: string | null;
};
type HistoryCache = { cachedAt: string; items: CachedHistoryItem[] };

function historyCacheKey(userId: string): string {
  return `gemscan.cache.history.v1:${userId}`;
}

// A HistoryItem enriched (once, in a memo) with its precomputed display line
// and formatted date/time strings — see itemsWithLine.
type HistoryListItem = HistoryItem & {
  line: { text: string; muted: boolean };
  dateText: string;
  timeText: string;
};

// B3: one memoized row. Because it's React.memo'd and receives per-row booleans
// (isDeleting/isPdfBusy) rather than the shared deletingId/pdfBusyId, changing
// the delete/PDF-busy state of ONE row (or typing in search) re-renders only
// the affected row instead of every mounted row. All other props (item,
// handlers) are referentially stable, so unaffected rows bail out.
const HistoryRow = React.memo(function HistoryRow({
  item,
  editMode,
  isDeleting,
  isPdfBusy,
  canPdf,
  so,
  onOpen,
  onDelete,
  onGeneratePdf,
}: {
  item: HistoryListItem;
  editMode: boolean;
  isDeleting: boolean;
  isPdfBusy: boolean;
  canPdf: boolean;
  so: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string, label: string) => void;
  onGeneratePdf: (id: string) => void;
}) {
  const line = item.line;
  const fr = item.final_result;
  const showConfidence = !line.muted && fr;

  return (
    <Pressable
      style={styles.itemCard}
      onPress={() => (editMode ? undefined : onOpen(item.id))}
      disabled={editMode}
    >
      {item.thumbnailUrl ? (
        <Image source={{ uri: item.thumbnailUrl }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]}>
          <Ionicons name="diamond-outline" size={22} color="#8A8A8E" />
        </View>
      )}

      <View style={styles.itemBody}>
        <Text style={[styles.itemTitle, line.muted && styles.itemTitleMuted]} numberOfLines={1}>
          {line.text}
        </Text>
        <View style={styles.metaRow}>
          {showConfidence && fr && (
            <ConfidenceBadge pct={fr.confidenceScore * 100} band={fr.confidenceBand} size="sm" />
          )}
          <Text style={styles.dateText}>
            {item.dateText} · {item.timeText}
          </Text>
          {item.location && (
            <View style={styles.locChip}>
              <Ionicons name="location" size={11} color="#2EE66E" />
            </View>
          )}
        </View>
      </View>

      {editMode ? (
        <Pressable
          style={styles.rowDeleteBtn}
          onPress={() => onDelete(item.id, line.text)}
          disabled={isDeleting}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={so ? "Tirtir baaristan" : "Delete this scan"}
        >
          {isDeleting ? (
            <ActivityIndicator color="#F5B3B3" size="small" />
          ) : (
            <Ionicons name="trash-outline" size={20} color="#F5B3B3" />
          )}
        </Pressable>
      ) : (
        <>
          {canPdf && !line.muted && (
            <Pressable
              style={styles.rowPdfBtn}
              onPress={() => onGeneratePdf(item.id)}
              disabled={isPdfBusy}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={so ? "Samee warbixin PDF" : "Generate PDF report"}
            >
              {isPdfBusy ? (
                <ActivityIndicator color="#C9A227" size="small" />
              ) : (
                <Ionicons name="document-text-outline" size={20} color="#C9A227" />
              )}
            </Pressable>
          )}

          <Ionicons name="chevron-forward" size={20} color="#8A8A8E" />
        </>
      )}
    </Pressable>
  );
});

export default function HistoryScreen() {
  const { t, i18n } = useTranslation();
  const so = i18n.language === "so";
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const isOnline = useIsOnline();

  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  // "cache" once loadFromCache has populated items from disk; flips to
  // "live" only once a live fetch actually succeeds. Drives the offline
  // banner — never cleared on a failed live refresh, so stale-but-real data
  // stays on screen instead of being replaced by an error state.
  const [dataSource, setDataSource] = useState<"cache" | "live">("live");
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  // Collection management: "Edit" mode reveals a delete control on each row.
  const [editMode, setEditMode] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Professional PDF report — Pro / "Gem Collector" tier only.
  const { data: sub } = useSubscriptionStatus();
  const canPdf = sub?.features?.pdfReports ?? false;
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null);

  // Delete one scan (server-side, ownership-checked), then drop it from the
  // on-screen list AND the offline cache (list entry + cached thumbnail) so it
  // doesn't reappear from cache on the next offline visit.
  const onDeleteScan = useCallback(
    (id: string, label: string) => {
      if (deletingId) return;
      const doDelete = async () => {
        setDeletingId(id);
        try {
          await deleteScan(id);
          setItems((prev) => prev.filter((it) => it.id !== id));
          const userId = session?.user.id;
          if (userId) {
            const cached = await readCachedJson<HistoryCache>(historyCacheKey(userId));
            if (cached) {
              await writeCachedJson<HistoryCache>(historyCacheKey(userId), {
                cachedAt: cached.cachedAt,
                items: cached.items.filter((it) => it.id !== id),
              });
            }
            await deleteCachedImage(id);
          }
        } catch (err) {
          Alert.alert(
            so ? "Waa fashilantay" : "Couldn't delete",
            (err as Error).message,
          );
        } finally {
          setDeletingId(null);
        }
      };

      Alert.alert(
        so ? "Tirtir baaristan?" : "Delete this scan?",
        so
          ? `"${label}" waa la tirtiri doonaa gebi ahaanba, sawirradiisa iyo wixii warbixin xaqiijin oo lacag lagu bixiyay ee la xidhiidha oo dhan. Tallaabadan lama soo celin karo.`
          : `"${label}" and its photos will be permanently removed, along with any paid verification report tied to it. This cannot be undone.`,
        [
          { text: so ? "Maya" : "Cancel", style: "cancel" },
          { text: so ? "Tirtir" : "Delete", style: "destructive", onPress: () => void doDelete() },
        ],
      );
    },
    [deletingId, session?.user.id, so],
  );

  const onGeneratePdf = useCallback(
    async (id: string) => {
      if (pdfBusyId) return;
      setPdfBusyId(id);
      try {
        await generatePdfForScan(id, so ? "so" : "en");
      } catch {
        /* generation/share failed or was dismissed — no-op */
      } finally {
        setPdfBusyId(null);
      }
    },
    [pdfBusyId, so],
  );

  // Read whatever was cached from the LAST successful live fetch (see
  // loadLive below) — resolves instantly, works with no network at all.
  // Returns whether there was anything to show.
  const loadFromCache = useCallback(async (): Promise<boolean> => {
    if (!session?.user.id) return false;
    const cached = await readCachedJson<HistoryCache>(historyCacheKey(session.user.id));
    if (!cached || cached.items.length === 0) return false;
    setItems(
      cached.items.map((i) => ({
        id: i.id,
        status: i.status,
        final_result: i.final_result,
        created_at: i.created_at,
        location: i.location,
        thumbnailUrl: i.thumbnailLocalUri,
      })),
    );
    setDataSource("cache");
    setCachedAt(cached.cachedAt);
    return true;
  }, [session?.user.id]);

  // The original live query, unchanged, plus (best-effort, fire-and-forget)
  // persisting a fresh offline cache afterward. Returns whether it succeeded.
  const loadLive = useCallback(async (): Promise<boolean> => {
    if (!session?.user.id) return false;
    const { data, error: queryError } = await supabase
      .from("scans")
      .select("id, status, final_result, created_at, capture_location, scan_images(original_storage_path)")
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (queryError || !data) return false;

    // Batch-sign the first image of each scan (the bucket is private, so raw
    // storage paths aren't directly loadable).
    const firstPaths = data
      .map((row: any) => row.scan_images?.[0]?.original_storage_path as string | undefined)
      .filter((p: string | undefined): p is string => Boolean(p));

    const signedByPath = new Map<string, string>();
    if (firstPaths.length > 0) {
      const { data: signed } = await supabase.storage
        .from("scan-images")
        .createSignedUrls(firstPaths, 3600);
      signed?.forEach((s) => {
        if (s.signedUrl && s.path) signedByPath.set(s.path, s.signedUrl);
      });
    }

    const freshItems: HistoryItem[] = data.map((row: any) => {
      const path = row.scan_images?.[0]?.original_storage_path as string | undefined;
      const loc = row.capture_location as { lat?: number; lng?: number } | null;
      return {
        id: row.id,
        status: row.status,
        final_result: row.final_result as ScanFinalResult,
        created_at: row.created_at,
        location:
          loc && typeof loc.lat === "number" && typeof loc.lng === "number"
            ? { lat: loc.lat, lng: loc.lng }
            : null,
        thumbnailUrl: path ? signedByPath.get(path) ?? null : null,
      };
    });

    setItems(freshItems);
    setDataSource("live");
    setCachedAt(null);

    // Never blocks rendering — downloads/prunes thumbnails and writes the
    // refreshed cache in the background so the NEXT offline visit has
    // something to show.
    const userId = session.user.id;
    (async () => {
      const cachedItems: CachedHistoryItem[] = await Promise.all(
        freshItems.map(async (item) => ({
          id: item.id,
          status: item.status,
          final_result: item.final_result,
          created_at: item.created_at,
          location: item.location,
          thumbnailLocalUri: item.thumbnailUrl
            ? await cacheImageFile(item.id, item.thumbnailUrl)
            : await localImageUriIfCached(item.id),
        })),
      );
      await pruneImageFiles(freshItems.map((i) => i.id));
      await writeCachedJson<HistoryCache>(historyCacheKey(userId), {
        cachedAt: new Date().toISOString(),
        items: cachedItems,
      });
    })().catch(() => {});

    return true;
  }, [session?.user.id]);

  const refresh = useCallback(
    async (showFullScreenLoading: boolean) => {
      const hadCache = await loadFromCache();
      if (showFullScreenLoading) setLoading(!hadCache);
      setError(false);
      if (isOnline) {
        const ok = await loadLive();
        if (!ok && !hadCache) setError(true);
      } else if (!hadCache) {
        setError(true);
      }
      if (showFullScreenLoading) setLoading(false);
    },
    [loadFromCache, loadLive, isOnline],
  );

  // Reload whenever the screen regains focus so a scan the user just finished
  // shows up when they navigate here.
  useFocusEffect(
    useCallback(() => {
      refresh(true);
    }, [refresh]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await refresh(false);
    setRefreshing(false);
  }

  function resultLine(item: HistoryItem): { text: string; muted: boolean } {
    if (item.status === "failed") return { text: t("history.failed"), muted: true };
    if (item.status !== "completed") return { text: t("history.processing"), muted: true };
    const fr = item.final_result;
    if (!fr || fr.insufficientConfidence || !fr.bestMatch)
      return { text: t("history.noResult"), muted: true };
    return { text: fr.bestMatch, muted: false };
  }

  // Compute each item's display line AND its formatted date/time ONCE per
  // items/language change, rather than recomputing them again in every
  // renderItem call for every visible row (B4: toLocaleDate/TimeString are
  // comparatively expensive Intl calls at 100 rows).
  const itemsWithLine = useMemo<HistoryListItem[]>(
    () =>
      items.map((item) => {
        const when = new Date(item.created_at);
        return {
          ...item,
          line: resultLine(item),
          dateText: when.toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          }),
          timeText: when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
        };
      }),
    // resultLine is a plain function redefined every render (uses t());
    // adding it here would defeat the memo since it'd never be stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items],
  );

  // Client-side search over already-loaded items — no new API call, no change
  // to what a scan is or how it's fetched, just filtering the display list.
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return itemsWithLine;
    return itemsWithLine.filter((item) => item.line.text.toLowerCase().includes(q));
  }, [itemsWithLine, query]);

  // Stable open handler so the memoized rows don't see a new prop each render.
  const onOpenResult = useCallback(
    (id: string) => router.push({ pathname: "/(app)/scan/results", params: { scanId: id } }),
    [router],
  );

  // B3: renderItem now delegates to the memoized HistoryRow. Passing per-row
  // booleans (deletingId/pdfBusyId compared to item.id) means a state change on
  // one row only re-renders that row; the rest bail out via React.memo.
  const renderItem = useCallback(
    ({ item }: { item: HistoryListItem }) => (
      <HistoryRow
        item={item}
        editMode={editMode}
        isDeleting={deletingId === item.id}
        isPdfBusy={pdfBusyId === item.id}
        canPdf={canPdf}
        so={so}
        onOpen={onOpenResult}
        onDelete={onDeleteScan}
        onGeneratePdf={onGeneratePdf}
      />
    ),
    [editMode, deletingId, pdfBusyId, canPdf, so, onOpenResult, onDeleteScan, onGeneratePdf],
  );

  // Hooks must run unconditionally on every render — declared here, before
  // the loading/error/empty early returns below.
  const locatedCount = useMemo(() => items.filter((i) => i.location).length, [items]);

  const bannerMessage = useMemo(() => {
    if (dataSource !== "cache" || !cachedAt) return null;
    const age = formatCacheAge(cachedAt, so);
    return isOnline ? t("history.refreshFailedShowingSaved", { age }) : t("history.offlineShowingSaved", { age });
  }, [dataSource, cachedAt, isOnline, so, t]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#C9A227" size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyHint}>{t("history.loadError")}</Text>
        <Pressable style={styles.primaryButton} onPress={onRefresh}>
          <Text style={styles.primaryButtonText}>{t("common.retry")}</Text>
        </Pressable>
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={styles.centered}>
        <EmptyState
          icon="diamond-outline"
          title={t("history.emptyTitle")}
          hint={t("history.emptyHint")}
          ctaLabel={t("history.startScanning")}
          onPressCta={() => router.push("/(app)/scan/live")}
        />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={[styles.listContent, { paddingBottom: 16 + insets.bottom }]}
      data={filteredItems}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      // B5: windowing for a list of up to 100 image rows. Conservative values
      // that only limit how much is mounted/rendered ahead — no getItemLayout
      // (rows use flex `gap` spacing + slightly variable height, so a fixed
      // offset formula would risk scroll glitches; not worth the risk here).
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={11}
      updateCellsBatchingPeriod={50}
      removeClippedSubviews
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View>
              <Text style={styles.headerTitle}>💎 {so ? "Kaydkaaga" : "My Collection"}</Text>
              <Text style={styles.headerCount}>
                {items.length} {so ? "baaris" : items.length === 1 ? "scan" : "scans"}
                {locatedCount > 0 ? ` · ${locatedCount} ${so ? "goobo la calaamadeeyay" : "mapped"}` : ""}
              </Text>
            </View>
            <View style={styles.headerActions}>
              {locatedCount > 0 && !editMode && (
                <Pressable
                  style={styles.mapButton}
                  onPress={() => router.push("/(app)/collection-map")}
                >
                  <Ionicons name="map" size={16} color="#0B0B0C" />
                  <Text style={styles.mapButtonText}>{so ? "Khariidad" : "Map"}</Text>
                </Pressable>
              )}
              <Pressable
                style={styles.editButton}
                onPress={() => setEditMode((e) => !e)}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Text style={styles.editButtonText}>
                  {editMode ? (so ? "Diyaar" : "Done") : so ? "Wax ka beddel" : "Edit"}
                </Text>
              </Pressable>
            </View>
          </View>

          {bannerMessage && <OfflineBanner message={bannerMessage} />}

          <View style={styles.searchBar}>
            <Ionicons name="search" size={16} color={colors.textFaint} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder={so ? "Raadi kaydkaaga…" : "Search your collection…"}
              placeholderTextColor={colors.textFaint}
              returnKeyType="search"
              autoCapitalize="none"
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery("")} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={colors.textFaint} />
              </Pressable>
            )}
          </View>
        </View>
      }
      ListEmptyComponent={
        <View style={styles.noMatches}>
          <Text style={styles.emptyHint}>
            {so ? `Wax lama helin oo la mid ah "${query}"` : `No results for "${query}"`}
          </Text>
        </View>
      }
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#C9A227" />
      }
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B0B0C" },
  listContent: { padding: 16, gap: 10 },
  centered: {
    flex: 1,
    backgroundColor: "#0B0B0C",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 12,
  },
  emptyHint: { fontSize: 14, color: "#8A8A8E", textAlign: "center", lineHeight: 20 },
  noMatches: { paddingVertical: spacing.xxxl, alignItems: "center" },
  itemCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  thumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: "#2A2A2C" },
  thumbPlaceholder: { alignItems: "center", justifyContent: "center" },
  rowPdfBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#C9A227",
    backgroundColor: "#161618",
    alignItems: "center",
    justifyContent: "center",
  },
  rowDeleteBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#F5B3B3",
    backgroundColor: "#2a1414",
    alignItems: "center",
    justifyContent: "center",
  },
  itemBody: { flex: 1, gap: 4 },
  itemTitle: { fontSize: 16, fontWeight: "600", color: "#F5F1E8" },
  itemTitleMuted: { color: "#8A8A8E", fontWeight: "500" },
  header: { paddingVertical: 8, paddingHorizontal: 4, marginBottom: 4, gap: spacing.md },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerTitle: { fontSize: 22, fontWeight: "800", color: "#C9A227" },
  headerCount: { fontSize: 13, color: "#8A8A8E", marginTop: 2 },
  mapButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  mapButtonText: { color: "#0B0B0C", fontWeight: "800", fontSize: 13 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  editButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#C9A227",
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  editButtonText: { color: "#C9A227", fontWeight: "800", fontSize: 13 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 14, padding: 0 },
  dateText: { fontSize: 12, color: "#8A8A8E" },
  locChip: { flexDirection: "row", alignItems: "center" },
  primaryButton: {
    backgroundColor: "#C9A227",
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignItems: "center",
    marginTop: 8,
  },
  primaryButtonText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
});

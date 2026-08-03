// Enterprise › Sample Details (Sprint 4.2 owner beta).
// Read-only view of one submitted sample (GET /enterprise-samples/:id,
// RLS-scoped). Shows GPS, photos, minerals and rock/field notes — enough to
// confirm the submission round-tripped. No edit/verify/community actions.
import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Image, RefreshControl, Pressable, Alert, Linking } from "react-native";
import { cellToLatLng } from "h3-js";
import { useLocalSearchParams, router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../../lib/supabase";
import { colors, spacing, radius, type as t } from "../../../../lib/theme";
import { Card } from "../../../../components/ui/Card";
import { SectionLabel } from "../../../../components/ui/SectionLabel";
import { getSample, reanalyzeSample, sampleIsEditable, type SampleDetail, type AssessmentEvidence, type MediaRole } from "../../../../lib/enterpriseSamples";
import { shotNeedsFor } from "../../../../lib/shotNeeds";

export default function SampleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const [sample, setSample] = useState<SampleDetail | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const s = await getSample(String(id));
      setSample(s);
      // Photos are private — resolve short-lived signed URLs for display.
      const map: Record<string, string> = {};
      for (const m of s.sample_media ?? []) {
        const { data } = await supabase.storage.from("scan-images").createSignedUrl(m.storage_path, 3600);
        if (data?.signedUrl) map[m.id] = data.signedUrl;
      }
      setThumbs(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sample.");
    } finally {
      isRefresh ? setRefreshing(false) : setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Force a fresh AI re-analysis (picks up newly loaded data, e.g. MRDS).
  const onReanalyze = useCallback(async () => {
    setReanalyzing(true);
    try {
      await reanalyzeSample(String(id));
      Alert.alert(
        so ? "Dib-u-falanqayn bilaabatay" : "Re-analysis started",
        so ? "Dib ayaa loo xisaabinayaa. Daqiiqad ka dib hoos u jiid si aad u aragto natiijada cusub." : "Re-analyzing. Pull to refresh in a moment to see the updated result.",
      );
    } catch (e) {
      Alert.alert("Re-analyze failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setReanalyzing(false);
    }
  }, [id, so]);

  if (loading) return <View style={styles.center}><ActivityIndicator color={colors.gold} /></View>;
  if (error || !sample) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={40} color={colors.danger} />
        <Text style={styles.errText}>{error ?? "Sample not found."}</Text>
      </View>
    );
  }

  const loc = sample.sample_location?.[0];
  const rock = sample.rock_observation?.[0];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.gold} />}
    >
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{sample.name || `Sample ${sample.id.slice(0, 8)}`}</Text>
          <Text style={styles.subtitle}>Collected {new Date(sample.collected_at).toLocaleString()}</Text>
        </View>
        {sampleIsEditable(sample.status) && (
          <Pressable
            style={styles.editBtn}
            onPress={() => router.push(`/(app)/enterprise/new-sample?edit=${sample.id}`)}
            hitSlop={6}
          >
            <Ionicons name="create-outline" size={15} color={colors.gold} />
            <Text style={styles.editBtnText}>{so ? "Wax ka beddel" : "Edit"}</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.badges}>
        <Badge label={statusLabel(sample.status)} />
        {sample.ai_confidence != null && <Badge label={`Analysis ${Math.round(sample.ai_confidence)}%`} />}
        {sample.geologist_confidence != null && <Badge label={`Geologist ${Math.round(sample.geologist_confidence)}%`} />}
        {sample.completeness_score != null && <Badge label={`${Math.round(sample.completeness_score)}/100 complete`} />}
      </View>

      <GeologistReview sample={sample} so={so} />

      {loc && (
        <>
          <SectionLabel>Location</SectionLabel>
          <Card>
            <Row icon="location" text={`${loc.h3_cell}`} />
            {loc.gps_accuracy_m != null && <Row icon="navigate-outline" text={`±${loc.gps_accuracy_m} m`} />}
            {loc.altitude_m != null && <Row icon="trending-up-outline" text={`${loc.altitude_m} m altitude`} />}
            <Row icon="ellipse-outline" text={`source: ${loc.provenance}`} />
          </Card>
        </>
      )}

      {sample.sample_media?.length > 0 && (
        <>
          <SectionLabel>Photos ({sample.sample_media.length})</SectionLabel>
          <View style={styles.photoRow}>
            {sample.sample_media.map((m) =>
              thumbs[m.id] ? (
                <Image key={m.id} source={{ uri: thumbs[m.id] }} style={styles.thumb} />
              ) : (
                <View key={m.id} style={[styles.thumb, styles.thumbPlaceholder]}>
                  <Ionicons name="image-outline" size={20} color={colors.textFaint} />
                </View>
              ),
            )}
          </View>
        </>
      )}

      {sample.mineral_observation?.length > 0 && (
        <>
          <SectionLabel>Minerals</SectionLabel>
          <View style={styles.chips}>
            {sample.mineral_observation.map((m, i) => (
              <View key={i} style={styles.chip}><Text style={styles.chipText}>{m.mineral}</Text></View>
            ))}
          </View>
        </>
      )}

      {(rock?.rock_class || rock?.notes) && (
        <>
          <SectionLabel>Host rock</SectionLabel>
          <Card>
            {rock?.rock_class && <Text style={styles.bodyText}>{rock.rock_class}</Text>}
            {rock?.notes && <Text style={[styles.bodyText, { color: colors.textMuted, marginTop: 4 }]}>{rock.notes}</Text>}
          </Card>
        </>
      )}

      {sample.field_observations && (
        <>
          <SectionLabel>Field notes</SectionLabel>
          <Card><Text style={styles.bodyText}>{sample.field_observations}</Text></Card>
        </>
      )}

      {loc?.h3_cell && (
        <SatelliteMap h3={loc.h3_cell} geology={(sample.assessment?.assessment_evidence ?? []).filter((e) => e.ev_type === "spatial")} so={so} />
      )}

      {/* AI Geological Assessment (§6/§7/§10/§11) */}
      <View style={styles.aiHeader}>
        <SectionLabel>{so ? "Falanqaynta Juqraafi" : "Geological Analysis"}</SectionLabel>
        <Pressable style={styles.reBtn} onPress={onReanalyze} disabled={reanalyzing} hitSlop={6}>
          {reanalyzing
            ? <ActivityIndicator color={colors.gold} size="small" />
            : <Ionicons name="refresh" size={15} color={colors.gold} />}
          <Text style={styles.reBtnText}>{so ? "Dib u falanqee" : "Re-analyze"}</Text>
        </Pressable>
      </View>
      <AiAnalysis sample={sample} so={so} />
    </ScrollView>
  );
}

// Human-friendly status labels for the production lifecycle (§13).
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", ready: "Ready", uploading: "Uploading", ai_processing: "Processing",
  ai_completed: "Analysis ready", awaiting_review: "Waiting for Geologist", verified: "Verified",
  needs_more_data: "Needs More Data", rejected: "Rejected", submitted: "Submitted",
  community_confirmed: "Community Confirmed", expert_verified: "Expert Verified",
  lab_verified: "Lab Verified", held: "Held",
};
function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s.replace(/_/g, " ");
}

function Badge({ label }: { label: string }) {
  return <View style={styles.badge}><Text style={styles.badgeText}>{label}</Text></View>;
}
function Row({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={styles.detailRow}>
      <Ionicons name={icon} size={16} color={colors.textMuted} />
      <Text style={styles.bodyText}>{text}</Text>
    </View>
  );
}

const KIND_LABELS: Record<string, string> = {
  rock_type: "Rock type", mineralization: "Mineralization", ore_mineral: "Ore minerals",
  gangue_mineral: "Gangue minerals", environment: "Geological environment",
  deposit_model: "Deposit model", exploration_significance: "Exploration significance",
};
const KIND_LABELS_SO: Record<string, string> = {
  rock_type: "Nooca dhagaxa", mineralization: "Macdaneed", ore_mineral: "Macdanaha birta",
  gangue_mineral: "Macdanaha aan faa'iidada lahayn", environment: "Deegaanka juqraafi",
  deposit_model: "Qaabka kaydka", exploration_significance: "Muhiimadda sahaminta",
};

// Satellite map of the sample location + the geology mapped there. Decodes the H3
// cell to lat/lng and shows an ESRI World Imagery tile (free, no key) with a pin.
function SatelliteMap({ h3, geology, so }: { h3: string; geology: AssessmentEvidence[]; so: boolean }) {
  let center: [number, number] | null = null;
  try { center = cellToLatLng(h3); } catch { center = null; }
  if (!center) return null;
  const [lat, lng] = center;
  const latD = 0.004;
  const lngD = 0.004 / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const bbox = `${lng - lngD},${lat - latD},${lng + lngD},${lat + latD}`;
  const img = `https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=680,420&format=jpg&f=image`;
  const maps = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

  return (
    <>
      <SectionLabel>{so ? "Goobta — satellite" : "Location — satellite"}</SectionLabel>
      <View style={styles.satWrap}>
        <Image source={{ uri: img }} style={styles.satImg} resizeMode="cover" />
        <View style={styles.satPin} />
      </View>
      <View style={styles.satFoot}>
        <Text style={styles.rowMetaSmall}>{lat.toFixed(5)}, {lng.toFixed(5)}</Text>
        <Pressable onPress={() => Linking.openURL(maps)} hitSlop={8}>
          <Text style={styles.satLink}>{so ? "Ku fur Maps ↗" : "Open in Maps ↗"}</Text>
        </Pressable>
      </View>
      {geology.length > 0 && (
        <Card>
          <Text style={styles.evLabel}>{so ? "Geology-ga khariidadda halkan" : "Mapped geology here"}</Text>
          {geology.map((e) => (
            <Text key={e.id} style={styles.evItem}>• {(so && e.statement_so) ? e.statement_so : e.statement}</Text>
          ))}
        </Card>
      )}
    </>
  );
}

// Opportunity + confidence display helpers (the plain-language layer).
// Short level labels — this is the EXPLORATION POTENTIAL, shown separately from the
// (independent) identification confidence.
const OPP_META: Record<string, { en: string; so: string; color: string }> = {
  high: { en: "High", so: "Sare", color: colors.success },
  moderate: { en: "Moderate", so: "Dhexe", color: colors.gold },
  low: { en: "Low", so: "Hoose", color: "#d98324" },
  none: { en: "Not clear", so: "Ma cadda", color: colors.textFaint },
};
// Epistemic status of a persisted evidence row (derived — how grounded it is).
function epiOfEv(e: AssessmentEvidence): "observed" | "inferred" | "possible" {
  if (e.tier === "knowledge_kb") return "possible";
  if (e.is_observation) return "observed";
  return "inferred";
}
function epiColor(k: "observed" | "inferred" | "possible"): string {
  return k === "observed" ? colors.success : k === "possible" ? colors.gold : "#9cc0ff";
}
function aiBand(pct: number, so: boolean): { label: string; color: string } {
  if (pct >= 70) return { label: so ? "Sare" : "High", color: colors.success };
  if (pct >= 40) return { label: so ? "Dhexe" : "Moderate", color: colors.gold };
  if (pct >= 20) return { label: so ? "Hoose" : "Low", color: "#d98324" };
  return { label: so ? "Aad u hooseeya" : "Very low", color: colors.danger };
}
// A long horizontal 0–100% bar with Low→High labels, so confidence reads instantly.
function AiConfBar({ pct, so, big }: { pct: number | null; so: boolean; big?: boolean }) {
  const v = Math.max(0, Math.min(100, Math.round(pct ?? 0)));
  const b = aiBand(v, so);
  return (
    <View style={{ marginTop: 6 }}>
      <View style={styles.barScale}><Text style={styles.barScaleTxt}>{so ? "Hoose" : "Low"}</Text><Text style={styles.barScaleTxt}>{so ? "Sare" : "High"}</Text></View>
      <View style={[styles.barTrack, big && { height: 14 }]}><View style={[styles.barFill, { width: `${v}%`, backgroundColor: b.color }]} /></View>
      <View style={styles.barFoot}><Text style={[styles.barBand, { color: b.color }]}>{b.label}</Text><Text style={styles.barPct}>{v}%</Text></View>
    </View>
  );
}

// Star rating (fill n of 5).
function Stars({ n, big }: { n: number; big?: boolean }) {
  return (
    <Text style={[styles.starsTxt, big && { fontSize: 22 }]}>
      {[1, 2, 3, 4, 5].map((i) => <Text key={i} style={{ color: i <= n ? colors.gold : colors.border }}>★</Text>)}
    </Text>
  );
}
const confStars = (pct: number) => Math.max(1, Math.min(5, Math.round(pct / 20)));
// Exploration potential → stars + label (independent of identification confidence).
const OPP_STARS: Record<string, { stars: number; en: string; so: string; color: string }> = {
  high: { stars: 5, en: "Very High", so: "Aad u Sarreysa", color: colors.success },
  moderate: { stars: 3, en: "Moderate", so: "Dhexe", color: colors.gold },
  low: { stars: 2, en: "Low", so: "Hoose", color: "#d98324" },
  none: { stars: 1, en: "Unclear", so: "Ma cadda", color: colors.textFaint },
};
type MineralCard = { name: string; importance: string; kind: "commodity" | "indicator"; critical?: boolean };
// Bilingual text block — English then Somali.
function BiRN({ v }: { v?: { en: string; so: string } }) {
  if (!v?.en && !v?.so) return null;
  return (
    <>
      {!!v.en && <Text style={styles.bodyText}>{v.en}</Text>}
      {!!v.so && v.so !== v.en && <Text style={[styles.bodyText, styles.soLine]}>{v.so}</Text>}
    </>
  );
}
function titleCaseRN(s: string): string { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }

// Geological analysis — a 12-year-old-friendly SIMPLE report (7 visual sections) and
// an EXPERT view (the full traceable evidence graph). Bilingual throughout.
// This file speaks both languages inline rather than through i18n keys, as the
// rest of the enterprise screens do; the shot names follow that convention.
const NEED_LABEL: Record<string, { en: string; so: string }> = {
  closer: { en: "A closer photo", so: "Sawir dhow" },
  angle: { en: "A different angle", so: "Jiho kale" },
  fresh_surface: { en: "A fresh broken surface", so: "Dhinac cusub oo la jebiyay" },
  wider_context: { en: "A wider context photo", so: "Sawir ballaadhan oo goobta muujinaya" },
  vein_closeup: { en: "A quartz vein close-up", so: "Xididka quartz-ka oo dhow" },
  weathered: { en: "The weathered surface", so: "Dusha duugoobay" },
  mineral_closeup: { en: "A mineral close-up", so: "Macdanta oo dhow" },
};

function AiAnalysis({ sample, so }: { sample: SampleDetail; so: boolean }) {
  const a = sample.assessment;
  const [mode, setMode] = useState<"simple" | "expert">("simple");
  // Valuable minerals commonly associated (§4) — live from the geology KB for the
  // sample's host rock. Reviewers/collectors can call these read-only RPCs.
  const [mineralCards, setMineralCards] = useState<MineralCard[]>([]);
  useEffect(() => {
    const rock = sample.rock_observation?.[0]?.rock_class;
    if (!rock) return;
    (async () => {
      try {
        const { data: rules } = await supabase.schema("geo").rpc("knowledge_rules_for", { p_host_rocks: [rock], p_lithology: [], p_deposit_types: [] });
        const rs = (rules ?? []) as { commodity_code: string | null; expected_minerals: string[] | null }[];
        const codes = [...new Set(rs.map((r) => r.commodity_code).filter((c): c is string => !!c))];
        const { data: profs } = codes.length ? await supabase.schema("geo").rpc("commodity_profiles", { p_codes: codes }) : { data: [] };
        const byCode = new Map(((profs ?? []) as { code: string; name: string; strategic_importance: string | null; is_critical_mineral: boolean }[]).map((p) => [p.code, p]));
        const cards: MineralCard[] = [];
        const seen = new Set<string>();
        for (const code of codes) { const p = byCode.get(code); if (!p) continue; cards.push({ name: p.name, importance: p.strategic_importance ?? "", kind: "commodity", critical: p.is_critical_mineral }); seen.add(p.name.toLowerCase()); }
        for (const m of [...new Set(rs.flatMap((r) => r.expected_minerals ?? []))]) {
          if (seen.has(m.toLowerCase())) continue; seen.add(m.toLowerCase());
          cards.push({ name: titleCaseRN(m), importance: (so ? "Macdan tilmaame ah oo geologist-yadu ku raadiyaan " : "An indicator mineral geologists look for to trace ") + rock.toLowerCase() + (so ? "." : " systems."), kind: "indicator" });
        }
        setMineralCards(cards);
      } catch { /* KB optional */ }
    })();
  }, [sample.id, so]);
  const evStatement = (e: AssessmentEvidence) => (so && e.statement_so) ? e.statement_so : e.statement;
  if (!a) {
    return (
      <Card>
        <Text style={styles.pendingText}>
          {sample.status === "ai_processing"
            ? (so ? "Falanqayntu waa socotaa…" : "Analysis in progress…")
            : (so ? "Falanqayntu si toos ah ayey u shaqaysaa gudbinta kadib. Hoos u jiid si aad u cusboonaysiiso." : "Analysis runs automatically after submission. Pull to refresh.")}
        </Text>
      </Card>
    );
  }
  const evById = new Map(a.assessment_evidence.map((e) => [e.id, e]));
  const edgeEv = (cid: string, pol: string): AssessmentEvidence[] =>
    a.assessment_edge
      .filter((e) => e.conclusion_id === cid && e.polarity === pol)
      .map((e) => evById.get(e.evidence_id))
      .filter((e): e is AssessmentEvidence => !!e);
  const recs = a.report?.recommendations ?? [];
  const unc = a.report?.uncertainties ?? [];
  const missing = a.report?.missingInformation ?? [];
  // Bilingual throughout — every result shows English AND Somali.
  const headlineBi = a.report?.headline;
  const summaryBi = a.report?.simpleSummary;
  const opp = a.report?.opportunity ? OPP_META[a.report.opportunity] : null;
  const interp = a.report?.interpretation;
  const interpItems: [string, { en: string; so: string } | undefined][] = interp
    ? ([
        [so ? "Waa maxay" : "What it is", interp.whatItIs],
        [so ? "Caadi ahaan wuxuu qabaa" : "Commonly hosts", interp.commonlyHosts],
        [so ? "Waxa xiga la raadiyo" : "What to look for next", interp.lookForNext],
        [so ? "Maxay muhiim u tahay" : "Why it matters", interp.whyItMatters],
        [so ? "Deegaanka juqraafi" : "Geological environment", interp.environment],
      ] as [string, { en: string; so: string } | undefined][]).filter(([, v]) => v?.en || v?.so)
    : [];
  // 7-section report derivations
  const pct = Math.max(0, Math.min(100, Math.round(a.overall_confidence ?? 0)));
  const cband = aiBand(pct, so);
  const oppMeta = OPP_STARS[a.report?.opportunity ?? "none"];
  const whyBi = interp?.whyItMatters;
  const lookBi = interp?.lookForNext;
  const envBi = interp?.environment;
  const supports = a.assessment_evidence.filter((e) => e.is_observation).slice(0, 4).map((e) => evStatement(e));
  const limits = [...unc.map((u) => (so ? u.so : u.en)), ...missing.map((m) => (so ? m.so : m.en))].filter(Boolean).slice(0, 3);

  // What, if anything, is worth going back for. Empty on a confident result —
  // which is the common case, and the reason this is a deduction over the
  // report rather than a standing "add more photos" prompt.
  const needs = shotNeedsFor({
    // The engine reports a percentage; shotNeedsFor works in 0..1.
    overallConfidence: a.overall_confidence == null ? null : a.overall_confidence / 100,
    roles: (sample.sample_media ?? []).map((m) => m.role as MediaRole),
    missingInformation: missing.map((m) => `${m.en} ${m.so ?? ""}`),
  });

  const NeedsBlock = needs.length === 0 ? null : (
    <Card>
      <SectionLabel>{so ? "SAWIRO KALE OO LOO BAAHAN YAHAY" : "PHOTOS THAT WOULD HELP"}</SectionLabel>
      <Text style={styles.needIntro}>
        {so
          ? "Falanqayntu way hubi kartaa haddii aad sawirradan qaadato. Waxa kaliya ee la weydiisanayo waa kuwan."
          : "The analysis could be more certain with these. Only these are being asked for."}
      </Text>
      {needs.map((n) => (
        <Text key={n} style={styles.needItem}>{"•"} {NEED_LABEL[n][so ? "so" : "en"]}</Text>
      ))}
      <Pressable
        style={styles.needBtn}
        onPress={() =>
          router.push({
            pathname: "/(app)/enterprise/new-sample",
            params: { edit: sample.id, need: needs.join(",") },
          })
        }
      >
        <Ionicons name="camera" size={18} color="#0B0B0C" />
        <Text style={styles.needBtnText}>
          {so ? "Qaad sawirradan" : "Take these photos"}
        </Text>
      </Pressable>
    </Card>
  );

  return (
    <>
      {/* What is worth going back for, when anything is. Above the report on
          purpose: acting on it is time-critical while the geologist is still
          near the outcrop. */}
      {NeedsBlock}

      {/* Simple / Expert toggle */}
      <View style={styles.modeToggle}>
        {(["simple", "expert"] as const).map((m) => (
          <Pressable key={m} style={[styles.modeBtn, mode === m && styles.modeBtnOn]} onPress={() => setMode(m)}>
            <Text style={[styles.modeBtnTxt, mode === m && styles.modeBtnTxtOn]}>
              {m === "simple" ? (so ? "Fudud" : "Simple") : (so ? "Khabiir" : "Expert")}
            </Text>
          </Pressable>
        ))}
      </View>

      {mode === "simple" ? (
        <>
          {/* 1. What I think this is */}
          <SectionLabel>{so ? "Waxaan filayo inuu yahay" : "What I think this is"}</SectionLabel>
          <Card style={{ borderColor: colors.goldBorder, backgroundColor: colors.goldSoft }}>
            {!!headlineBi?.en && <Text style={styles.repLead}>{headlineBi.en}</Text>}
            {!!headlineBi?.so && headlineBi.so !== headlineBi.en && <Text style={[styles.repLead, styles.soLine]}>{headlineBi.so}</Text>}
          </Card>

          {/* 2. Confidence meter + why */}
          <SectionLabel>{so ? "Sida aan u hubo (aqoonsiga)" : "How confident I am"}</SectionLabel>
          <Card>
            <View style={styles.meterRow}>
              <View style={{ flex: 1 }}><AiConfBar pct={a.overall_confidence} so={so} big /></View>
              <View style={styles.starsCol}><Stars n={confStars(pct)} /><Text style={[styles.meterPct, { color: cband.color }]}>{pct}%</Text></View>
            </View>
            {supports.length > 0 && (
              <View style={styles.whyBlock}>
                <Text style={[styles.whyH, { color: colors.success }]}>{so ? "Sababo kor u qaadaya" : "Higher because"}</Text>
                {supports.map((s, i) => <Text key={i} style={styles.whyItem}>✓ {s}</Text>)}
              </View>
            )}
            {limits.length > 0 && (
              <View style={styles.whyBlock}>
                <Text style={[styles.whyH, { color: colors.textFaint }]}>{so ? "Sababo hoos u dhigaya" : "Lower because"}</Text>
                {limits.map((s, i) => <Text key={i} style={styles.whyItem}>• {s}</Text>)}
              </View>
            )}
          </Card>

          {/* 3. Why this matters */}
          {(whyBi?.en || whyBi?.so) ? (
            <>
              <SectionLabel>{so ? "Maxay muhiim u tahay" : "Why this matters"}</SectionLabel>
              <Card><BiRN v={whyBi} /></Card>
            </>
          ) : null}

          {/* 4. Valuable minerals commonly associated */}
          {mineralCards.length > 0 && (
            <>
              <SectionLabel>{so ? "Macdanaha qiimaha leh ee la xiriira" : "Valuable minerals commonly associated"}</SectionLabel>
              <View style={styles.minGrid}>
                {mineralCards.map((c) => (
                  <View key={c.name} style={[styles.minCard, { borderLeftColor: c.kind === "commodity" ? colors.gold : "#9cc0ff" }]}>
                    <View style={styles.minNameRow}>
                      <Text style={styles.minName}>{c.name}</Text>
                      {c.critical && <View style={styles.critBadge}><Text style={styles.critTxt}>critical</Text></View>}
                    </View>
                    {!!c.importance && <Text style={styles.minImp}>{c.importance}</Text>}
                  </View>
                ))}
              </View>
            </>
          )}

          {/* 5. What I'd look for next */}
          <SectionLabel>{so ? "Waxa xiga la raadiyo" : "What I'd look for next"}</SectionLabel>
          <Card>
            <BiRN v={lookBi} />
            {recs.map((r, i) => (
              <View key={i} style={[styles.detailRow, { marginTop: 6 }]}>
                <Ionicons name={r.flagged ? "alert-circle-outline" : "arrow-forward-circle-outline"} size={16} color={r.flagged ? colors.danger : colors.gold} />
                <Text style={styles.bodyText}>{(so && r.actionSo) ? r.actionSo : r.action}{r.scaleM ? ` (${r.scaleM} m)` : ""}</Text>
              </View>
            ))}
          </Card>

          {/* 6. Exploration potential (stars) */}
          <SectionLabel>{so ? "Fursadda sahaminta" : "Exploration potential"}</SectionLabel>
          <Card>
            <View style={styles.potStarRow}><Stars n={oppMeta.stars} big /><Text style={[styles.potTxt, { color: oppMeta.color }]}>{so ? oppMeta.so : oppMeta.en}</Text></View>
            <Text style={styles.repNote}>{so ? "Tani way ka duwan tahay sida aan u hubno waxa uu yahay — waxay muujinaysaa qiimaha uu deegaanku yeelan karo." : "This is separate from how sure we are what the rock is — it shows how valuable the setting could be."}</Text>
            <BiRN v={envBi} />
          </Card>

          {/* 7. Final advice */}
          {(summaryBi?.en || summaryBi?.so) ? (
            <>
              <SectionLabel>{so ? "Talo kama dambays ah" : "Final advice"}</SectionLabel>
              <Card style={{ borderColor: colors.goldBorder, backgroundColor: colors.goldSoft }}><BiRN v={summaryBi} /></Card>
            </>
          ) : null}
        </>
      ) : (
        <>
          {/* Expert: calibrated headline + two metrics + interpretation grid */}
          {(headlineBi?.en || headlineBi?.so) ? (
            <Card style={{ borderColor: colors.goldBorder, backgroundColor: colors.goldSoft }}>
              {!!headlineBi.en && <Text style={styles.headline}>{headlineBi.en}</Text>}
              {!!headlineBi.so && headlineBi.so !== headlineBi.en && <Text style={[styles.headline, styles.soLine]}>{headlineBi.so}</Text>}
            </Card>
          ) : null}
          <Card>
            <Text style={styles.barCaption}>{so ? "Kalsoonida aqoonsiga" : "Identification confidence"}</Text>
            <AiConfBar pct={a.overall_confidence} so={so} big />
          </Card>
          <Card style={{ marginTop: 8 }}>
            <View style={styles.potRow}>
              <Text style={styles.barCaption}>{so ? "Fursadda sahaminta" : "Exploration potential"}</Text>
              <View style={[styles.potBox, { borderColor: opp?.color ?? colors.textFaint }]}>
                <Text style={[styles.potTxt, { color: opp?.color ?? colors.textFaint }]}>{opp ? (so ? opp.so : opp.en) : "—"}</Text>
              </View>
            </View>
          </Card>
          {interpItems.length > 0 && (
            <>
              <SectionLabel>{so ? "Fahamka geology-ga" : "Geological interpretation"}</SectionLabel>
              <Card>
                {interpItems.map(([label, v], i) => (
                  <View key={label} style={i > 0 ? styles.interpItem : undefined}>
                    <Text style={styles.interpLabel}>{label}</Text>
                    {!!v!.en && <Text style={styles.bodyText}>{v!.en}</Text>}
                    {!!v!.so && v!.so !== v!.en && <Text style={[styles.bodyText, styles.soLine]}>{v!.so}</Text>}
                  </View>
                ))}
              </Card>
            </>
          )}
          {a.assessment_conclusion.map((c) => {
            const support = edgeEv(c.id, "supporting");
            const contra = edgeEv(c.id, "contradicting");
            return (
              <Card key={c.id} style={{ marginTop: 8 }}>
                <View style={styles.conclHeader}>
                  <Text style={styles.conclKind}>{(so ? KIND_LABELS_SO : KIND_LABELS)[c.kind] ?? c.kind}</Text>
                </View>
                <Text style={styles.bodyText}>{(so && c.statement_so) ? c.statement_so : c.statement}</Text>
                {c.confidence != null && <AiConfBar pct={c.confidence} so={so} />}
                <Text style={styles.tag}>{c.is_interpretation ? (so ? "fasiraad" : "interpretation") : (so ? "indho-indhayn" : "observation")}</Text>
                {support.length > 0 && (
                  <View style={styles.evBlock}>
                    <Text style={styles.evLabel}>{so ? "Caddaynta taageerta" : "Supporting evidence"}</Text>
                    {support.map((e) => {
                      const k = epiOfEv(e);
                      return (
                        <View key={e.id} style={styles.evRow}>
                          <View style={[styles.epiBadge, { borderColor: epiColor(k) }]}><Text style={[styles.epiTxt, { color: epiColor(k) }]}>{k}</Text></View>
                          <Text style={[styles.evItem, { flex: 1 }]}>{evStatement(e)} <Text style={styles.evSrc}>({e.ev_type})</Text></Text>
                        </View>
                      );
                    })}
                  </View>
                )}
                {contra.length > 0 && (
                  <View style={styles.evBlock}>
                    <Text style={[styles.evLabel, { color: colors.danger }]}>{so ? "Caddayn ka hor imanaysa" : "Contradicting"}</Text>
                    {contra.map((e) => <Text key={e.id} style={styles.evItem}>• {evStatement(e)}</Text>)}
                  </View>
                )}
              </Card>
            );
          })}
          {(unc.length > 0 || missing.length > 0) && (
            <>
              <SectionLabel>{so ? "Hubin la'aan & xog maqan" : "Uncertainties & missing data"}</SectionLabel>
              <Card>
                {unc.map((u, i) => <Text key={`u${i}`} style={styles.evItem}>• {so ? u.so : u.en}</Text>)}
                {missing.map((m, i) => <Text key={`m${i}`} style={[styles.evItem, { color: colors.textFaint }]}>• {so ? "maqan" : "missing"}: {so ? m.so : m.en}</Text>)}
              </Card>
            </>
          )}
          <Text style={styles.traceNote}>{so ? "Gunaanad kasta wuxuu ku xiran yahay caddaynta soo saartay." : "Every conclusion is linked to the evidence that produced it."}</Text>
        </>
      )}
    </>
  );
}

// Geologist Review — the reviewer's binding decision, confidence, notes and the
// discussion timeline, so the collector actually receives the review feedback.
const DECISION_META: Record<string, { en: string; so: string; color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  verify: { en: "Verified", so: "La xaqiijiyay", color: colors.success, icon: "checkmark-circle" },
  needs_more_data: { en: "Needs more data", so: "Xog dheeraad ah ayaa loo baahan yahay", color: colors.gold, icon: "information-circle" },
  reject: { en: "Rejected", so: "La diiday", color: colors.danger, icon: "close-circle" },
};

function GeologistReview({ sample, so }: { sample: SampleDetail; so: boolean }) {
  const r = sample.review;
  const msgs = sample.discussion ?? [];
  if (!r && msgs.length === 0) return null;
  const d = r?.decision ? DECISION_META[r.decision] : null;
  return (
    <>
      <SectionLabel>{so ? "Eegista Geologistaha" : "Geologist Review"}</SectionLabel>
      <Card>
        {d ? (
          <View style={styles.decisionRow}>
            <Ionicons name={d.icon} size={18} color={d.color} />
            <Text style={[styles.decisionText, { color: d.color }]}>{so ? d.so : d.en}</Text>
            {r?.geologist_confidence != null && (
              <View style={styles.gConfPill}><Text style={styles.gConfText}>{Math.round(r.geologist_confidence)}%</Text></View>
            )}
          </View>
        ) : (
          <Text style={styles.pendingText}>{so ? "Weli lama eegin." : "Not yet reviewed."}</Text>
        )}
        {r?.review_notes ? (
          <View style={styles.revBlock}><Text style={styles.revLabel}>{so ? "Qoraalka eegista" : "Review notes"}</Text><Text style={styles.bodyText}>{r.review_notes}</Text></View>
        ) : null}
        {r?.corrected_interpretation ? (
          <View style={styles.revBlock}><Text style={styles.revLabel}>{so ? "Fasiraad la saxay" : "Corrected interpretation"}</Text><Text style={styles.bodyText}>{r.corrected_interpretation}</Text></View>
        ) : null}
        {r?.recommendation ? (
          <View style={styles.revBlock}><Text style={styles.revLabel}>{so ? "Talo" : "Recommendation"}</Text><Text style={styles.bodyText}>{r.recommendation}</Text></View>
        ) : null}
      </Card>
      {msgs.length > 0 && (
        <Card style={{ marginTop: 8 }}>
          <Text style={styles.revLabel}>{so ? "Fariimo" : "Messages"}</Text>
          {msgs.map((m) => (
            <View key={m.id} style={styles.msgRow}>
              <Ionicons name="chatbubble-ellipses-outline" size={14} color={colors.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={styles.bodyText}>{m.body}</Text>
                <Text style={styles.msgMeta}>{(m.author_role ?? "").replace(/_/g, " ")} · {new Date(m.created_at).toLocaleString()}</Text>
              </View>
            </View>
          ))}
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  needIntro: { ...t.bodySmall, marginBottom: spacing.sm },
  needItem: { ...t.body, color: colors.text, lineHeight: 21 },
  needBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm,
    backgroundColor: colors.gold, borderRadius: radius.lg,
    paddingVertical: spacing.md, marginTop: spacing.md,
  },
  needBtnText: { color: "#0B0B0C", fontWeight: "700", fontSize: 15 },
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, backgroundColor: colors.bg, padding: spacing.xl },
  errText: { ...t.body, textAlign: "center" },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  title: { ...t.title },
  subtitle: { ...t.caption, marginTop: 4, marginBottom: spacing.md },
  editBtn: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.goldSoft, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.goldBorder, marginTop: 2 },
  editBtnText: { ...t.caption, color: colors.gold, fontWeight: "700" },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.sm },
  badge: { backgroundColor: colors.surfaceSunken, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { ...t.caption, color: colors.textMuted, textTransform: "capitalize" },
  detailRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 4 },
  bodyText: { ...t.body, color: colors.text },
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  thumb: { width: 88, height: 88, borderRadius: radius.md, backgroundColor: colors.surfaceAlt },
  thumbPlaceholder: { alignItems: "center", justifyContent: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: { backgroundColor: colors.goldSoft, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.goldBorder },
  chipText: { ...t.bodySmall, color: colors.text },
  aiHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  reBtn: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.goldSoft, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.goldBorder },
  reBtnText: { ...t.caption, color: colors.gold, fontWeight: "700" },
  pendingText: { ...t.body, color: colors.textMuted, fontStyle: "italic" },
  conclHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  conclKind: { ...t.label, color: colors.gold },
  confPill: { backgroundColor: colors.goldSoft, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderColor: colors.goldBorder },
  confPillText: { ...t.caption, color: colors.gold, fontWeight: "700" },
  tag: { ...t.caption, color: colors.textFaint, marginTop: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  evBlock: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  evLabel: { ...t.caption, color: colors.success, fontWeight: "700", marginBottom: 3 },
  evItem: { ...t.bodySmall, color: colors.textMuted, marginBottom: 2 },
  evSrc: { color: colors.textFaint },
  traceNote: { ...t.caption, color: colors.textFaint, fontStyle: "italic", marginTop: spacing.md, textAlign: "center" },
  decisionRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  decisionText: { ...t.subheading, fontWeight: "800" },
  gConfPill: { marginLeft: "auto", backgroundColor: colors.goldSoft, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1, borderColor: colors.goldBorder },
  gConfText: { ...t.caption, color: colors.gold, fontWeight: "700" },
  revBlock: { marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  revLabel: { ...t.caption, color: colors.textFaint, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 },
  msgRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, marginTop: spacing.sm },
  msgMeta: { ...t.caption, color: colors.textFaint, marginTop: 2 },
  // Simple/Expert toggle
  modeToggle: { flexDirection: "row", backgroundColor: colors.surfaceSunken, borderRadius: radius.pill, padding: 3, marginBottom: spacing.sm, alignSelf: "flex-start" },
  modeBtn: { paddingHorizontal: 18, paddingVertical: 7, borderRadius: radius.pill },
  modeBtnOn: { backgroundColor: colors.gold },
  modeBtnTxt: { ...t.bodySmall, color: colors.textMuted, fontWeight: "700" },
  modeBtnTxtOn: { color: "#0B0B0C" },
  // Headline + opportunity
  headline: { ...t.subheading, fontWeight: "800", lineHeight: 22 },
  oppChip: { alignSelf: "flex-start", marginTop: spacing.sm, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 4 },
  oppChipTxt: { ...t.caption, fontWeight: "800" },
  // Confidence bar
  barCaption: { ...t.caption, color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.5 },
  barScale: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
  barScaleTxt: { fontSize: 10, color: colors.textFaint },
  barTrack: { height: 9, backgroundColor: colors.surfaceSunken, borderRadius: 999, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 999 },
  barFoot: { flexDirection: "row", justifyContent: "space-between", marginTop: 3 },
  barBand: { ...t.caption, fontWeight: "800" },
  barPct: { ...t.caption, color: colors.textMuted, fontWeight: "700" },
  // Exploration-potential metric (independent of identification confidence)
  potRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  potBox: { borderWidth: 2, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 6 },
  potTxt: { ...t.subheading, fontWeight: "800" },
  // Geological interpretation layer
  interpItem: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  interpLabel: { ...t.caption, color: colors.gold, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 },
  soLine: { color: colors.textMuted, marginTop: 3 },
  // 7-section report visuals
  repLead: { ...t.subheading, fontWeight: "700", lineHeight: 24 },
  starsTxt: { fontSize: 16, letterSpacing: 1 },
  meterRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  starsCol: { alignItems: "center" },
  meterPct: { ...t.subheading, fontWeight: "800", marginTop: 2 },
  whyBlock: { marginTop: spacing.md },
  whyH: { ...t.caption, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 },
  whyItem: { ...t.bodySmall, color: colors.textMuted, marginBottom: 3, lineHeight: 19 },
  minGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  minCard: { width: "100%", backgroundColor: colors.surfaceAlt, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 4, padding: spacing.md },
  minNameRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: 3 },
  minName: { ...t.subheading, fontWeight: "800" },
  critBadge: { borderWidth: 1, borderColor: colors.danger, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  critTxt: { fontSize: 8, fontWeight: "800", textTransform: "uppercase", color: colors.danger, letterSpacing: 0.3 },
  minImp: { ...t.bodySmall, color: colors.textMuted, lineHeight: 19 },
  potStarRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginBottom: 6 },
  repNote: { ...t.caption, color: colors.textFaint, fontStyle: "italic", marginBottom: 6 },
  // Epistemic badge on evidence rows
  evRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginBottom: 3 },
  epiBadge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, marginTop: 1 },
  epiTxt: { fontSize: 8, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3 },
  // Satellite location map
  satWrap: { position: "relative", borderRadius: radius.lg, overflow: "hidden", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
  satImg: { width: "100%", aspectRatio: 680 / 420 },
  satPin: { position: "absolute", top: "50%", left: "50%", width: 16, height: 16, marginTop: -14, marginLeft: -8, borderRadius: 8, backgroundColor: colors.gold, borderWidth: 2, borderColor: "#0B0B0C" },
  satFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.sm, marginBottom: spacing.sm },
  rowMetaSmall: { ...t.caption, color: colors.textMuted },
  satLink: { ...t.caption, color: colors.gold, fontWeight: "700" },
});

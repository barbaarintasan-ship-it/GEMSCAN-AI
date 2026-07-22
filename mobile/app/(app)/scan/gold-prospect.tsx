// Gold Prospect Evaluation screen (Gem Collector only).
//
// ADDITIVE + self-contained: it reuses the EXISTING scan result (host-rock
// label + confidence, read from the scans/scan_candidates rows this scan
// already wrote) and optional user answers, then runs the local rule-based
// engine in lib/goldProspect.ts. It makes NO AI/model calls, adds NO new
// tables or APIs, and never persists anything new.
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, TextInput, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { supabase } from "../../../lib/supabase";
import LocationMap from "../../../components/LocationMap";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { colors, spacing, radius } from "../../../lib/theme";
import {
  detectGoldHost,
  evaluateGoldProspect,
  categoryLabel,
  economicLabel,
  categoryColor,
  EMPTY_ANSWERS,
  type GoldProspectAnswers,
  type GoldProspectReport,
  type FoundContext,
  type NearbyDensity,
  type Observation,
} from "../../../lib/goldProspect";
import { regionalGeologyContext, geologyByPlace, type GeologyContext } from "../../../lib/goldGeology";
import { generateAndShareGoldProspectPdf } from "../../../lib/goldProspectPdfReport";

export default function GoldProspectScreen() {
  const { scanId } = useLocalSearchParams<{ scanId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { i18n } = useTranslation();
  const so = i18n.language === "so";
  const L = (en: string, soT: string) => (so ? soT : en);

  const [loading, setLoading] = useState(true);
  const [labels, setLabels] = useState<string[]>([]);
  const [confidencePct, setConfidencePct] = useState(0);
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [createdAt, setCreatedAt] = useState<string>("");
  const [answers, setAnswers] = useState<GoldProspectAnswers>(EMPTY_ANSWERS);
  const [report, setReport] = useState<GoldProspectReport | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    if (!scanId) return;
    let active = true;
    (async () => {
      const [{ data: scanRow }, { data: cands }] = await Promise.all([
        supabase.from("scans").select("final_result, capture_location, created_at").eq("id", scanId).maybeSingle(),
        supabase.from("scan_candidates").select("label, rank").eq("scan_id", scanId).order("rank", { ascending: true }),
      ]);
      if (!active) return;
      const fr = (scanRow as { final_result?: { bestMatch?: string | null; confidenceScore?: number } } | null)?.final_result;
      const candLabels = ((cands as { label: string }[] | null) ?? []).map((c) => c.label);
      const all = [fr?.bestMatch ?? "", ...candLabels].filter(Boolean);
      setLabels(all);
      setConfidencePct(Math.round((fr?.confidenceScore ?? 0) * 100));
      const loc = (scanRow as { capture_location?: { lat?: number; lng?: number } | null } | null)?.capture_location;
      setLocation(loc && typeof loc.lat === "number" && typeof loc.lng === "number" ? { lat: loc.lat, lng: loc.lng } : null);
      setCreatedAt((scanRow as { created_at?: string } | null)?.created_at ?? new Date().toISOString());
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [scanId]);

  const host = useMemo(() => detectGoldHost(labels), [labels]);

  // Regional geology (source-backed, honest — see lib/goldGeology). GPS is the
  // primary source; if there is no GPS fix we fall back to the manually typed
  // country. If neither is available it stays null → an informative empty state.
  const geology: GeologyContext | null = useMemo(() => {
    if (location) return regionalGeologyContext(location.lat, location.lng, L, so);
    return geologyByPlace({ country: answers.country, region: answers.region, district: answers.district }, L, so);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, answers.country, answers.region, answers.district, so]);

  // Download / share the professional Gold Prospect PDF (Part 5). Pure local
  // render — no AI, no network beyond the OS share sheet.
  async function downloadPdf(r: GoldProspectReport) {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      await generateAndShareGoldProspectPdf(
        {
          scanId: scanId ?? null,
          createdAt: createdAt || new Date().toISOString(),
          hostRock: r.hostRock,
          hostConfidencePct: r.hostConfidencePct,
          environment: r.environment,
          score: r.score,
          categoryLabel: categoryLabel(r.category, so),
          economicLabel: economicLabel(r.economic, so),
          categoryColor: categoryColor(r.category),
          evidenceFor: r.evidenceFor,
          evidenceAgainst: r.evidenceAgainst,
          nextSteps: r.nextSteps,
          regionalGeology: geology ? { line: geology.line, source: geology.source, favorable: geology.favorable } : null,
          location: location ? { lat: location.lat, lng: location.lng, label: geology?.locationLabel ?? null } : null,
        },
        so ? "so" : "en",
      );
    } catch {
      Alert.alert(
        L("Could not create PDF", "PDF lama abuuri karo"),
        L("Please try again.", "Fadlan isku day mar kale."),
      );
    } finally {
      setPdfBusy(false);
    }
  }

  function toggleObservation(o: Observation) {
    setAnswers((a) => ({
      ...a,
      observations: a.observations.includes(o) ? a.observations.filter((x) => x !== o) : [...a.observations, o],
    }));
  }

  function generate() {
    setReport(
      evaluateGoldProspect(
        {
          labels,
          confidencePct,
          answers,
          geology: geology ? { favorable: geology.favorable, documentedNearby: geology.documentedNearby } : undefined,
        },
        L,
      ),
    );
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.gold} size="large" />
      </View>
    );
  }

  // Should never really happen (the entry card only shows for gold hosts), but
  // guards against a direct navigation to a non-applicable scan.
  if (!host) {
    return (
      <View style={styles.centered}>
        <Ionicons name="earth-outline" size={44} color={colors.textFaint} />
        <Text style={styles.emptyTitle}>{L("No gold-associated host rock", "Dhagax dahab lama helin")}</Text>
        <Text style={[styles.body, { textAlign: "center" }]}>
          {L(
            "This specimen isn't one of the common gold host rocks (e.g. quartz vein, pyrite, greenstone). Gold Prospect Evaluation applies to gold-associated hosts only.",
            "Shaygani maaha mid ka mid ah dhagxaanta caadiga ah ee dahabka (tusaale quartz vein, pyrite, greenstone). Qiimaynta Rajada Dahabka waxay khusaysaa dhagxaanta dahab-la-xiriira oo keliya.",
          )}
        </Text>
        <Button title={L("Back to results", "Ku noqo natiijada")} variant="outline" onPress={() => router.back()} />
      </View>
    );
  }

  // ── Report view ──────────────────────────────────────────────────────────
  if (report) {
    return (
      <ScrollView contentContainerStyle={[styles.container, { paddingBottom: 32 + insets.bottom }]}>
        <View style={styles.headerRow}>
          <Ionicons name="earth" size={20} color={colors.gold} />
          <Text style={styles.h1}>{L("Gold Prospect Report", "Warbixinta Rajada Dahabka")}</Text>
        </View>

        {/* Host Rock */}
        <Card style={styles.card}>
          <SectionTitle icon="layers-outline" text={L("Host Rock", "Dhagaxa Martida")} />
          <Text style={styles.hostRock}>{report.hostRock}</Text>
          <Text style={styles.kv}>
            {L("Identification confidence", "Kalsoonida aqoonsiga")}: <Text style={styles.kvStrong}>{report.hostConfidencePct}%</Text>
          </Text>
          <Text style={styles.body}>{report.environment}</Text>
        </Card>

        {/* Gold Prospect Score */}
        <Card accent style={styles.card}>
          <SectionTitle icon="speedometer-outline" text={L("Gold Prospect Score", "Dhibcaha Rajada Dahabka")} />
          <View style={styles.scoreRow}>
            <Text style={[styles.scoreNum, { color: categoryColor(report.category) }]}>{report.score}</Text>
            <Text style={styles.scoreMax}>/100</Text>
            <View style={[styles.catPill, { backgroundColor: categoryColor(report.category) }]}>
              <Text style={styles.catPillText}>{categoryLabel(report.category, so)}</Text>
            </View>
          </View>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${report.score}%`, backgroundColor: categoryColor(report.category) }]} />
          </View>
          <Text style={styles.note}>
            {L(
              "This is an EXPLORATION score only — it does not confirm gold is present.",
              "Kani waa dhibco SAHAMIN oo keliya — ma xaqiijiyo in dahab jiro.",
            )}
          </Text>
        </Card>

        {/* Evidence For */}
        {report.evidenceFor.length > 0 && (
          <Card style={styles.card}>
            <SectionTitle icon="trending-up-outline" text={L("Evidence Supporting Gold Potential", "Caddaynta Taageeraysa")} color="#2E9E4F" />
            {report.evidenceFor.map((e) => (
              <View key={e} style={styles.evRow}>
                <Ionicons name="checkmark-circle" size={15} color="#2E9E4F" />
                <Text style={styles.evText}>{e}</Text>
              </View>
            ))}
          </Card>
        )}

        {/* Evidence Against */}
        {report.evidenceAgainst.length > 0 && (
          <Card style={styles.card}>
            <SectionTitle icon="trending-down-outline" text={L("Evidence Against Gold Potential", "Caddaynta Ka Soo Horjeedda")} color="#E4685D" />
            {report.evidenceAgainst.map((e) => (
              <View key={e} style={styles.evRow}>
                <Ionicons name="remove-circle" size={15} color="#E4685D" />
                <Text style={styles.evText}>{e}</Text>
              </View>
            ))}
          </Card>
        )}

        {/* Recommended Next Steps */}
        <Card style={styles.card}>
          <SectionTitle icon="list-outline" text={L("Recommended Next Steps", "Tallaabooyinka Xiga ee La Talinayo")} />
          {report.nextSteps.map((s, i) => (
            <View key={s} style={styles.evRow}>
              <Text style={styles.stepNum}>{i + 1}.</Text>
              <Text style={styles.evText}>{s}</Text>
            </View>
          ))}
        </Card>

        {/* Economic Potential */}
        <Card accent style={styles.card}>
          <SectionTitle icon="cash-outline" text={L("Economic Potential", "Suurtagalnimada Dhaqaale")} />
          <Text style={[styles.econ, { color: categoryColor(report.category) }]}>{economicLabel(report.economic, so)}</Text>
          <Text style={styles.note}>
            {L(
              "This does NOT indicate that recoverable gold exists. Only field sampling, drilling and laboratory analysis can determine whether an economic gold deposit is present.",
              "Tani MA muujinayso in dahab la soo saari karo uu jiro. Kaliya muunad-qaadis goob, qodid iyo falanqayn shaybaar ayaa go'aamin kara in kayd dahab oo dhaqaale ah jiro.",
            )}
          </Text>
        </Card>

        {/* Regional Geology (GPS primary, manual fallback; honest, source-backed) */}
        {geology ? (
          <Card style={styles.card}>
            <SectionTitle
              icon="map-outline"
              text={L("Regional Geology", "Geology-ga Gobolka")}
              color={geology.favorable ? "#2E9E4F" : colors.gold}
            />
            <View style={styles.chipRowInline}>
              <StatusChip
                text={geology.resolvedBy === "gps" ? L("GPS location", "Goob GPS") : L("Entered location", "Goob la geliyay")}
                icon={geology.resolvedBy === "gps" ? "navigate" : "create"}
              />
              {geology.favorable && (
                <StatusChip text={L("Documented province", "Gobol la diiwaangeliyay")} icon="checkmark-circle" tone="good" />
              )}
            </View>
            <View style={styles.evRow}>
              <Ionicons
                name={geology.favorable ? "checkmark-circle" : "information-circle"}
                size={15}
                color={geology.favorable ? "#2E9E4F" : colors.textFaint}
              />
              <Text style={styles.evText}>{geology.line}</Text>
            </View>
            <Text style={styles.note}>
              {L("Source", "Isha")}: {geology.source}
            </Text>
          </Card>
        ) : (
          <Card style={styles.card}>
            <SectionTitle icon="map-outline" text={L("Regional Geology", "Geology-ga Gobolka")} />
            <View style={styles.emptyRow}>
              <Ionicons name="location-outline" size={18} color={colors.textFaint} />
              <Text style={styles.evText}>
                {L(
                  "Add your location to receive regional geological insights — enter a country under 'Edit answers', or scan again with GPS enabled.",
                  "Ku dar goobtaada si aad u hesho aragtida juqraafi ee gobolka — geli wadan 'Wax ka beddel jawaabaha', ama dib u scan garee GPS oo shaqaynaya.",
                )}
              </Text>
            </View>
          </Card>
        )}

        {/* Map */}
        {location && (
          <Card style={styles.card}>
            <SectionTitle icon="location-outline" text={L("Specimen Found Here", "Halkan ayaa Shayga laga Helay")} />
            <LocationMap markers={[{ lat: location.lat, lng: location.lng, title: report.hostRock }]} height={190} zoom={13} />
            <Text style={styles.note}>{L("Location does not estimate underground gold.", "Goobtu ma qiyaaso dahab dhulka hoostiisa ah.")}</Text>
          </Card>
        )}

        {/* Disclaimer (rule-based Geological Prospect Assessment — not AI) */}
        <View style={styles.disclaimerBox}>
          <Ionicons name="shield-checkmark-outline" size={16} color={colors.textFaint} />
          <Text style={styles.disclaimer}>
            {L(
              "Geological Prospect Assessment — a geological interpretation based on mineral identification, regional geology and established geological rules. It does NOT confirm the existence of gold. Economic viability can only be determined through professional geological exploration.",
              "Qiimayn Rajo Juqraafi — fasiraad juqraafi oo ku salaysan aqoonsiga macdanta, geology-ga gobolka iyo qawaaniinta juqraafi ee la aasaasay. MA xaqiijiso jiritaanka dahabka. Suurtagalnimada dhaqaale waxaa kaliya go'aamin kara sahamin juqraafi oo xirfad leh.",
            )}
          </Text>
        </View>

        <Button
          title={pdfBusy ? L("Preparing PDF…", "PDF diyaarinaya…") : L("Download PDF report", "Soo deji warbixinta PDF")}
          variant="primary"
          loading={pdfBusy}
          icon={<Ionicons name="download-outline" size={18} color="#0B0B0C" />}
          onPress={() => downloadPdf(report)}
          style={{ marginTop: spacing.md }}
        />
        <Button
          title={L("Edit answers", "Wax ka beddel jawaabaha")}
          variant="outline"
          icon={<Ionicons name="create-outline" size={16} color={colors.gold} />}
          onPress={() => setReport(null)}
          style={{ marginTop: spacing.sm }}
        />
      </ScrollView>
    );
  }

  // ── Questions view ───────────────────────────────────────────────────────
  const foundOpts: { key: FoundContext; label: string }[] = [
    { key: "river", label: L("River", "Webi") },
    { key: "mountain", label: L("Mountain", "Buur") },
    { key: "old_mine", label: L("Old mine", "Macdan hore") },
    { key: "quartz_vein", label: L("Quartz vein", "Xidid quartz") },
    { key: "loose_surface", label: L("Loose surface rock", "Dhagax dul-yaal") },
    { key: "unknown", label: L("Unknown", "Lama garanayo") },
  ];
  const densityOpts: { key: NearbyDensity; label: string }[] = [
    { key: "many", label: L("Many", "Badan") },
    { key: "few", label: L("Few", "Yar") },
    { key: "one", label: L("Only one", "Hal keliya") },
    { key: "unknown", label: L("Unknown", "Lama garanayo") },
  ];
  const obsOpts: { key: Observation; label: string }[] = [
    { key: "quartz_veins", label: L("Quartz veins", "Xididada quartz") },
    { key: "rust_staining", label: L("Rust staining", "Wasakh miri ah") },
    { key: "black_sulfides", label: L("Black sulfides", "Sulfide madow") },
    { key: "metallic_particles", label: L("Metallic particles", "Walxo bir ah") },
    { key: "heavy_minerals", label: L("Heavy minerals", "Macdano culus") },
  ];

  return (
    <ScrollView contentContainerStyle={[styles.container, { paddingBottom: 32 + insets.bottom }]}>
      <View style={styles.headerRow}>
        <Ionicons name="earth" size={20} color={colors.gold} />
        <Text style={styles.h1}>{L("Gold Prospect Evaluation", "Qiimaynta Rajada Dahabka")}</Text>
      </View>
      <Text style={styles.body}>
        {L(
          `Detected host rock: ${host.label}. Answer a few optional questions to refine the exploration score. All fields are optional.`,
          `Dhagaxa martida la helay: ${host.label}. Ka jawaab su'aalo dhawr ah oo ikhtiyaari ah si aad u saxdo dhibcaha. Dhammaan ikhtiyaari.`,
        )}
      </Text>

      <Card style={styles.card}>
        <SectionTitle icon="location-outline" text={L("Where was it found?", "Xaggee laga helay?")} />
        <Text style={styles.note}>
          {L(
            "Used for regional geology when GPS isn't available.",
            "Loo isticmaalo geology-ga gobolka marka GPS la'aan.",
          )}
        </Text>
        <LabeledInput label={L("Country", "Wadan")} value={answers.country ?? ""} onChangeText={(t) => setAnswers((a) => ({ ...a, country: t }))} />
        <LabeledInput label={L("Region / State", "Gobol")} value={answers.region ?? ""} onChangeText={(t) => setAnswers((a) => ({ ...a, region: t }))} />
        <LabeledInput label={L("District", "Degmo")} value={answers.district ?? ""} onChangeText={(t) => setAnswers((a) => ({ ...a, district: t }))} />
      </Card>

      <Card style={styles.card}>
        <SectionTitle icon="trail-sign-outline" text={L("Found at", "Meesha laga helay")} />
        <ChipRow options={foundOpts} selected={[answers.foundContext]} onPress={(k) => setAnswers((a) => ({ ...a, foundContext: k as FoundContext }))} />
      </Card>

      <Card style={styles.card}>
        <SectionTitle icon="copy-outline" text={L("Similar rocks nearby?", "Dhagxaan la mid ah oo u dhow?")} />
        <ChipRow options={densityOpts} selected={[answers.nearbyDensity]} onPress={(k) => setAnswers((a) => ({ ...a, nearbyDensity: k as NearbyDensity }))} />
      </Card>

      <Card style={styles.card}>
        <SectionTitle icon="eye-outline" text={L("What did you observe? (select any)", "Maxaad aragtay? (dooro mid kasta)")} />
        <ChipRow options={obsOpts} selected={answers.observations} onPress={(k) => toggleObservation(k as Observation)} multi />
      </Card>

      <Button
        title={L("Generate Report", "Samee Warbixinta")}
        variant="primary"
        icon={<Ionicons name="analytics-outline" size={18} color="#0B0B0C" />}
        onPress={generate}
        style={{ marginTop: spacing.sm }}
      />
    </ScrollView>
  );
}

function SectionTitle({ icon, text, color }: { icon: keyof typeof Ionicons.glyphMap; text: string; color?: string }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Ionicons name={icon} size={16} color={color ?? colors.gold} />
      <Text style={[styles.sectionTitle, color ? { color } : null]}>{text}</Text>
    </View>
  );
}

// Small professional status chip (Part 7 polish) — a labeled pill used to tag
// how a section's data was resolved (GPS vs typed) or its status.
function StatusChip({
  text,
  icon,
  tone,
}: {
  text: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone?: "good" | "neutral";
}) {
  const good = tone === "good";
  return (
    <View style={[styles.statusChip, good && styles.statusChipGood]}>
      <Ionicons name={icon} size={12} color={good ? "#2E9E4F" : colors.textFaint} />
      <Text style={[styles.statusChipText, good && { color: "#2E9E4F" }]}>{text}</Text>
    </View>
  );
}

function LabeledInput({ label, value, onChangeText }: { label: string; value: string; onChangeText: (t: string) => void }) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput style={styles.input} value={value} onChangeText={onChangeText} placeholderTextColor={colors.textFaint} />
    </View>
  );
}

function ChipRow({
  options,
  selected,
  onPress,
  multi,
}: {
  options: { key: string; label: string }[];
  selected: string[];
  onPress: (key: string) => void;
  multi?: boolean;
}) {
  return (
    <View style={styles.chipWrap}>
      {options.map((o) => {
        const active = selected.includes(o.key);
        return (
          <Pressable key={o.key} style={[styles.chip, active && styles.chipActive]} onPress={() => onPress(o.key)}>
            {multi && <Ionicons name={active ? "checkbox" : "square-outline"} size={13} color={active ? "#0B0B0C" : colors.textFaint} />}
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 18, gap: 12, backgroundColor: colors.bg, flexGrow: 1 },
  centered: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 28, gap: 14 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  h1: { fontSize: 20, fontWeight: "800", color: colors.text, flexShrink: 1 },
  card: { gap: 8 },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  sectionTitle: { fontSize: 15, fontWeight: "800", color: colors.gold },
  hostRock: { fontSize: 22, fontWeight: "800", color: colors.text },
  kv: { fontSize: 13.5, color: colors.textFaint },
  kvStrong: { color: colors.text, fontWeight: "700" },
  body: { fontSize: 14, color: "#C9C9CC", lineHeight: 20 },
  note: { fontSize: 12, color: colors.textFaint, lineHeight: 17, marginTop: 2 },
  scoreRow: { flexDirection: "row", alignItems: "flex-end", gap: 6, flexWrap: "wrap" },
  scoreNum: { fontSize: 40, fontWeight: "900", lineHeight: 42 },
  scoreMax: { fontSize: 16, color: colors.textFaint, fontWeight: "700", marginBottom: 5 },
  catPill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4, marginLeft: "auto", marginBottom: 6 },
  catPillText: { color: "#0B0B0C", fontWeight: "900", fontSize: 12 },
  barTrack: { height: 10, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.12)", overflow: "hidden", marginTop: 6 },
  barFill: { height: 10, borderRadius: 999 },
  evRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  emptyRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  emptyTitle: { fontSize: 17, fontWeight: "800", color: colors.text, textAlign: "center" },
  chipRowInline: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 2 },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  statusChipGood: { borderColor: "rgba(46,158,79,0.5)", backgroundColor: "rgba(46,158,79,0.12)" },
  statusChipText: { fontSize: 11, color: colors.textFaint, fontWeight: "700" },
  evText: { flex: 1, fontSize: 13.5, color: "#D6D6D9", lineHeight: 19 },
  stepNum: { color: colors.gold, fontWeight: "800", fontSize: 13.5, width: 18 },
  econ: { fontSize: 18, fontWeight: "800" },
  disclaimerBox: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: radius.md,
    padding: 12,
    marginTop: 4,
  },
  disclaimer: { flex: 1, fontSize: 11.5, color: colors.textFaint, lineHeight: 16 },
  inputGroup: { gap: 4 },
  inputLabel: { fontSize: 12, color: colors.textFaint, fontWeight: "600" },
  input: { backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: 14 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: colors.gold, borderColor: colors.gold },
  chipText: { fontSize: 13, color: "#D6D6D9", fontWeight: "600" },
  chipTextActive: { color: "#0B0B0C", fontWeight: "800" },
});

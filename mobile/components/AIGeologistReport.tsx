// The AI geologist's report, in the reader's own language.
//
// Every line here is rendered from the language-free findings by `renderReport`,
// so switching between Somali and English is a re-render with no model call, no
// network and no waiting — and the two versions cannot disagree about the geology,
// because they are two renderings of one set of codes.
//
// The language follows the app by default and can be overridden per report,
// because a Somali geologist writing up for an English-speaking client needs both
// and should not have to change the whole app to get them.
//
// WHAT IS SHOWN WHEN THERE IS NO REPORT
//
// The states before an assessment are not blank. "Waiting to upload" and "waiting
// for analysis" are real positions in the workflow, and a geologist who has just
// finished a section on a mountain needs to be told their evidence is safe rather
// than shown an empty panel.
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../lib/theme";
import { renderReport, type ReportLanguage } from "../../shared/geo-core/gie/renderReport";
import type { MissionFindings } from "../../shared/geo-core/gie/missionFindings";
import type { Mission } from "../lib/exploration/mission";
import type { TFunc } from "../lib/exploration/format";

export function AIGeologistReport({
  mission, findings, prospectivityScore, photosPending, analysisError, appLanguage, t,
}: {
  mission: Mission;
  /** Null until the assessment comes back. */
  findings: MissionFindings | null;
  /**
   * Why it did NOT come back, when the server said so.
   *
   * This screen used to infer failure from `mission_closed`, which is a different
   * fact entirely — a geologist can close a mission that is analysing perfectly
   * well, and one that genuinely failed while still open read as "waiting" for
   * ever. The reason is shown, not just the state: "analysis failed" with nothing
   * after it is a dead end for someone standing on a mountain.
   */
  analysisError?: string | null;
  /** The ENGINE's score. The analysis never carries one. */
  prospectivityScore: number;
  /** Photographs still on their way to storage — analysis waits for them. */
  photosPending: number;
  appLanguage: ReportLanguage;
  t: TFunc;
}) {
  // Defaults to the app's language; the reader can switch this report alone.
  const [language, setLanguage] = React.useState<ReportLanguage | null>(null);
  const lang = language ?? appLanguage;

  const report = React.useMemo(
    () => (findings ? renderReport(findings, t, lang, { prospectivityScore }) : null),
    [findings, lang, prospectivityScore, t],
  );

  return (
    <View style={styles.wrap}>
      {/* Language first: a reader who cannot read the report needs the switch
          before the text, not after it. */}
      {findings ? (
        <View style={styles.langRow}>
          <Text style={styles.langLabel}>{t("report.language")}</Text>
          <LangChip label="English" active={lang === "en"} onPress={() => setLanguage("en")} />
          <LangChip label="Soomaali" active={lang === "so"} onPress={() => setLanguage("so")} />
        </View>
      ) : null}

      {report == null ? (
        // Order matters: photographs still uploading is the commonest reason and
        // resolves itself; a recorded failure is the one that needs a person.
        photosPending > 0 ? (
          <Text style={styles.waiting}>
            {t("report.blockedPhotos", { count: photosPending })}
          </Text>
        ) : analysisError ? (
          <View style={styles.failed}>
            <Text style={styles.failedTitle}>{t("report.failed")}</Text>
            <Text style={styles.failedReason}>{analysisError}</Text>
            <Text style={styles.failedNote}>{t("report.failedNote")}</Text>
          </View>
        ) : (
          <Text style={styles.waiting}>{t("report.pending")}</Text>
        )
      ) : (
        report.sections.map((s) => (
          <View key={s.titleKey} style={styles.section}>
            <Text style={styles.sectionTitle}>{s.title}</Text>
            {s.lines.map((line, i) => (
              <Text key={`${s.titleKey}-${i}`} style={styles.line}>{line}</Text>
            ))}
          </View>
        ))
      )}
    </View>
  );
}

function LangChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.langChip, active && styles.langChipActive]}
      hitSlop={6}
    >
      <Text style={[styles.langChipText, active && styles.langChipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.md, gap: spacing.sm,
  },
  langRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  langLabel: { color: colors.textMuted, fontSize: 11, marginRight: 2 },
  langChip: {
    paddingHorizontal: spacing.sm, paddingVertical: 4,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
  },
  langChipActive: { borderColor: colors.gold, backgroundColor: "rgba(212,175,55,0.14)" },
  langChipText: { color: colors.textMuted, fontSize: 11 },
  langChipTextActive: { color: colors.gold, fontWeight: "700" },
  section: { gap: 2, marginTop: spacing.xs },
  sectionTitle: {
    color: colors.gold, fontSize: 11, fontWeight: "800", letterSpacing: 0.6,
  },
  line: { color: colors.text, fontSize: 13, lineHeight: 19 },
  waiting: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  failed: {
    borderWidth: 1, borderColor: "#EF4444", borderRadius: radius.md,
    backgroundColor: "rgba(239,68,68,0.10)", padding: spacing.sm, gap: 4,
  },
  failedTitle: { color: "#FCA5A5", fontSize: 12, fontWeight: "800", letterSpacing: 0.4 },
  // The server's own words. Verbatim, because a paraphrase of a failure is a
  // second thing that can be wrong.
  failedReason: { color: colors.text, fontSize: 12, lineHeight: 18 },
  failedNote: { color: colors.textFaint, fontSize: 11, lineHeight: 16 },
});

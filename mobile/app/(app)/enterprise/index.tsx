// Enterprise Field Work — where the two workflows are told apart.
//
// This screen exists because one entry point was doing the work of two. "Field
// Samples" led to a single list that held a geologist's personal specimens and,
// had the exploration path ever written one, a mission's evidence beside them —
// with nothing on screen or in the schema saying which was which.
//
// They are different questions:
//
//   MY SAMPLES          "what is this rock?"      — a specimen, identified
//   EXPLORATION REPORTS "what is this ground?"    — a place, investigated
//
// The separation is not presentational. A personal sample never meets the spatial
// providers, never receives a prospectivity reading, and never carries an
// exploration target. That is enforced in the database (`sample.origin`) and in
// the analysis (`buildKnowledgeProviders`); this screen is where it becomes
// visible to the person using it.
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius, spacing } from "../../../lib/theme";

export default function EnterpriseFieldWorkScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{t("fieldWork.title")}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* ── 1. The primary action ──────────────────────────────────────────
            First and largest, because it is the thing this app is for. Going out
            and looking is what produces everything on the other two cards. */}
        <Pressable
          style={styles.primary}
          onPress={() => router.push("/(app)/explore")}
          accessibilityRole="button"
        >
          <View style={styles.primaryIcon}>
            <Ionicons name="navigate" size={26} color="#0B0B0C" />
          </View>
          <View style={styles.primaryText}>
            <Text style={styles.primaryTitle}>{t("fieldWork.start.title")}</Text>
            <Text style={styles.primaryBody}>{t("fieldWork.start.body")}</Text>
          </View>
        </Pressable>

        {/* ── 2. What came back from going out ─────────────────────────────── */}
        <Card
          icon="document-text-outline"
          title={t("fieldWork.reports.title")}
          body={t("fieldWork.reports.body")}
          onPress={() => router.push("/(app)/enterprise/reports")}
        />

        {/* ── 3. The personal collection ────────────────────────────────────
            Deliberately last and deliberately separate. A bag of rocks is a
            record of what was picked up, not an assessment of anywhere. */}
        <Card
          icon="cube-outline"
          title={t("fieldWork.samples.title")}
          body={t("fieldWork.samples.body")}
          onPress={() => router.push("/(app)/enterprise/samples")}
        />

        {/* THE EMPTY HALF OF THIS SCREEN, filled with the thing a first-time
            user actually needs: what the three buttons above are for, and in
            what order. A dashboard that offers three doors and explains none of
            them makes the reader guess, and guessing wrong here means walking
            somewhere for nothing. */}
        <View style={styles.guide}>
          <Text style={styles.guideTitle}>{t("fieldWork.guide.title")}</Text>

          <Step n="1" title={t("fieldWork.guide.s1.title")} body={t("fieldWork.guide.s1.body")} />
          <Step n="2" title={t("fieldWork.guide.s2.title")} body={t("fieldWork.guide.s2.body")} />
          <Step n="3" title={t("fieldWork.guide.s3.title")} body={t("fieldWork.guide.s3.body")} />
          <Step n="4" title={t("fieldWork.guide.s4.title")} body={t("fieldWork.guide.s4.body")} />

          <Text style={styles.guideNote}>{t("fieldWork.guide.offline")}</Text>
        </View>

        <Text style={styles.footnote}>{t("fieldWork.footnote")}</Text>
      </ScrollView>
    </View>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}><Text style={styles.stepNumText}>{n}</Text></View>
      <View style={styles.stepText}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.stepBody}>{body}</Text>
      </View>
    </View>
  );
}

function Card({
  icon, title, body, onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string; body: string; onPress: () => void;
}) {
  return (
    <Pressable style={styles.card} onPress={onPress} accessibilityRole="button">
      <View style={styles.cardIcon}>
        <Ionicons name={icon} size={22} color={colors.gold} />
      </View>
      <View style={styles.cardText}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardBody}>{body}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },
  body: { padding: spacing.md, gap: spacing.md },

  primary: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    backgroundColor: colors.gold, borderRadius: radius.lg, padding: spacing.lg,
  },
  primaryIcon: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: "rgba(0,0,0,0.14)", alignItems: "center", justifyContent: "center",
  },
  primaryText: { flex: 1, gap: 3 },
  primaryTitle: { color: "#0B0B0C", fontSize: 17, fontWeight: "800", letterSpacing: 0.3 },
  primaryBody: { color: "rgba(11,11,12,0.72)", fontSize: 12, lineHeight: 17 },

  card: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: spacing.md,
  },
  cardIcon: {
    width: 40, height: 40, borderRadius: 20,
    borderWidth: 1, borderColor: colors.goldBorder,
    alignItems: "center", justifyContent: "center",
  },
  cardText: { flex: 1, gap: 3 },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  cardBody: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },

  guide: {
    borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg,
    padding: spacing.md, gap: spacing.md, marginTop: spacing.xs,
  },
  guideTitle: {
    color: colors.gold, fontSize: 11, fontWeight: "800", letterSpacing: 0.6,
  },
  step: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  stepNum: {
    width: 22, height: 22, borderRadius: 11, marginTop: 1,
    borderWidth: 1, borderColor: colors.goldBorder,
    alignItems: "center", justifyContent: "center",
  },
  stepNumText: { color: colors.gold, fontSize: 11, fontWeight: "800" },
  stepText: { flex: 1, gap: 2 },
  stepTitle: { color: colors.text, fontSize: 13, fontWeight: "700" },
  stepBody: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  guideNote: {
    color: colors.textFaint, fontSize: 11, lineHeight: 16,
    borderTopWidth: 1, borderTopColor: colors.borderSubtle, paddingTop: spacing.sm,
  },
  footnote: {
    color: colors.textFaint, fontSize: 11, lineHeight: 16,
    marginTop: spacing.xs, paddingHorizontal: spacing.xs,
  },
});

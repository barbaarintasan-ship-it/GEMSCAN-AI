// Manage Missions — a project manager's list of missions + create-mission
// entry point. Authorization is NOT pre-filtered here (that would require
// guessing the same predicate create_mission's RPC already enforces); anyone
// can open this screen, but only an actual project owner / org owner-admin
// can successfully create one — the RPC's rejection message is shown as-is.
import React, { useCallback, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, TextInput, Alert } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, spacing, radius } from "../../../lib/theme";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { SectionLabel } from "../../../components/ui/SectionLabel";
import {
  fetchMyMissions, fetchMyProjects, createProject, createMission,
  type MyMission, type MyProject,
} from "../../../lib/enterprise/missions";
import { fetchMyOrganizations } from "../../../lib/enterprise/team";

export default function ManagerMissionsScreen() {
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const so = i18n.language === "so";

  const [loading, setLoading] = useState(true);
  const [missions, setMissions] = useState<MyMission[]>([]);
  const [projects, setProjects] = useState<MyProject[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [missionName, setMissionName] = useState("");
  const [missionDesc, setMissionDesc] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mine, myProjects, orgs] = await Promise.all([
        fetchMyMissions(),
        fetchMyProjects(),
        fetchMyOrganizations().catch(() => []),
      ]);
      setMissions(mine);
      setProjects(myProjects);
      setOrgId(orgs[0]?.organization_id ?? null);
      if (myProjects.length > 0 && !selectedProject) setSelectedProject(myProjects[0].id);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleCreateProject() {
    if (!newProjectName.trim()) return;
    setBusy(true);
    try {
      const p = await createProject(newProjectName.trim(), orgId);
      setProjects((prev) => [...prev, p]);
      setSelectedProject(p.id);
      setNewProjectName("");
    } catch (err) {
      Alert.alert(so ? "Khalad" : "Error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateMission() {
    if (!selectedProject || !missionName.trim()) return;
    setBusy(true);
    try {
      const id = await createMission(selectedProject, missionName.trim(), missionDesc.trim() || undefined);
      setMissionName(""); setMissionDesc(""); setShowForm(false);
      await load();
      router.push(`/(app)/enterprise/manager-mission/${id}`);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      Alert.alert(
        so ? "Khalad" : "Error",
        /forbidden/i.test(msg)
          ? (so ? "Kaliya milkiilaha mashruuca ama admin-ka shirkadda ayaa mission abuuri kara." : "Only the project owner or an org admin can create a mission.")
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{so ? "Maamul Mission-nada" : "Manage Missions"}</Text>
      </View>

      {loading ? (
        <View style={styles.centerFill}><ActivityIndicator color={colors.gold} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {missions.length === 0 ? (
            <Text style={styles.emptyText}>
              {so ? "Weli ma jiraan mission-yo." : "No missions yet."}
            </Text>
          ) : null}
          {missions.map((m) => (
            <Pressable
              key={m.mission_id}
              style={styles.missionRow}
              onPress={() => router.push(`/(app)/enterprise/manager-mission/${m.mission_id}`)}
            >
              <View style={styles.missionRowText}>
                <Text style={styles.missionName}>{m.mission.name}</Text>
                <Text style={styles.missionStatus}>{m.mission.status}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </Pressable>
          ))}

          {!showForm ? (
            <Button
              title={so ? "+ Mission Cusub" : "+ New Mission"}
              variant="outline"
              onPress={() => setShowForm(true)}
              style={styles.newButton}
            />
          ) : (
            <Card style={styles.formCard}>
              <SectionLabel>{so ? "Mashruuc" : "Project"}</SectionLabel>
              {projects.length === 0 ? (
                <View style={styles.row}>
                  <TextInput
                    style={styles.input}
                    placeholder={so ? "Magaca mashruuca cusub" : "New project name"}
                    placeholderTextColor={colors.textFaint}
                    value={newProjectName}
                    onChangeText={setNewProjectName}
                  />
                  <Button title={so ? "Abuur" : "Create"} size="sm" loading={busy} onPress={handleCreateProject} />
                </View>
              ) : (
                <View style={styles.chips}>
                  {projects.map((p) => (
                    <Pressable
                      key={p.id}
                      style={[styles.chip, selectedProject === p.id && styles.chipActive]}
                      onPress={() => setSelectedProject(p.id)}
                    >
                      <Text style={[styles.chipText, selectedProject === p.id && styles.chipTextActive]}>{p.name}</Text>
                    </Pressable>
                  ))}
                </View>
              )}

              <SectionLabel>{so ? "Magaca Mission-ka" : "Mission name"}</SectionLabel>
              <TextInput
                style={styles.input}
                placeholder={so ? "tusaale: Sahamin G-07" : "e.g. Reconnaissance G-07"}
                placeholderTextColor={colors.textFaint}
                value={missionName}
                onChangeText={setMissionName}
              />
              <SectionLabel>{so ? "Sharaxaad (ikhtiyaari)" : "Description (optional)"}</SectionLabel>
              <TextInput
                style={[styles.input, styles.inputMultiline]}
                placeholder={so ? "Waxa mission-kan lagu doonayo..." : "What this mission is for..."}
                placeholderTextColor={colors.textFaint}
                value={missionDesc}
                onChangeText={setMissionDesc}
                multiline
              />
              <View style={styles.row}>
                <Button title={so ? "Jooji" : "Cancel"} variant="secondary" size="sm" onPress={() => setShowForm(false)} />
                <Button
                  title={so ? "Abuur Mission" : "Create Mission"}
                  size="sm"
                  loading={busy}
                  disabled={!selectedProject || !missionName.trim()}
                  onPress={handleCreateMission}
                />
              </View>
            </Card>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { color: colors.textMuted, fontSize: 13, textAlign: "center", marginBottom: spacing.md },
  body: { padding: spacing.md, gap: spacing.sm, paddingBottom: 40 },
  missionRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: colors.surfaceAlt, borderRadius: radius.lg, padding: spacing.md,
  },
  missionRowText: { gap: 2 },
  missionName: { color: colors.text, fontSize: 15, fontWeight: "700" },
  missionStatus: { color: colors.textFaint, fontSize: 12, textTransform: "capitalize" },
  newButton: { marginTop: spacing.sm },
  formCard: { gap: spacing.sm, marginTop: spacing.sm },
  row: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: 10, color: colors.text, fontSize: 14, flex: 1,
  },
  inputMultiline: { minHeight: 60, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill,
    paddingHorizontal: spacing.md, paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.goldSoft, borderColor: colors.goldBorder },
  chipText: { color: colors.textMuted, fontSize: 13 },
  chipTextActive: { color: colors.gold, fontWeight: "700" },
});

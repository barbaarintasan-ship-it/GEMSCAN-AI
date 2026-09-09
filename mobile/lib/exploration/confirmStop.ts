// Ask before discarding a field investigation that hasn't been filed.
//
// FOUND BUG: MapWorkspace.tsx's top-bar stop icon called `actions.stop`
// (orchestrator.stop()) straight through — no confirmation, no check for
// whether the geologist had arrived at / was investigating a target with
// nothing yet saved via `finishSection()`. orchestrator.stop() has no
// awareness of unfinished work; it tears down GPS and marks the session
// "ended", and whatever was recorded only in memory/the waypoint store for
// the OPEN mission is never assembled into an EvidencePackage. CONFIRMED on
// a real field test: a just-recorded Quartz-vein waypoint never appeared in
// Exploration Reports or the server after tapping stop mid-investigation.
//
// The fix is scoped to exactly that gap: `isOnSite()` (mission.ts) is the
// SAME guard `finishSection()` itself already uses to decide whether there
// is a package to build, so "should we ask?" and "is there something to
// lose?" can never disagree.
import { Alert } from "react-native";
import { isOnSite } from "./mission.ts";
import type { ExplorationSnapshot } from "./orchestrator.ts";

export interface ConfirmStopInput {
  snapshot: ExplorationSnapshot;
  finishSection: () => Promise<void>;
  stop: () => void;
  /**
   * The caller's own useTranslation().t, not the global i18n singleton —
   * this runs from inside MapWorkspace, which already has one. Reaching
   * past it for the singleton directly would pull the real i18next init
   * into every test that renders MapWorkspace, including ones that mock
   * react-i18next's `useTranslation` alone (see mount.test.tsx).
   */
  t: (key: string) => string;
}

/**
 * Ends the session — asking first if there is on-site work `finishSection()`
 * has not yet captured. With no mission open, or a mission that is only
 * navigating/already delivering (nothing left `isOnSite` would apply to),
 * this proceeds straight to `stop()`, exactly as before: the prompt only
 * ever appears when there is something it would otherwise discard.
 *
 * Resolves `true` when the session was actually ended — either there was
 * nothing on-site to lose, or the geologist chose Finish or Discard — and
 * `false` when Cancel or a dismiss left it running untouched. A caller that
 * must not proceed past "the session ended" (logout's Handover option is the
 * reason this return value exists: it must not close the lease or sign out
 * on a cancelled confirmation) checks this instead of assuming `stop()`
 * always ran.
 */
export async function confirmStopIfUnfinished(input: ConfirmStopInput): Promise<boolean> {
  const m = input.snapshot.mission;
  if (!m || !isOnSite(m.state)) {
    input.stop();
    return true;
  }

  const t = input.t;
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      t("field.stop.title"),
      t("field.stop.body"),
      [
        { text: t("field.stop.cancel"), style: "cancel", onPress: () => resolve(false) },
        {
          text: t("field.stop.finish"),
          onPress: () => {
            void (async () => {
              await input.finishSection();
              input.stop();
              resolve(true);
            })();
          },
        },
        {
          text: t("field.stop.discard"),
          style: "destructive",
          onPress: () => {
            input.stop();
            resolve(true);
          },
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

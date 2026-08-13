// What "log out" means while a geologist is 130 km from anywhere.
//
// THE POLICY, in one line: logging out revokes the ability to UPLOAD as you. It
// does not end the expedition, and it does not rewrite who collected what.
//
// Three intentions hide behind one button, and they need different answers:
//
//   "I am done for the day / protecting my account"
//       -> the account goes, the expedition continues. Detached Expedition.
//   "A colleague is taking over"
//       -> this walk must CLOSE so the next one opens under their name, or their
//          observations would be filed under yours.
//   "I tapped it by mistake"
//       -> nothing happens.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//
//   * It does not refuse. Logging out is a security action, and an app that
//     holds your account hostage because it is busy is worse than one that logs
//     out at an awkward moment.
//   * It does not end the expedition on your behalf. That was the Karkaar
//     failure in a different costume: an authentication event stopping field
//     work.
//   * It does not clear `collectedBy`. Records already taken belong to whoever
//     took them, and no account action may restate that.
//
// AND AN HONEST LIMIT: this does not protect the data on the device. The
// photographs, the traverse and the queue are all still here and readable by
// whoever holds the phone. If the concern is a phone being taken, logging out is
// not the answer — that is local encryption, which does not exist yet.
import { Alert } from "react-native";
// Translated, because the dialog appears inside an app the geologist may be
// running in Somali. It shipped English-only and would have said so in the
// field — a policy nobody can read is not a policy.
import i18n from "../i18n";
import { expeditionLease } from "./expeditionLease";

export interface FieldLogoutInput {
  /** The real sign-out. Always called on every path that proceeds. */
  signOut: () => Promise<void>;
  /** Ends the walk. Only called when the geologist chooses to hand over. */
  endExpedition?: () => void;
  /** How many records are waiting, so the dialog can be specific. */
  heldRecords?: number;
}

/**
 * Ask, then act.
 *
 * With no expedition open this is an ordinary sign-out, byte for byte what it
 * was before — which is the whole point of keeping Milestone 1 inside Expedition
 * Mode. Nothing outside it changes.
 */
export async function requestFieldLogout(input: FieldLogoutInput): Promise<void> {
  const store = expeditionLease();
  await store.load();

  if (!store.isOpen()) {
    await input.signOut();
    return;
  }

  const t = i18n.t.bind(i18n);
  const lease = store.get();
  const who = lease?.collectedBy?.email ?? t("field.logout.thisAccount");
  const held = input.heldRecords ?? 0;
  const heldLine = held > 0
    ? `\n\n${t("field.logout.held", { count: held, who })}`
    : "";

  await new Promise<void>((resolve) => {
    Alert.alert(
      t("field.logout.title"),
      t("field.logout.body") + heldLine,
      [
        { text: t("field.logout.cancel"), style: "cancel", onPress: () => resolve() },
        {
          // Handover. The walk closes so the next collector's observations are
          // never filed under the previous one's name.
          text: t("field.logout.handover"),
          onPress: () => {
            void (async () => {
              input.endExpedition?.();
              await store.close();
              await input.signOut();
              resolve();
            })();
          },
        },
        {
          text: t("field.logout.keepRecording"),
          style: "destructive",
          onPress: () => {
            void (async () => {
              // Detach BEFORE signing out: the auth state change arrives
              // immediately, and the router must already see a detached lease
              // rather than a bare null session.
              await store.detach();
              await input.signOut();
              resolve();
            })();
          },
        },
      ],
      { cancelable: true, onDismiss: () => resolve() },
    );
  });
}

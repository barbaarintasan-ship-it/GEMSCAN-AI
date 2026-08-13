// Which walk is running, readable from outside the workspace.
//
// The capture screen is pushed onto the ROOT stack, not into the explore layout,
// so it cannot read the exploration context — and it is the one screen that most
// needs to know which expedition a sample belongs to. A sample taken during a
// traverse is part of that traverse; one taken from the collection screen is not.
//
// A module slot rather than a provider, for the same reason lib/captureHandoff is
// one: the two screens are in different navigation subtrees, and threading a
// context through the root layout to join them would put the whole exploration
// engine above every screen in the app.
//
// Written only by the workspace (see useExpeditionSync), read by anyone.

let sessionId: string | null = null;

export function setCurrentExpedition(id: string | null): void {
  sessionId = id;
}

/** The running expedition, or null when no session is open. */
export function currentExpeditionSessionId(): string | null {
  return sessionId;
}

/**
 * The mission being walked, when there is one.
 *
 * Kept beside the session id and for the same reason: the capture screen sits on
 * the root stack and cannot read the exploration context, but a sample taken on a
 * mission belongs to that mission, and nothing else on that screen can say so.
 *
 * A session can contain SEVERAL missions, so this is not derivable from the
 * session id — that was the defect that once attached one target's rock to
 * another target's package.
 */
let missionId: string | null = null;

export function setCurrentMission(id: string | null): void {
  missionId = id;
}

/** The running mission, or null between missions and outside a session. */
export function currentMissionId(): string | null {
  return missionId;
}

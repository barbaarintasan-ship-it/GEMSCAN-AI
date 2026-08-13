// Who is signed in, readable without the auth context.
//
// A module slot, for exactly the reason lib/exploration/currentExpedition and
// lib/captureHandoff are ones: two parts of the app in different trees need the
// same answer, and threading a context between them would couple things that
// should not be coupled.
//
// THE COUPLING THIS AVOIDS. The field path — the map, the pack, GPS, the track,
// the outbox — must not depend on the auth context. That independence is the
// whole point of Milestone 1: an expedition survives an expired token because
// nothing it does asks the auth layer for permission. Wiring `useAuth()` into
// useExpeditionSync would have quietly undone that: the hook would throw outside
// an AuthProvider, which is to say the field pipeline would once again require
// authentication to be mounted at all. The mount tests caught it immediately,
// which is the second time this session that a test earned its keep.
//
// So attribution reads an IDENTITY, not a session. Published by AuthProvider,
// read by anyone, owned by nobody.

export interface Identity {
  userId: string;
  email: string | null;
}

let identity: Identity | null = null;

/** Written only by AuthProvider, on every auth state change. */
export function setCurrentIdentity(next: Identity | null): void {
  identity = next;
}

/**
 * Whoever is signed in, or null.
 *
 * Null is an ordinary answer, not an error: field work does not require an
 * identity, and a record that cannot name its collector says so rather than
 * guessing.
 */
export function currentIdentity(): Identity | null {
  return identity;
}

// A ceiling for supabase.auth.getUser() — it always makes its own network
// round-trip to validate the token (unlike getSession(), which can resolve
// from a cached local session), so it is at least as exposed to the
// stalled-connection freeze withTimeout.ts documents (measured 51-52s hangs
// on getSession()/appUpdate/pushOutbox before those were fixed). getUser()
// itself was never covered — every call site below threw only on `!user`,
// never read `error`, so a plain `User | null` fallback is a drop-in match:
// a timeout surfaces as "not signed in", the same message an expired session
// already produces today.
import { supabase } from "./supabase";
import { withTimeout } from "./withTimeout";

export const GET_USER_TIMEOUT_MS = 8_000;

export function getAuthUserTimed(): Promise<{ id: string } | null> {
  return withTimeout(supabase.auth.getUser().then((r) => r.data.user), GET_USER_TIMEOUT_MS, null);
}

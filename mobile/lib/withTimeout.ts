// A ceiling for a promise that carries no timeout of its own.
//
// THE PATTERN THIS GENERALISES. Three separate cold-start network calls —
// AuthProvider's getSession() (lib/auth.tsx), the update check
// (lib/appUpdate.ts) and the outbox's OWN getSession() (lib/sync/pushOutbox.ts)
// — each carried no timeout, and each, independently, produced a 51-52 SECOND
// freeze. MEASURED, repeatedly, on a device with a stalled connection to the
// auth endpoint: fixing the first two still left the third, because the
// underlying call — supabase-js reaching the auth server — is duplicated at
// every site that needs a token, not shared.
//
// Whichever settles first wins. The loser is never awaited again; if it does
// eventually resolve, nothing is listening, which is correct — the caller
// already moved on with the fallback.
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

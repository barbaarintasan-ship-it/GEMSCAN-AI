// The lease, as React sees it.
//
// The router asks two questions before it renders anything: is there a session,
// and is a field session open. The second must be answered from STORAGE, so it
// is asynchronous — and it must not be answered late, or the login screen
// flashes over a running expedition before the read completes. So this hook has
// its own `isLoading`, and the gates wait for both.
import { useEffect, useState } from "react";
import { expeditionLease, type ExpeditionLease, type LeaseClosure } from "./expeditionLease";

export interface LeaseView {
  lease: ExpeditionLease | null;
  /** True while the stored lease is still being read. Gates must not decide yet. */
  isLoading: boolean;
  /** Whether a lease should currently lift the auth gate. */
  isOpen: boolean;
  /** Open, but the account has been signed out. */
  isDetached: boolean;
  /** How the LAST lease ended, which outlives the lease itself. */
  lastClosure: LeaseClosure | null;
}

export function useExpeditionLease(): LeaseView {
  const store = expeditionLease();
  const [, bump] = useState(0);
  const [isLoading, setIsLoading] = useState(!store.isLoaded());

  useEffect(() => {
    const off = store.subscribe(() => bump((n) => n + 1));
    void store.load().then(() => setIsLoading(false));
    return off;
  }, [store]);

  return {
    lease: store.get(),
    isLoading,
    isOpen: store.isOpen(),
    isDetached: store.isDetached(),
    lastClosure: store.lastClosure(),
  };
}

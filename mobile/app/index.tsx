import { Redirect } from "expo-router";
import { useAuth } from "../lib/auth";
import { useExpeditionLease } from "../lib/exploration/useExpeditionLease";
import LoadingScreen from "../components/LoadingScreen";

export default function Index() {
  const { session, isLoading } = useAuth();
  const lease = useExpeditionLease();

  if (isLoading || lease.isLoading) return <LoadingScreen />;

  /**
   * COLD START, WHICH IS A DIFFERENT FAILURE FROM THE ONE IN (app)/_layout.
   *
   * Fixing the in-session gate alone is not enough, and it took reading the code
   * to see why: Android kills a backgrounded app to reclaim memory — reliably,
   * overnight, on a phone in a tent. On the next launch the process is new, so
   * every in-memory trace of the expedition is gone and this line decided purely
   * on `session`. With an expired token and no signal, the geologist would wake
   * up to a login screen having lost nothing but access to their own work.
   *
   * The stored lease is what survives a process kill, so it is what this asks.
   * An open lease means an expedition is still running: go to the app. Login is
   * still the right answer for a first launch, or once the expedition has ended.
   */
  const goToApp = session != null || lease.isOpen;
  return <Redirect href={goToApp ? "/(app)" : "/(auth)/login"} />;
}

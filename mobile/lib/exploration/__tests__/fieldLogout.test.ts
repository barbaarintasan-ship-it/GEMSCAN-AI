// requestFieldLogout — the Handover branch must not discard unfinished
// on-site evidence.
//
// CONFIRMED gap: settings.tsx and account.tsx wired `endExpedition:
// exploration.actions.stop` straight through — the raw orchestrator stop,
// with no awareness of on-site work `finishSection()` has not yet saved.
// That is the exact shape of the bug 9b9ceeb fixed for the map's Stop icon,
// reachable a second time through Log out -> "Hand over to someone else".
//
// The fix does not change what Handover fixed to mean (or the outer
// three-option Alert.alert): endExpedition() may now itself ask a question,
// and reports back whether the walk actually ended. `false` means that
// question was answered "cancel" — Handover must abort, with the lease left
// open and signOut() never called. This file asserts that branching at the
// level requestFieldLogout owns it, treating endExpedition as opaque so the
// on-site guard itself (confirmStop.test.ts) is not re-tested here — except
// for one integration test that wires the real confirmStopIfUnfinished in,
// exactly as settings.tsx/account.tsx do, to prove the full ordering.
jest.mock("../../i18n", () => ({ __esModule: true, default: { t: (key: string) => key } }));

import { Alert } from "react-native";
import { requestFieldLogout } from "../fieldLogout";
import { ExpeditionLeaseStore, __setExpeditionLeaseForTests } from "../expeditionLease";
import { confirmStopIfUnfinished } from "../confirmStop";
import type { ExplorationSnapshot } from "../orchestrator.ts";
import type { Mission } from "../mission.ts";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => { map.set(k, v); },
  };
}

async function openLease(): Promise<ExpeditionLeaseStore> {
  const store = new ExpeditionLeaseStore({ storage: memoryStorage() });
  await store.open("ex-test", { userId: "u-1", email: "geologist@example.com" });
  __setExpeditionLeaseForTests(store);
  return store;
}

function pressHandover() {
  const call = (Alert.alert as jest.Mock).mock.calls[0];
  const buttons = call[2] as Array<{ text: string; onPress?: () => void }>;
  const handover = buttons.find((b) => b.text === "field.logout.handover")!;
  handover.onPress!();
}

function missionSnapshot(state: Mission["state"]): ExplorationSnapshot {
  return { mission: { state } } as unknown as ExplorationSnapshot;
}

describe("requestFieldLogout — Handover and unfinished on-site work", () => {
  afterEach(() => {
    __setExpeditionLeaseForTests(null);
    jest.restoreAllMocks();
  });

  test("endExpedition confirms the stop: Handover proceeds to close the lease and sign out", async () => {
    const store = await openLease();
    const closeSpy = jest.spyOn(store, "close");
    const signOut = jest.fn().mockResolvedValue(undefined);
    const endExpedition = jest.fn().mockResolvedValue(true);
    jest.spyOn(Alert, "alert").mockImplementation(() => {});

    const done = requestFieldLogout({ signOut, endExpedition });
    await new Promise((r) => setTimeout(r, 0));
    pressHandover();
    await done;

    expect(endExpedition).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test("endExpedition reports the confirmation was cancelled: Handover aborts, nothing closes or signs out", async () => {
    const store = await openLease();
    const closeSpy = jest.spyOn(store, "close");
    const signOut = jest.fn().mockResolvedValue(undefined);
    const endExpedition = jest.fn().mockResolvedValue(false);
    jest.spyOn(Alert, "alert").mockImplementation(() => {});

    const done = requestFieldLogout({ signOut, endExpedition });
    await new Promise((r) => setTimeout(r, 0));
    pressHandover();
    await done;

    expect(endExpedition).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    // The expedition is exactly as it was: still open, still attached.
    expect(store.isOpen()).toBe(true);
    expect(store.get()?.state).toBe("attached");
  });

  test("no endExpedition callback at all: Handover proceeds as before (back-compat)", async () => {
    const store = await openLease();
    const closeSpy = jest.spyOn(store, "close");
    const signOut = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(Alert, "alert").mockImplementation(() => {});

    const done = requestFieldLogout({ signOut });
    await new Promise((r) => setTimeout(r, 0));
    pressHandover();
    await done;

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test("integration: on-site Handover, choosing Finish, saves before stopping, before closing, before signing out", async () => {
    const store = await openLease();
    const order: string[] = [];
    const stop = jest.fn(() => { order.push("stop"); });
    const finishSection = jest.fn(async () => { order.push("finishSection"); });
    jest.spyOn(store, "close").mockImplementation(async () => { order.push("close"); });
    const signOut = jest.fn(async () => { order.push("signOut"); });

    let alertCalls = 0;
    jest.spyOn(Alert, "alert").mockImplementation((_title, _body, buttons) => {
      alertCalls += 1;
      if (alertCalls === 1) {
        // requestFieldLogout's own three-option Alert — choose Handover.
        const handover = buttons!.find((b) => b.text === "field.logout.handover")!;
        handover.onPress!();
      } else {
        // confirmStopIfUnfinished's Alert, reached from inside endExpedition — choose Finish.
        const finish = buttons!.find((b) => b.text === "field.stop.finish")!;
        finish.onPress!();
      }
    });

    const t = (k: string) => k;
    const done = requestFieldLogout({
      signOut,
      endExpedition: () => confirmStopIfUnfinished({
        snapshot: missionSnapshot("field_investigation"),
        finishSection,
        stop,
        t,
      }),
    });
    await done;

    expect(order).toEqual(["finishSection", "stop", "close", "signOut"]);
  });

  test("integration: on-site Handover, choosing Cancel inside the stop guard, leaves the expedition open and never signs out", async () => {
    const store = await openLease();
    const stop = jest.fn();
    const finishSection = jest.fn();
    const closeSpy = jest.spyOn(store, "close");
    const signOut = jest.fn().mockResolvedValue(undefined);

    let alertCalls = 0;
    jest.spyOn(Alert, "alert").mockImplementation((_title, _body, buttons) => {
      alertCalls += 1;
      if (alertCalls === 1) {
        const handover = buttons!.find((b) => b.text === "field.logout.handover")!;
        handover.onPress!();
      } else {
        const cancel = buttons!.find((b) => b.text === "field.stop.cancel")!;
        cancel.onPress!();
      }
    });

    const t = (k: string) => k;
    const done = requestFieldLogout({
      signOut,
      endExpedition: () => confirmStopIfUnfinished({
        snapshot: missionSnapshot("arrived_at_target_area"),
        finishSection,
        stop,
        t,
      }),
    });
    await done;

    expect(stop).not.toHaveBeenCalled();
    expect(finishSection).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(store.isOpen()).toBe(true);
  });

  test("integration: not on-site — Handover proceeds exactly as before, with no prompt from the stop guard", async () => {
    const store = await openLease();
    const stop = jest.fn();
    const finishSection = jest.fn();
    jest.spyOn(store, "close").mockResolvedValue(undefined);
    const signOut = jest.fn().mockResolvedValue(undefined);

    jest.spyOn(Alert, "alert").mockImplementation((_title, _body, buttons) => {
      // Only the logout policy's own Alert should ever fire here — the
      // stop guard has nothing to confirm off-site and never calls Alert.
      const handover = buttons!.find((b) => b.text === "field.logout.handover")!;
      handover.onPress!();
    });

    const t = (k: string) => k;
    const done = requestFieldLogout({
      signOut,
      endExpedition: () => confirmStopIfUnfinished({
        snapshot: missionSnapshot("navigating"),
        finishSection,
        stop,
        t,
      }),
    });
    await done;

    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(finishSection).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

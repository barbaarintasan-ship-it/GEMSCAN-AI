// confirmStopIfUnfinished — the fix for the stop-icon data-loss bug.
//
// CONFIRMED on a real field test: tapping the top-bar stop icon while
// on-site (arrived_at_target_area / field_investigation) called
// orchestrator.stop() straight through, discarding a just-recorded waypoint
// that finishSection() had never been given a chance to save. This asserts
// the fix at the level the bug was actually observed: stop() must not run
// unconfirmed while isOnSite(mission.state), and must run WITHOUT any
// prompt in every other state (nothing to lose, no reason to interrupt).
import { Alert } from "react-native";
import { confirmStopIfUnfinished } from "../confirmStop";
import type { ExplorationSnapshot } from "../orchestrator.ts";
import type { Mission } from "../mission.ts";

const t = (k: string) => k;

function snapshotWith(mission: Mission | null): ExplorationSnapshot {
  return { mission } as unknown as ExplorationSnapshot;
}

function missionInState(state: Mission["state"]): Mission {
  return { state } as unknown as Mission;
}

describe("confirmStopIfUnfinished", () => {
  test("no mission open: stops immediately, no prompt", async () => {
    const stop = jest.fn();
    const finishSection = jest.fn();
    const alertSpy = jest.spyOn(Alert, "alert");

    await confirmStopIfUnfinished({ snapshot: snapshotWith(null), finishSection, stop, t });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(finishSection).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test.each(["none", "target_selected", "navigating", "section_completed", "waiting_for_upload", "ai_analysis_complete", "mission_closed"] as const)(
    "mission state %s (not on-site): stops immediately, no prompt",
    async (state) => {
      const stop = jest.fn();
      const finishSection = jest.fn();
      const alertSpy = jest.spyOn(Alert, "alert");

      await confirmStopIfUnfinished({
        snapshot: snapshotWith(missionInState(state)), finishSection, stop, t,
      });

      expect(stop).toHaveBeenCalledTimes(1);
      expect(finishSection).not.toHaveBeenCalled();
      expect(alertSpy).not.toHaveBeenCalled();
    },
  );

  test.each(["arrived_at_target_area", "field_investigation"] as const)(
    "mission state %s (on-site): prompts instead of stopping immediately",
    async (state) => {
      const stop = jest.fn();
      const finishSection = jest.fn();
      jest.spyOn(Alert, "alert").mockImplementation(() => {});

      // Alert.alert never calls back in this mock, so the promise from
      // confirmStopIfUnfinished stays pending — proving stop() was NOT
      // called synchronously the way the bug did.
      void confirmStopIfUnfinished({
        snapshot: snapshotWith(missionInState(state)), finishSection, stop, t,
      });
      await Promise.resolve();

      expect(stop).not.toHaveBeenCalled();
      expect(Alert.alert).toHaveBeenCalledTimes(1);
    },
  );

  test("choosing Finish: calls finishSection() before stop()", async () => {
    const order: string[] = [];
    const stop = jest.fn(() => order.push("stop"));
    const finishSection = jest.fn(async () => { order.push("finishSection"); });
    jest.spyOn(Alert, "alert").mockImplementation((_title, _body, buttons) => {
      const finish = buttons!.find((b) => b.text === "field.stop.finish")!;
      finish.onPress!();
    });

    await confirmStopIfUnfinished({
      snapshot: snapshotWith(missionInState("field_investigation")), finishSection, stop, t,
    });

    expect(order).toEqual(["finishSection", "stop"]);
  });

  test("choosing Discard: calls stop() without finishSection()", async () => {
    const stop = jest.fn();
    const finishSection = jest.fn();
    jest.spyOn(Alert, "alert").mockImplementation((_title, _body, buttons) => {
      const discard = buttons!.find((b) => b.text === "field.stop.discard")!;
      discard.onPress!();
    });

    await confirmStopIfUnfinished({
      snapshot: snapshotWith(missionInState("arrived_at_target_area")), finishSection, stop, t,
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(finishSection).not.toHaveBeenCalled();
  });

  test("choosing Cancel: neither finishSection() nor stop() runs", async () => {
    const stop = jest.fn();
    const finishSection = jest.fn();
    jest.spyOn(Alert, "alert").mockImplementation((_title, _body, buttons) => {
      const cancel = buttons!.find((b) => b.text === "field.stop.cancel")!;
      cancel.onPress!();
    });

    await confirmStopIfUnfinished({
      snapshot: snapshotWith(missionInState("field_investigation")), finishSection, stop, t,
    });

    expect(stop).not.toHaveBeenCalled();
    expect(finishSection).not.toHaveBeenCalled();
  });

  afterEach(() => { jest.restoreAllMocks(); });
});

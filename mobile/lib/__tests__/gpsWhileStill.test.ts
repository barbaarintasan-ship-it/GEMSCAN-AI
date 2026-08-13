// A geologist standing still is not a dead receiver.
//
// THE FIELD REPORT, verbatim: press the power button, the screen goes dark,
// double-tap to wake it — "GPS works immediately". A minute later it does not.
// Outdoors. Clear sky. Repeatedly.
//
// The cause was one number. `watchPositionAsync` on Android applies distance AND
// time together, so with `distanceIntervalM: 5` a fix arrived only once three
// seconds had passed AND the phone had moved five metres. Standing on an outcrop
// writing notes moves nobody five metres. Waking the screen jostles the phone,
// ±11 m of noise crosses the gate, one fix lands — and it looks fixed, until it
// stops again.
//
// The comment on the old value said "still silent when still", which was the
// intent. It was the wrong intent: three things this app does depend on fixes
// continuing while stationary, and arrival is the one that matters most, because
// you stop walking exactly when you get there.
import {
  DEFAULT_TRACK_CONFIG,
} from "../field/trackRecorder";
import { WALKING_PROFILE } from "../field/types";

describe("the watch delivers while the geologist is standing still", () => {
  test("the OS distance gate is OFF", () => {
    // Any non-zero value reintroduces the bug: no movement, no fix, and a
    // staleness warning that counts time against a watch gated on distance.
    expect(WALKING_PROFILE.distanceIntervalM).toBe(0);
  });

  test("there is still a time interval, so this is not a firehose", () => {
    expect(WALKING_PROFILE.timeIntervalMs).toBeGreaterThan(0);
    expect(WALKING_PROFILE.timeIntervalMs).toBeGreaterThanOrEqual(1000);
  });

  test("the receiver is still asked for its best work", () => {
    // Balanced answers from wifi and cell towers. A geologist recording where an
    // outcrop is needs the GNSS chip asked properly.
    expect(WALKING_PROFILE.accuracy).toBe("highest");
  });
});

describe("the traverse does not fill with jitter now that every fix arrives", () => {
  // Removing the OS gate means the recorder sees every fix, including the ones
  // that are noise around a stationary phone. It gates independently — and that
  // independence is now load-bearing rather than a safety net.
  test("the recorder has a movement floor of its own", () => {
    expect(DEFAULT_TRACK_CONFIG.minDistanceM).toBeGreaterThan(0);
  });

  test("its floor is coarser than any OS gate would have been", () => {
    expect(DEFAULT_TRACK_CONFIG.minDistanceM).toBeGreaterThanOrEqual(10);
  });

  test("movement must also clear the fix's own accuracy", () => {
    // Otherwise a ±40 m fix wandering in place draws a walk nobody took.
    expect(DEFAULT_TRACK_CONFIG.accuracyGateFactor).toBeGreaterThan(0);
  });

  test("a long stop is still recorded, so standing somewhere is visible", () => {
    expect(DEFAULT_TRACK_CONFIG.idleResampleMs).toBeGreaterThan(0);
  });
});

// Arriving means being there.
//
// TWO FIELD READINGS, ONE CAUSE, on an SM-A165F with a +-9 m fix:
//
//   10:46  "You reached the target"   ...  "Target: 1.1 km east"
//                                     ...  "Continue east - 1.1 km to the target."
//   11:00  "You reached the target"   ...  667 m south (163 deg)
//
// The app told a geologist they had arrived and, in the same sheet, told them to
// keep walking a kilometre. Arrival was `currentCell === target.cell`, and at H3
// resolution 7 a cell is ~5.2 km2 — about 2.4 km across. Entering it fired at 44
// times the metric radius it was standing in for (`arrivalRadiusFor(9) === 25`).
//
// It cost more than a wrong sentence. Arrival spends the commitment, so the next
// re-rank was free to issue a different target: walking to the first target, they
// were told they had reached it and sent somewhere else.
//
// WHY IT WAS WRITTEN THAT WAY, and why undoing it is safe. `rank()` drops the cell
// you are standing in, so once inside the target cell the ranking stopped offering
// it — guidance said "not yet", the ranking said "not a candidate", and the target
// was replaced over and over (a driver alternated between two cells 71 times).
// Calling cell entry arrival ended that. But the thing that actually holds a target
// is `locked` in the re-rank — a live mission, a taken commitment, or having left
// the cell the suggestion came from — and all three are true from the moment the
// geologist sets off. The ping-pong test below pins that.
//
// SECOND FIX, same file: a destination reached is now promoted to a target. It used
// to be navigation and nothing else, so the pill counted down to 2 m and stopped
// there — no arrival, no mission, `missionId: null` on everything recorded, no
// evidence package, and "No sections finished yet" after a day in the field with
// two waypoints and nine photographs.
import { cellToBoundary } from "h3-js";
import type { FieldFix, SessionSnapshot } from "../field/types";
import { buildPack } from "../../../shared/geo-core/pack/build.ts";
import type { PackData } from "../../../shared/geo-core/pack/types.ts";
import { haversineM } from "../../../shared/geo-core/geo/spatial.ts";
import { PackStore, createBundledPackSource } from "../geo/packStore.ts";
import { OfflineGeoContextService } from "../geo/offlineGeoContext.ts";
import { TargetingEngine } from "../geo/targeting.ts";
import { cellCentre, cellFor } from "../geo/h3.ts";
import { arrivalRadiusFor } from "../geo/fixQuality.ts";
import {
  ExplorationOrchestrator, destinationKey, type FieldSessionPort,
} from "../exploration/orchestrator.ts";
import { PackageStore } from "../exploration/packageStore";
import { Outbox, type KeyValueAdapter } from "../sync/outbox";
import { isMissionLive } from "../exploration/mission";

const NOW = Date.parse("2026-08-12T08:00:00.000Z");
const BUILD_OPTS = {
  packId: "somalia", packVersion: "1.0.0", engineVersion: "1.0.0", region: "SO",
  h3Resolution: 7, builtAt: "2026-08-01T00:00:00.000Z",
  datasets: [{ datasetId: "d1", source: "USGS MRDS", version: "2024" }],
};
const START = { lat: 2.0469, lng: 45.3182 };
const FIX_ACCURACY_M = 9;   // the receiver in both field readings

function pack(): PackData {
  const d: PackData = {
    geology: [{
      id: "g1", name: "Precambrian Basement", kind: "metamorphic", source: "Macrostrat",
      attributes: null,
      rings: [[[45.1, 1.9], [45.6, 1.9], [45.6, 2.3], [45.1, 2.3], [45.1, 1.9]]],
      bbox: [45.1, 1.9, 45.6, 2.3], isPolygon: true,
    }],
    occurrences: [], knowledge: [], structures: [], community: [], mapFeatures: [], terrain: [],
    associations: [], rules: [], commodities: [], assemblages: [], land: [],
  };
  for (const [tag, c] of [
    ["a", { lat: START.lat + 0.021, lng: START.lng + 0.021 }],
    ["b", { lat: START.lat - 0.002, lng: START.lng + 0.030 }],
  ] as const) {
    for (let i = 0; i < 4; i++) {
      d.occurrences.push({
        id: `${tag}${i}`, name: `${tag} Gold ${i}`, commodity_key: "gold",
        deposit_type: "orogenic", host_rocks: ["greenstone"],
        lat: c.lat + i * 0.001, lng: c.lng + i * 0.001,
        dataset_id: "d1", source: "USGS MRDS", version: "2024",
        reference: `R${tag}${i}`, cell: "c",
      });
    }
  }
  return d;
}

function fakeField() {
  const listeners = new Set<() => void>();
  let snap: SessionSnapshot = {
    machine: { state: "idle", pausedBy: null, errorCode: null },
    sessionId: null, startedAt: null, lastFix: null, lastHeading: null,
    fixCount: 0, headingSupported: true, degradedAccuracy: false, permission: null,
  };
  const port: FieldSessionPort & { emitFix: (lat: number, lng: number) => void } = {
    getSnapshot: () => snap,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    start: () => {
      snap = {
        ...snap, machine: { state: "active", pausedBy: null, errorCode: null },
        sessionId: "fs-1", startedAt: NOW,
      };
      listeners.forEach((l) => l());
    },
    stop: () => {
      snap = { ...snap, machine: { state: "idle", pausedBy: null, errorCode: null } };
      listeners.forEach((l) => l());
    },
    emitFix: (lat, lng) => {
      const fix: FieldFix = {
        lat, lng, accuracy: FIX_ACCURACY_M, altitude: 700, speed: 1.2,
        timestamp: NOW, provisional: false,
      };
      snap = { ...snap, lastFix: fix, fixCount: snap.fixCount + 1 };
      listeners.forEach((l) => l());
    },
  };
  return port;
}

function memoryStorage(): KeyValueAdapter {
  const data = new Map<string, string>();
  return { getItem: async (k) => data.get(k) ?? null, setItem: async (k, v) => { data.set(k, v); } };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
jest.setTimeout(180_000);

function harness() {
  const storage = memoryStorage();
  const files = buildPack(pack(), BUILD_OPTS).files;
  const packs = new PackStore(createBundledPackSource(() => files), () => NOW);
  const field = fakeField();
  const orch = new ExplorationOrchestrator({
    field, targeting: new TargetingEngine(new OfflineGeoContextService(packs)),
    packs, now: () => NOW,
    packages: new PackageStore({ storage, now: () => NOW }),
    outbox: new Outbox({ storage, now: () => NOW }),
    findHotspot: async () => null,
  });
  return { orch, field };
}

/** Take a target and set off, so the mission is live and the target committed. */
async function travelling(h: ReturnType<typeof harness>) {
  h.orch.start();
  h.field.emitFix(START.lat, START.lng);
  await settle();
  const t = h.orch.getSnapshot().activeTarget!;
  h.orch.selectTarget(t.cell);
  await settle();
  return t;
}

/**
 * A point INSIDE `cell` but roughly `wantM` from its centre.
 *
 * Interpolating toward a vertex keeps it inside the hexagon by construction, which
 * a bearing-and-distance offset would not: at resolution 7 the centre-to-vertex
 * distance is about 1.22 km and the centre-to-edge distance is shorter, so the same
 * 1.1 km lands inside or outside depending on which way you face. The whole point of
 * these tests is a fix that is inside the cell and far from the middle.
 */
function insideCellAt(cell: string, wantM: number): { lat: number; lng: number } {
  const centre = cellCentre(cell);
  let best = centre;
  let bestErr = Infinity;
  for (const [vLat, vLng] of cellToBoundary(cell)) {
    const span = haversineM(centre, { lat: vLat, lng: vLng });
    if (span <= 0) continue;
    // 0.97 keeps the point off the vertex itself, where floating point can round
    // it into the neighbouring cell.
    const f = Math.min(0.97, wantM / span);
    const p = { lat: centre.lat + (vLat - centre.lat) * f, lng: centre.lng + (vLng - centre.lng) * f };
    if (cellFor(p.lat, p.lng) !== cell) continue;
    const err = Math.abs(haversineM(centre, p) - wantM);
    if (err < bestErr) { bestErr = err; best = p; }
  }
  return best;
}

describe("the fix that made these tests necessary is real", () => {
  test("a resolution 7 cell really is wide enough to hide a kilometre", () => {
    // If this ever stops being true the premature arrivals were something else and
    // the reasoning above needs rewriting rather than trusting.
    const cell = cellFor(START.lat, START.lng);
    const centre = cellCentre(cell);
    const spans = cellToBoundary(cell).map(([la, ln]) => haversineM(centre, { lat: la, lng: ln }));
    expect(Math.max(...spans)).toBeGreaterThan(1000);
  });

  test("the metric radius for the field's own receiver is 25 m", () => {
    expect(arrivalRadiusFor(FIX_ACCURACY_M)).toBe(25);
  });
});

describe("1. arrival is judged in metres, not by cell membership", () => {
  test("1.1 km from the target, inside its cell, is NOT arriving", async () => {
    // The 10:46 reading, reproduced. Before the fix this was `awaitingEvidence`
    // while the same snapshot said "Continue east - 1.1 km to the target".
    const h = harness();
    const t = await travelling(h);
    const p = insideCellAt(t.cell, 1100);
    h.field.emitFix(p.lat, p.lng);
    await settle();
    await settle();

    const s = h.orch.getSnapshot();
    expect(s.currentCell).toBe(t.cell);            // genuinely inside the cell
    expect(s.distanceToTargetM).toBeGreaterThan(800);
    expect(s.state).toBe("guiding");
    expect(s.state).not.toBe("awaitingEvidence");
  });

  test("667 m from the target, inside its cell, is NOT arriving", async () => {
    // The 11:00 reading.
    const h = harness();
    const t = await travelling(h);
    const p = insideCellAt(t.cell, 667);
    h.field.emitFix(p.lat, p.lng);
    await settle();
    await settle();
    expect(h.orch.getSnapshot().state).toBe("guiding");
  });

  test("standing on the target IS arriving", async () => {
    const h = harness();
    const t = await travelling(h);
    const c = cellCentre(t.cell);
    h.field.emitFix(c.lat, c.lng);
    await settle();
    await settle();
    expect(h.orch.getSnapshot().state).toBe("awaitingEvidence");
  });

  test("the screen can no longer contradict itself", async () => {
    // The invariant behind both readings: whenever the app says "you reached the
    // target", the distance it is showing must be inside the arrival radius. This
    // is the assertion that would have caught the bug in the first place.
    const h = harness();
    const t = await travelling(h);
    for (const m of [2000, 1100, 667, 300, 120, 40, 0]) {
      const p = m === 0 ? cellCentre(t.cell) : insideCellAt(t.cell, m);
      h.field.emitFix(p.lat, p.lng);
      await settle();
      await settle();
      const s = h.orch.getSnapshot();
      if (s.state === "awaitingEvidence") {
        expect(s.distanceToTargetM).not.toBeNull();
        expect(s.distanceToTargetM!).toBeLessThanOrEqual(arrivalRadiusFor(FIX_ACCURACY_M));
      }
    }
  });
});

describe("2. no early arrival, so no being sent somewhere else mid-walk", () => {
  test("crossing into the target cell does not release the commitment", async () => {
    // The mechanism behind "it told me I had arrived and sent me to another one":
    // arrival sets targetCommitment to "none", and the next re-rank is then free to
    // replace the target the geologist is walking to.
    const h = harness();
    const t = await travelling(h);
    const p = insideCellAt(t.cell, 900);
    h.field.emitFix(p.lat, p.lng);
    await settle();
    await settle();

    const s = h.orch.getSnapshot();
    expect(s.targetCommitment).toBe("committed");
    expect(s.activeTarget!.cell).toBe(t.cell);
  });

  test("THE PING-PONG STAYS FIXED: the target survives the ranking dropping it", async () => {
    // `rank()` drops the cell you stand in, so deep inside the target cell the
    // ranking no longer offers it. `locked` must hold it anyway. This is the 71-
    // alternations bug, and it must not come back now that cell entry no longer
    // counts as arriving.
    const h = harness();
    const t = await travelling(h);
    for (const m of [1100, 900, 700, 500]) {
      const p = insideCellAt(t.cell, m);
      h.field.emitFix(p.lat, p.lng);
      await settle();
      await settle();
      expect(h.orch.getSnapshot().activeTarget!.cell).toBe(t.cell);
    }
  });
});

describe("3. a destination reached becomes a place worth recording", () => {
  test("arriving at a map-tapped destination opens a mission", async () => {
    // Before: the pill reached 2 m and nothing happened, because arrival is judged
    // on activeTarget and a destination is not one. No mission meant no evidence
    // package and no report, however much was photographed there.
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();

    const there = { lat: START.lat + 0.02, lng: START.lng + 0.02 };
    h.orch.navigateTo(there.lat, there.lng);
    await settle();
    expect(h.orch.getSnapshot().destination).not.toBeNull();

    h.field.emitFix(there.lat, there.lng);
    await settle();
    await settle();
    await settle();

    const s = h.orch.getSnapshot();
    expect(s.mission).not.toBeNull();
    expect(isMissionLive(s.mission!.state)).toBe(true);
    expect(s.activeTarget!.cell).toBe(cellFor(there.lat, there.lng));
    // The destination has become the target; two arrows on the same ground would
    // be one too many.
    expect(s.destination).toBeNull();
    // AND THE SENTENCE THE GEOLOGIST CAME FOR. `ArrivedBlock` — "You reached the
    // target", Scan area, Add waypoint — is gated on exactly this state, and the
    // evidence package that becomes the report is built from what is recorded
    // under it. A promotion that stopped short of here would open a mission
    // nobody could put anything into.
    expect(s.state).toBe("awaitingEvidence");
  });

  test("arrival is judged at the point CHOSEN, not the middle of its cell", async () => {
    // The half-fix this replaced. `targetAt` builds the target for the cell the tap
    // fell in, and a cell centre is up to ~1.2 km from its edge — so promoting a
    // point near the edge would arrive the geologist and immediately tell them to
    // walk most of a kilometre to the middle of the hexagon.
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();

    // Deliberately near the rim of its own cell, which is where the old behaviour
    // came apart.
    const rim = insideCellAt(cellFor(START.lat + 0.02, START.lng + 0.02), 1000);
    expect(haversineM(cellCentre(cellFor(rim.lat, rim.lng)), rim)).toBeGreaterThan(500);

    h.orch.navigateTo(rim.lat, rim.lng);
    await settle();
    h.field.emitFix(rim.lat, rim.lng);
    await settle();
    await settle();
    await settle();

    const s = h.orch.getSnapshot();
    expect(s.state).toBe("awaitingEvidence");
    expect(s.distanceToTargetM!).toBeLessThanOrEqual(arrivalRadiusFor(FIX_ACCURACY_M));
  });

  test("travelling toward it is still plain navigation", async () => {
    // Pointing at a lead 184 km away must not open a mission on it. Only standing
    // there does.
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();
    const before = h.orch.getSnapshot().mission;

    h.orch.navigateTo(START.lat + 0.02, START.lng + 0.02);
    await settle();
    h.field.emitFix(START.lat + 0.001, START.lng + 0.001);   // set off, still far
    await settle();
    await settle();

    const s = h.orch.getSnapshot();
    expect(s.destination).not.toBeNull();
    expect(s.mission).toBe(before);
  });

  test("promotion is attempted once, not on every fix", async () => {
    // updateGuidance runs on every fix. Without the guard, standing on a
    // destination would fire an async targeting call every three seconds.
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();

    const there = { lat: START.lat + 0.02, lng: START.lng + 0.02 };
    h.orch.navigateTo(there.lat, there.lng);
    await settle();
    for (let i = 0; i < 4; i++) {
      h.field.emitFix(there.lat, there.lng);
      await settle();
      await settle();
    }
    const s = h.orch.getSnapshot();
    expect(s.mission).not.toBeNull();
    // One mission, not four: a second promotion would have minted a new id.
    expect(s.mission!.id).toMatch(/^ms-/);
    expect(s.destination).toBeNull();
  });

  test("choosing a new destination re-arms the guard", async () => {
    const h = harness();
    h.orch.start();
    h.field.emitFix(START.lat, START.lng);
    await settle();

    const first = { lat: START.lat + 0.02, lng: START.lng + 0.02 };
    h.orch.navigateTo(first.lat, first.lng);
    await settle();
    h.field.emitFix(first.lat, first.lng);
    await settle();
    await settle();
    await settle();
    const missionA = h.orch.getSnapshot().mission!;

    const second = { lat: START.lat - 0.02, lng: START.lng + 0.03 };
    h.orch.navigateTo(second.lat, second.lng);
    await settle();
    h.field.emitFix(second.lat, second.lng);
    await settle();
    await settle();
    await settle();

    const s = h.orch.getSnapshot();
    expect(s.activeTarget!.cell).toBe(cellFor(second.lat, second.lng));
    expect(s.mission!.id).not.toBe(missionA.id);
  });
});

describe("the destination key discriminates points, not floating point noise", () => {
  test("the same point is the same key", () => {
    expect(destinationKey({ lat: 9.491823, lng: 49.091485 }))
      .toBe(destinationKey({ lat: 9.4918230000001, lng: 49.0914850000002 }));
  });

  test("the two waypoints of 12 August are different keys", () => {
    expect(destinationKey({ lat: 9.491823, lng: 49.091485 }))
      .not.toBe(destinationKey({ lat: 9.509693, lng: 49.081106 }));
  });
});

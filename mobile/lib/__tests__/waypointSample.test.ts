// SLICE 1 — the sample model on a waypoint.
//
// A sample is OPTIONAL and ADDITIVE. Most field observations are looked at and
// photographed, not collected, and every waypoint written before samples existed
// has to keep working with no migration and no backfill. That property is what
// these tests defend: the shape is new, the old records are not touched.
//
// NOTHING HERE CHANGES SCORING, and `sample-location` in particular produces NO
// scoring signal at all. It was first given the floor weight — the same as `other` —
// which was wrong: TYPE_SIGNAL feeds the prospectivity score, so 0.2 meant the ACT
// of bagging a rock raised a site's ranking, and anyone could lift a score by
// collecting on it. The contents of a sample are unknown until the assay comes
// back. Collection is evidence for the assessment, never a signal in the score.
import {
  COLLECTION_METHODS, SAMPLE_ID_PREFIX, SAMPLE_TYPES, WAYPOINT_TYPES,
  collectionMethodLabelKey, isCollectionMethod, isSampleType, isWaypointType,
  nextSampleId, sampleTypeLabelKey,
  type Waypoint, type WaypointSample,
} from "../field/waypointTypes";
import { buildEvidencePackage } from "../exploration/evidencePackage";
import en from "../../locales/en.json";
import so from "../../locales/so.json";

const NOW = Date.parse("2026-08-10T09:15:00.000Z");

function waypoint(over: Partial<Waypoint> = {}): Waypoint {
  return {
    id: "w1", sessionId: "ex-1", trackId: "ex-1", type: "outcrop", name: null,
    notes: "", position: null, heading: null, photos: [],
    capturedAt: NOW, updatedAt: NOW, syncState: "local", deletedAt: null,
    ...over,
  };
}

const SAMPLE: WaypointSample = {
  sampleId: "LW-20260810-001",
  sampleType: "rock",
  collectionMethod: "outcrop",
  description: "White quartz vein with iron staining",
};

describe("the type catalogue gained exactly one entry", () => {
  test("sample-location is there and mineral-occurrence is NOT", () => {
    expect(isWaypointType("sample-location")).toBe(true);
    // Rejected on purpose: an occurrence is a database concept that reads as a
    // confirmed deposit, and a waypoint is one person's field observation.
    expect(isWaypointType("mineral-occurrence")).toBe(false);
    expect(WAYPOINT_TYPES.length).toBe(11);
  });

  test("every pre-existing type survived", () => {
    for (const t of [
      "outcrop", "float", "quartz-vein", "vein", "sulfides",
      "gossan", "alteration", "fault", "contact", "other",
    ]) {
      expect(isWaypointType(t)).toBe(true);
    }
  });
});

describe("a sample is optional and additive", () => {
  test("a waypoint with no sample is valid, and that is the common case", () => {
    const w = waypoint();
    expect(w.sample).toBeUndefined();
    // Both spellings of "no sample" are legal, so no record needs rewriting.
    expect(waypoint({ sample: null }).sample).toBeNull();
  });

  test("a record written before samples existed still parses", () => {
    // Exactly what is on disk from an earlier build: no `sample` key at all.
    const onDisk = JSON.parse(JSON.stringify({
      id: "old-1", sessionId: "ex-0", trackId: null, type: "gossan", name: null,
      notes: "rusty cap", position: null, heading: null, photos: [],
      capturedAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000,
      syncState: "synced", deletedAt: null,
    })) as Waypoint;
    expect(onDisk.sample).toBeUndefined();
    expect(isWaypointType(onDisk.type)).toBe(true);
  });

  test("a sample carries the four things a bag needs", () => {
    const w = waypoint({ type: "sample-location", sample: SAMPLE });
    expect(w.sample!.sampleId).toBe("LW-20260810-001");
    expect(w.sample!.sampleType).toBe("rock");
    expect(w.sample!.collectionMethod).toBe("outcrop");
    expect(w.sample!.description).toContain("quartz");
  });
});

describe("the sample vocabularies", () => {
  test("the five sample types and four collection methods", () => {
    expect([...SAMPLE_TYPES]).toEqual(["rock", "soil", "sediment", "mineral-specimen", "other"]);
    expect([...COLLECTION_METHODS]).toEqual(["surface", "outcrop", "float", "stream-sediment"]);
  });

  test("unknown values are rejected rather than coerced", () => {
    expect(isSampleType("rock")).toBe(true);
    expect(isSampleType("gold")).toBe(false);
    expect(isCollectionMethod("stream-sediment")).toBe(true);
    expect(isCollectionMethod("drilling")).toBe(false);
  });

  test("labels are i18n KEYS — the domain carries no user-facing copy", () => {
    expect(sampleTypeLabelKey("mineral-specimen")).toBe("field.sampleType.mineral-specimen");
    expect(collectionMethodLabelKey("stream-sediment")).toBe("field.collectionMethod.stream-sediment");
  });
});

describe("both locales can render every sample word", () => {
  type Dict = Record<string, unknown>;
  const read = (b: Dict, key: string): string | undefined => {
    let node: unknown = b;
    for (const part of key.split(".")) {
      if (node == null || typeof node !== "object") return undefined;
      node = (node as Dict)[part];
    }
    return typeof node === "string" ? node : undefined;
  };

  test("every sample type, method and waypoint type has BOTH languages", () => {
    // The app sets fallbackLng "en", so a key missing from Somali renders in
    // English instead of being flagged. The only defence is that none is missing.
    for (const t of SAMPLE_TYPES) {
      expect(read(en as Dict, sampleTypeLabelKey(t))).toBeDefined();
      expect(read(so as Dict, sampleTypeLabelKey(t))).toBeDefined();
    }
    for (const m of COLLECTION_METHODS) {
      expect(read(en as Dict, collectionMethodLabelKey(m))).toBeDefined();
      expect(read(so as Dict, collectionMethodLabelKey(m))).toBeDefined();
    }
    for (const w of WAYPOINT_TYPES) {
      expect(read(en as Dict, `field.waypointType.${w}`)).toBeDefined();
      expect(read(so as Dict, `field.waypointType.${w}`)).toBeDefined();
    }
  });

  test("the Somali is Somali, not a copy of the English", () => {
    for (const key of [
      "field.sampleType.rock", "field.sampleType.soil",
      "field.collectionMethod.surface", "field.collectionMethod.stream-sediment",
      "field.waypointType.sample-location",
    ]) {
      expect(read(so as Dict, key)).not.toBe(read(en as Dict, key));
    }
  });
});

describe("sample ids are generated from the record, not a counter", () => {
  test("the first of a day is 001, in the documented shape", () => {
    expect(nextSampleId([], NOW)).toBe("LW-20260810-001");
    expect(nextSampleId([], NOW).startsWith(SAMPLE_ID_PREFIX)).toBe(true);
  });

  test("it counts the samples that ALREADY EXIST", () => {
    // Derived rather than stored: a counter and a record set can disagree after a
    // restore or a partial sync, and the id printed on a bag has to be unique in
    // the record that actually exists.
    const existing = [
      waypoint({ sample: { ...SAMPLE, sampleId: "LW-20260810-001" } }),
      waypoint({ sample: { ...SAMPLE, sampleId: "LW-20260810-002" } }),
    ];
    expect(nextSampleId(existing, NOW)).toBe("LW-20260810-003");
  });

  test("a gap does not repeat an id already in use", () => {
    // Highest wins, not count: deleting 002 must not hand out 002 again, because
    // the bag with that label may still be in somebody's rucksack.
    const existing = [
      waypoint({ sample: { ...SAMPLE, sampleId: "LW-20260810-001" } }),
      waypoint({ sample: { ...SAMPLE, sampleId: "LW-20260810-007" } }),
    ];
    expect(nextSampleId(existing, NOW)).toBe("LW-20260810-008");
  });

  test("the sequence is per DAY", () => {
    const yesterday = [
      waypoint({ sample: { ...SAMPLE, sampleId: "LW-20260809-042" } }),
    ];
    expect(nextSampleId(yesterday, NOW)).toBe("LW-20260810-001");
  });

  test("waypoints with no sample are ignored, and malformed ids do not break it", () => {
    const mixed = [
      waypoint(),
      waypoint({ sample: null }),
      waypoint({ sample: { ...SAMPLE, sampleId: "hand-written-label" } }),
      waypoint({ sample: { ...SAMPLE, sampleId: "LW-20260810-abc" } }),
      waypoint({ sample: { ...SAMPLE, sampleId: "LW-20260810-004" } }),
    ];
    // A geologist's own numbering scheme is allowed to sit alongside the generated
    // ones — the id is editable precisely so it can match the bag.
    expect(nextSampleId(mixed, NOW)).toBe("LW-20260810-005");
  });

  test("the day boundary is UTC, so a night shift does not reuse ids", () => {
    const lateUtc = Date.parse("2026-08-10T23:59:00.000Z");
    const earlyUtc = Date.parse("2026-08-11T00:01:00.000Z");
    const existing = [waypoint({ sample: { ...SAMPLE, sampleId: nextSampleId([], lateUtc) } })];
    expect(existing[0].sample!.sampleId).toBe("LW-20260810-001");
    expect(nextSampleId(existing, earlyUtc)).toBe("LW-20260811-001");
  });
});

// ── Collecting a sample must NEVER raise the prospectivity score ─────────────
//
// TYPE_SIGNAL feeds Observation.weight, which becomes a `role: "field"` item in
// prospectivityEvidence, which becomes the score, which becomes the ranking. So a
// weight for `sample-location` is a weight for the ACT of bagging a rock — and the
// contents are unknown until the assay comes back. It was first given the floor
// value of 0.2, which was wrong for exactly that reason: 0.2 is not zero, and
// anyone could raise a site's prospectivity by collecting on it.
describe("a sample-location produces NO scoring signal", () => {
  const AT = { lat: 2.0469, lng: 45.3182 };
  const position = {
    lat: AT.lat, lng: AT.lng, accuracyM: 5, altitudeM: 700,
    fixedAt: NOW - 1_000, ageMs: 1_000, provisional: false,
  };

  function source(waypoints: Waypoint[]) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { makeWaypointEvidenceSource } = require("../exploration/localEvidence");
    return makeWaypointEvidenceSource({ visible: () => waypoints });
  }

  test("it emits no observation at all", () => {
    const src = source([waypoint({
      id: "s1", type: "sample-location", position,
      sample: { ...SAMPLE }, notes: "bagged the vein",
    })]);
    expect(src.observationsNear(AT.lat, AT.lng, 5_000)).toEqual([]);
  });

  test("a gossan at the same spot still scores — this changed nothing else", () => {
    const src = source([waypoint({ id: "g1", type: "gossan", position })]);
    const obs = src.observationsNear(AT.lat, AT.lng, 5_000);
    expect(obs).toHaveLength(1);
    expect(obs[0].weight).toBeCloseTo(0.8, 5);
  });

  test("a sample-location beside a gossan adds nothing to the total", () => {
    const withSample = source([
      waypoint({ id: "g1", type: "gossan", position }),
      waypoint({ id: "s1", type: "sample-location", position, sample: { ...SAMPLE } }),
    ]).observationsNear(AT.lat, AT.lng, 5_000);
    const without = source([
      waypoint({ id: "g1", type: "gossan", position }),
    ]).observationsNear(AT.lat, AT.lng, 5_000);
    // Same count, same weights. Collecting is evidence for the assessment, never a
    // signal in the score.
    expect(withSample.map((o: { weight: number }) => o.weight))
      .toEqual(without.map((o: { weight: number }) => o.weight));
  });

  test("EVERY pre-existing weight is exactly what it was", () => {
    // The record of the table, so a future edit cannot drift it. These are the
    // values from before sample-location existed.
    const expected: Record<string, number> = {
      sulfides: 0.85, gossan: 0.8, "quartz-vein": 0.7, vein: 0.65,
      alteration: 0.6, contact: 0.5, fault: 0.5, float: 0.45,
      outcrop: 0.3, other: 0.2,
    };
    for (const [type, weight] of Object.entries(expected)) {
      const obs = source([waypoint({ id: type, type: type as Waypoint["type"], position })])
        .observationsNear(AT.lat, AT.lng, 5_000);
      expect(obs).toHaveLength(1);
      expect(obs[0].weight).toBeCloseTo(weight, 5);
    }
  });

  test("an unlisted type scores NOTHING rather than falling back to the floor", () => {
    // The table used to be total with a `?? 0.2` fallback, so any type added later
    // silently began scoring. That is how sample-location acquired a weight.
    const src = source([waypoint({
      id: "x1", type: "not-a-real-type" as Waypoint["type"], position,
    })]);
    expect(src.observationsNear(AT.lat, AT.lng, 5_000)).toEqual([]);
  });
});

// ── SLICE 2 — the mission relationship ───────────────────────────────────────
//
// `sessionId` and `trackId` identify a WALK, and a walk can hold several missions.
// Matching a package on session therefore swept every observation of the whole
// traverse into each one, and the AI assessed one target against another target's
// rock. `missionId` is what makes the relationship
//
//   Target -> Mission -> Waypoint -> Sample + Photos -> Package -> AI
//
// actually hold. It is optional and additive: records written before it existed,
// and observations captured between missions, fall back to the old session rule.
describe("SLICE 2 — a waypoint belongs to a mission", () => {
  const MISSION_A = "ms-aaa";
  const MISSION_B = "ms-bbb";

  function mission(id: string, startedAt: number) {
    return {
      id, state: "field_investigation" as const, cell: `cell-${id}`,
      centre: { lat: 2, lng: 45 }, hotspot: null, commodity: null, score: 0.5,
      startedAt, arrivedAt: startedAt, completedAt: null, closedAt: null,
      packageId: null,
    };
  }

  function build(m: ReturnType<typeof mission>, waypoints: Waypoint[]) {
    return buildEvidencePackage({
      mission: m, explorationSessionId: "ex-1", waypoints, track: [],
      targetReasons: [], geologyContext: null, terrainContext: null,
      structuralContext: [], coverage: null, at: NOW + 10_000,
    });
  }

  test("ONE WALK, TWO MISSIONS: each package gets only its own evidence", () => {
    // The defect this slice fixes. Both waypoints are in the same session and both
    // were captured after both missions started — session matching cannot tell
    // them apart.
    const wps = [
      waypoint({ id: "wa", missionId: MISSION_A, type: "gossan", capturedAt: NOW + 1_000 }),
      waypoint({ id: "wb", missionId: MISSION_B, type: "sulfides", capturedAt: NOW + 2_000 }),
    ];
    expect(build(mission(MISSION_A, NOW), wps).observations.map((o) => o.id)).toEqual(["wa"]);
    expect(build(mission(MISSION_B, NOW), wps).observations.map((o) => o.id)).toEqual(["wb"]);
  });

  test("a record with NO missionId still works, by the old session rule", () => {
    // Everything already on a geologist's phone. Nothing is lost.
    const legacy = waypoint({
      id: "old", type: "outcrop", capturedAt: NOW + 1_000,
      sessionId: "ex-1", trackId: "ex-1",
    });
    delete (legacy as { missionId?: unknown }).missionId;
    expect(build(mission(MISSION_A, NOW), [legacy]).observations.map((o) => o.id)).toEqual(["old"]);
  });

  test("and one from BEFORE the mission started is still excluded", () => {
    const legacy = waypoint({ id: "older", type: "outcrop", capturedAt: NOW - 86_400_000 });
    delete (legacy as { missionId?: unknown }).missionId;
    expect(build(mission(MISSION_A, NOW), [legacy]).observations).toEqual([]);
  });

  test("a stamped waypoint is NOT included by the time window", () => {
    // The stamp is authoritative. A waypoint belonging to mission B must not appear
    // in A's package merely because it was captured during A's window.
    const wb = waypoint({ id: "wb", missionId: MISSION_B, capturedAt: NOW + 1_000 });
    expect(build(mission(MISSION_A, NOW), [wb]).observations).toEqual([]);
  });

  test("a deleted waypoint never appears, stamped or not", () => {
    const gone = waypoint({ id: "d1", missionId: MISSION_A, deletedAt: NOW + 5_000 });
    expect(build(mission(MISSION_A, NOW), [gone]).observations).toEqual([]);
  });

  test("the sample travels with the observation into the package", () => {
    const w = waypoint({
      id: "s1", missionId: MISSION_A, type: "sample-location",
      capturedAt: NOW + 1_000,
      sample: { ...SAMPLE },
      position: {
        lat: 2.05, lng: 45.32, accuracyM: 6, altitudeM: 700,
        fixedAt: NOW, ageMs: 1_000, provisional: false,
      },
    });
    const pkg = build(mission(MISSION_A, NOW), [w]);
    expect(pkg.observations).toHaveLength(1);
    expect(pkg.observations[0].type).toBe("sample-location");
    // GPS is carried, and it was never typed by hand.
    expect(pkg.observations[0].position!.lat).toBeCloseTo(2.05, 5);
    expect(pkg.observations[0].position!.accuracyM).toBe(6);
    expect(pkg.observations[0].positionQuality).toBe("good");
  });
});

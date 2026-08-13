// Evidence somebody else collected.
//
// THE CASE THIS IS FOR. A colleague in Borama sends a latitude, a longitude, three
// photographs of a quartz vein and a paragraph of notes. The geologist is four
// hundred kilometres away. Every part of that is real evidence and worth assessing
// — and none of it is something this phone witnessed.
//
// Before this, neither half could be entered at all. A waypoint's position came
// from the live fix and nothing else (`positionFromFix(snap.lastFix, …)`), so it
// always recorded where the phone was standing; and the exploration photo button,
// labelled ADD PHOTO, opened the camera, so there was no way to attach a picture
// the device had not taken.
//
// The rule that governs all of it: THE REPORT MUST NOT LIE. The package reads as an
// eyewitness account, and an assessment that treats a forwarded photograph as
// first-hand is a claim nobody can stand behind. So the origin is recorded on the
// waypoint, carried into the package, and printed on the PDF.
import {
  isUsableCoordinate, positionQuality, positionReported,
} from "../field/waypointTypes";
import { reportedCount } from "../explorationReportPdf";
import type { EvidencePackage, PackageObservation } from "../exploration/evidencePackage";

const AT = Date.parse("2026-08-12T09:00:00.000Z");
/** Borama, near enough. */
const BORAMA = { lat: 9.9361, lng: 43.1806 };

describe("1. a coordinate somebody sent is a position, honestly labelled", () => {
  test("it records the point it was given", () => {
    const p = positionReported(BORAMA.lat, BORAMA.lng, AT);
    expect(p.lat).toBe(BORAMA.lat);
    expect(p.lng).toBe(BORAMA.lng);
  });

  test("ACCURACY STAYS NULL — none was measured, and inventing one is worse", () => {
    const p = positionReported(BORAMA.lat, BORAMA.lng, AT);
    expect(p.accuracyM).toBeNull();
    expect(p.altitudeM).toBeNull();
  });

  test("it is not stale: there was no fix to grow old", () => {
    // `ageMs` measures how long ago a receiver produced a fix. A number read off a
    // message has no such history, and reporting it as stale would send a geologist
    // looking for a satellite problem that does not exist.
    const p = positionReported(BORAMA.lat, BORAMA.lng, AT);
    expect(p.ageMs).toBe(0);
    expect(p.provisional).toBe(false);
  });

  test("quality reads DEGRADED — usable, precision unknown", () => {
    expect(positionQuality(positionReported(BORAMA.lat, BORAMA.lng, AT))).toBe("degraded");
  });
});

describe("2. the coordinate box rejects what is not a place", () => {
  test("Borama is a place", () => {
    expect(isUsableCoordinate(BORAMA.lat, BORAMA.lng)).toBe(true);
  });

  test("null island is a parse failure, not a place", () => {
    // 0,0 is what an empty box and a failed Number() both produce, and it is in the
    // Gulf of Guinea. Accepting it would file a Somali outcrop off the coast of Ghana.
    expect(isUsableCoordinate(0, 0)).toBe(false);
  });

  test("out of range and not-a-number are refused", () => {
    expect(isUsableCoordinate(91, 43)).toBe(false);
    expect(isUsableCoordinate(9.9, 181)).toBe(false);
    expect(isUsableCoordinate(Number.NaN, 43)).toBe(false);
  });

  test("a real negative coordinate still passes", () => {
    expect(isUsableCoordinate(-1.2921, 36.8219)).toBe(true);
  });
});

describe("3. the package tells the model who saw it", () => {
  const obs = (over: Partial<PackageObservation>): PackageObservation => ({
    id: "wp-1", type: "quartz_vein", notes: "White quartz, iron staining",
    capturedAt: AT, position: { ...BORAMA, accuracyM: null, altitudeM: null, ageMs: 0, provisional: false },
    positionQuality: "degraded", headingDeg: null, photos: [], ...over,
  });
  const pkg = (observations: PackageObservation[]) =>
    ({ observations } as unknown as EvidencePackage);

  test("reported observations are counted for the document", () => {
    expect(reportedCount(pkg([
      obs({ id: "a", origin: "reported" }),
      obs({ id: "b", origin: "reported" }),
      obs({ id: "c", origin: "observed" }),
    ]))).toBe(2);
  });

  test("an old package with no origin at all counts as nobody's report", () => {
    // Absent means observed — which every record written before this existed was.
    // Counting them as reported would put a warning on years of honest fieldwork.
    expect(reportedCount(pkg([obs({ id: "a" }), obs({ id: "b" })]))).toBe(0);
  });
});

describe("4. the two halves are wired together, not merely present", () => {
  // Read as source because the invariant is structural: someone drops the origin
  // while keeping the position, and the app files another person's ground as an
  // eyewitness record with nothing failing anywhere.
  const read = (rel: string) =>
    require("fs").readFileSync(require("path").join(__dirname, "..", "..", rel), "utf8");

  test("capture prefers a supplied position over the receiver", () => {
    const src = read("lib/field/waypointService.ts");
    expect(src).toContain("input.position ?? positionFromFix(");
  });

  test("capture records an origin, defaulting to observed", () => {
    expect(read("lib/field/waypointService.ts")).toContain('origin: input.origin ?? "observed"');
  });

  test("the package carries the origin to the model", () => {
    expect(read("lib/exploration/evidencePackage.ts"))
      .toContain('origin: w.origin ?? "observed"');
  });

  test("the orchestrator passes both through", () => {
    const src = read("lib/exploration/orchestrator.ts");
    expect(src).toContain("position: input.position");
    expect(src).toContain("origin: input.origin");
  });

  test("ADD PHOTO opens the LIBRARY, so a photograph this phone never took can be filed", () => {
    const src = read("app/(app)/explore/index.tsx");
    expect(src).toContain("launchImageLibraryAsync");
    // The field camera is still the camera; this is the other button.
    expect(read("components/FieldCamera.tsx").length).toBeGreaterThan(0);
  });
});

describe("5. a desk investigation can be finished, not only a walk", () => {
  // The mission lifecycle was gated on physically arriving: START INVESTIGATION,
  // FINISH SECTION and CLOSE only ever appeared to somebody standing on the
  // ground. A target 653 km away — measured on the phone, with the colleague's
  // coordinate entered by hand — could never reach any of the three, so a mission
  // with a full set of evidence attached to it sat in `target_selected` for ever.
  const read = (rel: string) =>
    require("fs").readFileSync(require("path").join(__dirname, "..", "..", rel), "utf8");

  test("a reported observation advances the mission out of target_selected", () => {
    const src = read("lib/exploration/orchestrator.ts");
    expect(src).toMatch(/input\.origin === "reported"[\s\S]{0,120}advanceMission\("arrived_at_target_area"\)/);
  });

  test("the transition it uses is one the state machine already allowed", () => {
    // Not a new door: the same allowance made for a geologist who was already
    // standing in the cell they picked.
    const { canTransition } = require("../exploration/mission");
    expect(canTransition("target_selected", "arrived_at_target_area")).toBe(true);
  });

  test("and from there the rest of the lifecycle is reachable", () => {
    const { canTransition } = require("../exploration/mission");
    expect(canTransition("arrived_at_target_area", "field_investigation")).toBe(true);
    expect(canTransition("field_investigation", "section_completed")).toBe(true);
    expect(canTransition("section_completed", "mission_closed")).toBe(true);
  });

  test("an OBSERVED capture is not advanced by this path", () => {
    // On foot, arrival has already moved the mission on before any observation can
    // be recorded. Advancing again here would be a second, silent arrival.
    const src = read("lib/exploration/orchestrator.ts");
    const block = src.slice(src.indexOf('input.origin === "reported"') - 200,
                            src.indexOf('input.origin === "reported"') + 200);
    expect(block).not.toContain('input.origin === "observed"');
  });

  test("Add waypoint is reachable without having arrived", () => {
    const src = read("app/(app)/explore/index.tsx");
    expect(src).toMatch(/!arrived && s\.state !== "idle"[\s\S]{0,200}setWaypointFormOpen\(true\)/);
  });
});

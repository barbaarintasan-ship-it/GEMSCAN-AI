// Phase 3 — interpreted lineaments are CONTEXT, not a scored signal.
//
// The prospectivity baseline showed the 5,960 Copernicus DEM-derived lineaments
// leak 4.3x and are the DEM/terrain signal restated, so scoring them would
// double-count landform. They are held in ROLES_NOT_SCORED — drawn on the map and
// reported in the coverage/evidence panel, never fed to the numeric score. These
// pin that contract: the engine READS them as context, and they DO NOT move the
// score (which keeps the validated LOO AUC 0.900 baseline intact).
import { prospectivityEvidence, collapseGroups } from "../geo/targeting";
import { coverageAt, dataRolesAt } from "../geo/evidenceCoverage";
import { ROLES_NOT_SCORED } from "../geo/evidenceRoles";
import { computeConfidence } from "../../../shared/geo-core/confidence.ts";
import type { GeoContext } from "../../../shared/geo-core/types.ts";
import type { PackData, PackMapFeature } from "../../../shared/geo-core/pack/types.ts";

const AT = { lat: 9.94, lng: 43.13 };
const R = 5000;

const ctx = (): GeoContext => ({
  location: { lat: AT.lat, lng: AT.lng },
  knownOccurrences: [], commodityAssociations: [], communityEvidence: null,
} as unknown as GeoContext);

function pack(features: PackMapFeature[]): PackData {
  return {
    geology: [], occurrences: [], knowledge: [], structures: [], community: [],
    mapFeatures: features, terrain: [], associations: [], rules: [],
    commodities: [], assemblages: [], land: [],
  } as unknown as PackData;
}

function lineament(id: string, latOffsetDeg = 0.001): PackMapFeature {
  const lat = AT.lat + latOffsetDeg;
  return {
    id, kind: "lineament", name: null, source: "copernicus_dem_derived",
    attributes: { confidence: "interpreted" },
    lines: [[[AT.lng - 0.02, lat], [AT.lng + 0.02, lat]]],
    bbox: [AT.lng - 0.02, lat, AT.lng + 0.02, lat],
  } as PackMapFeature;
}

const score = (p: PackData) =>
  computeConfidence(collapseGroups(prospectivityEvidence(ctx(), R, undefined, p))).score;

describe("interpreted lineaments — CONTEXT, not scored", () => {
  it("lineaments is a withheld role (ROLES_NOT_SCORED), like contacts", () => {
    expect(ROLES_NOT_SCORED).toContain("lineaments");
  });

  it("a nearby lineament produces NO scored evidence and does not move the score", () => {
    const items = prospectivityEvidence(ctx(), R, undefined, pack([lineament("L1")]));
    // Nothing was scored from the lineament — no structural/lineament item.
    expect(items).toHaveLength(0);
    // And the score is unchanged from an empty pack (0 either way here).
    expect(score(pack([lineament("L1")]))).toBe(score(pack([])));
  });

  it("but the engine READS it as context: coverage reports lineaments 'not_scored'", () => {
    const cov = coverageAt(pack([lineament("L1")]), new Set(), AT, R);
    const lin = cov.roles.find((r) => r.role === "lineaments");
    expect(lin).toBeDefined();
    // present as data at this point, held out of the score → not_scored.
    expect(lin!.state).toBe("not_scored");
  });

  it("with no lineament nearby, the layer reports empty (no invented structure)", () => {
    const cov = coverageAt(pack([]), new Set(), AT, R);
    const lin = cov.roles.find((r) => r.role === "lineaments");
    expect(lin!.state).toBe("empty_layer");
  });

  it("dataRolesAt sees the lineament layer (map/context), so it is never silent", () => {
    expect(dataRolesAt(pack([lineament("L1")]), AT, R).has("lineaments")).toBe(true);
  });
});

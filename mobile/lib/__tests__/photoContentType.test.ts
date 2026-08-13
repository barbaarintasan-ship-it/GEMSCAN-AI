// The photograph's content type, from the camera to the server.
//
// WHY THIS FILE EXISTS
//
// The object key in R2 ends in an extension, and four things have to agree about
// what that extension is: the local filename, the upload header, the key the
// presigner signs, and the key the database stores. They did not. The presigner
// derived the extension from the content type while the database row and the
// verification pass both hardcoded `.jpg`.
//
// A single PNG would have uploaded perfectly to `…/p.png` and then been recorded
// and searched for at `…/p.jpg`. The verification gate reports a key it cannot
// find as "photograph not in storage" — a WAITING state, not an error — so the
// mission would have sat unanalysed for ever, waiting on a file that was in the
// bucket the whole time, with nothing anywhere saying why.
//
// These tests pin the device half: the type is recorded where the photograph is
// created and carried, unmodified, all the way into the package the server reads.
import {
  DEFAULT_PHOTO_CONTENT_TYPE, type Waypoint, type WaypointPhoto,
} from "../field/waypointTypes";
import { buildEvidencePackage } from "../exploration/evidencePackage";
import type { Mission } from "../exploration/mission";

const NOW = Date.parse("2026-08-10T09:15:00.000Z");
const MISSION_ID = "ms-abc";

function photo(over: Partial<WaypointPhoto> = {}): WaypointPhoto {
  return {
    id: "p1", uri: "file:///photos/p1.jpg", capturedAt: NOW,
    contentType: DEFAULT_PHOTO_CONTENT_TYPE, remotePath: null,
    ...over,
  };
}

function waypoint(over: Partial<Waypoint> = {}): Waypoint {
  return {
    id: "w1", sessionId: "ex-1", trackId: "ex-1", type: "outcrop", name: null,
    notes: "", position: null, heading: null, photos: [],
    missionId: MISSION_ID,
    capturedAt: NOW + 1_000, updatedAt: NOW, syncState: "local", deletedAt: null,
    ...over,
  };
}

function mission(): Mission {
  return {
    id: MISSION_ID, state: "field_investigation", cell: "87abc",
    centre: { lat: 9.5, lng: 45.5 }, hotspot: null, commodity: "gold",
    score: 0.42, startedAt: NOW, arrivedAt: NOW, packageId: null,
  } as Mission;
}

function build(waypoints: Waypoint[]) {
  return buildEvidencePackage({
    mission: mission(), explorationSessionId: "ex-1", waypoints, track: [],
    targetReasons: [], geologyContext: null, terrainContext: null,
    structuralContext: [], coverage: null, at: NOW + 10_000,
  });
}

describe("the content type reaches the package", () => {
  test("a JPEG is carried, not assumed", () => {
    const pkg = build([waypoint({ photos: [photo()] })]);
    expect(pkg.observations[0].photos[0].contentType).toBe("image/jpeg");
  });

  test("a NON-jpeg survives the journey intact — the whole point", () => {
    // If this ever silently became image/jpeg again, the server would compute
    // `.jpg`, the presigner would have signed `.png`, and the mission would hang.
    const pkg = build([waypoint({
      photos: [
        photo({ id: "p1", contentType: "image/png" }),
        photo({ id: "p2", contentType: "image/heic" }),
      ],
    })]);
    expect(pkg.observations[0].photos.map((p) => p.contentType))
      .toEqual(["image/png", "image/heic"]);
  });

  test("a photo saved before the field existed carries none, and that is legal", () => {
    // Everything already on a geologist's phone. The server resolves an absent
    // type to JPEG, which is what those photographs actually are — so their keys
    // are unchanged and nothing already uploaded is orphaned.
    const legacy = { id: "old", uri: "file:///photos/old.jpg", capturedAt: NOW, remotePath: null };
    const pkg = build([waypoint({ photos: [legacy as WaypointPhoto] })]);
    expect(pkg.observations[0].photos[0].contentType).toBeUndefined();
    expect(pkg.observations[0].photos[0].id).toBe("old");
  });

  test("the default is the format the field camera actually writes", () => {
    // persistPhotos names the local file `{photoId}.jpg`. This constant and that
    // filename are one decision; if they part company the key lies about the
    // bytes again.
    expect(DEFAULT_PHOTO_CONTENT_TYPE).toBe("image/jpeg");
  });

  test("remotePath still travels beside it, untouched", () => {
    // Not yet written by anything (the sync layer sets it), but the package has
    // always carried the field and the server ignores it in favour of recomputing
    // the key — a device-chosen key could point at another mission's object.
    const pkg = build([waypoint({ photos: [photo({ remotePath: null })] })]);
    expect(pkg.observations[0].photos[0].remotePath).toBeNull();
  });
});

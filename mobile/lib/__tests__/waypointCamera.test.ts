// Field evidence is photographed with the geological camera.
//
// THE BUG THIS PINS
//
// The Add Waypoint form took its photographs with `ImagePicker.launchCameraAsync`
// — the system camera. No zoom, no focus lock, no burst, and no full-sensor
// capture. Meanwhile a camera built for exactly this job, with all four, already
// existed one screen away and was wired only to the enterprise sample form.
//
// That matters more here than anywhere else in the app: a waypoint photograph IS
// the evidence the AI geologist is later asked to read. The observation with the
// worst available image was the one the assessment would be built on.
//
// WHY THE FIX HAD TO BE A COMPONENT
//
// The obvious repair — `router.push` to the camera route — cannot work from this
// form. The form is a React Native `Modal`, and a modal renders in a native
// window above the router's stack, so the pushed camera would sit behind the very
// form that opened it. So the camera became a component both callers render, and
// the route became a wrapper.
//
// These tests read source. That is unusual and deliberate: "the evidence camera
// is the geological one" is a structural property, and it regresses silently —
// someone swaps a button back to the picker and nothing fails, the photographs
// just quietly get worse.
import * as fs from "fs";
import * as path from "path";

const MOBILE = path.join(__dirname, "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(MOBILE, ...p), "utf8");

/**
 * Source with its comments removed.
 *
 * These files explain themselves at length and the prose names the very
 * identifiers being asserted — the comment above `setCameraOpen` says the words
 * "ImagePicker" and "route". Structure is checked against code, not commentary.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const form = () => code(read("components", "AddWaypointForm.tsx"));
const camera = () => code(read("components", "FieldCamera.tsx"));
const route = () => code(read("app", "(app)", "enterprise", "field-camera.tsx"));

describe("the waypoint form photographs with the geological camera", () => {
  test("it renders FieldCamera, not only the system picker", () => {
    const src = form();
    expect(src).toContain('from "./FieldCamera"');
    expect(src).toContain("<FieldCamera");
  });

  test("the camera is rendered INSIDE the modal, never pushed as a route", () => {
    // A pushed route would render behind this modal. If someone reaches for the
    // router here again, this is what says why they cannot.
    const src = form();
    expect(src).not.toContain("router.push");
    expect(src).not.toContain("expo-router");
    // The FieldCamera sits in its own Modal, so it covers the sheet rather than
    // scrolling around inside it.
    const cam = src.indexOf("<FieldCamera");
    const modal = src.lastIndexOf("<Modal", cam);
    expect(modal).toBeGreaterThan(-1);
  });

  test("the observation survives the photographs being taken", () => {
    // The draft resets on `visible`, and opening the camera must not touch it:
    // notes typed standing on an outcrop are not recoverable if they are lost.
    const src = form();
    expect(src).toContain("setCameraOpen");
    // The reset effect is keyed on `visible` alone — not on the camera flag.
    expect(src).toMatch(/}, \[visible\]\);/);
  });

  test("photographs taken come back as photo uris on the draft", () => {
    expect(form()).toMatch(/onDone=\{\([\s\S]*?setPhotoUris/);
  });
});

describe("there is ONE camera implementation, not two", () => {
  test("the component owns the camera", () => {
    const src = camera();
    expect(src).toContain("<CameraView");
    expect(src).toContain("takePictureAsync");
  });

  test("the route delegates and holds no camera of its own", () => {
    // Two copies would drift, and the copy the waypoint form used would be the
    // one nobody remembered to update.
    const src = route();
    expect(src).toContain("<FieldCamera");
    expect(src).not.toContain("<CameraView");
    expect(src).not.toContain("takePictureAsync");
  });

  test("SHOT_NEEDS is still reachable from the route path", () => {
    // lib/shotNeeds.ts has always imported ShotNeed from here. Moving the camera
    // must not break an import that has nothing to do with the move.
    const src = route();
    expect(src).toContain("SHOT_NEEDS");
    expect(code(read("lib", "shotNeeds.ts")))
      .toContain('from "../app/(app)/enterprise/field-camera"');
  });
});

describe("the zoom the geologist asked for", () => {
  test("zoom is wired to the camera, and has stops to tap", () => {
    const src = camera();
    expect(src).toContain("zoom={zoom}");
    expect(src).toContain("ZOOM_STOPS");
    expect(src).toContain("setZoom");
  });

  test("the stops span the whole range the lens offers", () => {
    // expo-camera takes zoom as 0..1 across the lens's real range, so the first
    // and last stops are the ends of it. A set that stopped short would put
    // magnification the device has behind no control at all.
    const stops = camera().match(/const ZOOM_STOPS = \[([^\]]+)\]/);
    expect(stops).not.toBeNull();
    const values = stops![1].split(",").map((s) => Number(s.trim()));
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(1);
    expect(values.length).toBeGreaterThanOrEqual(3);
    // Ascending, so the chips read left to right as increasing magnification.
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  test("the close-range pair — zoom AND focus lock — are both present", () => {
    // expo-camera exposes no macro lens. Optical zoom plus a held focus is what
    // actually works on a hand specimen, and the camera says so.
    const src = camera();
    expect(src).toContain("autofocus={locked");
    expect(src).toContain("setLocked");
  });
});

describe("the capture settings the analysis depends on", () => {
  test("full sensor resolution is chosen, not the default", () => {
    // A downscaled photo of a sulphide speck is what the analysis cannot recover
    // from. The picker gave no say in this at all.
    const src = camera();
    expect(src).toContain("getAvailablePictureSizesAsync");
    expect(src).toContain("pictureSize={pictureSize}");
  });

  test("EXIF is kept, so a portrait outcrop does not arrive rotated", () => {
    expect(camera()).toContain("exif: true");
  });

  test("quality is capped below 1 — a field phone has to survive the traverse", () => {
    const q = camera().match(/quality:\s*([0-9.]+)/);
    expect(q).not.toBeNull();
    expect(Number(q![1])).toBeLessThan(1);
    expect(Number(q![1])).toBeGreaterThanOrEqual(0.8);
  });
});

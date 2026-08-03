// Unit tests for the GIE VISION stage (mocked AI; no key, no network).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildVisionPrompt, parseVisionResponse, runVision, visualEvidence,
  MAX_VISION_IMAGES, MAX_VISION_BYTES, MAX_SINGLE_IMAGE_BYTES,
  type VisionDeps, type VisionImage,
} from "./vision.ts";

Deno.test("parseVisionResponse reads {observations:[…]} and validates", () => {
  const obs = parseVisionResponse(JSON.stringify({
    observations: [
      { statement: "Coarse-grained interlocking crystals", aspect: "texture", clarity: 0.8 },
      { statement: "White vein cross-cutting", aspect: "vein", clarity: 1.5 },   // clamped
      { statement: "milky mineral", aspect: "bogus", clarity: 0.5 },              // aspect → other
      { statement: "   ", aspect: "color", clarity: 0.9 },                        // dropped (empty)
    ],
  }));
  assertEquals(obs.length, 3);
  assertEquals(obs[1].clarity, 1);          // clamped to 1
  assertEquals(obs[2].aspect, "other");     // invalid aspect normalised
});

Deno.test("parseVisionResponse tolerates markdown fences and bare arrays", () => {
  const fenced = "```json\n[{\"statement\":\"reddish staining\",\"aspect\":\"weathering\",\"clarity\":0.6}]\n```";
  const obs = parseVisionResponse(fenced);
  assertEquals(obs.length, 1);
  assertEquals(obs[0].aspect, "weathering");
});

Deno.test("parseVisionResponse returns [] on garbage / empty", () => {
  assertEquals(parseVisionResponse("not json").length, 0);
  assertEquals(parseVisionResponse(JSON.stringify({ observations: [] })).length, 0);
});

Deno.test("visualEvidence maps to visual observation nodes scaled by image quality", () => {
  const nodes = visualEvidence([{ statement: "quartz vein", statementSo: "silig quartz", aspect: "vein", clarity: 0.8 }], 0.5);
  assertEquals(nodes.length, 1);
  assertEquals(nodes[0].evType, "visual");
  assert(nodes[0].isObservation);
  assertEquals(nodes[0].tier, "ai_visual");
  assertEquals(nodes[0].quality, 0.4); // 0.8 × 0.5
});

Deno.test("runVision short-circuits with no images", async () => {
  let called = false;
  const deps: VisionDeps = {
    fetchImageBase64: () => { called = true; return Promise.resolve({ base64: "x", mimeType: "image/jpeg" }); },
    generate: () => Promise.resolve("[]"),
  };
  assertEquals((await runVision([], deps)).length, 0);
  assert(!called);
});

Deno.test("runVision fetches images, calls generate, parses result", async () => {
  let sawImages = 0;
  const deps: VisionDeps = {
    fetchImageBase64: (u) => Promise.resolve({ base64: `b64:${u}`, mimeType: "image/jpeg" }),
    generate: (prompt, images) => {
      sawImages = images.length;
      assert(prompt.includes("exploration geologist"));
      return Promise.resolve(JSON.stringify({ observations: [{ statement: "granitic texture", aspect: "texture", clarity: 0.7 }] }));
    },
  };
  const obs = await runVision(["u1.jpg", "u2.jpg"], deps);
  assertEquals(sawImages, 2);
  assertEquals(obs[0].statement, "granitic texture");
});

Deno.test("buildVisionPrompt forbids identification", () => {
  const p = buildVisionPrompt();
  assert(/do not identify/i.test(p));
});

// ── Image-count ceiling (the "samples stuck at submitted" outage) ────────────
//
// Every image is downloaded, base64-encoded and inlined into ONE request. A
// sample with 27 photos therefore built a payload far beyond both the Edge
// Function's memory ceiling and Gemini's inline limit, the request died, and
// the sample sat at "submitted" forever. Samples with 2-5 photos were fine.
Deno.test("runVision caps how many images reach the model", async () => {
  const urls = Array.from({ length: 27 }, (_, i) => `https://example.test/${i}.jpg`);
  let fetched = 0;
  let sentCount = 0;
  const obs = await runVision(urls, {
    fetchImageBase64: (_u) => {
      fetched++;
      return Promise.resolve({ base64: "AAAA", mimeType: "image/jpeg" });
    },
    generate: (_p, images) => {
      sentCount = images.length;
      return Promise.resolve(JSON.stringify({ observations: [] }));
    },
  });
  assertEquals(fetched, MAX_VISION_IMAGES, "must not download more than the cap");
  assertEquals(sentCount, MAX_VISION_IMAGES, "must not inline more than the cap");
  assertEquals(obs, []);
});

Deno.test("runVision still sends everything when under the cap", async () => {
  let sentCount = 0;
  await runVision(["a", "b", "c"], {
    fetchImageBase64: () => Promise.resolve({ base64: "AAAA", mimeType: "image/jpeg" }),
    generate: (_p, images) => {
      sentCount = images.length;
      return Promise.resolve(JSON.stringify({ observations: [] }));
    },
  });
  assertEquals(sentCount, 3);
});

Deno.test("runVision with no images makes no call at all", async () => {
  let called = false;
  const obs = await runVision([], {
    fetchImageBase64: () => { called = true; return Promise.resolve({ base64: "", mimeType: "" }); },
    generate: () => { called = true; return Promise.resolve("{}"); },
  });
  assertEquals(called, false);
  assertEquals(obs, []);
});

// ── The budget is BYTES, not photo count ────────────────────────────────────
//
// Written against the real production figures. Capping the COUNT at six passed
// every test that existed and fixed nothing, because "Guri" failed on three
// photos while "Sample" succeeded on five. These tests use those exact sizes so
// the wrong axis cannot be chosen again.

const MB = 1024 * 1024;

/**
 * An image whose FILE size is `mb`.
 *
 * base64 inflates by a third, and the budget is measured on the encoded length
 * because that is what goes on the wire. Modelling the file size as the encoded
 * size would make every figure here a third too small — and the production
 * numbers quoted below are file sizes.
 */
const BASE64_INFLATION = 4 / 3;
function image(fileMb: number): VisionImage {
  return { base64: "x".repeat(Math.round(fileMb * MB * BASE64_INFLATION)), mimeType: "image/jpeg" };
}

function depsFor(sizesMb: number[], seen: { images?: VisionImage[] } = {}): VisionDeps {
  const byUrl = new Map(sizesMb.map((mb, i) => [`u${i}`, image(mb)]));
  return {
    fetchImageBase64: (url) => Promise.resolve(byUrl.get(url)!),
    generate: (_p, images) => {
      seen.images = images;
      return Promise.resolve('{"observations":[{"statement":"quartz","statement_so":"quartz","aspect":"vein","clarity":0.8}]}');
    },
  };
}
const urls = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);

Deno.test("Guri: three 4.42 MB photos — the count was fine, the bytes were not", async () => {
  const seen: { images?: VisionImage[] } = {};
  await runVision(urls(3), depsFor([4.42, 4.42, 4.42], seen));
  const total = seen.images!.reduce((a, im) => a + im.base64.length, 0);
  assertEquals(total <= MAX_VISION_BYTES, true);
  // At least one photo still reaches the model — degraded, not discarded.
  assertEquals(seen.images!.length >= 1, true);
});

Deno.test("Sample: five 0.10 MB photos all go through untouched", async () => {
  const seen: { images?: VisionImage[] } = {};
  await runVision(urls(5), depsFor([0.1, 0.1, 0.1, 0.1, 0.1], seen));
  assertEquals(seen.images!.length, 5);
});

Deno.test("Qardho buur: 27 photos at 5.04 MB stay inside the budget", async () => {
  const seen: { images?: VisionImage[] } = {};
  await runVision(urls(27), depsFor(Array(27).fill(5.04), seen));
  const total = (seen.images ?? []).reduce((a, im) => a + im.base64.length, 0);
  assertEquals(total <= MAX_VISION_BYTES, true);
  assertEquals((seen.images ?? []).length <= MAX_VISION_IMAGES, true);
  // Something still reaches the model rather than the whole set being dropped.
  assertEquals((seen.images ?? []).length >= 1, true);
});

Deno.test("Qarka Qardhl: 6.94 MB photos exceed even the single-image limit", async () => {
  let generated = false;
  const obs = await runVision(urls(11), {
    fetchImageBase64: () => Promise.resolve(image(6.94)),
    generate: () => { generated = true; return Promise.resolve("{}"); },
  });
  // No visual evidence, and that is the right answer: the assessment rests on
  // the geological providers. What must NOT happen is a throw, which is what
  // left this sample at "submitted" for seven hours.
  assertEquals(obs, []);
  assertEquals(generated, false);
});

Deno.test("a single oversized frame is skipped, not allowed to eat the budget", async () => {
  const seen: { images?: VisionImage[] } = {};
  // One 9 MB monster followed by four usable photos.
  await runVision(urls(5), depsFor([9, 0.5, 0.5, 0.5, 0.5], seen));
  assertEquals(seen.images!.length, 4);
  for (const im of seen.images!) assertEquals(im.base64.length <= MAX_SINGLE_IMAGE_BYTES, true);
});

Deno.test("a dead image URL costs that image, not the assessment", async () => {
  const seen: { images?: VisionImage[] } = {};
  const good = depsFor([0.5, 0.5], seen);
  const obs = await runVision(["u0", "broken", "u1"], {
    fetchImageBase64: (u) => u === "broken"
      ? Promise.reject(new Error("image fetch failed (403)"))
      : good.fetchImageBase64(u),
    generate: good.generate,
  });
  assertEquals(seen.images!.length, 2);
  assertEquals(obs.length, 1);
});

Deno.test("if every photo is too large, vision returns empty rather than throwing", async () => {
  let generated = false;
  const obs = await runVision(urls(3), {
    fetchImageBase64: () => Promise.resolve(image(9)),
    generate: () => { generated = true; return Promise.resolve("{}"); },
  });
  // Throwing here would strand the sample — the exact failure this path exists
  // to prevent. The geological providers still produce a real assessment.
  assertEquals(obs, []);
  assertEquals(generated, false);
});

// Unit tests for the GIE VISION stage (mocked AI; no key, no network).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildVisionPrompt, parseVisionResponse, runVision, visualEvidence, type VisionDeps , MAX_VISION_IMAGES} from "./vision.ts";

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

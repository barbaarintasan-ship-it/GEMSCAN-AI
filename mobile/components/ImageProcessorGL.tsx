// ImageProcessorGL
//
// A hidden, always-mounted GL surface that implements:
//   - Stage 1 automatic image quality validation (blur + exposure check)
//   - Stage 3 on-device image enhancement (gray-world white balance,
//     exposure/contrast correction, unsharp-mask sharpening)
// entirely on-device, before anything is uploaded to the cloud AI ensemble.
//
// Why one shared hidden component instead of a plain utility module: expo-gl
// requires a mounted <GLView> to obtain a WebGL context, so both stages share
// one GL context/program via this component's imperative ref API rather than
// each screen re-creating its own GL surface.
//
// Known trade-off (documented, not accidental): the enhancement output is a
// fixed square canvas (ENHANCE_OUTPUT_SIZE x ENHANCE_OUTPUT_SIZE) using a
// "cover" crop of the source image, which sacrifices exact source aspect
// ratio for a much simpler, more robust offscreen-rendering implementation.
// If preserving the exact aspect ratio becomes a priority, switch to
// dynamically resizing the GLView per image and re-measuring via onLayout
// before drawing.
import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import * as ImageManipulator from "expo-image-manipulator";
import { computeDetectionFromPixels, type GemstoneDetection } from "../lib/gemstoneDetector";

const ANALYSIS_SIZE = 96; // small + cheap for blur/exposure sampling
const ENHANCE_OUTPUT_SIZE = 1024; // final size sent onward to Stage 4 cloud AI

// How long a GL operation will WAIT for the context to finish initializing
// before giving up. expo-gl creates the WebGL context asynchronously (via
// GLView.onContextCreate) after the view mounts, so the very first live-scan
// frames can arrive before the context exists. Rather than throwing
// "GL context not ready" on those early frames (the bug users saw), callers
// now await readiness up to this budget. On a healthy device the context is
// ready in well under a second; this is only a ceiling.
const GL_READY_TIMEOUT_MS = 5000;

export type QualityAssessment = {
  qualityScore: number; // 0-1, higher is better
  blurry: boolean;
  lowLight: boolean;
  overexposed: boolean;
  meanBrightness: number; // 0-1
  sharpness: number; // arbitrary Laplacian-variance-like unit, higher = sharper
};

export type ImageProcessorHandle = {
  assessQuality: (uri: string) => Promise<QualityAssessment>;
  // Live-scan combined pass: from a SINGLE downscale + readPixels, returns both
  // the Stage 1 quality assessment and the on-device gemstone object-detection
  // result. Used by the real-time scanner so per-frame detection gating costs
  // nothing beyond the quality sampling it already does.
  analyzeFrame: (uri: string) => Promise<{ quality: QualityAssessment; detection: GemstoneDetection }>;
  enhance: (uri: string) => Promise<{ uri: string }>;
};

const QUALITY_THRESHOLDS = {
  blurSharpnessMin: 4, // below this, flag as blurry
  lowLightBrightnessMax: 0.18,
  overexposedBrightnessMin: 0.92,
};

const VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUV;
void main() {
  vUV = vec2(aPosition.x * 0.5 + 0.5, 1.0 - (aPosition.y * 0.5 + 0.5));
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// Pass-through (used for the quality-analysis draw — no processing, we just
// need the pixels of the source image on a GPU surface so we can readPixels).
const PASSTHROUGH_FRAGMENT_SHADER = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTexture;
void main() {
  gl_FragColor = texture2D(uTexture, vUV);
}
`;

// Stage 3 enhancement: gray-world white balance + exposure/contrast gain +
// unsharp-mask sharpening, all in one pass.
const ENHANCE_FRAGMENT_SHADER = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTexture;
uniform vec3 uWBGain;
uniform float uExposureGain;
uniform vec2 uTexelSize;
uniform float uSharpenAmount;

void main() {
  vec3 color = texture2D(uTexture, vUV).rgb;

  vec3 n = texture2D(uTexture, vUV + vec2(0.0, uTexelSize.y)).rgb;
  vec3 s = texture2D(uTexture, vUV - vec2(0.0, uTexelSize.y)).rgb;
  vec3 e = texture2D(uTexture, vUV + vec2(uTexelSize.x, 0.0)).rgb;
  vec3 w = texture2D(uTexture, vUV - vec2(uTexelSize.x, 0.0)).rgb;
  vec3 blurred = (n + s + e + w) * 0.25;
  vec3 sharpened = color + uSharpenAmount * (color - blurred);

  vec3 balanced = sharpened * uWBGain;
  vec3 exposed = (balanced - 0.5) * uExposureGain + 0.5;

  gl_FragColor = vec4(clamp(exposed, 0.0, 1.0), 1.0);
}
`;

function compileShader(gl: ExpoWebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

function linkProgram(
  gl: ExpoWebGLRenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    throw new Error(`Program link error: ${info}`);
  }
  return program;
}

function setupQuad(gl: ExpoWebGLRenderingContext, program: WebGLProgram) {
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]),
    gl.STATIC_DRAW,
  );
  const aPosition = gl.getAttribLocation(program, "aPosition");
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
}

// Create (once) an offscreen framebuffer with a `size`x`size` RGBA colour
// texture attachment, so GL passes render into a correctly-sized target rather
// than the 1x1 DEFAULT framebuffer of the hidden GLView. Reading/snapshotting
// the default framebuffer returned an almost-entirely-zero buffer (the view is
// 1px), which made on-device quality + gemstone detection garbage. Returns the
// cached target on subsequent calls (kept for the GL context lifetime).
function ensureRenderTarget(
  gl: ExpoWebGLRenderingContext,
  cache: { current: { fbo: WebGLFramebuffer; tex: WebGLTexture } | null },
  size: number,
): WebGLFramebuffer {
  if (cache.current) return cache.current.fbo;
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindTexture(gl.TEXTURE_2D, null);
  cache.current = { fbo, tex };
  return fbo;
}

async function loadTexture(
  gl: ExpoWebGLRenderingContext,
  uri: string,
): Promise<WebGLTexture> {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // expo-gl's texImage2D accepts a { uri } source and decodes/uploads the
  // image natively — no HTMLImageElement / three.js texture loader needed.
  await (gl as unknown as {
    texImage2D: (...args: unknown[]) => Promise<void>;
  }).texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, { uri } as never);
  return texture;
}

export function computeQualityFromPixels(pixels: Uint8Array, size: number): QualityAssessment {
  const gray = new Float32Array(size * size);
  let brightnessSum = 0;

  for (let i = 0; i < size * size; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    gray[i] = luminance;
    brightnessSum += luminance;
  }

  const meanBrightness = brightnessSum / (size * size);

  // Laplacian-variance-style sharpness estimate over the small grayscale
  // grid: convolve with a simple edge kernel and take the variance of the
  // response. Low variance = few sharp edges = likely blurry.
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const idx = y * size + x;
      const laplacian =
        4 * gray[idx] - gray[idx - 1] - gray[idx + 1] - gray[idx - size] - gray[idx + size];
      sum += laplacian;
      sumSq += laplacian * laplacian;
      count++;
    }
  }
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  const sharpness = variance * 1000; // scale to a more human-readable range

  const blurry = sharpness < QUALITY_THRESHOLDS.blurSharpnessMin;
  const lowLight = meanBrightness < QUALITY_THRESHOLDS.lowLightBrightnessMax;
  const overexposed = meanBrightness > QUALITY_THRESHOLDS.overexposedBrightnessMin;

  let qualityScore = 1;
  if (blurry) qualityScore -= 0.5;
  if (lowLight || overexposed) qualityScore -= 0.35;
  qualityScore = Math.max(0, Math.min(1, qualityScore));

  return { qualityScore, blurry, lowLight, overexposed, meanBrightness, sharpness };
}

export const ImageProcessorGL = forwardRef<ImageProcessorHandle>((_props, ref) => {
  const glRef = useRef<ExpoWebGLRenderingContext | null>(null);
  const passthroughProgramRef = useRef<WebGLProgram | null>(null);
  const enhanceProgramRef = useRef<WebGLProgram | null>(null);
  // Offscreen render targets — see ensureRenderTarget. One 96x96 target for the
  // analysis/proxy reads, one 1024x1024 for the final enhancement snapshot.
  const analysisTargetRef = useRef<{ fbo: WebGLFramebuffer; tex: WebGLTexture } | null>(null);
  const enhanceTargetRef = useRef<{ fbo: WebGLFramebuffer; tex: WebGLTexture } | null>(null);

  // Readiness gate. expo-gl's onContextCreate fires asynchronously after the
  // <GLView> mounts, so any method invoked before then would previously throw
  // "GL context not ready". Instead we expose a promise that resolves the moment
  // the context + shader programs are built, and callers await it (bounded by
  // GL_READY_TIMEOUT_MS). `readyResolveRef` is the resolver captured so
  // onContextCreate can fulfil the promise; `readyRef` is a boolean fast-path so
  // a warm context skips the promise machinery entirely.
  const readyRef = useRef(false);
  const readyResolveRef = useRef<(() => void) | null>(null);
  // Lazily create the readiness promise EXACTLY once. Passing `new Promise(...)`
  // straight to useRef would re-run the executor on every re-render (this
  // propless component re-renders whenever its parent does), each time replacing
  // readyResolveRef with a resolver for a promise that's immediately discarded —
  // stranding the real promise. The null-guard constructs it a single time.
  const readyPromiseRef = useRef<Promise<void> | null>(null);
  if (readyPromiseRef.current === null) {
    readyPromiseRef.current = new Promise<void>((resolve) => {
      readyResolveRef.current = resolve;
    });
  }

  // Resolve (once) when the GL context and both shader programs are ready.
  function markGLReady() {
    if (readyRef.current) return;
    readyRef.current = true;
    readyResolveRef.current?.();
  }

  // Await GL readiness, up to `timeoutMs`. Resolves to true if the context
  // became ready in time, false if the budget elapsed first (device never
  // produced a context — genuinely broken GL, or GLView never mounted).
  function waitForGL(timeoutMs: number): Promise<boolean> {
    if (readyRef.current && glRef.current && passthroughProgramRef.current) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      readyPromiseRef.current?.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  // Shared for assessQuality + analyzeFrame: downscale the source and read back
  // the small RGBA grid once, so a live frame that needs both quality and
  // detection only pays for a single manipulate + GL draw + readPixels.
  async function readAnalysisPixels(uri: string): Promise<Uint8Array> {
    // Wait for the GL context to finish initializing before touching it. On a
    // healthy device this resolves almost immediately; only a device that never
    // produces a context will hit the timeout.
    const ready = await waitForGL(GL_READY_TIMEOUT_MS);

    // Downscale first via expo-image-manipulator (cheap, native, and
    // guarantees the texture we hand to GL is already small) rather than
    // relying on GL alone to do the downsampling.
    const resized = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: ANALYSIS_SIZE, height: ANALYSIS_SIZE } }],
      { compress: 1, format: ImageManipulator.SaveFormat.PNG },
    );

    const gl = glRef.current;
    if (!ready || !gl || !passthroughProgramRef.current) {
      throw new Error(
        `GL context unavailable after ${GL_READY_TIMEOUT_MS}ms — cannot analyze frame`,
      );
    }

    // Render into the 96x96 offscreen framebuffer (NOT the 1x1 default one).
    const target = ensureRenderTarget(gl, analysisTargetRef, ANALYSIS_SIZE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);
    gl.useProgram(passthroughProgramRef.current);
    setupQuad(gl, passthroughProgramRef.current);

    const texture = await loadTexture(gl, resized.uri);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(passthroughProgramRef.current, "uTexture"), 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.flush();

    const pixels = new Uint8Array(ANALYSIS_SIZE * ANALYSIS_SIZE * 4);
    gl.readPixels(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.deleteTexture(texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return pixels;
  }

  useImperativeHandle(ref, () => ({
    async assessQuality(uri: string) {
      const pixels = await readAnalysisPixels(uri);
      return computeQualityFromPixels(pixels, ANALYSIS_SIZE);
    },

    async analyzeFrame(uri: string) {
      const pixels = await readAnalysisPixels(uri);
      return {
        quality: computeQualityFromPixels(pixels, ANALYSIS_SIZE),
        detection: computeDetectionFromPixels(pixels, ANALYSIS_SIZE),
      };
    },

    async enhance(uri: string) {
      // Wait for GL, then produce a CPU-resized copy. That copy doubles as the
      // graceful fallback: if the context never initializes we still return a
      // correctly-sized (just un-enhanced) image so the scan can proceed rather
      // than failing outright.
      const ready = await waitForGL(GL_READY_TIMEOUT_MS);

      const resized = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: ENHANCE_OUTPUT_SIZE, height: ENHANCE_OUTPUT_SIZE } }],
        { compress: 1, format: ImageManipulator.SaveFormat.PNG },
      );

      const gl = glRef.current;
      if (!ready || !gl || !enhanceProgramRef.current || !passthroughProgramRef.current) {
        // Graceful fallback: hand back the CPU-resized original unenhanced. The
        // cloud ensemble still receives a valid, correctly-sized image.
        return { uri: resized.uri };
      }

      // First, sample a small proxy of the source to compute gray-world
      // white balance gains + an exposure gain, without doing that math on
      // the full-resolution image.
      const proxy = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: ANALYSIS_SIZE, height: ANALYSIS_SIZE } }],
        { compress: 1, format: ImageManipulator.SaveFormat.PNG },
      );
      const proxyTarget = ensureRenderTarget(gl, analysisTargetRef, ANALYSIS_SIZE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, proxyTarget);
      gl.viewport(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);
      gl.useProgram(passthroughProgramRef.current);
      setupQuad(gl, passthroughProgramRef.current);
      const proxyTexture = await loadTexture(gl, proxy.uri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, proxyTexture);
      gl.uniform1i(gl.getUniformLocation(passthroughProgramRef.current, "uTexture"), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.flush();
      const proxyPixels = new Uint8Array(ANALYSIS_SIZE * ANALYSIS_SIZE * 4);
      gl.readPixels(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, proxyPixels);
      gl.deleteTexture(proxyTexture);

      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      const pixelCount = ANALYSIS_SIZE * ANALYSIS_SIZE;
      for (let i = 0; i < pixelCount; i++) {
        rSum += proxyPixels[i * 4];
        gSum += proxyPixels[i * 4 + 1];
        bSum += proxyPixels[i * 4 + 2];
      }
      const rMean = rSum / pixelCount / 255;
      const gMean = gSum / pixelCount / 255;
      const bMean = bSum / pixelCount / 255;
      const grayMean = (rMean + gMean + bMean) / 3;

      const clampGain = (g: number) => Math.max(0.7, Math.min(1.4, g));
      const wbGain: [number, number, number] = [
        clampGain(grayMean / Math.max(rMean, 0.01)),
        clampGain(grayMean / Math.max(gMean, 0.01)),
        clampGain(grayMean / Math.max(bMean, 0.01)),
      ];

      // Push overall brightness toward mid-gray (~0.45-0.5), clamped so we
      // never wildly over/under-correct a single frame.
      const targetBrightness = 0.47;
      const exposureGain = Math.max(0.6, Math.min(1.6, targetBrightness / Math.max(grayMean, 0.05)));

      // Now render the full-resolution enhancement pass into the 1024x1024
      // offscreen framebuffer (NOT the 1x1 default one) and snapshot THAT.
      const enhanceTarget = ensureRenderTarget(gl, enhanceTargetRef, ENHANCE_OUTPUT_SIZE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, enhanceTarget);
      gl.viewport(0, 0, ENHANCE_OUTPUT_SIZE, ENHANCE_OUTPUT_SIZE);
      gl.useProgram(enhanceProgramRef.current);
      setupQuad(gl, enhanceProgramRef.current);

      const texture = await loadTexture(gl, resized.uri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(enhanceProgramRef.current, "uTexture"), 0);
      gl.uniform3f(
        gl.getUniformLocation(enhanceProgramRef.current, "uWBGain"),
        wbGain[0],
        wbGain[1],
        wbGain[2],
      );
      gl.uniform1f(gl.getUniformLocation(enhanceProgramRef.current, "uExposureGain"), exposureGain);
      gl.uniform2f(
        gl.getUniformLocation(enhanceProgramRef.current, "uTexelSize"),
        1 / ENHANCE_OUTPUT_SIZE,
        1 / ENHANCE_OUTPUT_SIZE,
      );
      gl.uniform1f(gl.getUniformLocation(enhanceProgramRef.current, "uSharpenAmount"), 0.5);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.endFrameEXP();
      gl.deleteTexture(texture);

      const snapshot = await GLView.takeSnapshotAsync(gl, {
        framebuffer: enhanceTarget,
        rect: { x: 0, y: 0, width: ENHANCE_OUTPUT_SIZE, height: ENHANCE_OUTPUT_SIZE },
        format: "jpeg",
        compress: 0.9,
        flip: false,
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      if (!snapshot.uri || typeof snapshot.uri !== "string") {
        throw new Error("GL snapshot did not return a file URI");
      }

      return { uri: snapshot.uri };
    },
  }));

  return (
    <GLView
      style={{ position: "absolute", top: -9999, left: -9999, width: 1, height: 1 }}
      onContextCreate={(gl: ExpoWebGLRenderingContext) => {
        glRef.current = gl;
        passthroughProgramRef.current = linkProgram(
          gl,
          VERTEX_SHADER,
          PASSTHROUGH_FRAGMENT_SHADER,
        );
        enhanceProgramRef.current = linkProgram(gl, VERTEX_SHADER, ENHANCE_FRAGMENT_SHADER);
        // Context + both programs are live — release any callers awaiting
        // readiness. Only mark ready once everything a method needs exists.
        markGLReady();
      }}
    />
  );
});

ImageProcessorGL.displayName = "ImageProcessorGL";

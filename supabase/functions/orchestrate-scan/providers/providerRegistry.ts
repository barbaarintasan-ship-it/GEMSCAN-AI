// Central registry of every provider in the ensemble.
//
// THIS is the one file you touch to add a new AI vendor. Write a new adapter
// implementing `VisionProvider` (see types.ts) and add it to this array —
// nothing in index.ts or ensemble.ts needs to know it exists. Each provider
// declares its own `isApplicable()` and `baseWeight`, so the orchestration
// loop and the ensemble math stay generic.
import type { VisionProvider } from "./types.ts";
import { onDeviceClassifierProvider } from "./onDeviceClassifier.ts";
import { geminiVisionProvider } from "./geminiVision.ts";
import { openaiVisionProvider } from "./openaiVision.ts";
import { claudeVisionProvider } from "./claudeVision.ts";
import { hallmarkOcrProvider } from "./hallmarkOcr.ts";
import { geologicalContextProvider } from "./geologicalContext.ts";

export const providerRegistry: VisionProvider[] = [
  onDeviceClassifierProvider,
  geminiVisionProvider,
  openaiVisionProvider,
  claudeVisionProvider,
  hallmarkOcrProvider,
  geologicalContextProvider,
];

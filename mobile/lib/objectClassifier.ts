// STAGE 1 — On-device object classification (the cost gate).
//
// Before any cloud AI runs, we classify the object in frame so we can reject
// clearly-unsupported things (food, a person, an animal, furniture, …) WITHOUT
// spending a Gemini/OpenAI/Claude call. Implemented with TensorFlow.js +
// MobileNet running fully on-device.
//
// Design notes / honesty:
//  - MobileNet is an ImageNet classifier. It is excellent at recognising the
//    common INVALID categories the spec lists (people, animals, food, everyday
//    household objects) but it does NOT have fine gemstone/mineral classes. So
//    we use it as a REJECTER: a confident invalid match stops the scan; anything
//    it is unsure about is treated as "possibly a specimen" and allowed through
//    to the (better-qualified) cloud ensemble.
//  - It is BEST-EFFORT and FAILS OPEN. tfjs-react-native is unmaintained and the
//    device's WebGL runtime has been unreliable, so if TF can't initialise we
//    return { available: false, supported: true } and the scan simply proceeds.
//    The gate is a cost optimisation, never a hard dependency for scanning.
//  - We force the CPU backend: this device's GL/WebGL has been failing, and a
//    one-shot MobileNet classify on CPU (~1–2s) is an acceptable price.
import * as FileSystem from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";

export type ObjectCategory =
  | "gemstone"
  | "rock"
  | "mineral"
  | "gold"
  | "silver"
  | "metal"
  | "coin"
  | "jewelry"
  | "artifact"
  | "unknown"
  | "not_supported";

export type ClassificationResult = {
  category: ObjectCategory;
  rawLabel: string;
  confidence: number;
  supported: boolean; // proceed to guided capture + cloud?
  available: boolean; // did the on-device model actually run?
};

// MobileNet input size.
const MODEL_INPUT = 224;
// Minimum probability for a confident invalid rejection.
const INVALID_MIN_PROB = 0.3;

// ImageNet class-name keywords that mean "definitely not a specimen we support".
const INVALID_KEYWORDS = [
  "person", "man", "woman", "boy", "girl", "baby", "face", "head",
  "dog", "cat", "puppy", "kitten", "bird", "fish", "animal", "insect", "spider",
  "retriever", "terrier", "poodle", "cattle", "horse", "sheep", "monkey",
  "food", "fruit", "banana", "apple", "orange", "lemon", "pineapple", "strawberry",
  "pizza", "burger", "cheeseburger", "sandwich", "hotdog", "bread", "bagel",
  "plate", "bowl", "cup", "mug", "bottle", "wine", "coffee", "meal", "soup",
  "chair", "couch", "sofa", "table", "desk", "bed", "bench", "furniture",
  "book", "notebook", "paper", "envelope", "menu", "carton", "packet",
  "shirt", "jersey", "sock", "shoe", "sandal", "hat", "sunglass", "clothing",
  "plant", "flower", "tree", "leaf", "pot",
  "car", "truck", "bicycle", "keyboard", "mouse", "remote", "laptop", "cellphone",
  "screen", "monitor", "television", "printer",
];

// Keyword → supported category. Order matters (first match wins).
const CATEGORY_KEYWORDS: [ObjectCategory, string[]][] = [
  ["coin", ["coin", "nickel", "penny", "dime", "medal", "medallion"]],
  ["jewelry", ["necklace", "ring", "bracelet", "earring", "brooch", "pendant", "bangle"]],
  ["gold", ["gold", "bullion", "ingot"]],
  ["silver", ["silver"]],
  ["metal", ["metal", "steel", "iron", "buckle", "nail", "screw", "bolt", "chain", "hardware"]],
  ["artifact", ["vase", "pottery", "pot", "sculpture", "statue", "relic", "urn", "amphora"]],
  ["gemstone", ["gem", "jewel", "crystal", "quartz", "opal", "diamond", "agate", "amber", "prism"]],
  ["rock", ["rock", "stone", "boulder", "geode"]],
  ["mineral", ["mineral", "ore"]],
];

type Predictions = { className: string; probability: number }[];

// Lazy singleton model. Never throws out of ensureModel — resolves to a boolean.
let model: { classify: (t: unknown, n?: number) => Promise<Predictions> } | null = null;
let decodeJpegFn: ((b: Uint8Array) => unknown) | null = null;
let tfNs: { ready: () => Promise<void>; setBackend: (b: string) => Promise<boolean>; dispose: (t: unknown) => void } | null = null;
let initPromise: Promise<boolean> | null = null;

async function ensureModel(): Promise<boolean> {
  if (model && decodeJpegFn && tfNs) return true;
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const tf = await import("@tensorflow/tfjs");
        const rn = await import("@tensorflow/tfjs-react-native");
        await tf.ready();
        // Prefer CPU — this device's WebGL has been unreliable.
        try {
          await tf.setBackend("cpu");
        } catch {
          /* keep whatever backend initialised */
        }
        const mobilenet = await import("@tensorflow-models/mobilenet");
        const loaded = await mobilenet.load({ version: 2, alpha: 1.0 });
        model = loaded as unknown as typeof model;
        decodeJpegFn = (rn as unknown as { decodeJpeg: (b: Uint8Array) => unknown }).decodeJpeg;
        tfNs = tf as unknown as typeof tfNs;
        return true;
      } catch {
        model = null;
        return false;
      }
    })();
  }
  return initPromise;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob ? globalThis.atob(b64) : decodeBase64Fallback(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Minimal base64 decode for environments without atob.
function decodeBase64Fallback(b64: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let str = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of b64.replace(/=+$/, "")) {
    const idx = chars.indexOf(ch);
    if (idx === -1) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      str += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return str;
}

function mapPredictions(preds: Predictions): ClassificationResult {
  const top = preds[0] ?? { className: "", probability: 0 };
  const hay = (s: string) => s.toLowerCase();

  // 1) Confident INVALID → reject before any cloud call.
  for (const p of preds) {
    const name = hay(p.className);
    if (p.probability >= INVALID_MIN_PROB && INVALID_KEYWORDS.some((k) => name.includes(k))) {
      return {
        category: "not_supported",
        rawLabel: p.className,
        confidence: p.probability,
        supported: false,
        available: true,
      };
    }
  }

  // 2) Supported category match.
  for (const p of preds) {
    const name = hay(p.className);
    for (const [category, keys] of CATEGORY_KEYWORDS) {
      if (keys.some((k) => name.includes(k))) {
        return { category, rawLabel: p.className, confidence: p.probability, supported: true, available: true };
      }
    }
  }

  // 3) Unsure → let the cloud ensemble decide (fail open, but it ran).
  return { category: "unknown", rawLabel: top.className, confidence: top.probability, supported: true, available: true };
}

// Classify the object in the given image. NEVER throws.
export async function classifyObject(uri: string): Promise<ClassificationResult> {
  const failOpen: ClassificationResult = {
    category: "unknown",
    rawLabel: "",
    confidence: 0,
    supported: true,
    available: false,
  };
  try {
    const ok = await ensureModel();
    if (!ok || !model || !decodeJpegFn || !tfNs) return failOpen;

    const resized = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: MODEL_INPUT, height: MODEL_INPUT } }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
    );
    const b64 = await FileSystem.readAsStringAsync(resized.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const bytes = base64ToBytes(b64);
    const tensor = decodeJpegFn(bytes);
    try {
      const preds = await model.classify(tensor, 5);
      return mapPredictions(preds ?? []);
    } finally {
      tfNs.dispose(tensor);
    }
  } catch {
    return failOpen;
  }
}

// Human-readable category label (English / Somali) for the HUD.
export function categoryLabel(category: ObjectCategory, lang: "en" | "so"): string {
  const map: Record<ObjectCategory, [string, string]> = {
    gemstone: ["Gemstone", "Dhagax qaali ah"],
    rock: ["Rock", "Dhagax"],
    mineral: ["Mineral", "Macdan"],
    gold: ["Gold", "Dahab"],
    silver: ["Silver", "Qalin/Silfar"],
    metal: ["Metal", "Bir"],
    coin: ["Coin", "Qadaadiic"],
    jewelry: ["Jewelry", "Dahabbir/Jewelry"],
    artifact: ["Ancient artifact", "Shay taariikhi ah"],
    unknown: ["Object", "Shay"],
    not_supported: ["Not supported", "Lama taageero"],
  };
  const entry = map[category];
  return lang === "so" ? entry[1] : entry[0];
}

// Which map layers the geologist last chose.
//
// A layer set is a working preference, not a session detail: someone who turns
// the satellite off to read the geology wants it off tomorrow too, and having
// to redo it at the start of every traverse is the kind of small friction that
// makes a field app feel unfinished.
//
// Stored as an explicit map rather than a blob so that a layer added in a later
// version does not vanish for existing users — an unknown key falls back to its
// default instead of being read as "off".
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "exploration.layers.v1";

export type LayerState = Record<string, boolean>;

/**
 * Merge what was stored over the defaults.
 *
 * Defaults win for any key the stored set does not mention, which is what keeps
 * a NEW layer visible the first time a user meets it. Stored keys that no
 * longer exist are dropped rather than carried forward.
 */
export function mergeLayers<T extends LayerState>(defaults: T, stored: unknown): T {
  if (!stored || typeof stored !== "object") return defaults;
  const s = stored as Record<string, unknown>;
  const out = { ...defaults };
  for (const k of Object.keys(defaults)) {
    if (typeof s[k] === "boolean") (out as LayerState)[k] = s[k] as boolean;
  }
  return out;
}

export async function loadLayers<T extends LayerState>(defaults: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? mergeLayers(defaults, JSON.parse(raw)) : defaults;
  } catch {
    // Unreadable preferences are not worth failing a field session over.
    return defaults;
  }
}

export async function saveLayers(layers: LayerState): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(layers));
  } catch {
    // The map still works; only the memory of the choice is lost.
  }
}
